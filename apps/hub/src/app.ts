// Hono API 조립 (의존성 주입 가능: JWKS, 시계)
import { Hono, type Context } from 'hono';
import { authenticate, remoteJwks, type Identity, type JwksProvider } from './auth';
import { canWrite, loadPrincipal, type Principal } from './authz';
import { runAudited } from './audit';
import { checkConfig } from './config';
import type { Env } from './env';
import { ApiError, jsonError, SECURITY_HEADERS } from './http';
import { ValidationError } from './validate';
import { canSeeApp, listApps, toLauncherItem } from './apps';
import type { UptimeRow } from './uptime';
import { adminRoutes } from './admin';
import { kpiRoutes } from './kpi/routes';

export type Vars = {
  requestId: string;
  now: Date;
  identity: Identity;
  principal: Principal;
};

export type HubEnv = { Bindings: Env; Variables: Vars };
export type HubContext = Context<HubEnv>;

export interface AppDeps {
  jwks?: JwksProvider;
  now?: () => Date;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const PROD_ORIGIN_RE = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
const DEV_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

export function isValidAllowedOrigin(origin: string | undefined, env: Env): origin is string {
  if (!origin) return false;
  if (PROD_ORIGIN_RE.test(origin)) return true;
  return env.ENVIRONMENT === 'development' && DEV_ORIGIN_RE.test(origin);
}

const DENY_MESSAGES: Record<string, string> = {
  not_registered: 'User is not registered',
  account_inactive: 'Account is not active',
  no_access_group: 'User is not in any access group',
};

export function createApp(deps: AppDeps = {}) {
  const jwks = deps.jwks ?? remoteJwks;
  const clock = deps.now ?? (() => new Date());
  const app = new Hono<HubEnv>();

  // 공통: 요청 ID, 보안 헤더, 캐시 금지
  app.use('*', async (c, next) => {
    const rid = crypto.randomUUID();
    c.set('requestId', rid);
    c.set('now', clock());
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Request-Id', rid);
  });

  // 설정 점검 (운영에서 DEV 변수 → 전부 500)
  app.use('*', async (c, next) => {
    const cfg = checkConfig(c.env);
    if (!cfg.ok) {
      console.error('config_error', cfg.reason);
      return jsonError(c, 500, 'server_misconfigured', 'Server is misconfigured');
    }
    await next();
  });

  // 인증 없는 상태 확인 (정보 노출 없음)
  app.get('/api/health', (c) => c.json({ ok: true }));

  // 인증: Access JWT
  app.use('/api/*', async (c, next) => {
    const r = await authenticate(c.req.raw, c.env, jwks, c.get('now'));
    if (!r.ok) {
      if (r.reason === 'access_config_missing' || r.reason === 'dev_identity_invalid') console.error('auth_config', r.reason);
      return jsonError(c, 401, 'unauthenticated', 'Authentication required');
    }
    c.set('identity', r.identity);
    await next();
  });

  // CSRF: 쓰기는 같은 Origin + JSON 만
  app.use('/api/*', async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const allowed = c.env.ALLOWED_ORIGIN;
      if (!isValidAllowedOrigin(allowed, c.env)) {
        console.error('config_error', 'allowed_origin_invalid');
        return jsonError(c, 403, 'csrf_rejected', 'Write requests are not allowed');
      }
      if (c.req.header('Origin') !== allowed) return jsonError(c, 403, 'csrf_rejected', 'Origin not allowed');
      const site = c.req.header('Sec-Fetch-Site');
      if (site !== undefined && site !== 'same-origin') return jsonError(c, 403, 'csrf_rejected', 'Cross-site request');
      const ct = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (ct !== 'application/json') return jsonError(c, 415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    await next();
  });

  // 권한 주체 적재 (캐시 없음)
  app.use('/api/*', async (c, next) => {
    const identity = c.get('identity');
    const now = c.get('now');
    const r = await loadPrincipal(c.env.DB, identity.email, now);
    if (!r.ok) return jsonError(c, 403, r.code, DENY_MESSAGES[r.code] ?? 'Forbidden');
    const p = r.principal;
    c.set('principal', p);

    if (p.isBreakglass) await recordBreakglass(c, p, identity);

    // 그룹 사본이 오래되면 ADMIN 외 쓰기 거부
    if (!SAFE_METHODS.has(c.req.method) && !canWrite(p)) {
      return jsonError(c, 403, 'group_snapshot_stale', 'Group snapshot is stale; writes are limited to administrators');
    }
    await next();
  });

  app.get('/api/me', (c) => {
    const p = c.get('principal');
    return c.json({
      email: p.email,
      display_name: p.displayName,
      emp_id: p.empId,
      groups: p.groups,
      is_admin: p.isHubAdmin,
      roles: [...p.roles.values()].sort((a, b) => a.app_id.localeCompare(b.app_id)),
      snapshot: { synced_at: p.snapshotSyncedAt, stale: p.snapshotStale },
      auth_source: c.get('identity').source,
    });
  });

  app.get('/api/apps', async (c) => {
    const p = c.get('principal');
    const apps = await listApps(c.env.DB);
    return c.json({ apps: apps.filter((a) => canSeeApp(a, p)).map((a) => toLauncherItem(a, p)) });
  });

  app.get('/api/status', async (c) => {
    const p = c.get('principal');
    const [apps, states] = await Promise.all([
      listApps(c.env.DB),
      c.env.DB.prepare('SELECT * FROM uptime_state').all<UptimeRow>(),
    ]);
    const stateMap = new Map((states.results ?? []).map((s) => [s.app_id, s]));
    const monitored = apps.filter((a) => a.health_url !== null && a.status !== 'not_connected');
    const summary = { up: 0, down: 0, unknown: 0, monitored: monitored.length };
    let lastChecked: string | null = null;
    for (const a of monitored) {
      const s = stateMap.get(a.app_id);
      const st = s?.state ?? 'UNKNOWN';
      if (st === 'UP') summary.up++;
      else if (st === 'DOWN') summary.down++;
      else summary.unknown++;
      if (s?.last_checked_at && (lastChecked === null || s.last_checked_at > lastChecked)) lastChecked = s.last_checked_at;
    }
    const name = (a: (typeof apps)[number]) => ({ ko: a.name_ko, uz: a.name_uz, ru: a.name_ru });
    const items = p.isHubAdmin
      ? monitored.map((a) => {
          const s = stateMap.get(a.app_id);
          return {
            app_id: a.app_id,
            name: name(a),
            state: s?.state ?? 'UNKNOWN',
            consecutive_failures: s?.consecutive_failures ?? 0,
            last_checked_at: s?.last_checked_at ?? null,
            last_change_at: s?.last_change_at ?? null,
            last_status_code: s?.last_status_code ?? null,
          };
        })
      : monitored
          .filter((a) => canSeeApp(a, p))
          .map((a) => ({ app_id: a.app_id, name: name(a), state: stateMap.get(a.app_id)?.state ?? 'UNKNOWN' }));
    return c.json({ detail: p.isHubAdmin, summary, last_checked_at: lastChecked, items });
  });

  app.route('/api/kpi', kpiRoutes());
  app.route('/api/admin', adminRoutes());

  app.notFound((c) => jsonError(c, 404, 'not_found', 'Not found'));

  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return jsonError(c, 400, 'invalid_input', `${err.code}: ${err.field}`);
    }
    if (err instanceof ApiError) return jsonError(c, err.status, err.code, err.message);
    // 내부 정보·스택은 응답에 넣지 않음
    console.error('unhandled_error', c.get('requestId'), err instanceof Error ? err.name : 'unknown');
    return jsonError(c, 500, 'internal_error', 'Internal error');
  });

  return app;
}

// BREAKGLASS 로그인: Access 세션(iat)당 1건 감사기록. 기록 실패 시 요청 거부.
async function recordBreakglass(c: HubContext, p: Principal, identity: Identity): Promise<void> {
  const target = identity.iat !== null ? `session:${identity.iat}` : `request:${c.get('requestId')}`;
  const db = c.env.DB;
  const exists = await db
    .prepare("SELECT 1 AS x FROM audit_log WHERE action = 'breakglass_login' AND actor_email = ? AND target = ? LIMIT 1")
    .bind(p.email, target)
    .first();
  if (exists) return;
  try {
    await runAudited(db, async () => ({
      stmts: [],
      entry: {
        ts: c.get('now').toISOString(),
        actor_email: p.email,
        action: 'breakglass_login',
        target,
        detail: { path: new URL(c.req.url).pathname, method: c.req.method, groups: p.groups },
        request_id: c.get('requestId'),
      },
    }));
  } catch {
    throw new ApiError(500, 'audit_unavailable', 'Audit logging failed');
  }
}
