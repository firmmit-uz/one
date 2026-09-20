// R3 CCTV 1단계: 중계 서버의 영상을 허브가 **같은 출처로 전달**한다 (ADMIN 전용).
//
// 왜 전달(프록시)인가
//   1) 브라우저는 RTSP 를 못 튼다 → 중계 서버가 MP4/JPEG 로 바꿔 준다.
//   2) 중계 서버 주소를 브라우저에 직접 주면 보안 헤더(CSP)를 풀어야 한다 → 풀지 않는다.
//      허브가 대신 받아서 같은 출처(/api/cctv/...)로 내보내면 CSP 를 그대로 둘 수 있다.
//   3) 중계 서버 접속표(토큰)가 브라우저로 나가지 않는다.
//   4) 영상 요청 하나하나가 허브의 인증·권한 검사를 지난다.
//
// 열람 기록이 약속대로 남게 하는 법 (2단계)
//   /open 이 감사기록과 **같은 batch** 로 열람 토큰을 남기고, /play 는 그 토큰(카메라·사람·만료에 묶임)이
//   있어야만 연다. 화면의 호출 순서에 기대지 않는다.
//
// fail-closed: 꺼져 있음·주소 미설정·자리표시자·인증 설정 비어 있음·알 수 없는 재생 방식·예상 밖 응답 형식 → 거부.
import { Hono } from 'hono';
import type { HubEnv } from './app';
import { runAudited } from './audit';
import type { Env } from './env';
import { requireHubAdmin } from './guard';
import { ApiError } from './http';
import { CONTROL_RE, objectOf, readJsonBody, str, ValidationError } from './validate';

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

// 구간 요청은 한쪽이라도 숫자가 있어야 한다. `bytes=-` 는 규격 밖이라 넘기지 않는다.
const RANGE_RE = /^bytes=(\d+-\d*|-\d+)$/;

/** 넘겨도 되는 구간 요청인가 — 규격에 맞고, 시작·끝이 둘 다 있으면 시작 ≤ 끝. */
export function isForwardableRange(v: string): boolean {
  if (!RANGE_RE.test(v)) return false;
  const [start, end] = v.slice('bytes='.length).split('-');
  if (start !== '' && end !== '' && Number(start) > Number(end)) return false; // MUTATION:CCTV-RANGE-ORDER
  return true;
}

/** 본문이 이만큼 멈춰 있으면 연결을 끊는다 — 중계 서버가 머리말만 보내고 얼어붙었을 때 재생기가 영원히 돌지 않게. */
export const IDLE_TIMEOUT_MS = 30_000;

/** 조각이 idleMs 동안 안 오면 onIdle 을 부른다(부르는 쪽이 연결을 끊는다). 읽는 쪽이 취소하면 위로 그대로 전해진다. */
export function withIdleTimeout(body: ReadableStream<Uint8Array>, idleMs: number, onIdle: () => void): ReadableStream<Uint8Array> {
  let ctrl: TransformStreamDefaultController<Uint8Array> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const idle = () => {
    timer = null;
    onIdle(); // 위쪽 연결을 끊는다
    // 아래쪽(브라우저)도 바로 오류로 끝낸다 — 위쪽이 끊기는 것을 기다리지 않는다
    try { ctrl?.error(new Error('CCTV relay stalled')); } catch { /* 이미 닫힘 */ }
  };
  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(idle, idleMs);
  };
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        ctrl = controller;
        arm();
      },
      transform(chunk, controller) {
        arm();
        controller.enqueue(chunk);
      },
      flush() {
        disarm();
      },
      cancel() {
        disarm();
      },
    }),
  );
}

export const UPSTREAM_TIMEOUT_MS = 10_000;

/** 열람 토큰 수명. 사진 새로고침·영상 구간 요청이 이 안에서 같은 토큰을 쓴다. 지나면 다시 연다. */
export const VIEW_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * 중계 서버에 자신을 밝히는 방법.
 *   none      : 밝히지 않는다 (중계 서버가 사내망에서만 열릴 때) — **적어서 골라야** 한다
 *   basic     : 아이디·비밀번호 (go2rtc 등 중계 프로그램 자체의 인증)
 *   cf-access : Cloudflare Access 서비스 토큰 (Cloudflare 가 가장자리에서 먼저 막는다)
 * 목록 밖 값·빈 값은 **설정 잘못**으로 보고 재생을 막는다.
 */
export const RELAY_AUTH_SCHEMES = ['none', 'basic', 'cf-access'] as const;
export type RelayAuthScheme = (typeof RELAY_AUTH_SCHEMES)[number];

// 아이디·비밀번호·토큰에 쓸 수 있는 글자 (btoa 가 처리할 수 있는 ASCII 만)
const CRED_RE = /^[\x21-\x7e]{1,256}$/;

export type RelayAuthResult =
  | { ok: true; headers: [string, string][] }
  | { ok: false };

/**
 * 밝히는 방법을 정한다.
 * **방법을 정해 놓고 값이 없거나 형식이 어긋나면 실패**로 본다 —
 * 조용히 "안 밝히고" 부르면 중계 서버가 열려 있을 때 그대로 통과해 버린다.
 */
export function relayAuth(env: Env): RelayAuthResult {
  const raw = env.CCTV_RELAY_AUTH;
  // 설정이 비어 있으면 거부한다. 'none' 도 **적어 두어야** 고른 것이다. MUTATION:CCTV-AUTH-BLANK
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false };
  const scheme = raw.trim();
  if (!(RELAY_AUTH_SCHEMES as readonly string[]).includes(scheme)) return { ok: false }; // MUTATION:CCTV-AUTH-UNKNOWN
  if (scheme === 'none') return { ok: true, headers: [] };
  if (scheme === 'basic') {
    const user = env.CCTV_RELAY_USER;
    const pass = env.CCTV_RELAY_PASS;
    // 아이디에 ':' 가 있으면 비밀번호와 구분되지 않는다 (RFC 7617)
    if (typeof user !== 'string' || !CRED_RE.test(user) || user.includes(':')) return { ok: false };
    if (typeof pass !== 'string' || !CRED_RE.test(pass)) return { ok: false };
    return { ok: true, headers: [['Authorization', `Basic ${btoa(`${user}:${pass}`)}`]] };
  }
  const id = env.CCTV_RELAY_CF_ID;
  const secret = env.CCTV_RELAY_CF_SECRET;
  if (typeof id !== 'string' || !CRED_RE.test(id)) return { ok: false };
  if (typeof secret !== 'string' || !CRED_RE.test(secret)) return { ok: false };
  return {
    ok: true,
    headers: [
      ['CF-Access-Client-Id', id],
      ['CF-Access-Client-Secret', secret],
    ],
  };
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

export type CctvDeps = { fetch: (input: string, init?: RequestInit) => Promise<Response>; idleTimeoutMs?: number };

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

/**
 * 중계 서버를 실제로 부를 수 있는 상태인가 — 켜짐 · 주소 · 인증 설정 **셋 다**.
 * 목록(`playable`)·관리 화면·재생 판정이 모두 이 하나를 본다. 화면이 "볼 수 있음" 이라 했는데
 * 재생이 설정 오류로 막히는 어긋남이 여기서 없어진다.
 */
export function relayReady(env: Env): boolean {
  return isEnabled(env) && relayOrigin(env) !== null && relayAuth(env).ok;
}

export function isStreamKind(v: unknown): v is StreamKind {
  return typeof v === 'string' && (STREAM_KINDS as readonly string[]).includes(v);
}

/**
 * 중계 서버 안에서의 경로 검사.
 * '/' 로 시작 · '//'(다른 서버로 새는 주소) 금지 · '..' 금지 · 제어문자 금지.
 * 역슬래시는 따로 막지 않는다 — URL 파서가 '/' 로 바꿔 되감기 검사에서 걸린다(겹치는 검사는 꺼져도 티가 나지 않는다).
 */
export function isSafeStreamPath(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length < 1 || v.length > 200) return false;
  if (!v.startsWith('/')) return false;
  if (v.startsWith('//')) return false;
  if (v.includes('..')) return false;
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
export function toView(row: CameraRow, ready: boolean): CameraView {
  const kind = isStreamKind(row.stream_kind) ? row.stream_kind : null;
  const status: CameraStatus = row.status === 'active' ? 'active' : 'not_connected';
  const playable =
    ready && status === 'active' && kind !== null && isSafeStreamPath(row.stream_path); // MUTATION:CCTV-PLAYABLE
  return { camera_id: row.camera_id, name_ko: row.name_ko, site: row.site, stream_kind: kind, status, playable };
}

/** 목록 응답의 공통 부분. `/api/cctv` 와 `/api/admin/cctv` 가 같은 것을 쓴다 — 두 화면이 `playable` 에서 어긋나지 않게. */
export async function cameraList(env: Env, db: D1Database): Promise<{ enabled: boolean; relay_configured: boolean; rows: CameraRow[]; views: CameraView[] }> {
  const ready = relayReady(env);
  const rows = await listCameras(db);
  return { enabled: isEnabled(env), relay_configured: ready, rows, views: rows.map((row) => toView(row, ready)) };
}

export type PlayCheck =
  | { ok: true; url: string; kind: StreamKind; authHeaders: [string, string][] }
  | { ok: false; code: 'cctv_disabled' | 'relay_not_configured' | 'relay_auth_misconfigured' | 'not_connected' | 'unsupported_stream' };

/** 재생 전 확인 한 군데. 화면·프록시 모두 이 결과만 믿는다. */
export function playTarget(env: Env, row: CameraRow): PlayCheck {
  if (!isEnabled(env)) return { ok: false, code: 'cctv_disabled' };
  const origin = relayOrigin(env);
  if (origin === null) return { ok: false, code: 'relay_not_configured' };
  if (row.status !== 'active') return { ok: false, code: 'not_connected' };
  if (!isStreamKind(row.stream_kind)) return { ok: false, code: 'unsupported_stream' };
  if (!isSafeStreamPath(row.stream_path)) return { ok: false, code: 'unsupported_stream' };
  const auth = relayAuth(env);
  if (!auth.ok) return { ok: false, code: 'relay_auth_misconfigured' };
  return { ok: true, url: `${origin}${row.stream_path}`, kind: row.stream_kind, authHeaders: auth.headers };
}

// 재생 전 확인에 걸리면 전부 409 (상태가 맞지 않음). 404 는 카메라가 없을 때만 따로 낸다.
const FAIL_STATUS = 409 as const;

const FAIL_MESSAGE: Record<Exclude<PlayCheck, { ok: true }>['code'], string> = {
  cctv_disabled: 'CCTV viewing is disabled',
  relay_not_configured: 'CCTV relay is not configured',
  relay_auth_misconfigured: 'CCTV relay credentials are not configured correctly',
  not_connected: 'Camera is not connected',
  unsupported_stream: 'Camera stream is not usable',
};

/**
 * 중계 서버로 전달.
 * - 브라우저가 보낸 머리말은 **Range 하나만** 넘긴다 (쿠키·Access 표는 절대 넘기지 않는다).
 * - 돌려줄 때도 정해진 머리말만 넘기고, 형식이 다르면 거부한다.
 */
export async function proxyStream(
  target: { url: string; kind: StreamKind; authHeaders?: [string, string][] },
  range: string | null,
  deps: CctvDeps,
): Promise<Response> {
  const headers = new Headers();
  // 실시간이어야 하므로 중간 캐시를 쓰지 않는다. 브라우저 쪽 ?t= 만으로는 가장자리 캐시를 못 막는다.
  // [재확인 필요] 요청 머리말만으로 Cloudflare 가장자리 캐시(.jpeg/.mp4 기본 캐시 대상)를 확실히 건너뛰는지는
  // G11 에서 실측한다. 아래 cf 옵션도 같이 두고, README 는 중계 호스트에 Bypass Cache 규칙을 권한다.
  headers.set('Cache-Control', 'no-cache');
  if (range !== null && isForwardableRange(range)) headers.set('Range', range);
  // 접속표는 중계 서버로만 간다. 브라우저·로그·감사기록에는 나오지 않는다.
  for (const [k, v] of target.authHeaders ?? []) headers.set(k, v);

  let upstream: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // workerd 는 redirect:'error' 를 구현하지 않고 TypeError 를 던진다(바이너리 문구 확인).
    // 'manual' 로 받고 3xx 는 아래 200/206 검사가 그대로 거부한다. MUTATION:CCTV-REDIRECT
    upstream = await deps.fetch(target.url, { method: 'GET', headers, redirect: 'manual', signal: ctl.signal, cf: { cacheEverything: false } });
  } catch {
    throw new ApiError(502, 'relay_unreachable', 'CCTV relay did not respond');
  } finally {
    clearTimeout(timer);
  }

  // 거부할 때는 중계 연결을 바로 끊는다 — 안 읽을 영상이 온실 업로드 회선을 계속 타지 않게. MUTATION:CCTV-CANCEL
  const reject = async (code: string, message: string): Promise<never> => {
    await upstream.body?.cancel().catch(() => undefined);
    throw new ApiError(502, code, message);
  };
  if (upstream.status === 416) {
    // 구간이 영상 범위를 벗어난 것은 클라이언트 쪽 문제 — 중계 서버 장애(502)로 보고하지 않는다
    await upstream.body?.cancel().catch(() => undefined);
    throw new ApiError(416, 'range_not_satisfiable', 'Requested range is outside the stream');
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    return reject('relay_error', 'CCTV relay returned an unexpected response');
  }
  // 형식 확인: 목록 밖이면 내보내지 않는다 (허브 출처로 HTML·JS 가 들어오는 것을 막는다)
  const ct = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (ct !== ALLOWED_UPSTREAM_TYPES[target.kind]) {
    return reject('relay_bad_content_type', 'CCTV relay returned an unexpected content type');
  }
  // 압축된 응답은 받지 않는다 — Worker 가 몸통을 풀어 버리면 넘겨준 content-length 와 어긋나 재생이 깨진다
  const enc = (upstream.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (enc !== '' && enc !== 'identity') { // MUTATION:CCTV-ENCODING
    return reject('relay_bad_encoding', 'CCTV relay returned a compressed response');
  }

  const out = new Headers();
  for (const k of PASS_RESPONSE_HEADERS) {
    const v = upstream.headers.get(k);
    if (v !== null) out.set(k, v);
  }
  // 영상은 저장하지 않는다 (공통 미들웨어가 다시 no-store 를 씌우지만 여기서도 명시)
  out.set('Cache-Control', 'no-store');
  out.set('X-Content-Type-Options', 'nosniff');
  // 머리말은 왔는데 몸통이 멈추면 끊는다 — 브라우저가 error 를 받아 다시 청하거나 안내를 낸다
  const body = upstream.body === null ? null : withIdleTimeout(upstream.body, deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => ctl.abort()); // MUTATION:CCTV-IDLE
  return new Response(body, { status: upstream.status, headers: out });
}

interface ViewSessionRow {
  camera_id: string;
  actor_email: string;
  expires_at: string;
}

export function cctvRoutes(deps: CctvDeps) {
  const r = new Hono<HubEnv>();

  // ADMIN 전용 (서버가 최종 판정). 관리 API 와 같은 관문을 쓴다.
  r.use('*', requireHubAdmin);

  // 목록: 경로·중계 서버 주소는 내보내지 않는다
  r.get('/', async (c) => {
    const l = await cameraList(c.env, c.env.DB);
    return c.json({ enabled: l.enabled, relay_configured: l.relay_configured, cameras: l.views });
  });

  // 열람 시작: 감사기록 1건 + 열람 토큰을 **한 batch** 로. 화면은 돌려받은 play_path 로만 재생을 건다.
  r.post('/:camera_id/open', async (c) => {
    const id = cameraIdParam(c.req.param('camera_id'));
    // 본문은 사유만 받는다 (모르는 필드는 거부)
    const body = objectOf({ reason: { v: str({ max: 500 }), optional: true } })(await readJsonBody(c.req.raw), '');
    const db = c.env.DB;
    const row = await getCamera(db, id);
    if (row === null) throw new ApiError(404, 'not_found', 'Camera not found');
    const target = playTarget(c.env, row);
    if (!target.ok) throw new ApiError(FAIL_STATUS, target.code, FAIL_MESSAGE[target.code]);
    const nowDate = c.get('now');
    const now = nowDate.toISOString();
    const expires = new Date(nowDate.getTime() + VIEW_SESSION_TTL_MS).toISOString();
    const actor = c.get('principal').email;
    const token = crypto.randomUUID();
    await runAudited(db, async () => ({
      stmts: [
        // 지난 토큰은 여기서 함께 치운다 (따로 크론을 두지 않는다)
        db.prepare('DELETE FROM cctv_view_sessions WHERE expires_at <= ?').bind(now),
        db
          .prepare('INSERT INTO cctv_view_sessions (token, camera_id, actor_email, opened_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .bind(token, id, actor, now, expires),
      ],
      entry: {
        ts: now,
        actor_email: actor,
        action: 'cctv_view_open',
        target: `camera:${id}`,
        // 주소·경로·토큰은 기록하지 않는다 (감사기록은 오래 남는다)
        detail: { site: row.site, stream_kind: target.kind, reason: body.reason ?? null, expires_at: expires },
        request_id: c.get('requestId'),
      },
    }));
    return c.json({
      camera_id: id,
      stream_kind: target.kind,
      play_path: `/api/cctv/${id}/play?s=${token}`,
      opened_at: now,
      expires_at: expires,
    });
  });

  // 영상 전달. 조각 요청마다 감사기록을 남기면 체인이 넘치므로 구조화 로그만 남긴다.
  r.get('/:camera_id/play', async (c) => {
    // Hono 는 HEAD 를 GET 처리기로 보내고 본문을 버린다 → 아무도 읽지 않을 영상 연결이 열린다. GET 만 받는다.
    if (c.req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET');
    const id = cameraIdParam(c.req.param('camera_id'));
    const token = c.req.query('s') ?? '';
    // 카메라 행과 열람 토큰을 한 번의 왕복으로 읽는다 — 사진 방식은 2초마다 오는 요청이다
    const db = c.env.DB;
    const [camRes, sessRes] = await db.batch([
      db.prepare('SELECT camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at FROM cctv_cameras WHERE camera_id = ?').bind(id),
      db.prepare('SELECT camera_id, actor_email, expires_at FROM cctv_view_sessions WHERE token = ?').bind(token),
    ]);
    const row = (camRes?.results?.[0] as CameraRow | undefined) ?? null;
    if (row === null) throw new ApiError(404, 'not_found', 'Camera not found');
    const target = playTarget(c.env, row);
    if (!target.ok) throw new ApiError(FAIL_STATUS, target.code, FAIL_MESSAGE[target.code]);

    // 열람 토큰: /open 이 남긴 것이어야 하고, 같은 카메라·같은 사람·만료 전이어야 한다.
    const sess = (sessRes?.results?.[0] as ViewSessionRow | undefined) ?? null;
    const nowIso = c.get('now').toISOString();
    const actor = c.get('principal').email;
    if (sess === null || sess.camera_id !== id || sess.actor_email !== actor || sess.expires_at <= nowIso) { // MUTATION:CCTV-VIEW-SESSION
      throw new ApiError(409, 'view_not_opened', 'Open the camera first');
    }

    console.log(
      JSON.stringify({
        event: 'cctv_stream',
        request_id: c.get('requestId'),
        actor,
        camera_id: id,
        stream_kind: target.kind,
      }),
    );
    return proxyStream(target, c.req.header('Range') ?? null, deps);
  });

  return r;
}

function cameraIdParam(v: string): string {
  if (!CAMERA_ID_RE.test(v)) throw new ValidationError('invalid_format', 'camera_id');
  return v;
}
