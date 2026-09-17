// 감사기록: 추가 전용 + SHA-256 해시 체인
import { errorIncludes } from './http';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  ts: string;
  actor_email: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  request_id: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor_email: string;
  action: string;
  target: string;
  detail_json: string;
  request_id: string;
  prev_hash: string;
  row_hash: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 해시 대상 내용 (필드 순서 고정)
export function canonicalContent(r: Pick<AuditRow, 'ts' | 'actor_email' | 'action' | 'target' | 'detail_json' | 'request_id'>): string {
  return JSON.stringify([r.ts, r.actor_email, r.action, r.target, r.detail_json, r.request_id]);
}

export async function computeRowHash(prevHash: string, content: string): Promise<string> {
  return sha256Hex(`${prevHash}|${content}`);
}

async function headHash(db: D1Database): Promise<string> {
  const row = await db.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').first<{ row_hash: string }>();
  return row?.row_hash ?? GENESIS_HASH;
}

export interface AuditedWrite {
  entry: AuditEntry;
  stmts: D1PreparedStatement[];
}

const RETRYABLE = ['audit_chain_conflict'];

/**
 * 변경 문장들과 감사기록 1건을 한 배치(트랜잭션)로 실행.
 * 체인 머리 충돌 시 prepare 를 다시 호출해 재시도.
 */
export async function runAudited(
  db: D1Database,
  prepare: () => Promise<AuditedWrite>,
  opts: { attempts?: number; retryOn?: string[] } = {},
): Promise<D1Result[]> {
  const attempts = opts.attempts ?? 5;
  const retryOn = [...RETRYABLE, ...(opts.retryOn ?? [])];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const { entry, stmts } = await prepare();
    const prev = await headHash(db);
    const detail_json = JSON.stringify(entry.detail);
    const content = canonicalContent({ ...entry, detail_json });
    const row_hash = await computeRowHash(prev, content);
    const insert = db
      .prepare(
        'INSERT INTO audit_log (ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(entry.ts, entry.actor_email, entry.action, entry.target, detail_json, entry.request_id, prev, row_hash);
    try {
      return await db.batch([...stmts, insert]);
    } catch (err) {
      lastErr = err;
      if (!retryOn.some((s) => errorIncludes(err, s))) throw err;
    }
  }
  throw lastErr;
}

export function appendAudit(db: D1Database, entry: AuditEntry): Promise<D1Result[]> {
  return runAudited(db, async () => ({ entry, stmts: [] }));
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  head_hash: string;
  broken_at_id?: number;
  reason?: 'prev_hash_mismatch' | 'row_hash_mismatch';
}

// 체인 전체 점검 (id 오름차순, 페이지 단위)
export async function verifyAuditChain(db: D1Database, pageSize = 500): Promise<VerifyResult> {
  let expectedPrev = GENESIS_HASH;
  let lastId = 0;
  let checked = 0;
  for (;;) {
    const res = await db
      .prepare(
        'SELECT id, ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?',
      )
      .bind(lastId, pageSize)
      .all<AuditRow>();
    const rows = res.results ?? [];
    for (const r of rows) {
      if (r.prev_hash !== expectedPrev) {
        return { ok: false, checked, head_hash: expectedPrev, broken_at_id: r.id, reason: 'prev_hash_mismatch' };
      }
      const h = await computeRowHash(r.prev_hash, canonicalContent(r));
      if (h !== r.row_hash) {
        return { ok: false, checked, head_hash: expectedPrev, broken_at_id: r.id, reason: 'row_hash_mismatch' };
      }
      expectedPrev = r.row_hash;
      lastId = r.id;
      checked++;
    }
    if (rows.length < pageSize) break;
  }
  return { ok: true, checked, head_hash: expectedPrev };
}
