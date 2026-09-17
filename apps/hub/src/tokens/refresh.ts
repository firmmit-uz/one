// WP3: 외부 토큰 갱신 (R2 §1.4 의 ①–⑥ 을 순서 그대로)
//
// 왜 이렇게까지 하나: cafe24 처럼 갱신할 때마다 refresh token 이 바뀌는 연동은
// 동시 실행 한 번, 응답 유실 한 번으로 토큰을 잃는다. 잃으면 관리자 재인증뿐이다.
//
//  ①  실행권 확보      한 번에 한 실행만 (조건부 UPDATE, 변경 0행이면 종료)
//  ②  남은 시간 확인   요청 제한 + 여유보다 짧으면 요청을 보내지 않고 ⑥ 으로 해제
//  ②-1 시작 기록      외부 요청 **전에** journal 을 in_progress 로. 실패하면 요청을 보내지 않는다
//  ③  응답 선기록      응답 본문을 **파싱하기 전에** 암호문으로 먼저 기록
//  ④  버전 조건 저장   version 이 그대로일 때만 저장 + 같은 batch·같은 조건으로 journal applied
//  ⑤  충돌            ④ 가 0행이면 journal conflict 로 두고 새 토큰을 버리지 않는다
//  ⑥  실행권 해제      자기가 쥔 실행권만 푼다
//
// 응답 유실(요청은 갔는데 답이 없음) = REFRESH_UNKNOWN. **자동 재시도 금지.**
// 차단 규칙: 마지막 선기록이 unknown·conflict 이거나 실행권이 끝난 in_progress 이면 다음 실행을 시작하지 않는다.
//            해제는 관리자 재인증 뒤에만 가능하며 재인증 기능은 이번 범위 밖이다.
import { runAudited } from '../audit';
import type { Env } from '../env';
import { KEY_VERSION, loadKey, open, seal, toBytes } from './crypto';
import { adapterFor, type ParsedToken, type ProviderAdapter } from './providers';

export const TOKEN_REFRESH_CRON = '0 * * * *';
export const TOKEN_ACTOR = 'system:tokens';
/** 실행권 해제값. 모든 시각은 YYYY-MM-DDTHH:MM:SS.sssZ 한 형식만 쓴다. */
export const EPOCH = '1970-01-01T00:00:00.000Z';
export const LEASE_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const LEASE_MARGIN_MS = 30_000;
/** 만료 임박 기준 (R4 SYS.TOKEN_EXPIRY: 72시간 전 알림) */
export const EXPIRY_WARN_MS = 72 * 60 * 60 * 1000;

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** 요청이 나가기 전에 난 오류 (토큰이 회전했을 리 없다 → 차단하지 않는다) */
const NOT_DISPATCHED = new Set(['provider_not_configured']);

export type RefreshOutcome =
  | 'disabled'
  | 'no_key'
  | 'unknown_provider'
  | 'blocked'
  | 'lease_taken'
  | 'lease_too_short'
  | 'journal_start_failed'
  | 'decrypt_failed'
  | 'applied'
  | 'conflict'
  | 'unknown'
  | 'failed';

export interface RefreshDeps {
  now: () => Date;
  leaseMs?: number;
  requestTimeoutMs?: number;
  leaseMarginMs?: number;
  requestId?: string;
  holder?: string;
}

export interface TokenRow {
  token_id: string;
  provider: string;
  account_ref: string;
  ciphertext: unknown;
  iv: unknown;
  version: number;
  key_version: number;
  expires_at: string | null;
  updated_at: string;
  /** 이 토큰을 마지막으로 바꾼 선기록 id (④ 가 우리 write 인지 가리는 데 쓴다) */
  last_refresh_journal_id?: number | null;
}

export interface JournalRow {
  id: number;
  token_id: string;
  holder: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  ciphertext: unknown;
  iv: unknown;
  detail_json: string;
  key_version: number | null;
  lease_until: string | null;
}

export interface RefreshResult {
  token_id: string;
  outcome: RefreshOutcome;
  /** 외부 요청을 실제로 보냈는지 (시험에서 "외부 호출 0건" 을 확인한다) */
  dispatched: boolean;
}

function iso(d: Date): string {
  return d.toISOString();
}

export function isEnabled(env: Env): boolean {
  // 기본값 꺼짐. "true" 외의 값은 모두 꺼짐으로 본다 (문자열 "false" 가 켜짐이 되는 사고 방지)
  return env.TOKEN_REFRESH_ENABLED === 'true';
}

// ---------------------------------------------------------------- 준비

/**
 * 토큰 행을 만들 때 실행권 행도 **같은 batch 에서** 만든다.
 * 실행권 행이 없으면 ① 의 조건부 UPDATE 가 언제나 0행이라 갱신이 영원히 안 돈다.
 */
export function createTokenStmts(
  db: D1Database,
  row: { token_id: string; provider: string; account_ref: string; ciphertext: Uint8Array; iv: Uint8Array; key_version: number; expires_at: string | null },
  nowIso: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'INSERT INTO tokens (token_id, provider, account_ref, ciphertext, iv, version, key_version, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      )
      .bind(row.token_id, row.provider, row.account_ref, row.ciphertext, row.iv, row.key_version, row.expires_at, nowIso),
    db.prepare("INSERT INTO token_lease (token_id, holder, lease_until) VALUES (?, 'none', ?)").bind(row.token_id, EPOCH),
  ];
}

// ---------------------------------------------------------------- 차단 규칙

export type BlockReason = 'unknown' | 'conflict' | 'stuck_in_progress' | 'running';

/**
 * 다음 실행을 시작해도 되는지. 막을 이유가 있으면 그 이유를 돌려준다.
 * running(아직 살아 있는 in_progress)은 다른 실행이 돌고 있다는 뜻이라 막되 차단 해제 대상은 아니다.
 */
export function blockedBy(latest: JournalRow | null, now: Date): BlockReason | null {
  if (latest === null) return null;
  if (latest.outcome === 'unknown') return 'unknown';
  if (latest.outcome === 'conflict') return 'conflict';
  if (latest.outcome === 'in_progress') {
    const until = latest.lease_until === null ? NaN : Date.parse(latest.lease_until);
    // 시각을 해석할 수 없으면 죽은 것으로 본다 (fail-closed)
    if (!Number.isFinite(until) || until <= now.getTime()) return 'stuck_in_progress';
    return 'running';
  }
  return null;
}

export async function latestJournal(db: D1Database, tokenId: string): Promise<JournalRow | null> {
  return db.prepare('SELECT * FROM token_refresh_journal WHERE token_id = ? ORDER BY id DESC LIMIT 1').bind(tokenId).first<JournalRow>();
}

// ---------------------------------------------------------------- 본체

export async function refreshAllTokens(
  db: D1Database,
  env: Env,
  deps: RefreshDeps,
  adapters: Record<string, ProviderAdapter> = {},
): Promise<{ results: RefreshResult[]; skipped: RefreshOutcome | null }> {
  if (!isEnabled(env)) return { results: [], skipped: 'disabled' };
  const key = await loadKey(env);
  if (key === null) {
    console.error('config_error', 'token_key_missing');
    return { results: [], skipped: 'no_key' };
  }
  const rows = (await db.prepare('SELECT * FROM tokens ORDER BY token_id').all<TokenRow>()).results ?? [];
  const results: RefreshResult[] = [];
  for (const row of rows) {
    const adapter = adapters[row.provider] ?? adapterFor(row.provider);
    if (adapter === null) {
      results.push({ token_id: row.token_id, outcome: 'unknown_provider', dispatched: false });
      continue;
    }
    results.push(await refreshOne(db, key, row, adapter, deps));
  }
  return { results, skipped: null };
}

export async function refreshOne(
  db: D1Database,
  key: CryptoKey,
  token: TokenRow,
  adapter: ProviderAdapter,
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const now = deps.now();
  const requestId = deps.requestId ?? `cron-${crypto.randomUUID()}`;
  const holder = deps.holder ?? crypto.randomUUID();
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const marginMs = deps.leaseMarginMs ?? LEASE_MARGIN_MS;
  const done = (outcome: RefreshOutcome, dispatched = false): RefreshResult => ({ token_id: token.token_id, outcome, dispatched });

  // 0. 차단 규칙 — 여기서 막히면 ① 을 시작하지 않는다.
  //    선기록을 읽지 못하면 안전한지 확인할 수 없으므로 시작하지 않는다(fail-closed).
  let latest: JournalRow | null;
  try {
    latest = await latestJournal(db, token.token_id);
  } catch (err) {
    console.error('token_journal_read_failed', token.token_id, err instanceof Error ? err.name : 'unknown');
    return done('blocked');
  }
  const block = blockedBy(latest, now);
  if (block !== null) {
    console.warn('token_refresh_blocked', JSON.stringify({ token_id: token.token_id, reason: block }));
    return done(block === 'running' ? 'lease_taken' : 'blocked');
  }

  // ① 실행권 확보
  const leaseUntil = iso(new Date(now.getTime() + leaseMs));
  const taken = await db
    .prepare('UPDATE token_lease SET holder = ?1, lease_until = ?2 WHERE token_id = ?4 AND lease_until < ?3')
    .bind(holder, leaseUntil, iso(now), token.token_id)
    .run();
  if ((taken.meta?.changes ?? 0) === 0) return done('lease_taken');

  const release = async (): Promise<void> => {
    // ⑥ 자기가 쥔 실행권만 푼다
    await db
      .prepare('UPDATE token_lease SET lease_until = ?1 WHERE token_id = ?2 AND holder = ?3')
      .bind(EPOCH, token.token_id, holder)
      .run();
  };

  // ② 남은 시간 확인 — 요청 제한 + 여유보다 짧으면 보내지 않는다
  if (Date.parse(leaseUntil) - now.getTime() < timeoutMs + marginMs) {
    await release();
    return done('lease_too_short');
  }

  // 지금 가진 토큰 풀기 (평문은 이 함수 밖으로 나가지 않는다)
  const cipher = toBytes(token.ciphertext);
  const ivBytes = toBytes(token.iv);
  if (cipher === null || ivBytes === null) {
    await release();
    return done('decrypt_failed');
  }
  const current = await open(key, { ciphertext: cipher, iv: ivBytes });
  if (current === null) {
    console.error('token_decrypt_failed', token.token_id);
    await release();
    return done('decrypt_failed');
  }

  // ②-1 시작 기록 — 이 기록이 실패하면 외부 요청을 보내지 않는다
  let journalId: number;
  try {
    const ins = await db
      .prepare(
        "INSERT INTO token_refresh_journal (token_id, holder, started_at, outcome, detail_json, lease_until) VALUES (?, ?, ?, 'in_progress', ?, ?)",
      )
      .bind(token.token_id, holder, iso(now), JSON.stringify({ provider: adapter.name, version: token.version }), leaseUntil)
      .run();
    journalId = Number(ins.meta?.last_row_id ?? 0);
    if (journalId === 0) throw new Error('no_journal_id');
  } catch (err) {
    console.error('token_journal_start_failed', token.token_id, err instanceof Error ? err.name : 'unknown');
    await release();
    await audit(db, token, 'token_refresh_failed', { step: 'journal_start' }, now, requestId);
    return done('journal_start_failed');
  }

  // 외부 요청
  const controller = AbortSignal.timeout(timeoutMs);
  let answer: { status: number; body: string };
  let dispatched = true;
  try {
    answer = await adapter.call({ refreshToken: current, accountRef: token.account_ref, signal: controller });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (NOT_DISPATCHED.has(message)) {
      // 요청이 나가지 않았으므로 토큰은 그대로다 → 차단하지 않는다
      await finishJournal(db, journalId, 'failed', deps.now(), { reason: message });
      await release();
      return done('failed', false);
    }
    // 요청은 갔는데 답이 없다 → 새 토큰을 모르는 상태. 자동 재시도 금지.
    await finishJournal(db, journalId, 'unknown', deps.now(), { reason: 'no_answer' });
    await audit(db, token, 'token_refresh_unknown', { step: 'call' }, deps.now(), requestId);
    await release();
    return done('unknown', true);
  }

  // ③ 응답 선기록 — 파싱 전에 암호문으로 먼저 기록한다
  try {
    const sealed = await seal(key, answer.body);
    await db
      .prepare('UPDATE token_refresh_journal SET ciphertext = ?, iv = ?, key_version = ? WHERE id = ? AND outcome = ?')
      .bind(sealed.ciphertext, sealed.iv, sealed.keyVersion, journalId, 'in_progress')
      .run();
  } catch (err) {
    console.error('token_journal_prerecord_failed', token.token_id, err instanceof Error ? err.name : 'unknown');
    // 새 토큰을 잃은 것과 같다 → unknown 으로 바꾸려 시도하고 종료.
    // 그것도 실패하면 in_progress 로 남고, 실행권이 끝나면 차단 규칙이 잡는다.
    await finishJournal(db, journalId, 'unknown', deps.now(), { reason: 'prerecord_failed' }).catch(() => undefined);
    await audit(db, token, 'token_refresh_unknown', { step: 'prerecord' }, deps.now(), requestId).catch(() => undefined);
    await release();
    return done('unknown', true);
  }

  // 파싱
  const parsed: ParsedToken | null = answer.status >= 200 && answer.status < 300 ? adapter.parse(answer.body) : null;
  if (parsed === null) {
    if (answer.status >= 200 && answer.status < 300) {
      // 2xx 인데 해석이 안 된다 = 토큰이 바뀌었을 수 있는데 새 값을 모른다 → unknown(차단)
      await finishJournal(db, journalId, 'unknown', deps.now(), { reason: 'unparsable_2xx', status: answer.status });
      await audit(db, token, 'token_refresh_unknown', { step: 'parse', status: answer.status }, deps.now(), requestId);
      await release();
      return done('unknown', true);
    }
    // 2xx 가 아니면 회전이 일어나지 않았다고 본다 → 다시 시도할 수 있는 실패
    await finishJournal(db, journalId, 'failed', deps.now(), { reason: 'http_error', status: answer.status });
    await release();
    return done('failed', true);
  }

  // ④ 버전 조건 저장 + journal applied 를 한 batch 로
  //
  // 두 문장은 **같은 pre-state(version = token.version)** 만 조건으로 본다.
  // 앞 문장이 쓴 값을 뒤 문장이 보는지(read-your-write)에 기대지 않기 위해서다 —
  // batch 는 트랜잭션이므로 두 문장이 같은 스냅샷을 보고 함께 적용되거나 함께 취소된다.
  // (예전에는 journal 쪽에서 앞 문장이 쓴 version+1·last_refresh_journal_id 를 EXISTS 로 확인했다.
  //  원격 D1 이 batch 안에서 그 가시성을 보장하지 않으면 **성공한 갱신이 전부 conflict 로 뒤집힌다.**)
  //
  // 판정은 토큰 UPDATE 의 meta.changes **하나로만** 한다 — 경합의 심판은 그것뿐이다.
  const sealedToken = await seal(key, parsed.refreshToken);
  const finishedAt = iso(deps.now());
  const batch = await db.batch([
    db
      .prepare(
        "UPDATE token_refresh_journal SET outcome = 'applied', finished_at = ? WHERE id = ? AND outcome = 'in_progress' AND EXISTS (SELECT 1 FROM tokens WHERE token_id = ? AND version = ?)",
      )
      .bind(finishedAt, journalId, token.token_id, token.version),
    db
      .prepare(
        'UPDATE tokens SET ciphertext = ?, iv = ?, key_version = ?, version = version + 1, expires_at = ?, updated_at = ?, last_refresh_journal_id = ? WHERE token_id = ? AND version = ?',
      )
      .bind(
        sealedToken.ciphertext,
        sealedToken.iv,
        sealedToken.keyVersion,
        parsed.expiresAt,
        finishedAt,
        journalId,
        token.token_id,
        token.version,
      ),
  ]);
  const journalApplied = (batch[0]?.meta?.changes ?? 0) > 0;
  const tokenChanged = (batch[1]?.meta?.changes ?? 0) > 0;

  if (!tokenChanged) {
    // ⑤ 충돌: 새 토큰은 선기록에 남아 있다(버리지 않는다)
    if (journalApplied) {
      // 조건이 같은데 어긋났다 = 있을 수 없는 상태. 기록이 '적용됨' 으로 남으면 차단 규칙이 이 시도를 놓친다.
      console.error('token_journal_mismatch', token.token_id, 'applied_without_token');
    }
    await finishJournal(db, journalId, 'conflict', deps.now(), { reason: 'version_conflict', expected_version: token.version }, 'any');
    await audit(db, token, 'token_refresh_conflict', { expected_version: token.version }, deps.now(), requestId);
    await release();
    return done('conflict', true);
  }

  if (!journalApplied) {
    // 토큰은 저장됐는데 기록이 in_progress 로 남았다 = 있을 수 없는 상태.
    // 그대로 두면 실행권이 끝난 뒤 차단 규칙이 **멀쩡한 토큰을 막는다** → 기록만 맞춘다.
    console.error('token_journal_mismatch', token.token_id, 'token_without_applied');
    await finishJournal(db, journalId, 'applied', deps.now(), { reason: 'journal_repaired' });
  }

  await release();
  return done('applied', true);
}

async function finishJournal(
  db: D1Database,
  journalId: number,
  outcome: 'applied' | 'conflict' | 'failed' | 'unknown',
  now: Date,
  detail: Record<string, unknown>,
  /** 기본은 in_progress 인 행만 닫는다. 'any' 는 어긋난 기록을 되돌릴 때만 쓴다(⑤). */
  from: 'in_progress' | 'any' = 'in_progress',
): Promise<void> {
  const where = from === 'any' ? 'WHERE id = ?' : "WHERE id = ? AND outcome = 'in_progress'";
  await db
    .prepare(`UPDATE token_refresh_journal SET outcome = ?, finished_at = ?, detail_json = json_patch(detail_json, ?) ${where}`)
    .bind(outcome, iso(now), JSON.stringify(detail), journalId)
    .run();
}

/** P1 상황 기록 = 감사기록 1건 + SYS.TOKEN_EXPIRY KPI 를 error 로. **알림 발송 없음.** */
async function audit(
  db: D1Database,
  token: TokenRow,
  action: 'token_refresh_conflict' | 'token_refresh_unknown' | 'token_refresh_failed',
  detail: Record<string, unknown>,
  now: Date,
  requestId: string,
): Promise<void> {
  try {
    await runAudited(db, async () => ({
      stmts: [],
      entry: {
        ts: iso(now),
        actor_email: TOKEN_ACTOR,
        action,
        target: `token:${token.token_id}`,
        // 토큰 값·암호문은 넣지 않는다
        detail: { provider: token.provider, ...detail },
        request_id: requestId,
      },
    }));
  } catch (err) {
    console.error('token_audit_failed', action, err instanceof Error ? err.name : 'unknown');
  }
}

// ---------------------------------------------------------------- 상태 보기 (관리 화면·KPI)

export type TokenState = 'ok' | 'expiring' | 'conflict' | 'unknown' | 'running' | 'no_data';

export interface TokenStatus {
  token_id: string;
  provider: string;
  account_ref: string;
  state: TokenState;
  expires_at: string | null;
  updated_at: string;
  version: number;
  key_version: number;
  last_outcome: string | null;
  last_attempt_at: string | null;
}

/** 토큰별 상태. **토큰 값·암호문은 절대 내려보내지 않는다.** */
export async function tokenStatuses(db: D1Database, now: Date): Promise<TokenStatus[]> {
  const [tokensRes, journalRes] = await db.batch([
    db.prepare('SELECT token_id, provider, account_ref, version, key_version, expires_at, updated_at FROM tokens ORDER BY token_id'),
    db.prepare(
      'SELECT j.* FROM token_refresh_journal j JOIN (SELECT token_id, MAX(id) AS id FROM token_refresh_journal GROUP BY token_id) m ON m.id = j.id',
    ),
  ]);
  const tokens = (tokensRes?.results ?? []) as unknown as Omit<TokenRow, 'ciphertext' | 'iv'>[];
  const latest = new Map(((journalRes?.results ?? []) as unknown as JournalRow[]).map((j) => [j.token_id, j]));
  return tokens.map((t) => {
    const j = latest.get(t.token_id) ?? null;
    const block = blockedBy(j, now);
    let state: TokenState;
    if (block === 'unknown' || block === 'conflict') state = block;
    else if (block === 'stuck_in_progress') state = 'unknown';
    else if (block === 'running') state = 'running';
    else if (t.expires_at !== null && Number.isFinite(Date.parse(t.expires_at)) && Date.parse(t.expires_at) - now.getTime() < EXPIRY_WARN_MS) {
      state = 'expiring';
    } else if (t.expires_at === null) state = 'no_data';
    else state = 'ok';
    return {
      token_id: t.token_id,
      provider: t.provider,
      account_ref: t.account_ref,
      state,
      expires_at: t.expires_at,
      updated_at: t.updated_at,
      version: t.version,
      key_version: t.key_version,
      last_outcome: j?.outcome ?? null,
      last_attempt_at: j?.started_at ?? null,
    };
  });
}

export function isIsoMs(v: unknown): boolean {
  return typeof v === 'string' && ISO_MS_RE.test(v) && Number.isFinite(Date.parse(v));
}

export { KEY_VERSION };
