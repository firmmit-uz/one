// 가용성 점검 (Cron). 알림 발송 없음 (Phase 3).
import { runAudited } from './audit';

export type UptimeStateName = 'UP' | 'DOWN' | 'UNKNOWN';

export interface UptimeRow {
  app_id: string;
  state: UptimeStateName;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_change_at: string | null;
  last_status_code: number | null;
}

export interface UptimeDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  timeoutMs?: number;
  requestId?: string;
}

export const DOWN_AFTER_FAILURES = 2;
export const SYSTEM_ACTOR = 'system:cron';

// 2xx·3xx 와 인증 필요(401/403)는 서버가 살아 있는 것으로 판단
export function isHealthyStatus(code: number): boolean {
  return (code >= 200 && code < 400) || code === 401 || code === 403;
}

export async function probe(url: string, deps: UptimeDeps): Promise<{ ok: boolean; status: number | null }> {
  if (!url.startsWith('https://')) return { ok: false, status: null };
  const timeout = deps.timeoutMs ?? 5000;
  const once = async (method: 'HEAD' | 'GET') => {
    const res = await deps.fetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'fm-one-hub-uptime/1' },
    });
    try {
      await res.body?.cancel();
    } catch {
      /* 본문 무시 */
    }
    return res.status;
  };
  try {
    let status = await once('HEAD');
    if (status === 405 || status === 501) status = await once('GET');
    return { ok: isHealthyStatus(status), status: status >= 100 && status <= 599 ? status : null };
  } catch {
    return { ok: false, status: null };
  }
}

export function nextState(
  prev: Pick<UptimeRow, 'state' | 'consecutive_failures'> | null,
  ok: boolean,
): { state: UptimeStateName; consecutive_failures: number } {
  if (ok) return { state: 'UP', consecutive_failures: 0 };
  const failures = (prev?.consecutive_failures ?? 0) + 1;
  if (failures >= DOWN_AFTER_FAILURES) return { state: 'DOWN', consecutive_failures: failures };
  return { state: prev?.state ?? 'UNKNOWN', consecutive_failures: failures };
}

const UPSERT_SQL = `INSERT INTO uptime_state (app_id, state, consecutive_failures, last_checked_at, last_change_at, last_status_code)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(app_id) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures,
  last_checked_at = excluded.last_checked_at, last_change_at = excluded.last_change_at, last_status_code = excluded.last_status_code`;

export async function runUptimeChecks(db: D1Database, deps: UptimeDeps): Promise<{ checked: number; changes: number; errors: number }> {
  const targets =
    (
      await db
        .prepare(
          "SELECT app_id, health_url FROM app_registry WHERE health_url IS NOT NULL AND status <> 'not_connected' ORDER BY app_id",
        )
        .all<{ app_id: string; health_url: string }>()
    ).results ?? [];
  const prevRows = (await db.prepare('SELECT * FROM uptime_state').all<UptimeRow>()).results ?? [];
  const prevMap = new Map(prevRows.map((r) => [r.app_id, r]));

  const results = await Promise.all(targets.map(async (t) => ({ t, r: await probe(t.health_url, deps) })));

  let changes = 0;
  let errors = 0;
  const requestId = deps.requestId ?? `cron-${crypto.randomUUID()}`;
  for (const { t, r } of results) {
    try {
      const now = deps.now().toISOString();
      const prev = prevMap.get(t.app_id) ?? null;
      const prevState: UptimeStateName = prev?.state ?? 'UNKNOWN';
      const next = nextState(prev, r.ok);
      const changed = next.state !== prevState;
      const stmt = db
        .prepare(UPSERT_SQL)
        .bind(t.app_id, next.state, next.consecutive_failures, now, changed ? now : (prev?.last_change_at ?? null), r.status);
      if (changed) {
        // 상태가 바뀔 때만 감사기록
        await runAudited(db, async () => ({
          stmts: [stmt],
          entry: {
            ts: now,
            actor_email: SYSTEM_ACTOR,
            action: 'uptime_state_change',
            target: `app:${t.app_id}`,
            detail: { from: prevState, to: next.state, consecutive_failures: next.consecutive_failures, status_code: r.status },
            request_id: requestId,
          },
        }));
        changes++;
      } else {
        await stmt.run();
      }
    } catch (err) {
      errors++;
      console.error('uptime_update_failed', t.app_id, err instanceof Error ? err.name : 'unknown');
    }
  }
  return { checked: results.length, changes, errors };
}
