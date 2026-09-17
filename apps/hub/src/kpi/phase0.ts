// WP2: Phase 0 게이트 G1 체크리스트 (허브 ADMIN 수기 입력)
//
// 허용되는 쓰기다 — 하위 앱에 값을 쓰는 것이 아니라 허브 자체 관리 입력이고,
// 기존 관리 API 규칙(ADMIN 확인 · CSRF · 입력 검증 · 변경 + 감사 한 batch)을 그대로 따른다.
import { runAudited } from '../audit';
import { ApiError } from '../http';
import { objectOf, oneOf, readJsonBody, str, ValidationError } from '../validate';
import { PHASE0_STATES, type Phase0State } from './defs';

export const ITEM_ID_RE = /^V(?:[0-9]|1[0-3])$/;

/**
 * 증적 칸 검사: 주소·비밀값을 넣지 못하게 한다.
 * 허용 = 한글·영문·숫자·공백과 - . , # ( ) · 만. "별첨 S-6 7행" 같은 참조를 받는 칸이다.
 */
const EVIDENCE_ALLOWED_RE = /^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ \-.,#()·]+$/;
const EVIDENCE_BANNED = [
  { re: /:\/\//, reason: 'url' },
  { re: /@/, reason: 'email' },
  { re: /\b(?:https?|ftp|mailto)\b/i, reason: 'url' },
  { re: /\b[0-9a-fA-F]{20,}\b/, reason: 'secret_like' },
  { re: /\b[A-Za-z0-9_-]{28,}\b/, reason: 'secret_like' },
];

export function checkEvidenceRef(value: string): { ok: true } | { ok: false; reason: string } {
  for (const b of EVIDENCE_BANNED) if (b.re.test(value)) return { ok: false, reason: b.reason };
  if (!EVIDENCE_ALLOWED_RE.test(value)) return { ok: false, reason: 'invalid_characters' };
  return { ok: true };
}

export interface Phase0Item {
  item_id: string;
  sort: number;
  title_ko: string;
  state: Phase0State;
  evidence_ref: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export async function listPhase0(db: D1Database): Promise<{ items: Phase0Item[]; passed: number; total: number }> {
  const res = await db.prepare('SELECT * FROM phase0_checklist ORDER BY sort').all<Phase0Item>();
  const items = res.results ?? [];
  return { items, passed: items.filter((i) => i.state === 'passed').length, total: items.length };
}

export interface Phase0Update {
  state: Phase0State;
  evidence_ref: string | null;
  reason: string | undefined;
}

export async function parsePhase0Body(req: Request): Promise<Phase0Update> {
  const body = objectOf({
    state: { v: oneOf(PHASE0_STATES) },
    evidence_ref: { v: str({ max: 200 }), optional: true, nullable: true },
    reason: { v: str({ max: 500 }), optional: true },
  })(await readJsonBody(req), '');
  const evidence = body.evidence_ref ?? null;
  if (evidence !== null) {
    const c = checkEvidenceRef(evidence);
    if (!c.ok) throw new ValidationError(`evidence_${c.reason}`, 'evidence_ref');
  }
  // 통과로 표시하려면 증적 참조가 있어야 한다 (증거 없는 통과 금지)
  if (body.state === 'passed' && evidence === null) throw new ValidationError('evidence_required', 'evidence_ref');
  return { state: body.state, evidence_ref: evidence, reason: body.reason };
}

export async function applyPhase0Update(
  db: D1Database,
  itemId: string,
  update: Phase0Update,
  actor: string,
  now: Date,
  requestId: string,
): Promise<Phase0Item> {
  if (!ITEM_ID_RE.test(itemId)) throw new ValidationError('invalid_value', 'item_id');
  const cur = await db.prepare('SELECT * FROM phase0_checklist WHERE item_id = ?').bind(itemId).first<Phase0Item>();
  if (!cur) throw new ApiError(404, 'not_found', 'Checklist item not found');
  if (cur.state === update.state && cur.evidence_ref === update.evidence_ref) {
    throw new ApiError(409, 'no_change', 'Nothing changed');
  }
  const ts = now.toISOString();
  await runAudited(db, async () => ({
    stmts: [
      db
        .prepare('UPDATE phase0_checklist SET state = ?, evidence_ref = ?, updated_at = ?, updated_by = ? WHERE item_id = ?')
        .bind(update.state, update.evidence_ref, ts, actor, itemId),
    ],
    entry: {
      ts,
      actor_email: actor,
      action: 'phase0_update',
      target: `phase0:${itemId}`,
      detail: {
        from: { state: cur.state, evidence_ref: cur.evidence_ref },
        to: { state: update.state, evidence_ref: update.evidence_ref },
        reason: update.reason ?? null,
      },
      request_id: requestId,
    },
  }));
  return { ...cur, state: update.state, evidence_ref: update.evidence_ref, updated_at: ts, updated_by: actor };
}
