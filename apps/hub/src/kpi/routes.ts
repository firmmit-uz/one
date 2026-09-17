// WP2: KPI 조회 API (기존 미들웨어 인증 → CSRF → 권한 주체를 그대로 탄다)
import { Hono } from 'hono';
import type { HubEnv } from '../app';
import { ApiError } from '../http';
import { ValidationError } from '../validate';
import { listKpis } from './gateway';

const KPI_ID_RE = /^[A-Z]{2,4}\.[A-Z0-9_]{2,40}$/;

export function kpiRoutes() {
  const r = new Hono<HubEnv>();

  r.get('/', async (c) => {
    for (const k of Object.keys(c.req.query())) throw new ValidationError('unknown_field', k);
    const p = c.get('principal');
    const result = await listKpis(c.env.DB, p, c.get('now'));
    logRead(c.get('requestId'), p.email, result.kpis.map((k) => k.kpi_id));
    return c.json(result);
  });

  r.get('/:kpi_id', async (c) => {
    const id = c.req.param('kpi_id');
    if (!KPI_ID_RE.test(id)) throw new ValidationError('invalid_value', 'kpi_id');
    const p = c.get('principal');
    const result = await listKpis(c.env.DB, p, c.get('now'), id);
    // 권한이 없거나 아직 수집되지 않은 KPI 는 구분 없이 404 (존재 여부를 흘리지 않는다)
    const kpi = result.kpis[0];
    if (!kpi) throw new ApiError(404, 'not_found', 'KPI not found');
    logRead(c.get('requestId'), p.email, [kpi.kpi_id]);
    return c.json({ as_of: result.as_of, kpi });
  });

  return r;
}

/**
 * KPI 조회 기록.
 * 감사 체인(audit_log)에는 넣지 않는다 — 조회마다 체인에 쓰면 경합·용량이 커지고,
 * 감사 보존 기간이 아직 결정되지 않았다(R4 §2.1 ⑥ 과 다른 점, 변경표에 "보류"로 기록).
 */
function logRead(requestId: string, actorEmail: string, kpiIds: string[]): void {
  console.log('kpi_read', JSON.stringify({ request_id: requestId, actor_email: actorEmail, kpi_ids: kpiIds }));
}
