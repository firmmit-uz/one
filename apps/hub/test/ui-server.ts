// UI 시험용 로컬 서버: public/ 정적 파일(+_headers) + 실제 Hono API(메모리 DB, 개발용 신원)
// 실행: esbuild 로 묶은 뒤 node 로 실행 (test/ui_screens.py 가 자동 처리)
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { createApp } from '../src/app';
import { appendAudit } from '../src/audit';
import { createDb, HUB_DIR, seedUser, setSynced } from './helpers';

const PORT = Number(process.env.PORT ?? 8799);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PUBLIC = join(HUB_DIR, 'public');

const { sqlite, d1 } = createDb();
const now = new Date();
const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();

// 가짜 조직 (example.test 도메인만)
seedUser(sqlite, { email: 'admin1@example.test', name: '김관리', empId: 'FM-001', groups: ['ADMIN'], grants: [{ app_id: 'hub', role: 'ADMIN' }, { app_id: 'ahost', role: 'OPERATOR' }] });
seedUser(sqlite, { email: 'admin2@example.test', name: '이관리', groups: ['ADMIN', 'BREAKGLASS'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
seedUser(sqlite, {
  email: 'staff1@example.test',
  name: 'Aziz Karimov',
  empId: 'UZ-017',
  groups: ['UZ', 'NONGJAJAE'],
  grants: [
    { app_id: 'amim', role: 'MANAGER', scope: 'UZ' },
    { app_id: 'nongjajae', role: 'VIEWER' },
    { app_id: 'icheon-vfarm', role: 'VIEWER', expires_at: iso(-86_400_000) },
    { app_id: 'nongjajae', role: 'ADMIN' },
  ],
});
seedUser(sqlite, { email: 'rnd1@example.test', name: '박연구', groups: ['RND'], grants: [{ app_id: 'icheon-vfarm', role: 'OPERATOR', expires_at: iso(30 * 86_400_000) }] });
seedUser(sqlite, { email: 'left@example.test', name: '퇴사자', status: 'revoked', groups: [] });
setSynced(sqlite, process.env.STALE === '1' ? new Date(now.getTime() - 45 * 60_000) : now);

// WP1 자동 동기화 화면 (AUTOSYNC=1): 마지막 시도가 실패한 상태를 보여준다
const AUTO_SYNC = process.env.AUTOSYNC === '1';
if (AUTO_SYNC) {
  sqlite
    .prepare(
      `INSERT INTO group_sync_state (key, last_attempt_at, last_outcome, last_failure_code, last_failure_at, consecutive_failures, stale_audited_at)
       VALUES ('access_groups', ?, 'failure', 'api_http_403', ?, 2, NULL)`,
    )
    .run(iso(-4 * 60_000), iso(-4 * 60_000));
}

// WP2: 홈 화면 KPI (가짜 값 — 실제 운영 수치 아님)
import { refreshInternalKpis } from '../src/kpi/gateway';
// WP3: 관리 화면 토큰 상태 (가짜 값)
import { createTokenStmts } from '../src/tokens/refresh';

const up = sqlite.prepare(
  'INSERT INTO uptime_state (app_id, state, consecutive_failures, last_checked_at, last_change_at, last_status_code) VALUES (?, ?, ?, ?, ?, ?)',
);
up.run('nongjajae', 'UP', 0, iso(-60_000), iso(-86_400_000), 200);
up.run('icheon-vfarm', 'UP', 0, iso(-60_000), null, 302);
up.run('amim', 'DOWN', 3, iso(-60_000), iso(-900_000), 503);
up.run('quote', 'UP', 1, iso(-60_000), iso(-3 * 86_400_000), 500);
up.run('fino', 'UP', 0, iso(-60_000), null, 200);
up.run('firmmit-mall', 'UP', 0, iso(-60_000), null, 200);

const db = d1 as unknown as D1Database;
await appendAudit(db, { ts: iso(-900_000), actor_email: 'system:cron', action: 'uptime_state_change', target: 'app:amim', detail: { from: 'UP', to: 'DOWN', consecutive_failures: 2, status_code: 503 }, request_id: 'cron-1' });
await appendAudit(db, { ts: iso(-600_000), actor_email: 'admin1@example.test', action: 'grant_create', target: 'grant:1', detail: { email: 'staff1@example.test', app_id: 'amim', role: 'MANAGER', scope: 'UZ', expires_at: null, reason: null }, request_id: 'r-1' });
await appendAudit(db, { ts: iso(-300_000), actor_email: 'admin1@example.test', action: 'user_status_change', target: 'user:left@example.test', detail: { from: 'active', to: 'revoked', reason: '퇴사' }, request_id: 'r-2' });

// R3 CCTV 화면 (가짜 카메라 — 실제 카메라·중계 서버 아님)
const cam = sqlite.prepare(
  'INSERT INTO cctv_cameras (camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
cam.run('cheonan-gate', '천안 정문', '천안', 'mp4', '/live/cheonan-gate.mp4', 'active', 10, now.toISOString(), now.toISOString());
cam.run('icheon-vfarm', '이천 재배동', '이천', 'snapshot', '/snapshot/icheon.jpg', 'active', 20, now.toISOString(), now.toISOString());
cam.run('nonsan-apc', '논산 APC', '논산', 'mp4', null, 'not_connected', 30, now.toISOString(), now.toISOString());

// 화면 확인용 설정. CCTV=off 로 두면 "꺼짐" 안내 화면을 찍을 수 있다.
const CCTV_ON = process.env.CCTV !== 'off';

// 가짜 중계 서버. **실제 네트워크로 나가지 않는다** — 고정 그림 1장만 돌려준다.
// (화면 시험은 외부 요청 0건이어야 한다. 실제 fetch 를 쓰면 relay.example.test 로 나간다.)
const TEST_PATTERN = readFileSync(join(HUB_DIR, 'test', 'fixtures', 'cctv-test-pattern.jpg'));
const fakeRelay = async (url: string): Promise<Response> => {
  const path = new URL(url).pathname;
  if (path.startsWith('/snapshot/')) {
    return new Response(new Uint8Array(TEST_PATTERN), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  // 영상(mp4)은 만들어 두지 않았다 — 화면 시험에서는 사진 카메라만 연다.
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
};

const app = createApp({ fetch: fakeRelay });
const IDENTITIES: Record<string, string> = { admin: 'admin1@example.test', staff: 'staff1@example.test', stranger: 'nobody@example.test' };

function staticHeaders(): Record<string, string> {
  const lines = readFileSync(join(PUBLIC, '_headers'), 'utf8').split('\n');
  const out: Record<string, string> = {};
  const start = lines.findIndex((l) => l.trim() === '/*');
  for (const l of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(l)) break;
    const i = l.indexOf(':');
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}
const HEADERS = staticHeaders();
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// WP3 자동 갱신 화면(AUTOSYNC=1)에서만 가짜 토큰 1건을 보여준다 (암호문은 시험용 더미)
if (AUTO_SYNC) {
  for (const st of createTokenStmts(
    d1 as unknown as D1Database,
    {
      token_id: 'cafe24:main',
      provider: 'cafe24',
      account_ref: 'mall:<MALL_ID>',
      ciphertext: new Uint8Array([1, 2, 3, 4]),
      iv: new Uint8Array(12),
      key_version: 1,
      expires_at: iso(36 * 60 * 60_000),
    },
    now.toISOString(),
  )) {
    await st.run();
  }
  sqlite
    .prepare(
      "INSERT INTO token_refresh_journal (token_id, holder, started_at, finished_at, outcome, detail_json, lease_until) VALUES ('cafe24:main', 'ui', ?, ?, 'applied', '{}', ?)",
    )
    .run(iso(-3_600_000), iso(-3_599_000), iso(-3_300_000));
}

// 서버가 뜨기 전에 KPI 캐시를 한 번 채운다 (STALE=1 이면 15분을 넘겨 "지연" 으로 보이게 한다)
const kpiAt = process.env.STALE === '1' ? new Date(now.getTime() - 45 * 60_000) : now;
await refreshInternalKpis(d1 as unknown as D1Database, 'production', { now: () => kpiAt, requestId: 'ui-server' });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    const as = String(req.headers['x-test-as'] ?? 'admin');
    const fail = String(req.headers['x-test-fail'] ?? '');
    if (fail && url.pathname === `/api/${fail}`) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal error' } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
    const env = {
      DB: db,
      ENVIRONMENT: 'development',
      ACCESS_TEAM: 'x',
      ACCESS_AUD: 'x',
      ALLOWED_ORIGIN: ORIGIN,
      DEV_FAKE_IDENTITY: IDENTITIES[as] ?? as,
      // 시험용 값 (실제 계정 정보 아님). 자동 동기화 화면 확인에만 쓰이고 외부 호출은 하지 않는다.
      ...(AUTO_SYNC ? { CF_ACCOUNT_ID: 'acct-test-0001', CF_API_TOKEN: 'test-token_0123456789' } : {}),
      // 시험용 값. 실제 중계 서버가 아니며 화면 시험은 영상을 재생하지 않는다.
      ...(CCTV_ON ? { CCTV_ENABLED: 'true', CCTV_RELAY_ORIGIN: 'https://relay.example.test' } : {}),
    };
    const r = await app.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => (h[k] = v));
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (p === '' || p.includes('..')) p = 'index.html';
  let file = join(PUBLIC, p);
  if (!existsSync(file) || statSync(file).isDirectory() || p === '_headers') file = join(PUBLIC, 'index.html'); // SPA 대체
  res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`ui-server ready ${ORIGIN}`));
