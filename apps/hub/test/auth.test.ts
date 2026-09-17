import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ADMIN, AUD, harness, ISSUER, json, NOW_SEC, seedOrg, STAFF, TEAM } from './helpers';

async function ready() {
  const h = await harness();
  seedOrg(h.sqlite);
  return h;
}

describe('인증: Access JWT (fail-closed)', () => {
  it('헤더 없음 → 401', async () => {
    const h = await ready();
    const res = await h.call('/api/me');
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
  });

  it('CF_Authorization 쿠키만 있음 → 401 (헤더만 신뢰)', async () => {
    const h = await ready();
    const t = await h.token(STAFF);
    const res = await h.call('/api/me', { headers: { Cookie: `CF_Authorization=${t}` } });
    expect(res.status).toBe(401);
  });

  it('정상 토큰 → 200, 발급자 JWKS 주소 사용', async () => {
    const h = await ready();
    const res = await h.call('/api/me', { token: await h.token(STAFF) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.email).toBe(STAFF);
    expect(body.auth_source).toBe('access');
    expect(h.jwksUrls).toContain(`https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  });

  it('이메일 대소문자 정규화', async () => {
    const h = await ready();
    const res = await h.call('/api/me', { token: await h.token(STAFF.toUpperCase()) });
    expect(res.status).toBe(200);
    expect((await json(res)).email).toBe(STAFF);
  });

  it('서명 불일치 (다른 키, 같은 kid) → 401', async () => {
    const h = await ready();
    const other = await generateKeyPair('RS256');
    const t = await new SignJWT({ email: STAFF })
      .setProtectedHeader({ alg: 'RS256', kid: h.keys.kid })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt(NOW_SEC - 60)
      .setExpirationTime(NOW_SEC + 3600)
      .sign(other.privateKey);
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('서명 부분 변조 → 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF);
    const parts = t.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    payload.email = ADMIN;
    const forged = [parts[0], Buffer.from(JSON.stringify(payload)).toString('base64url'), parts[2]].join('.');
    expect((await h.call('/api/me', { token: forged })).status).toBe(401);
  });

  it('aud 불일치 → 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF, {}, { aud: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' });
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('iss 불일치 → 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF, {}, { iss: 'https://evil.cloudflareaccess.com' });
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('만료 → 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF, {}, { iat: NOW_SEC - 7200, exp: NOW_SEC - 10 });
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('exp 없음 → 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF, {}, { omitExp: true });
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('nbf 미래 → 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF, {}, { nbf: NOW_SEC + 600 });
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('email 클레임 없음 (서비스 토큰 등) → 401', async () => {
    const h = await ready();
    const t = await h.token(null, { common_name: 'svc.access' });
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });

  it('email 클레임 형식 오류 → 401', async () => {
    const h = await ready();
    for (const bad of ['not-an-email', 123, '']) {
      const t = await h.token(null, { email: bad });
      expect((await h.call('/api/me', { token: t })).status).toBe(401);
    }
  });

  it('HS256 / alg=none 토큰 → 401', async () => {
    const h = await ready();
    const hs = await new SignJWT({ email: STAFF })
      .setProtectedHeader({ alg: 'HS256', kid: h.keys.kid })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime(NOW_SEC + 3600)
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect((await h.call('/api/me', { token: hs })).status).toBe(401);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none' })}.${b64({ email: STAFF, iss: ISSUER, aud: AUD, exp: NOW_SEC + 3600 })}.`;
    expect((await h.call('/api/me', { token: none })).status).toBe(401);
  });

  it('너무 긴 토큰 → 401', async () => {
    const h = await ready();
    expect((await h.call('/api/me', { token: 'a'.repeat(9000) })).status).toBe(401);
  });

  it('ACCESS_AUD / ACCESS_TEAM 누락·자리표시자 → 정상 토큰도 401', async () => {
    const h = await ready();
    const t = await h.token(STAFF);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const over of [{ ACCESS_AUD: undefined }, { ACCESS_AUD: '<AUD>' }, { ACCESS_TEAM: undefined }, { ACCESS_TEAM: '<TEAM>' }, { ACCESS_AUD: '' }]) {
      const res = await h.call('/api/me', { token: t, env: { ...h.env, ...over } });
      expect(res.status).toBe(401);
    }
    errSpy.mockRestore();
  });

  it('운영(production)에서 DEV_FAKE_IDENTITY 가 있으면 모든 요청 500', async () => {
    const h = await ready();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...h.env, DEV_FAKE_IDENTITY: ADMIN };
    const t = await h.token(ADMIN);
    for (const path of ['/api/health', '/api/me', '/api/apps', '/api/admin/users']) {
      const res = await h.call(path, { token: t, env });
      expect(res.status).toBe(500);
      expect((await json(res)).error.code).toBe('server_misconfigured');
    }
    // 빈 문자열이어도 거부
    expect((await h.call('/api/health', { env: { ...h.env, DEV_FAKE_IDENTITY: '' } })).status).toBe(500);
    expect(errSpy).toHaveBeenCalledWith('config_error', 'dev_identity_in_production');
    errSpy.mockRestore();
  });

  it('ENVIRONMENT 누락·알 수 없는 값 → 500', async () => {
    const h = await ready();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const v of [undefined, 'staging', 'Production']) {
      expect((await h.call('/api/health', { env: { ...h.env, ENVIRONMENT: v } })).status).toBe(500);
    }
    errSpy.mockRestore();
  });

  it('development + DEV_FAKE_IDENTITY → 토큰 없이 해당 신원', async () => {
    const h = await ready();
    const env = { ...h.env, ENVIRONMENT: 'development', DEV_FAKE_IDENTITY: ADMIN };
    const res = await h.call('/api/me', { env });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.email).toBe(ADMIN);
    expect(body.auth_source).toBe('dev');
  });

  it('development 이지만 DEV_FAKE_IDENTITY 없음 → JWT 필요', async () => {
    const h = await ready();
    const env = { ...h.env, ENVIRONMENT: 'development' };
    expect((await h.call('/api/me', { env })).status).toBe(401);
    expect((await h.call('/api/me', { env, token: await h.token(STAFF) })).status).toBe(200);
  });

  it('JWKS 키 교체: 모르는 kid → 401', async () => {
    const h = await ready();
    const k2 = await generateKeyPair('RS256', { extractable: true });
    void (await exportJWK(k2.publicKey));
    const t = await new SignJWT({ email: STAFF })
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime(NOW_SEC + 3600)
      .sign(k2.privateKey);
    expect((await h.call('/api/me', { token: t })).status).toBe(401);
  });
});
