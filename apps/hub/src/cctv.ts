// R3 CCTV 1단계: 중계 서버의 영상을 허브가 **같은 출처로 전달**한다 (ADMIN 전용).
//
// 왜 전달(프록시)인가
//   1) 브라우저는 RTSP 를 못 튼다 → 중계 서버가 MP4/JPEG 로 바꿔 준다.
//   2) 중계 서버 주소를 브라우저에 직접 주면 보안 헤더(CSP)를 풀어야 한다 → 풀지 않는다.
//      허브가 대신 받아서 같은 출처(/api/cctv/...)로 내보내면 CSP 를 그대로 둘 수 있다.
//   3) 중계 서버 접속표(토큰)가 브라우저로 나가지 않는다.
//   4) 영상 요청 하나하나가 허브의 인증·권한 검사를 지난다.
//
// fail-closed: 꺼져 있음·주소 미설정·자리표시자·알 수 없는 재생 방식·예상 밖 응답 형식 → 거부.
import { Hono } from 'hono';
import type { HubEnv } from './app';
import { appendAudit } from './audit';
import type { Env } from './env';
import { ApiError, jsonError } from './http';
import { objectOf, readJsonBody, str, ValidationError } from './validate';

export const CAMERA_ID_RE = /^[a-z0-9-]{2,64}$/;
export const STREAM_KINDS = ['mp4', 'snapshot'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];
export type CameraStatus = 'active' | 'not_connected';

/** 중계 서버에서 받아도 되는 형식. 목록 밖은 거부한다.
 *  (허브 출처로 HTML·자바스크립트가 흘러들어오는 것을 막는 핵심 방어다.) */
export const ALLOWED_UPSTREAM_TYPES: Record<StreamKind, string> = {
  mp4: 'video/mp4',
  snapshot: 'image/jpeg',
};

/** 브라우저로 그대로 넘기는 응답 머리말. 목록 밖은 버린다. */
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

const RANGE_RE = /^bytes=\d*-\d*$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

export const UPSTREAM_TIMEOUT_MS = 10_000;

/** 중계 서버 접속표(Worker Secret). 형식이 어긋나면 없는 것으로 본다.
 *  자리표시자 `<CCTV_RELAY_TOKEN>` 은 '<' 때문에 이 형식에서 걸러진다 —
 *  따로 자리표시자 검사를 두지 않는다(겹치는 검사는 꺼져도 티가 나지 않는다). */
const RELAY_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/;

export function relayToken(env: Env): string | null {
  const v = env.CCTV_RELAY_TOKEN;
  if (typeof v !== 'string') return null;
  return RELAY_TOKEN_RE.test(v) ? v : null;
}

export interface CameraRow {
  camera_id: string;
  name_ko: string;
  site: string;
  stream_kind: string;
  stream_path: string | null;
  status: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface CameraView {
  camera_id: string;
  name_ko: string;
  site: string;
  stream_kind: StreamKind | null;
  status: CameraStatus;
  /** 지금 실제로 볼 수 있는가 (하나라도 어긋나면 false) */
  playable: boolean;
}

export type CctvDeps = { fetch: (input: string, init?: RequestInit) => Promise<Response> };

/** 기본 꺼짐 — "true" 가 아니면 모두 꺼짐으로 본다. */
export function isEnabled(env: Env): boolean {
  return env.CCTV_ENABLED === 'true';
}

/**
 * 중계 서버 주소 확인. 하나라도 어긋나면 null (= 꺼진 것과 같게 취급).
 * https 만, 사용자정보·경로·질의·조각 금지.
 * 자리표시자 `<CCTV_RELAY_ORIGIN>` 은 주소로 읽히지 않아 여기서 걸러진다 —
 * 따로 자리표시자 검사를 두지 않는다(겹치는 검사는 꺼져도 티가 나지 않는다).
 */
export function relayOrigin(env: Env): string | null {
  const raw = env.CCTV_RELAY_ORIGIN;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 200) return null;
  if (CONTROL_RE.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return null;
  return u.origin;
}

export function isStreamKind(v: unknown): v is StreamKind {
  return typeof v === 'string' && (STREAM_KINDS as readonly string[]).includes(v);
}

/**
 * 중계 서버 안에서의 경로 검사.
 * '/' 로 시작 · '//'(다른 서버로 새는 주소) 금지 · '..' 금지 · 역슬래시·제어문자 금지.
 */
export function isSafeStreamPath(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length < 1 || v.length > 200) return false;
  if (!v.startsWith('/')) return false;
  if (v.startsWith('//')) return false;
  if (v.includes('..')) return false;
  if (v.includes('\\')) return false;
  if (CONTROL_RE.test(v)) return false;
  // 되감기 검사: 합쳐 본 결과가 정말 그 서버 안인지 확인한다
  try {
    const u = new URL(v, 'https://relay.invalid');
    return u.origin === 'https://relay.invalid' && `${u.pathname}${u.search}` === v;
  } catch {
    return false;
  }
}

export function streamPathValidator(value: unknown, field: string): string {
  if (!isSafeStreamPath(value)) throw new ValidationError('invalid_stream_path', field);
  return value;
}

export async function listCameras(db: D1Database): Promise<CameraRow[]> {
  const res = await db
    .prepare(
      'SELECT camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at FROM cctv_cameras ORDER BY sort ASC, camera_id ASC',
    )
    .all<CameraRow>();
  return res.results ?? [];
}

export async function getCamera(db: D1Database, cameraId: string): Promise<CameraRow | null> {
  return (
    (await db
      .prepare(
        'SELECT camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at FROM cctv_cameras WHERE camera_id = ?',
      )
      .bind(cameraId)
      .first<CameraRow>()) ?? null
  );
}

/**
 * 화면에 내보낼 모양으로 바꾼다. **경로·중계 서버 주소는 절대 넣지 않는다.**
 * 알 수 없는 값이 저장돼 있으면 볼 수 없음으로 내린다(조용히 재생하지 않는다).
 */
export function toView(row: CameraRow, relayReady: boolean): CameraView {
  const kind = isStreamKind(row.stream_kind) ? row.stream_kind : null;
  const status: CameraStatus = row.status === 'active' ? 'active' : 'not_connected';
  const playable =
    relayReady && status === 'active' && kind !== null && isSafeStreamPath(row.stream_path); // MUTATION:CCTV-PLAYABLE
  return { camera_id: row.camera_id, name_ko: row.name_ko, site: row.site, stream_kind: kind, status, playable };
}

export type PlayCheck =
  | { ok: true; url: string; kind: StreamKind }
  | { ok: false; code: 'cctv_disabled' | 'relay_not_configured' | 'not_connected' | 'unsupported_stream' };

/** 재생 전 확인 한 군데. 화면·프록시 모두 이 결과만 믿는다. */
export function playTarget(env: Env, row: CameraRow): PlayCheck {
  if (!isEnabled(env)) return { ok: false, code: 'cctv_disabled' };
  const origin = relayOrigin(env);
  if (origin === null) return { ok: false, code: 'relay_not_configured' };
  if (row.status !== 'active') return { ok: false, code: 'not_connected' };
  if (!isStreamKind(row.stream_kind)) return { ok: false, code: 'unsupported_stream' };
  if (!isSafeStreamPath(row.stream_path)) return { ok: false, code: 'unsupported_stream' };
  return { ok: true, url: `${origin}${row.stream_path}`, kind: row.stream_kind };
}

const FAIL_STATUS: Record<Exclude<PlayCheck, { ok: true }>['code'], 409 | 404> = {
  cctv_disabled: 409,
  relay_not_configured: 409,
  not_connected: 409,
  unsupported_stream: 409,
};

const FAIL_MESSAGE: Record<Exclude<PlayCheck, { ok: true }>['code'], string> = {
  cctv_disabled: 'CCTV viewing is disabled',
  relay_not_configured: 'CCTV relay is not configured',
  not_connected: 'Camera is not connected',
  unsupported_stream: 'Camera stream is not usable',
};

/**
 * 중계 서버로 전달.
 * - 브라우저가 보낸 머리말은 **Range 하나만** 넘긴다 (쿠키·Access 표는 절대 넘기지 않는다).
 * - 돌려줄 때도 정해진 머리말만 넘기고, 형식이 다르면 거부한다.
 */
export async function proxyStream(
  target: { url: string; kind: StreamKind },
  range: string | null,
  deps: CctvDeps,
  token: string | null = null,
): Promise<Response> {
  const headers = new Headers();
  if (range !== null && RANGE_RE.test(range)) headers.set('Range', range);
  // 접속표는 중계 서버로만 간다. 브라우저·로그·감사기록에는 나오지 않는다.
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);

  let upstream: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    upstream = await deps.fetch(target.url, { method: 'GET', headers, redirect: 'error', signal: ctl.signal });
  } catch {
    throw new ApiError(502, 'relay_unreachable', 'CCTV relay did not respond');
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status !== 200 && upstream.status !== 206) {
    throw new ApiError(502, 'relay_error', 'CCTV relay returned an unexpected response');
  }
  // 형식 확인: 목록 밖이면 내보내지 않는다 (허브 출처로 HTML·JS 가 들어오는 것을 막는다)
  const ct = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (ct !== ALLOWED_UPSTREAM_TYPES[target.kind]) {
    throw new ApiError(502, 'relay_bad_content_type', 'CCTV relay returned an unexpected content type');
  }

  const out = new Headers();
  for (const k of PASS_RESPONSE_HEADERS) {
    const v = upstream.headers.get(k);
    if (v !== null) out.set(k, v);
  }
  // 영상은 저장하지 않는다 (공통 미들웨어가 다시 no-store 를 씌우지만 여기서도 명시)
  out.set('Cache-Control', 'no-store');
  out.set('X-Content-Type-Options', 'nosniff');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export function cctvRoutes(deps: CctvDeps) {
  const r = new Hono<HubEnv>();

  // ADMIN 전용 (서버가 최종 판정). 화면이 숨기는 것과 별개로 여기서 막는다.
  r.use('*', async (c, next) => {
    if (!c.get('principal').isHubAdmin) return jsonError(c, 403, 'forbidden', 'Administrator role required');
    await next();
  });

  // 목록: 경로·중계 서버 주소는 내보내지 않는다
  r.get('/', async (c) => {
    const enabled = isEnabled(c.env);
    const relayReady = enabled && relayOrigin(c.env) !== null;
    const rows = await listCameras(c.env.DB);
    return c.json({
      enabled,
      relay_configured: relayReady,
      cameras: rows.map((row) => toView(row, relayReady)),
    });
  });

  // 열람 시작: 감사기록 1건. 화면은 이 응답을 받은 뒤에만 재생을 건다.
  r.post('/:camera_id/open', async (c) => {
    const id = cameraIdParam(c.req.param('camera_id'));
    // 본문은 사유만 받는다 (모르는 필드는 거부)
    const body = objectOf({ reason: { v: str({ max: 500 }), optional: true } })(await readJsonBody(c.req.raw), '');
    const row = await getCamera(c.env.DB, id);
    if (row === null) throw new ApiError(404, 'not_found', 'Camera not found');
    const target = playTarget(c.env, row);
    if (!target.ok) throw new ApiError(FAIL_STATUS[target.code], target.code, FAIL_MESSAGE[target.code]);
    const now = c.get('now').toISOString();
    await appendAudit(c.env.DB, {
      ts: now,
      actor_email: c.get('principal').email,
      action: 'cctv_view_open',
      target: `camera:${id}`,
      // 주소·경로는 기록하지 않는다 (감사기록은 오래 남는다)
      detail: { site: row.site, stream_kind: target.kind, reason: body.reason ?? null },
      request_id: c.get('requestId'),
    });
    return c.json({ camera_id: id, stream_kind: target.kind, play_path: `/api/cctv/${id}/play`, opened_at: now });
  });

  // 영상 전달. 조각 요청마다 감사기록을 남기면 체인이 넘치므로 구조화 로그만 남긴다.
  r.get('/:camera_id/play', async (c) => {
    const id = cameraIdParam(c.req.param('camera_id'));
    const row = await getCamera(c.env.DB, id);
    if (row === null) throw new ApiError(404, 'not_found', 'Camera not found');
    const target = playTarget(c.env, row);
    if (!target.ok) throw new ApiError(FAIL_STATUS[target.code], target.code, FAIL_MESSAGE[target.code]);
    console.log(
      JSON.stringify({
        event: 'cctv_stream',
        request_id: c.get('requestId'),
        actor: c.get('principal').email,
        camera_id: id,
        stream_kind: target.kind,
      }),
    );
    return proxyStream(target, c.req.header('Range') ?? null, deps, relayToken(c.env));
  });

  return r;
}

function cameraIdParam(v: string): string {
  if (!CAMERA_ID_RE.test(v)) throw new ValidationError('invalid_format', 'camera_id');
  return v;
}
