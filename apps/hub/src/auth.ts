// Cloudflare Access JWT 검증 (매 요청, fail-closed)
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './env';
import { isEmail } from './validate';

export type JwksProvider = (certsUrl: URL) => JWTVerifyGetKey;

export interface Identity {
  email: string;
  iat: number | null;
  source: 'access' | 'dev';
}

export type AuthResult = { ok: true; identity: Identity } | { ok: false; reason: string };

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const MAX_TOKEN_LENGTH = 8192;
const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUD_RE = /^[A-Za-z0-9]{16,128}$/;

// 원격 JWKS (isolate 단위 캐시; jose 가 키 회전·쿨다운 처리)
const jwksCache = new Map<string, JWTVerifyGetKey>();
export const remoteJwks: JwksProvider = (url) => {
  let getKey = jwksCache.get(url.href);
  if (!getKey) {
    getKey = createRemoteJWKSet(url, { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    jwksCache.set(url.href, getKey);
  }
  return getKey;
};

export function accessIssuer(team: string): string {
  return `https://${team}.cloudflareaccess.com`;
}

export async function authenticate(req: Request, env: Env, jwks: JwksProvider, now: Date): Promise<AuthResult> {
  // 로컬 개발 전용 우회 (development 에서만)
  if (env.ENVIRONMENT === 'development' && env.DEV_FAKE_IDENTITY !== undefined) {
    const email = env.DEV_FAKE_IDENTITY.trim().toLowerCase();
    if (!isEmail(email)) return { ok: false, reason: 'dev_identity_invalid' };
    return { ok: true, identity: { email, iat: null, source: 'dev' } };
  }

  const team = env.ACCESS_TEAM ?? '';
  const aud = env.ACCESS_AUD ?? '';
  if (!TEAM_RE.test(team) || !AUD_RE.test(aud)) return { ok: false, reason: 'access_config_missing' };

  // 헤더만 신뢰 (CF_Authorization 쿠키는 사용하지 않음)
  const token = req.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false, reason: 'missing_token' };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'token_too_large' };

  const issuer = accessIssuer(team);
  try {
    const { payload } = await jwtVerify(token, jwks(new URL(`${issuer}/cdn-cgi/access/certs`)), {
      issuer,
      audience: aud, // MUTATION:AUD
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'email'],
      currentDate: now,
    });
    const email = payload.email;
    if (typeof email !== 'string' || !isEmail(email)) return { ok: false, reason: 'invalid_email_claim' };
    const iat = typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : null;
    return { ok: true, identity: { email: email.toLowerCase(), iat, source: 'access' } };
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
}
