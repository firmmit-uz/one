import { describe, expect, it, vi } from 'vitest';
import { arrayOf, bool, email, futureIsoUtc, objectOf, role, str, ValidationError } from '../src/validate';
import { ADMIN, count, harness, json, NOW, ORIGIN, seedOrg, STAFF } from './helpers';

const body = { email: 'csrf@example.test', display_name: 'CSRF' };
const BEL = String.fromCharCode(7);

async function ready() {
  const h = await harness();
  seedOrg(h.sqlite);
  return { h, t: await h.token(ADMIN) };
}

describe('CSRF', () => {
  it('Origin 없음 → 403', async () => {
    const { h, t } = await ready();
    const res = await h.call('/api/admin/users', { token: t, body, origin: null });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('csrf_rejected');
  });

  it('Origin 다름 → 403 (http, 서브도메인, 끝 슬래시, null)', async () => {
    const { h, t } = await ready();
    for (const origin of ['https://evil.example', 'http://hub.example.test', 'https://x.hub.example.test', `${ORIGIN}/`, 'null']) {
      expect((await h.call('/api/admin/users', { token: t, body, origin })).status).toBe(403);
    }
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM users WHERE email = ?', body.email)).toBe(0);
  });

  it('Content-Type 다름 → 415', async () => {
    const { h, t } = await ready();
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
      const res = await h.call('/api/admin/users', { token: t, body, contentType: ct });
      expect(res.status).toBe(415);
    }
    expect((await h.call('/api/admin/users', { token: t, body, contentType: 'application/json; charset=utf-8' })).status).toBe(201);
  });

  it('Sec-Fetch-Site cross-site → 403', async () => {
    const { h, t } = await ready();
    const res = await h.call('/api/admin/users', { token: t, body, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('ALLOWED_ORIGIN 자리표시자·누락 → 쓰기 거부', async () => {
    const { h, t } = await ready();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const v of ['https://<허브 주소>', undefined, '', 'http://localhost:8787']) {
      // 요청 Origin 은 정상 주소, 서버 설정만 잘못됨
      const res = await h.call('/api/admin/users', { token: t, body, origin: ORIGIN, env: { ...h.env, ALLOWED_ORIGIN: v } });
      expect(res.status).toBe(403);
    }
    spy.mockRestore();
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM users WHERE email = ?', body.email)).toBe(0);
  });

  it('development 에서는 localhost Origin 허용', async () => {
    const { h, t } = await ready();
    const env = { ...h.env, ENVIRONMENT: 'development', ALLOWED_ORIGIN: 'http://localhost:8787' };
    const res = await h.call('/api/admin/users', { token: t, body, origin: 'http://localhost:8787', env });
    expect(res.status).toBe(201);
  });

  it('PUT/DELETE/PATCH 는 성공하지 않음', async () => {
    const { h, t } = await ready();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await h.call('/api/admin/users', { token: t, method, rawBody: '{}' });
      expect(res.status).toBe(404);
    }
  });
});

describe('입력 검증 (HTTP)', () => {
  const cases: [string, unknown][] = [
    ['모르는 필드', { ...body, is_admin: true }],
    ['빈 이메일', { email: '', display_name: 'x' }],
    ['공백 이메일', { email: '   ', display_name: 'x' }],
    ['이메일 숫자', { email: 42, display_name: 'x' }],
    ['이메일 형식', { email: 'no-at-sign', display_name: 'x' }],
    ['이메일 앞뒤 공백', { email: ' a@example.test', display_name: 'x' }],
    ['이름 누락', { email: 'a@example.test' }],
    ['이름 빈 값', { email: 'a@example.test', display_name: '  ' }],
    ['이름 null', { email: 'a@example.test', display_name: null }],
    ['이름 제어문자', { email: 'a@example.test', display_name: `a${BEL}b` }],
    ['배열 본문', [body]],
    ['null 본문', null],
    ['문자열 본문', 'x'],
    ['__proto__ 필드', JSON.parse('{"email":"a@example.test","display_name":"x","__proto__":{"admin":true}}')],
  ];
  for (const [name, b] of cases) {
    it(`직원 등록: ${name} → 400`, async () => {
      const { h, t } = await ready();
      const raw = name === '__proto__ 필드' ? '{"email":"a@example.test","display_name":"x","__proto__":{"admin":true}}' : JSON.stringify(b);
      const res = await h.call('/api/admin/users', { token: t, rawBody: raw });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('invalid_input');
      expect(count(h.sqlite, 'SELECT COUNT(*) FROM users')).toBe(3);
    });
  }

  it('잘못된 JSON·빈 본문·너무 큰 본문 → 400', async () => {
    const { h, t } = await ready();
    for (const raw of ['{bad json', '', ' ', JSON.stringify({ ...body, display_name: 'x'.repeat(70_000) })]) {
      expect((await h.call('/api/admin/users', { token: t, rawBody: raw })).status).toBe(400);
    }
  });

  const grantCases: [string, Record<string, unknown>][] = [
    ['잘못된 역할', { email: STAFF, app_id: 'amim', role: 'SUPERUSER' }],
    ['소문자 역할', { email: STAFF, app_id: 'amim', role: 'viewer' }],
    ['역할 누락', { email: STAFF, app_id: 'amim' }],
    ['빈 이메일', { email: '', app_id: 'amim', role: 'VIEWER' }],
    ['app_id 별표', { email: STAFF, app_id: '*', role: 'VIEWER' }],
    ['scope 형식', { email: STAFF, app_id: 'amim', role: 'VIEWER', scope: 'a b' }],
    ['과거 만료', { email: STAFF, app_id: 'amim', role: 'VIEWER', expires_at: '2020-01-01T00:00:00Z' }],
    ['만료 형식', { email: STAFF, app_id: 'amim', role: 'VIEWER', expires_at: '2027-01-01' }],
    ['없는 날짜', { email: STAFF, app_id: 'amim', role: 'VIEWER', expires_at: '2027-02-30T00:00:00Z' }],
    ['만료 숫자', { email: STAFF, app_id: 'amim', role: 'VIEWER', expires_at: 1893456000 }],
    ['모르는 필드', { email: STAFF, app_id: 'amim', role: 'VIEWER', granted_by: 'x' }],
  ];
  for (const [name, b] of grantCases) {
    it(`부여: ${name} → 400`, async () => {
      const { h, t } = await ready();
      const res = await h.call('/api/admin/grants', { token: t, body: b });
      expect(res.status).toBe(400);
      expect(count(h.sqlite, 'SELECT COUNT(*) FROM role_grants')).toBe(3);
    });
  }

  it('상태 변경: 잘못된 값·경로 → 400', async () => {
    const { h, t } = await ready();
    const p = `/api/admin/users/${encodeURIComponent(STAFF)}/status`;
    for (const b of [{ status: 'deleted' }, { status: 'Active' }, { status: true }, {}, { status: 'active', extra: 1 }]) {
      expect((await h.call(p, { token: t, body: b })).status).toBe(400);
    }
    expect((await h.call('/api/admin/users/not-email/status', { token: t, body: { status: 'active' } })).status).toBe(400);
  });

  it('회수: id 형식·본문 → 400', async () => {
    const { h, t } = await ready();
    for (const id of ['abc', '0', '-1', '1.5', '01']) {
      expect((await h.call(`/api/admin/grants/${id}/revoke`, { token: t, body: {} })).status).toBe(400);
    }
    expect((await h.call('/api/admin/grants/3/revoke', { token: t, body: { reason: '' } })).status).toBe(400);
    expect((await h.call('/api/admin/grants/3/revoke', { token: t, body: { force: true } })).status).toBe(400);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM role_grants WHERE revoked_at IS NOT NULL')).toBe(0);
  });

  it('감사 조회 쿼리 → 400', async () => {
    const { h, t } = await ready();
    for (const q of ['limit=abc', 'limit=0', 'limit=501', 'limit=-1', 'before=x', 'foo=1']) {
      expect((await h.call(`/api/admin/audit?${q}`, { token: t })).status).toBe(400);
    }
    expect((await h.call('/api/admin/audit?limit=500', { token: t })).status).toBe(200);
  });
});

describe('검증 함수 단위', () => {
  it('bool 은 true/false 만', () => {
    expect(bool(true, 'f')).toBe(true);
    expect(bool(false, 'f')).toBe(false);
    for (const v of ['true', 'false', 1, 0, null, undefined, 'yes']) {
      expect(() => bool(v, 'f')).toThrow(ValidationError);
    }
  });

  it('objectOf: bool 필드 포함 스펙', () => {
    const v = objectOf({ flag: { v: bool }, name: { v: str({ max: 5 }), optional: true } });
    expect(v({ flag: false }, '')).toEqual({ flag: false });
    expect(() => v({ flag: 'false' }, '')).toThrow(/invalid_type/);
    expect(() => v({ flag: true, other: 1 }, '')).toThrow(/unknown_field/);
    expect(() => v({}, '')).toThrow(/missing_field/);
    expect(() => v({ flag: true, name: 'toolong' }, '')).toThrow(/invalid_length/);
    expect(() => v(new Date(), '')).toThrow(/invalid_type/);
  });

  it('email·role·str·arrayOf·futureIsoUtc', () => {
    expect(email('A@B.example', 'e')).toBe('a@b.example');
    expect(() => email('a@b', 'e')).toThrow();
    expect(() => email('a@@b.example', 'e')).toThrow();
    expect(role('MANAGER', 'r')).toBe('MANAGER');
    expect(() => role('manager', 'r')).toThrow();
    expect(() => str({ max: 10 })(`a${BEL}b`, 's')).toThrow(/invalid_characters/);
    expect(() => arrayOf(email, { max: 1 })(['a@b.example', 'c@d.example'], 'a')).toThrow(/invalid_length/);
    const f = futureIsoUtc(() => NOW);
    expect(f('2026-09-16T12:00:01Z', 'x')).toBe('2026-09-16T12:00:01.000Z');
    expect(() => f('2026-09-16T12:00:00Z', 'x')).toThrow(/not_in_future/);
    expect(() => f('2026-09-16T12:00:01+09:00', 'x')).toThrow(/invalid_datetime/);
  });
});
