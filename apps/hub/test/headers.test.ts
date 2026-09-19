import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SECURITY_HEADERS } from '../src/http';
import { ADMIN, harness, HUB_DIR, json, seedOrg, STAFF } from './helpers';

function expectSecurity(res: Response) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(v);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
}

describe('보안 헤더·캐시', () => {
  it('/api/health: 인증 없이 {ok:true} 만', async () => {
    const h = await harness();
    const res = await h.call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expectSecurity(res);
    expect(res.headers.get('Server')).toBeNull();
  });

  it('성공·401·403·404·400 모두 보안 헤더 + no-store', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const s = await h.token(STAFF);
    const a = await h.token(ADMIN);
    const responses = [
      await h.call('/api/me', { token: s }),
      await h.call('/api/me'),
      await h.call('/api/admin/users', { token: s }),
      await h.call('/api/nope', { token: s }),
      await h.call('/api/admin/audit?limit=x', { token: a }),
      await h.call('/api/admin/users', { token: a, body: {}, origin: 'https://evil.example' }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 403, 404, 400, 403]);
    for (const r of responses) {
      expectSecurity(r);
      expect(r.headers.get('Content-Type')).toMatch(/^application\/json/);
    }
    for (const r of responses.slice(1)) {
      const b = await json(r);
      expect(Object.keys(b)).toEqual(['error']);
      expect(Object.keys(b.error).sort()).toEqual(['code', 'message']);
    }
  });

  it('500 응답에 내부 정보 없음', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const t = await h.token(STAFF);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sqlite.exec('ALTER TABLE app_registry RENAME TO app_registry_x');
    const res = await h.call('/api/apps', { token: t });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('{"error":{"code":"internal_error","message":"Internal error"}}');
    expectSecurity(res);
    // 로그에도 스택·SQL 을 남기지 않음 (오류 이름만)
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/app_registry|at \w+ \(/);
    spy.mockRestore();
  });

  // R3 CCTV 영상은 같은 출처(/api/cctv/:id/play)로만 받는다.
  // CSP 에 media-src 를 따로 두지 않으므로 default-src 'self' 가 적용된다
  // → 같은 출처 영상은 재생되고, 중계 서버 주소를 브라우저에 직접 주면 막힌다.
  // 이 전제가 깨지면(누가 media-src 를 넣거나 default-src 를 넓히면) 여기서 실패해야 한다.
  it('CSP: 영상은 같은 출처만 — media-src 를 따로 두지 않고 default-src 는 self 만', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/media-src/);
    expect(csp).not.toMatch(/default-src [^;]*\*/);
    expect(csp).not.toMatch(/default-src [^;]*https:(?!\/)/);
    const staticCsp = readFileSync(join(HUB_DIR, 'public', '_headers'), 'utf8');
    expect(staticCsp).not.toMatch(/media-src/);
  });

  it('public/_headers 가 같은 보안 헤더를 정적 자산에 적용', () => {
    const text = readFileSync(join(HUB_DIR, 'public', '_headers'), 'utf8');
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === '/*');
    expect(start).toBeGreaterThanOrEqual(0);
    const headers = new Map<string, string>();
    for (const l of lines.slice(start + 1)) {
      if (!/^\s+\S/.test(l)) break;
      const i = l.indexOf(':');
      headers.set(l.slice(0, i).trim(), l.slice(i + 1).trim());
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(headers.get(k)).toBe(v);
  });

  it('wrangler.jsonc: 자산·크론·자리표시자 확인 (실제 ID 없음)', () => {
    const raw = readFileSync(join(HUB_DIR, 'wrangler.jsonc'), 'utf8');
    const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(cfg.name).toBe('fm-one-hub');
    expect(cfg.main).toBe('src/index.ts');
    expect(cfg.compatibility_date).toBe('2026-09-01');
    expect(cfg.assets).toEqual({ directory: './public', run_worker_first: ['/api/*'], not_found_handling: 'single-page-application' });
    expect(cfg.d1_databases[0]).toMatchObject({ binding: 'DB', database_id: '<D1_DATABASE_ID>' });
    // WP1 에서 CF_ACCOUNT_ID(자리표시자)와 */15 Cron 추가, R3 에서 CCTV 변수 2개 추가
    // — 값은 정확 비교를 유지한다 (부분 비교로 완화하지 않는다)
    expect(cfg.vars).toEqual({
      ENVIRONMENT: 'production',
      ACCESS_TEAM: '<TEAM>',
      ACCESS_AUD: '<AUD>',
      ALLOWED_ORIGIN: 'https://<허브 주소>',
      CF_ACCOUNT_ID: '<CF_ACCOUNT_ID>',
      TOKEN_REFRESH_ENABLED: 'false',
      CCTV_ENABLED: 'false',
      CCTV_RELAY_ORIGIN: '<CCTV_RELAY_ORIGIN>',
      CCTV_RELAY_AUTH: 'none',
    });
    expect(cfg.vars.DEV_FAKE_IDENTITY).toBeUndefined();
    // 비밀값(API 토큰)은 설정에 없어야 한다 — Worker Secret 으로만 넣는다
    // (주석에서 이름을 안내하는 것은 허용, 설정 값으로 들어가는 것은 금지)
    expect(cfg.vars.CF_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/CF_API_TOKEN/);
    expect(cfg.triggers.crons).toEqual(['*/5 * * * *', '*/15 * * * *', '0 * * * *']);
    // 암호화 키는 설정에 없어야 한다 (Worker Secret 으로만)
    expect(JSON.stringify(cfg)).not.toMatch(/TOKEN_KEY/);
    // CCTV 접속표도 설정 값으로 들어가면 안 된다 (Worker Secret 으로만)
    for (const k of ['CCTV_RELAY_USER', 'CCTV_RELAY_PASS', 'CCTV_RELAY_CF_ID', 'CCTV_RELAY_CF_SECRET']) {
      expect(cfg.vars[k]).toBeUndefined();
      expect(JSON.stringify(cfg)).not.toMatch(new RegExp(k));
    }
    expect(cfg.observability.enabled).toBe(true);
    expect(cfg.env.development.vars.ENVIRONMENT).toBe('development');
    expect(cfg.env.development.vars.DEV_FAKE_IDENTITY).toMatch(/@example\.invalid$/);
    expect(raw).not.toMatch(/account_id/);
    expect(raw).not.toMatch(/[0-9a-f]{32}/);
  });

  it('SPA: iframe 없음, 외부 스크립트·스타일 없음, innerHTML 미사용', () => {
    const html = readFileSync(join(HUB_DIR, 'public', 'index.html'), 'utf8');
    const js = readFileSync(join(HUB_DIR, 'public', 'app.js'), 'utf8');
    expect(html).not.toMatch(/<iframe/i);
    expect(js).not.toMatch(/iframe/i);
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
    expect(html).not.toMatch(/style="/);
    expect(html).not.toMatch(/<script>(?!<)/);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(js).toContain('noopener noreferrer');
    expect(html).toContain('href="/cdn-cgi/access/logout"');
  });
});

describe('로컬 개발 시드', () => {
  it('scripts/dev-seed.sql 이 마이그레이션 뒤 적용되고, 개발 신원이 허브 ADMIN 이 됨', async () => {
    const h = await harness();
    h.sqlite.exec(readFileSync(join(HUB_DIR, 'scripts', 'dev-seed.sql'), 'utf8'));
    const raw = readFileSync(join(HUB_DIR, 'wrangler.jsonc'), 'utf8');
    const devId = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')).env.development.vars.DEV_FAKE_IDENTITY;
    h.clock.now = new Date();
    const env = { ...h.env, ENVIRONMENT: 'development', DEV_FAKE_IDENTITY: devId };
    const me = await json(await h.call('/api/me', { env }));
    expect(me).toMatchObject({ email: devId, is_admin: true, auth_source: 'dev' });
  });
});
