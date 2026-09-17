// 시험 공통 도구
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { FakeD1 } from './d1-adapter';

export const NOW = new Date('2026-09-16T12:00:00.000Z');
export const NOW_SEC = Math.floor(NOW.getTime() / 1000);
export const TEAM = 'firmmit-test';
export const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
export const ORIGIN = 'https://hub.example.test';
export const HUB_DIR = fileURLToPath(new URL('..', import.meta.url));
export const MIGRATIONS_DIR = join(HUB_DIR, 'migrations');

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function applyMigrations(db: DatabaseSync): void {
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
}

export function createDb(): { sqlite: DatabaseSync; d1: FakeD1 } {
  const sqlite = openDb();
  applyMigrations(sqlite);
  return { sqlite, d1: new FakeD1(sqlite) };
}

export async function makeKeys(kid = 'test-key-1') {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk, kid };
}

export type Keys = Awaited<ReturnType<typeof makeKeys>>;

export async function signToken(
  keys: Keys,
  claims: Record<string, unknown> = {},
  opts: { iss?: string; aud?: string; exp?: number; iat?: number; nbf?: number; omitExp?: boolean } = {},
): Promise<string> {
  const jwt = new SignJWT({ type: 'app', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(opts.iat ?? NOW_SEC - 60)
    .setSubject('sub-123');
  if (!opts.omitExp) jwt.setExpirationTime(opts.exp ?? NOW_SEC + 3600);
  if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf);
  return jwt.sign(keys.privateKey);
}

export function makeEnv(d1: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: d1 as unknown as D1Database,
    ENVIRONMENT: 'production',
    ACCESS_TEAM: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_ORIGIN: ORIGIN,
    ...overrides,
  };
}

export interface Harness {
  sqlite: DatabaseSync;
  d1: FakeD1;
  env: Env;
  keys: Keys;
  app: ReturnType<typeof createApp>;
  jwksUrls: string[];
  clock: { now: Date };
  token: (email: string | null, extra?: Record<string, unknown>, opts?: Parameters<typeof signToken>[2]) => Promise<string>;
  call: (path: string, init?: CallInit) => Promise<Response>;
}

export interface CallInit {
  method?: string;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
  env?: Env;
}

export async function harness(envOverrides: Partial<Env> = {}): Promise<Harness> {
  const { sqlite, d1 } = createDb();
  const keys = await makeKeys();
  const jwksUrls: string[] = [];
  const clock = { now: NOW };
  const app = createApp({
    jwks: (url) => {
      jwksUrls.push(url.href);
      return createLocalJWKSet({ keys: [keys.jwk] });
    },
    now: () => clock.now,
  });
  const env = makeEnv(d1, envOverrides);
  const h: Harness = {
    sqlite,
    d1,
    env,
    keys,
    app,
    jwksUrls,
    clock,
    token: (email, extra = {}, opts = {}) => signToken(keys, email === null ? extra : { email, ...extra }, opts),
    call: async (path, init = {}) => {
      const method = init.method ?? (init.body !== undefined || init.rawBody !== undefined ? 'POST' : 'GET');
      const headers = new Headers(init.headers ?? {});
      if (init.token) headers.set('Cf-Access-Jwt-Assertion', init.token);
      if (method !== 'GET' && method !== 'HEAD') {
        if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
        if (init.contentType !== null) headers.set('Content-Type', init.contentType ?? 'application/json');
      }
      const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
      const req = new Request(`${ORIGIN}${path}`, { method, headers, body });
      return app.fetch(req, init.env ?? env, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
    },
  };
  return h;
}

// ---- 데이터 준비 (직접 SQL) ----
export function setSynced(sqlite: DatabaseSync, at: Date | null): void {
  if (at === null) {
    sqlite.prepare('DELETE FROM sync_state WHERE key = ?').run('access_groups');
    return;
  }
  sqlite
    .prepare(
      "INSERT INTO sync_state (key, last_success_at) VALUES ('access_groups', ?) ON CONFLICT(key) DO UPDATE SET last_success_at = excluded.last_success_at",
    )
    .run(at.toISOString());
}

export interface SeedGrant {
  app_id: string;
  role: string;
  scope?: string;
  expires_at?: string | null;
  revoked?: boolean;
}

export function seedUser(
  sqlite: DatabaseSync,
  u: { email: string; name?: string; status?: string; groups?: string[]; grants?: SeedGrant[]; empId?: string | null },
): number[] {
  sqlite
    .prepare('INSERT INTO users (email, emp_id, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(u.email, u.empId ?? null, u.name ?? u.email.split('@')[0]!, u.status ?? 'active', '2026-09-01T00:00:00.000Z');
  for (const g of u.groups ?? []) {
    sqlite
      .prepare('INSERT INTO access_group_snapshot (group_name, email, synced_at) VALUES (?, ?, ?)')
      .run(g, u.email, NOW.toISOString());
  }
  const ids: number[] = [];
  for (const g of u.grants ?? []) {
    const info = sqlite
      .prepare('INSERT INTO role_grants (email, app_id, role, scope, expires_at, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(u.email, g.app_id, g.role, g.scope ?? '*', g.expires_at ?? null, 'seed@example.test', '2026-09-01T00:00:00.000Z');
    const id = Number(info.lastInsertRowid);
    if (g.revoked) {
      sqlite.prepare('UPDATE role_grants SET revoked_at = ?, revoked_by = ? WHERE id = ?').run('2026-09-02T00:00:00.000Z', 'seed@example.test', id);
    }
    ids.push(id);
  }
  return ids;
}

export const ADMIN = 'admin1@example.test';
export const ADMIN2 = 'admin2@example.test';
export const STAFF = 'staff1@example.test';

// 기본 조직: ADMIN 2명 + 농자재 직원 1명, 사본 신선
export function seedOrg(sqlite: DatabaseSync): void {
  seedUser(sqlite, { email: ADMIN, name: '관리자1', groups: ['ADMIN'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
  seedUser(sqlite, { email: ADMIN2, name: '관리자2', groups: ['ADMIN'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
  seedUser(sqlite, {
    email: STAFF,
    name: '직원1',
    groups: ['NONGJAJAE'],
    grants: [{ app_id: 'nongjajae', role: 'OPERATOR' }],
  });
  setSynced(sqlite, NOW);
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = sqlite.prepare(sql).get(...params) as Record<string, number>;
  return Number(Object.values(row)[0]);
}
