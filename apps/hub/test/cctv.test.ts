// R3 CCTV: 실제 카메라·중계 서버에 붙지 않는다 — 전부 가짜 fetch 와 메모리 DB.
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import {
  ALLOWED_UPSTREAM_TYPES,
  isSafeStreamPath,
  isEnabled,
  playTarget,
  relayAuth,
  relayOrigin,
  toView,
  type CameraRow,
} from '../src/cctv';
import type { Env } from '../src/env';
import { ADMIN, createDb, json, makeEnv, NOW, seedOrg, STAFF, count, type CallInit } from './helpers';
import { createLocalJWKSet, type JWK } from 'jose';
import { makeKeys, signToken } from './helpers';

const RELAY = 'https://relay.example.test';
const ORIGIN = 'https://hub.example.test';

interface Upstream {
  status?: number;
  type?: string;
  body?: string | ReadableStream;
  headers?: Record<string, string>;
  throws?: boolean;
}

/** 가짜 중계 서버가 달린 시험 도구 (외부 네트워크 호출 0건) */
async function cctvHarness(envOverrides: Partial<Env> = {}, upstream: Upstream = {}) {
  const { sqlite, d1 } = createDb();
  const keys = await makeKeys();
  const clock = { now: NOW };
  const calls: { url: string; init?: RequestInit }[] = [];
  const app = createApp({
    jwks: () => createLocalJWKSet({ keys: [keys.jwk as JWK] }),
    now: () => clock.now,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (upstream.throws) throw new Error('relay down');
      const headers = new Headers(upstream.headers ?? {});
      headers.set('content-type', upstream.type ?? ALLOWED_UPSTREAM_TYPES.mp4);
      const status = upstream.status ?? 200;
      // 204·205·304 는 본문을 가질 수 없다 (가짜 서버도 규격을 지킨다)
      const body = [204, 205, 304].includes(status) ? null : (upstream.body ?? 'video-bytes');
      return new Response(body, { status, headers });
    },
  });
  // 인증 방법은 비워 둘 수 없다(fail-closed). 시험 기본은 'none' 을 **명시**한다.
  const env = makeEnv(d1, { CCTV_ENABLED: 'true', CCTV_RELAY_ORIGIN: RELAY, CCTV_RELAY_AUTH: 'none', ...envOverrides });
  seedOrg(sqlite);
  const call = async (path: string, init: CallInit = {}) => {
    const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
    const headers = new Headers(init.headers ?? {});
    if (init.token) headers.set('Cf-Access-Jwt-Assertion', init.token);
    if (method !== 'GET' && method !== 'HEAD') {
      if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
      headers.set('Content-Type', 'application/json');
    }
    const req = new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return app.fetch(req, init.env ?? env, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
  };
  const token = (email: string) => signToken(keys, { email });
  return { sqlite, d1, env, app, calls, call, token, clock };
}

/** /open 을 거쳐 열람 토큰이 붙은 재생 경로를 얻는다. 같은 harness·카메라는 한 번만 연다. */
const openedPaths = new WeakMap<object, Map<string, string>>();
async function playPath(h: { call: (p: string, i?: CallInit) => Promise<Response>; token: (who: typeof ADMIN) => Promise<string> }, id: string, who: typeof ADMIN): Promise<string> {
  let m = openedPaths.get(h);
  if (!m) { m = new Map(); openedPaths.set(h, m); }
  const key = `${id}:${JSON.stringify(who)}`;
  const cached = m.get(key);
  if (cached) return cached;
  const res = await h.call(`/api/cctv/${id}/open`, { token: await h.token(who), body: {} });
  const body = (await json(res)) as { play_path?: unknown };
  const path = typeof body.play_path === 'string' ? body.play_path : `/api/cctv/${id}/play`;
  m.set(key, path);
  return path;
}

function addCamera(sqlite: DatabaseSync, cam: Partial<CameraRow> & { camera_id: string }): void {
  const path = cam.stream_path === undefined ? '/live/cam1.mp4' : cam.stream_path;
  sqlite
    .prepare(
      'INSERT INTO cctv_cameras (camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      cam.camera_id,
      cam.name_ko ?? '1번 카메라',
      cam.site ?? '천안',
      cam.stream_kind ?? 'mp4',
      path,
      cam.status ?? (path === null ? 'not_connected' : 'active'),
      cam.sort ?? 0,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    );
}

const envOf = (o: Partial<Env>) => o as Env;

describe('CCTV 설정 확인 (fail-closed)', () => {
  it('기본은 꺼짐 — "true" 가 아니면 모두 꺼짐', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true']) {
      expect(isEnabled(envOf({ CCTV_ENABLED: v }))).toBe(false);
    }
    expect(isEnabled(envOf({ CCTV_ENABLED: 'true' }))).toBe(true);
  });

  it('중계 서버 주소: https 만, 자리표시자·계정·경로·질의는 거부', () => {
    expect(relayOrigin(envOf({ CCTV_RELAY_ORIGIN: RELAY }))).toBe(RELAY);
    expect(relayOrigin(envOf({ CCTV_RELAY_ORIGIN: `${RELAY}/` }))).toBe(RELAY);
    // 앞뒤 공백·줄바꿈은 잘라내고 받는다 (설정값에 잘 붙는 실수)
    expect(relayOrigin(envOf({ CCTV_RELAY_ORIGIN: ` ${RELAY}\n` }))).toBe(RELAY);
    for (const bad of [
      undefined,
      '',
      '   ',
      '<CCTV_RELAY_ORIGIN>', // 자리표시자 그대로 두면 꺼짐
      'http://relay.example.test', // 평문
      'https://user:pw@relay.example.test', // 계정 포함
      'https://relay.example.test/live', // 경로 포함
      'https://relay.example.test/?a=1',
      'https://relay.example.test/#x',
      'relay.example.test',
      'ftp://relay.example.test',
      'https://relay.example.test\u0001',
      'javascript:alert(1)',
    ]) {
      expect(relayOrigin(envOf({ CCTV_RELAY_ORIGIN: bad }))).toBeNull();
    }
  });

  it('중계 서버에 밝히는 방법: 비어 있으면 실패(익명으로 부르지 않는다), 모르는 값도 실패', () => {
    // 'none' 도 고른 것이어야 한다. 설정을 반만 해 둔 상태로 인증 없는 중계 서버를 부르면 안 된다.
    expect(relayAuth(envOf({})).ok).toBe(false);
    expect(relayAuth(envOf({ CCTV_RELAY_AUTH: '' })).ok).toBe(false);
    expect(relayAuth(envOf({ CCTV_RELAY_AUTH: '  ' })).ok).toBe(false);
    expect(relayAuth(envOf({ CCTV_RELAY_AUTH: 'none' }))).toEqual({ ok: true, headers: [] });
    expect(relayAuth(envOf({ CCTV_RELAY_AUTH: ' none ' }))).toEqual({ ok: true, headers: [] });
    for (const bad of ['bearer', 'BASIC', 'digest', 'cf_access', 'x', '<CCTV_RELAY_AUTH>']) {
      expect(relayAuth(envOf({ CCTV_RELAY_AUTH: bad })).ok).toBe(false);
    }
  });

  it('중계 서버 요청: 자동 따라가기 없이 no-cache 로 부른다', async () => {
    // redirect:'error' 는 workerd 가 거부한다(TypeError) → 실제 Worker 에서 재생이 전부 막힌다.
    // 가장자리 캐시에 걸리면 멈춘 사진이 실시간처럼 보인다.
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await h.call(await playPath(h, 'cam-1', ADMIN), { token: await h.token(ADMIN) });
    spy.mockRestore();
    expect(h.calls[0]!.init?.redirect).toBe('manual');
    expect((h.calls[0]!.init as { cf?: { cacheEverything?: boolean } }).cf?.cacheEverything).toBe(false);
    expect(new Headers(h.calls[0]!.init?.headers as HeadersInit).get('Cache-Control')).toBe('no-cache');
  });

  it('basic: 아이디·비밀번호가 있어야 하고, 없으면 실패(그냥 부르지 않는다)', () => {
    const ok = relayAuth(envOf({ CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'firmmit', CCTV_RELAY_PASS: 'pw-123' }));
    expect(ok).toEqual({ ok: true, headers: [['Authorization', `Basic ${btoa('firmmit:pw-123')}`]] });
    const bad: Partial<Env>[] = [
      { CCTV_RELAY_AUTH: 'basic' },
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'firmmit' },
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_PASS: 'pw-123' },
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'a:b', CCTV_RELAY_PASS: 'pw' }, // ':' 는 구분이 안 된다
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'firmmit', CCTV_RELAY_PASS: '' },
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: '한글', CCTV_RELAY_PASS: 'pw' }, // ASCII 만
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'a b', CCTV_RELAY_PASS: 'pw' },
      { CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'firmmit', CCTV_RELAY_PASS: 'a'.repeat(257) },
    ];
    for (const e of bad) expect(relayAuth(envOf(e)).ok).toBe(false);
  });

  it('cf-access: Cloudflare 서비스 토큰 머리말 2개', () => {
    const ok = relayAuth(envOf({ CCTV_RELAY_AUTH: 'cf-access', CCTV_RELAY_CF_ID: 'abc.access', CCTV_RELAY_CF_SECRET: 'cfast_secret1234' }));
    expect(ok).toEqual({
      ok: true,
      headers: [
        ['CF-Access-Client-Id', 'abc.access'],
        ['CF-Access-Client-Secret', 'cfast_secret1234'],
      ],
    });
    for (const e of [
      { CCTV_RELAY_AUTH: 'cf-access' },
      { CCTV_RELAY_AUTH: 'cf-access', CCTV_RELAY_CF_ID: 'abc.access' },
      { CCTV_RELAY_AUTH: 'cf-access', CCTV_RELAY_CF_SECRET: 'cfast_x' },
      { CCTV_RELAY_AUTH: 'cf-access', CCTV_RELAY_CF_ID: 'abc.access', CCTV_RELAY_CF_SECRET: '' },
    ] as Partial<Env>[]) {
      expect(relayAuth(envOf(e)).ok).toBe(false);
    }
  });

  it('중계 서버 경로: 다른 서버로 새는 주소·상위 경로·역슬래시 거부', () => {
    for (const ok of ['/live/cam1.mp4', '/snapshot.jpg?cam=1', '/a', `/${'x'.repeat(199)}`]) {
      expect(isSafeStreamPath(ok)).toBe(true);
    }
    for (const bad of [
      null,
      undefined,
      123,
      '',
      'live/cam1.mp4', // '/' 로 시작하지 않음
      '//evil.example/live.mp4', // 다른 서버
      '/../secret', // 상위 경로
      '/live/../../etc/passwd',
      '/live\\cam1.mp4', // 역슬래시
      '/live\ncam',
      'https://evil.example/live.mp4',
      `/${'x'.repeat(200)}`, // 길이 초과
      // 아래 셋은 서로 다른 방어가 하나씩 맡는다 (한 방어를 꺼도 다른 것이 잡는 '이중 방어' 아님)
      '/live/..%2fsecret', // 글자 '..' 검사만 잡는다 (되감기는 통과한다)
      '/live/%2e%2e/secret', // 되감기 검사만 잡는다 (글자 '..' 가 없다)
      '/a#b', // 되감기 검사만 잡는다 (조각 '#' 는 중계 서버로 가지 않는다)
    ]) {
      expect(isSafeStreamPath(bad)).toBe(false);
    }
  });
});

describe('문서에 적은 실제 값이 그대로 통과하는가 (README 4.3 · go2rtc 보기)', () => {
  // 문서와 코드가 어긋나면 현장에서 "왜 안 되지" 로 시간을 잃는다.
  // AKIS 온실(Yuqori Chirchiq) 기준 값을 여기서 고정한다.
  const AKIS = [
    { camera_id: 'akis-gh1', stream_kind: 'mp4' as const, stream_path: '/api/stream.mp4?src=akis-gh1' },
    { camera_id: 'akis-gh2', stream_kind: 'snapshot' as const, stream_path: '/api/frame.jpeg?src=akis-gh2' },
    { camera_id: 'akis-gate', stream_kind: 'mp4' as const, stream_path: '/api/stream.mp4?src=akis-gate' },
  ];

  it('go2rtc 가 내보내는 경로가 경로 검사를 통과한다', () => {
    for (const c of AKIS) expect(isSafeStreamPath(c.stream_path)).toBe(true);
  });

  it('카메라 등록 API 가 그 값을 그대로 받는다', async () => {
    const h = await cctvHarness();
    const t = await h.token(ADMIN);
    for (const c of AKIS) {
      const res = await h.call('/api/admin/cctv', {
        token: t,
        body: { ...c, name_ko: 'AKIS 온실', site: '타슈켄트 AKIS' },
      });
      expect([200, 201]).toContain(res.status);
      expect((await json(res)).camera).toMatchObject({ camera_id: c.camera_id, status: 'active', playable: true });
    }
  });

  it('합쳐진 주소가 중계 서버 안을 벗어나지 않는다', async () => {
    const h = await cctvHarness();
    for (const c of AKIS) addCamera(h.sqlite, c);
    const t = await h.token(ADMIN);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const c of AKIS) await h.call(await playPath(h, c.camera_id, ADMIN), { token: t });
    spy.mockRestore();
    for (const call of h.calls) expect(new URL(call.url).origin).toBe(RELAY);
    expect(h.calls.map((c) => c.url)).toEqual(AKIS.map((c) => `${RELAY}${c.stream_path}`));
  });
});

describe('CCTV 재생 판정 — 한 군데에서만 한다', () => {
  const row = (o: Partial<CameraRow> = {}): CameraRow => ({
    camera_id: 'cam-1',
    name_ko: '1번',
    site: '천안',
    stream_kind: 'mp4',
    stream_path: '/live/cam1.mp4',
    status: 'active',
    sort: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...o,
  });
  const env = envOf({ CCTV_ENABLED: 'true', CCTV_RELAY_ORIGIN: RELAY, CCTV_RELAY_AUTH: 'none' });

  it('정상이면 중계 서버 주소 + 경로를 합쳐 준다', () => {
    expect(playTarget(env, row())).toEqual({ ok: true, url: `${RELAY}/live/cam1.mp4`, kind: 'mp4', authHeaders: [] });
  });

  it('꺼짐·주소 없음·미연결·알 수 없는 방식은 모두 거부', () => {
    expect(playTarget(envOf({ CCTV_RELAY_ORIGIN: RELAY }), row())).toEqual({ ok: false, code: 'cctv_disabled' });
    expect(playTarget(envOf({ CCTV_ENABLED: 'true', CCTV_RELAY_AUTH: 'none' }), row())).toEqual({ ok: false, code: 'relay_not_configured' });
    expect(playTarget(env, row({ status: 'not_connected', stream_path: null }))).toEqual({ ok: false, code: 'not_connected' });
    expect(playTarget(env, row({ stream_kind: 'hls' }))).toEqual({ ok: false, code: 'unsupported_stream' });
    expect(playTarget(env, row({ stream_kind: 'rtsp' }))).toEqual({ ok: false, code: 'unsupported_stream' });
    expect(playTarget(env, row({ stream_path: '//evil.example/x.mp4' }))).toEqual({ ok: false, code: 'unsupported_stream' });
    // 밝히는 방법을 정해 놓고 값이 없으면 **부르지 않는다** (조용히 익명으로 부르지 않는다)
    expect(playTarget(envOf({ ...env, CCTV_RELAY_AUTH: 'basic' }), row())).toEqual({ ok: false, code: 'relay_auth_misconfigured' });
    expect(playTarget(envOf({ ...env, CCTV_RELAY_AUTH: 'bearer' }), row())).toEqual({ ok: false, code: 'relay_auth_misconfigured' });
  });

  it('화면용 값에는 경로·중계 서버 주소가 들어가지 않는다', () => {
    const v = toView(row(), true);
    expect(JSON.stringify(v)).not.toContain('/live/cam1.mp4');
    expect(JSON.stringify(v)).not.toContain('relay.example.test');
    expect(v).toEqual({ camera_id: 'cam-1', name_ko: '1번', site: '천안', stream_kind: 'mp4', status: 'active', playable: true });
  });

  it('중계 서버가 준비되지 않았거나 값이 이상하면 볼 수 없음으로 내린다', () => {
    expect(toView(row(), false).playable).toBe(false);
    expect(toView(row({ stream_kind: 'rtsp' }), true).playable).toBe(false);
    expect(toView(row({ stream_kind: 'rtsp' }), true).stream_kind).toBeNull();
    expect(toView(row({ stream_path: '//evil.example/x' }), true).playable).toBe(false);
    expect(toView(row({ status: 'weird' }), true).status).toBe('not_connected');
  });
});

describe('CCTV API 권한', () => {
  it('ADMIN 아닌 직원은 목록·열람·영상 모두 403', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const t = await h.token(STAFF);
    expect((await h.call('/api/cctv', { token: t })).status).toBe(403);
    expect((await h.call('/api/cctv/cam-1/open', { token: t, body: {} })).status).toBe(403);
    expect((await h.call('/api/cctv/cam-1/play', { token: t })).status).toBe(403);
    expect(h.calls.length).toBe(0); // 중계 서버를 부르지도 않는다
  });

  it('로그인하지 않으면 401', async () => {
    const h = await cctvHarness();
    expect((await h.call('/api/cctv')).status).toBe(401);
  });

  it('카메라 이름이 규칙에 안 맞으면 400 (경로 조작 차단)', async () => {
    const h = await cctvHarness();
    const t = await h.token(ADMIN);
    for (const bad of ['Cam-1', 'cam_1', 'c', '..', 'cam%2F1']) {
      const res = await h.call(`/api/cctv/${bad}/play`, { token: t });
      expect([400, 404]).toContain(res.status);
    }
    expect(h.calls.length).toBe(0);
  });
});

describe('CCTV 목록', () => {
  it('꺼져 있으면 볼 수 있는 카메라가 없다', async () => {
    const h = await cctvHarness({ CCTV_ENABLED: 'false' });
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const body = await json(await h.call('/api/cctv', { token: await h.token(ADMIN) }));
    expect(body.enabled).toBe(false);
    expect(body.relay_configured).toBe(false);
    expect(body.cameras[0].playable).toBe(false);
  });

  it('중계 서버 주소가 자리표시자면 볼 수 없음', async () => {
    const h = await cctvHarness({ CCTV_RELAY_ORIGIN: '<CCTV_RELAY_ORIGIN>' });
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const body = await json(await h.call('/api/cctv', { token: await h.token(ADMIN) }));
    expect(body.relay_configured).toBe(false);
    expect(body.cameras[0].playable).toBe(false);
  });

  it('정상 설정이면 볼 수 있음 + 응답에 경로·주소·접속표가 없다', async () => {
    const h = await cctvHarness({ CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'firmmit', CCTV_RELAY_PASS: 'secret-token-value-123' });
    addCamera(h.sqlite, { camera_id: 'cam-1', sort: 2 });
    addCamera(h.sqlite, { camera_id: 'cam-2', sort: 1, stream_kind: 'snapshot', stream_path: '/snap.jpg' });
    const res = await h.call('/api/cctv', { token: await h.token(ADMIN) });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('relay.example.test');
    expect(text).not.toContain('secret-token-value-123');
    expect(text).not.toContain('/live/cam1.mp4');
    const body = JSON.parse(text);
    expect(body.cameras.map((c: { camera_id: string }) => c.camera_id)).toEqual(['cam-2', 'cam-1']); // sort 순
    expect(body.cameras.every((c: { playable: boolean }) => c.playable)).toBe(true);
  });
});

describe('CCTV 열람 기록', () => {
  it('열람을 시작하면 감사기록 1건이 남는다 (경로는 기록하지 않는다)', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const before = count(h.sqlite, 'SELECT COUNT(*) FROM audit_log');
    const res = await h.call('/api/cctv/cam-1/open', { token: await h.token(ADMIN), body: {} });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ camera_id: 'cam-1', stream_kind: 'mp4', play_path: expect.stringMatching(/^\/api\/cctv\/cam-1\/play\?s=[0-9a-f-]{36}$/) });
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(before + 1);
    const row = h.sqlite.prepare("SELECT action, target, detail_json FROM audit_log WHERE action = 'cctv_view_open'").get() as {
      action: string;
      target: string;
      detail_json: string;
    };
    expect(row.target).toBe('camera:cam-1');
    expect(row.detail_json).not.toContain('/live/cam1.mp4');
    expect(row.detail_json).not.toContain('relay.example.test');
  });

  it('미연결 카메라는 열람 기록도 남기지 않고 거부', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1', stream_path: null, status: 'not_connected' });
    const before = count(h.sqlite, 'SELECT COUNT(*) FROM audit_log');
    const res = await h.call('/api/cctv/cam-1/open', { token: await h.token(ADMIN), body: {} });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('not_connected');
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(before);
  });

  it('열람 본문은 사유만 받는다 (모르는 필드 거부)', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const t = await h.token(ADMIN);
    expect((await h.call('/api/cctv/cam-1/open', { token: t, body: { camera_id: 'other' } })).status).toBe(400);
    expect((await h.call('/api/cctv/cam-1/open', { token: t, body: { stream_path: '/x' } })).status).toBe(400);
    const ok = await h.call('/api/cctv/cam-1/open', { token: t, body: { reason: '정문 확인' } });
    expect(ok.status).toBe(200);
    const row = h.sqlite.prepare("SELECT detail_json FROM audit_log WHERE action = 'cctv_view_open'").get() as { detail_json: string };
    expect(row.detail_json).toContain('정문 확인');
  });

  it('없는 카메라는 404', async () => {
    const h = await cctvHarness();
    const res = await h.call('/api/cctv/cam-9/open', { token: await h.token(ADMIN), body: {} });
    expect(res.status).toBe(404);
  });

  it('영상 조각마다 감사기록을 남기지 않는다 (체인이 넘치지 않게)', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const t = await h.token(ADMIN);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // 열람 시작(/open)은 1건 남기지만, 그 뒤 조각 요청은 아무것도 남기지 않는다
    const path = await playPath(h, 'cam-1', ADMIN);
    const before = count(h.sqlite, 'SELECT COUNT(*) FROM audit_log');
    for (let i = 0; i < 3; i++) await h.call(path, { token: t });
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(before);
    // 대신 구조화 로그는 남는다
    expect(spy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('cctv_stream')).length).toBe(3);
    spy.mockRestore();
  });
});

describe('CCTV 영상 전달 (프록시)', () => {
  async function play(envOverrides: Partial<Env> = {}, upstream: Upstream = {}, cam: Partial<CameraRow> = {}) {
    const h = await cctvHarness(envOverrides, upstream);
    addCamera(h.sqlite, { camera_id: 'cam-1', ...cam });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await h.call(await playPath(h, 'cam-1', ADMIN), { token: await h.token(ADMIN), headers: { Range: 'bytes=0-99' } });
    spy.mockRestore();
    return { h, res };
  }

  it('정상: 중계 서버 응답을 같은 출처로 내보낸다', async () => {
    const { h, res } = await play();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('video-bytes');
    expect(h.calls[0]!.url).toBe(`${RELAY}/live/cam1.mp4`);
  });

  it('브라우저 머리말은 Range 만 넘기고 Access 표·쿠키는 넘기지 않는다', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await h.call(await playPath(h, 'cam-1', ADMIN), { token: await h.token(ADMIN),
      headers: { Range: 'bytes=0-99', Cookie: 'CF_Authorization=secret-cookie', 'X-Custom': 'x' },
    });
    spy.mockRestore();
    const sent = new Headers(h.calls[0]!.init?.headers as HeadersInit);
    expect(sent.get('Range')).toBe('bytes=0-99');
    expect(sent.get('Cookie')).toBeNull();
    expect(sent.get('Cf-Access-Jwt-Assertion')).toBeNull();
    expect(sent.get('X-Custom')).toBeNull();
  });

  it('이상한 Range 는 넘기지 않는다', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await h.call(await playPath(h, 'cam-1', ADMIN), { token: await h.token(ADMIN), headers: { Range: 'items=0-1' } });
    spy.mockRestore();
    expect(new Headers(h.calls[0]!.init?.headers as HeadersInit).get('Range')).toBeNull();
  });

  it('basic 접속표는 중계 서버에만 보낸다 (응답에는 없다)', async () => {
    const { h, res } = await play({ CCTV_RELAY_AUTH: 'basic', CCTV_RELAY_USER: 'firmmit', CCTV_RELAY_PASS: 'pw-secret-123' });
    const sent = new Headers(h.calls[0]!.init?.headers as HeadersInit);
    expect(sent.get('Authorization')).toBe(`Basic ${btoa('firmmit:pw-secret-123')}`);
    let dump = '';
    res.headers.forEach((v, k) => (dump += `${k}:${v};`));
    expect(dump).not.toContain('pw-secret-123');
    expect(dump).not.toContain(btoa('firmmit:pw-secret-123'));
  });

  it('cf-access 접속표는 머리말 2개로 보낸다', async () => {
    const { h } = await play({ CCTV_RELAY_AUTH: 'cf-access', CCTV_RELAY_CF_ID: 'abc.access', CCTV_RELAY_CF_SECRET: 'cfast_secret1234' });
    const sent = new Headers(h.calls[0]!.init?.headers as HeadersInit);
    expect(sent.get('CF-Access-Client-Id')).toBe('abc.access');
    expect(sent.get('CF-Access-Client-Secret')).toBe('cfast_secret1234');
  });

  it('밝히는 방법이 잘못 설정되면 중계 서버를 부르지 않는다', async () => {
    const { h, res } = await play({ CCTV_RELAY_AUTH: 'basic' }); // 아이디·비밀번호 없음
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('relay_auth_misconfigured');
    expect(h.calls.length).toBe(0);
  });

  it('형식이 다르면 거부한다 (허브 출처로 HTML·JS 가 들어오지 못하게)', async () => {
    for (const type of ['text/html', 'application/javascript', 'image/svg+xml', 'text/plain', '']) {
      const { res } = await play({}, { type });
      expect(res.status).toBe(502);
      expect((await json(res)).error.code).toBe('relay_bad_content_type');
    }
  });

  it('사진 방식에 영상 형식이 오면 거부', async () => {
    const { res } = await play({}, { type: 'video/mp4' }, { stream_kind: 'snapshot', stream_path: '/snap.jpg' });
    expect(res.status).toBe(502);
  });

  it('사진 방식에 JPEG 가 오면 통과', async () => {
    const { res } = await play({}, { type: 'image/jpeg' }, { stream_kind: 'snapshot', stream_path: '/snap.jpg' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('중계 서버가 200·206 외 응답이면 502', async () => {
    for (const status of [204, 301, 302, 401, 403, 404, 500]) {
      const { res } = await play({}, { status });
      expect(res.status).toBe(502);
      expect((await json(res)).error.code).toBe('relay_error');
    }
  });

  it('206(구간 응답)은 그대로 넘긴다', async () => {
    const { res } = await play({}, { status: 206, headers: { 'content-range': 'bytes 0-99/1000' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
  });

  it('중계 서버가 죽어 있으면 502 (내부 정보 없음)', async () => {
    const { res } = await play({}, { throws: true });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe('relay_unreachable');
    expect(JSON.stringify(body)).not.toContain('relay.example.test');
  });

  it('중계 서버가 보낸 예상 밖 머리말은 버린다', async () => {
    const { res } = await play({}, { headers: { 'set-cookie': 'a=b', 'x-leak': 'secret', 'access-control-allow-origin': '*' } });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-leak')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('꺼져 있으면 중계 서버를 부르지 않는다', async () => {
    const { h, res } = await play({ CCTV_ENABLED: 'false' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('cctv_disabled');
    expect(h.calls.length).toBe(0);
  });
});

describe('CCTV 카메라 등록 (관리)', () => {
  it('ADMIN 이 등록하면 감사기록과 한 batch 로 저장된다', async () => {
    const h = await cctvHarness();
    const before = count(h.sqlite, 'SELECT COUNT(*) FROM audit_log');
    const res = await h.call('/api/admin/cctv', {
      token: await h.token(ADMIN),
      body: { camera_id: 'cam-1', name_ko: '천안 1번', site: '천안', stream_kind: 'mp4', stream_path: '/live/cam1.mp4' },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).camera).toMatchObject({ camera_id: 'cam-1', status: 'active', playable: true });
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM cctv_cameras')).toBe(1);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(before + 1);
    const row = h.sqlite.prepare("SELECT detail_json FROM audit_log WHERE action = 'cctv_camera_create'").get() as { detail_json: string };
    expect(row.detail_json).not.toContain('/live/cam1.mp4'); // 경로는 기록하지 않는다
    expect(row.detail_json).toContain('path_changed');
  });

  it('경로를 null 로 주면 미연결로 저장된다', async () => {
    const h = await cctvHarness();
    const res = await h.call('/api/admin/cctv', {
      token: await h.token(ADMIN),
      body: { camera_id: 'cam-1', name_ko: '천안 1번', site: '천안', stream_kind: 'mp4', stream_path: null },
    });
    expect((await json(res)).camera).toMatchObject({ status: 'not_connected', playable: false });
  });

  it('위험한 경로·모르는 방식·모르는 필드는 거부', async () => {
    const h = await cctvHarness();
    const t = await h.token(ADMIN);
    const base = { camera_id: 'cam-1', name_ko: '천안 1번', site: '천안', stream_kind: 'mp4', stream_path: '/live/cam1.mp4' };
    const bad = [
      { ...base, stream_path: '//evil.example/x.mp4' },
      { ...base, stream_path: 'https://evil.example/x.mp4' },
      { ...base, stream_path: '/../secret' },
      { ...base, stream_path: 'live/x.mp4' },
      { ...base, stream_kind: 'hls' },
      { ...base, stream_kind: 'rtsp' },
      { ...base, camera_id: 'Cam-1' },
      { ...base, status: 'active' }, // 상태는 받지 않는다
      { ...base, relay_origin: 'https://evil.example' }, // 주소를 관리자가 정할 수 없다
      { ...base, sort: -1 },
      { ...base, sort: 1.5 },
    ];
    for (const body of bad) {
      const res = await h.call('/api/admin/cctv', { token: t, body });
      expect(res.status).toBe(400);
    }
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM cctv_cameras')).toBe(0);
  });

  it('ADMIN 이 아니면 등록할 수 없다', async () => {
    const h = await cctvHarness();
    const res = await h.call('/api/admin/cctv', {
      token: await h.token(STAFF),
      body: { camera_id: 'cam-1', name_ko: 'x', site: '천안', stream_kind: 'mp4', stream_path: '/a.mp4' },
    });
    expect(res.status).toBe(403);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM cctv_cameras')).toBe(0);
  });

  it('Origin 이 다르면 등록이 막힌다 (CSRF)', async () => {
    const h = await cctvHarness();
    const res = await h.call('/api/admin/cctv', {
      token: await h.token(ADMIN),
      origin: 'https://evil.example',
      body: { camera_id: 'cam-1', name_ko: 'x', site: '천안', stream_kind: 'mp4', stream_path: '/a.mp4' },
    });
    expect(res.status).toBe(403);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM cctv_cameras')).toBe(0);
  });

  it('다시 등록하면 덮어쓰고 처음 만든 시각은 유지된다', async () => {
    const h = await cctvHarness();
    const t = await h.token(ADMIN);
    const body = { camera_id: 'cam-1', name_ko: '천안 1번', site: '천안', stream_kind: 'mp4' as const, stream_path: '/live/cam1.mp4' };
    await h.call('/api/admin/cctv', { token: t, body });
    h.clock.now = new Date(NOW.getTime() + 60_000);
    const res = await h.call('/api/admin/cctv', { token: t, body: { ...body, name_ko: '천안 정문' } });
    expect(res.status).toBe(200);
    const row = h.sqlite.prepare('SELECT name_ko, created_at, updated_at FROM cctv_cameras WHERE camera_id = ?').get('cam-1') as {
      name_ko: string;
      created_at: string;
      updated_at: string;
    };
    expect(row.name_ko).toBe('천안 정문');
    expect(row.created_at).toBe(NOW.toISOString());
    expect(row.updated_at).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM cctv_cameras')).toBe(1);
  });
});

describe('CCTV 표 제약 (D1 쪽 방어)', () => {
  it('미연결인데 경로가 있거나, 연결인데 경로가 없으면 저장되지 않는다', async () => {
    const h = await cctvHarness();
    expect(() => addCamera(h.sqlite, { camera_id: 'cam-1', status: 'not_connected', stream_path: '/a.mp4' })).toThrow();
    expect(() => addCamera(h.sqlite, { camera_id: 'cam-2', status: 'active', stream_path: null })).toThrow();
  });

  it('모르는 재생 방식·이상한 경로는 표에 들어가지 않는다', async () => {
    const h = await cctvHarness();
    expect(() => addCamera(h.sqlite, { camera_id: 'cam-1', stream_kind: 'rtsp' })).toThrow();
    expect(() => addCamera(h.sqlite, { camera_id: 'cam-2', stream_path: '//evil.example/x' })).toThrow();
    expect(() => addCamera(h.sqlite, { camera_id: 'cam-3', stream_path: '/../x' })).toThrow();
    expect(() => addCamera(h.sqlite, { camera_id: 'CAM-4' })).toThrow();
  });
});

describe('경로 검사 — 역슬래시는 되감기 검사 하나로 잡는다', () => {
  it("경로 부분의 '\\' 는 파서가 '/' 로 바꾸므로 원문과 달라져 거부된다", () => {
    for (const bad of ['/live\\cam.mp4', '/a\\..\\b', '\\live']) expect(isSafeStreamPath(bad)).toBe(false);
  });
  it("질의 부분의 '\\' 는 파서가 손대지 않아 통과한다 — 출처를 벗어나지 않으므로 막을 이유가 없다", () => {
    expect(isSafeStreamPath('/x?y=\\z')).toBe(true);
  });
});

describe('CCTV 열람 세션 · 요청 방식 · Range 규격', () => {
  it('/play 는 /open 없이 열리지 않는다 (감사기록 없는 열람 금지)', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const res = await h.call('/api/cctv/cam-1/play', { token: await h.token(ADMIN) });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('view_not_opened');
    expect(h.calls.length).toBe(0); // 중계 서버를 부르지도 않는다
  });

  it('열람 토큰은 다른 카메라·다른 사람·만료 뒤에는 통하지 않는다', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    addCamera(h.sqlite, { camera_id: 'cam-2' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = await playPath(h, 'cam-1', ADMIN);
    const tok = path.split('s=')[1]!;
    // 다른 카메라에 같은 토큰
    expect((await h.call(`/api/cctv/cam-2/play?s=${tok}`, { token: await h.token(ADMIN) })).status).toBe(409);
    // 정상
    expect((await h.call(path, { token: await h.token(ADMIN) })).status).toBe(200);
    // 만료
    h.sqlite.prepare("UPDATE cctv_view_sessions SET opened_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T00:15:00.000Z'").run();
    expect((await h.call(path, { token: await h.token(ADMIN) })).status).toBe(409);
    spy.mockRestore();
  });

  it('/open 은 열람 토큰과 감사기록을 한 batch 로 남기고, 지난 토큰을 치운다', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    h.sqlite
      .prepare("INSERT INTO cctv_view_sessions (token, camera_id, actor_email, opened_at, expires_at) VALUES (?, 'cam-1', 'old@example.invalid', '2020-01-01T00:00:00.000Z', '2020-01-01T00:15:00.000Z')")
      .run('00000000-0000-4000-8000-000000000000');
    await playPath(h, 'cam-1', ADMIN);
    const rows = h.sqlite.prepare('SELECT token, camera_id, opened_at, expires_at FROM cctv_view_sessions').all() as { token: string; camera_id: string; opened_at: string; expires_at: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.token).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(rows[0]!.expires_at).toBe(new Date(Date.parse(rows[0]!.opened_at) + 15 * 60 * 1000).toISOString());
    const audit = h.sqlite.prepare("SELECT detail_json FROM audit_log WHERE action = 'cctv_view_open'").get() as { detail_json: string };
    expect(audit.detail_json).not.toContain(rows[0]!.token); // 토큰은 감사기록에 넣지 않는다
  });

  it('HEAD /play 는 405 — 읽지 않을 영상 연결을 열지 않는다', async () => {
    const h = await cctvHarness();
    addCamera(h.sqlite, { camera_id: 'cam-1' });
    const path = await playPath(h, 'cam-1', ADMIN);
    const res = await h.call(path, { method: 'HEAD', token: await h.token(ADMIN) });
    expect(res.status).toBe(405);
    expect(h.calls.length).toBe(0);
  });

  it('bytes=- 는 규격 밖이라 넘기지 않고, 한쪽만 있는 구간은 넘긴다', async () => {
    for (const [range, forwarded] of [['bytes=-', null], ['bytes=-500', 'bytes=-500'], ['bytes=100-', 'bytes=100-'], ['bytes=0-99', 'bytes=0-99']] as const) {
      const h = await cctvHarness();
      addCamera(h.sqlite, { camera_id: 'cam-1' });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await h.call(await playPath(h, 'cam-1', ADMIN), { token: await h.token(ADMIN), headers: { Range: range } });
      spy.mockRestore();
      expect(new Headers(h.calls[0]!.init?.headers as HeadersInit).get('Range')).toBe(forwarded);
    }
  });

  it('목록·관리 목록은 인증 설정이 비면 relay_configured=false · playable=false (재생 판정과 같은 기준)', async () => {
    for (const env of [{ CCTV_RELAY_AUTH: '' }, { CCTV_RELAY_AUTH: 'basic' }, { CCTV_RELAY_AUTH: 'cf-access', CCTV_RELAY_CF_ID: 'id' }]) {
      const h = await cctvHarness(env as Partial<Env>);
      addCamera(h.sqlite, { camera_id: 'cam-1' });
      const list = await json(await h.call('/api/cctv', { token: await h.token(ADMIN) }));
      expect(list.relay_configured).toBe(false);
      expect(list.cameras[0].playable).toBe(false);
      const admin = await json(await h.call('/api/admin/cctv', { token: await h.token(ADMIN) }));
      expect(admin.relay_configured).toBe(false);
      expect(admin.cameras[0].playable).toBe(false);
    }
  });
});

describe('CCTV 전달 — 거부할 때 중계 연결을 끊는다', () => {
  it('응답 코드·형식이 어긋나면 업스트림 본문을 취소한다', async () => {
    for (const upstream of [{ status: 500 }, { type: 'text/html' }] as Upstream[]) {
      let cancelled = false;
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      const h = await cctvHarness({}, { ...upstream, body });
      addCamera(h.sqlite, { camera_id: 'cam-1' });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const res = await h.call(await playPath(h, 'cam-1', ADMIN), { token: await h.token(ADMIN) });
      spy.mockRestore();
      expect(res.status).toBe(502);
      expect(cancelled).toBe(true);
    }
  });
});
