// WP3: 외부 토큰 갱신 (R2 §1.4 ①–⑥). 실제 외부 호출 없음 — 전부 가짜 provider.
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { importKey, keyMaterial, open, seal, toBytes, KEY_SECRET_NAME } from '../src/tokens/crypto';
import {
  blockedBy,
  createTokenStmts,
  EPOCH,
  isEnabled,
  latestJournal,
  refreshAllTokens,
  refreshOne,
  tokenStatuses,
  type JournalRow,
  type RefreshDeps,
  type TokenRow,
} from '../src/tokens/refresh';
import { cafe24Adapter, normalizeIso, type ProviderAdapter } from '../src/tokens/providers';
import { refreshInternalKpis } from '../src/kpi/gateway';
import { ADMIN, count, createDb, harness, json, makeEnv, NOW, seedOrg, STAFF } from './helpers';
import type { FakeD1 } from './d1-adapter';
import type { Env } from '../src/env';

// 시험용 키 (32바이트 base64). 실제 키가 아니다.
const TEST_KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 256)));
const TOKEN_ID = 'cafe24:main';
const ENABLED: Partial<Env> = { TOKEN_REFRESH_ENABLED: 'true', TOKEN_KEY_V1: TEST_KEY_B64 };

interface Ctx {
  sqlite: DatabaseSync;
  d1: FakeD1;
  db: D1Database;
  env: Env;
  key: CryptoKey;
  calls: { refreshToken: string }[];
}

async function ctx(over: Partial<Env> = {}): Promise<Ctx> {
  const { sqlite, d1 } = createDb();
  const env = makeEnv(d1, { ...ENABLED, ...over });
  const key = await importKey(keyMaterial(env)!);
  return { sqlite, d1, db: d1 as unknown as D1Database, env, key, calls: [] };
}

async function seedToken(c: Ctx, plaintext = 'refresh-token-000', over: Partial<{ expires_at: string | null }> = {}): Promise<void> {
  const sealed = await seal(c.key, plaintext);
  await c.db.batch(
    createTokenStmts(
      c.db,
      {
        token_id: TOKEN_ID,
        provider: 'cafe24',
        account_ref: 'mall:<MALL_ID>',
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        key_version: sealed.keyVersion,
        expires_at: over.expires_at === undefined ? new Date(NOW.getTime() + 14 * 86_400_000).toISOString() : over.expires_at,
      },
      NOW.toISOString(),
    ),
  );
}

/** 가짜 cafe24: 부르면 새 refresh token 을 준다 (회전형) */
function fakeProvider(
  c: Ctx,
  behavior: (n: number) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): ProviderAdapter {
  return {
    name: 'cafe24',
    async call(req) {
      c.calls.push({ refreshToken: req.refreshToken });
      return behavior(c.calls.length);
    },
    parse: cafe24Adapter.parse,
  };
}

const okBody = (n: number) =>
  JSON.stringify({ access_token: `a-${n}`, refresh_token: `refresh-token-${String(n).padStart(3, '0')}-new`, refresh_token_expires_at: '2026-10-01T00:00:00Z' });

function deps(over: Partial<RefreshDeps> = {}): RefreshDeps {
  return { now: () => NOW, requestId: 'test-token', ...over };
}

function tokenRow(sqlite: DatabaseSync): TokenRow {
  return sqlite.prepare('SELECT * FROM tokens WHERE token_id = ?').get(TOKEN_ID) as unknown as TokenRow;
}

function journals(sqlite: DatabaseSync): JournalRow[] {
  return sqlite.prepare('SELECT * FROM token_refresh_journal ORDER BY id').all() as unknown as JournalRow[];
}

function lease(sqlite: DatabaseSync): { holder: string; lease_until: string } {
  return sqlite.prepare('SELECT holder, lease_until FROM token_lease WHERE token_id = ?').get(TOKEN_ID) as {
    holder: string;
    lease_until: string;
  };
}

describe('WP3 암호화', () => {
  it('넣고 빼기가 되돌아온다', async () => {
    const c = await ctx();
    const sealed = await seal(c.key, '비밀-토큰-값');
    expect(await open(c.key, sealed)).toBe('비밀-토큰-값');
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.iv.byteLength).toBe(12);
  });

  it('같은 값도 매번 다른 암호문 (IV 재사용 금지)', async () => {
    const c = await ctx();
    const a = await seal(c.key, 'x');
    const b = await seal(c.key, 'x');
    expect(Buffer.from(a.ciphertext).toString('hex')).not.toBe(Buffer.from(b.ciphertext).toString('hex'));
    expect(Buffer.from(a.iv).toString('hex')).not.toBe(Buffer.from(b.iv).toString('hex'));
  });

  it('다른 키·변조된 암호문은 예외 대신 null', async () => {
    const c = await ctx();
    const sealed = await seal(c.key, 'x');
    const other = await importKey(new Uint8Array(32).fill(9));
    expect(await open(other, sealed)).toBeNull();
    const broken = new Uint8Array(sealed.ciphertext);
    broken[0] = broken[0]! ^ 0xff;
    expect(await open(c.key, { ciphertext: broken, iv: sealed.iv })).toBeNull();
  });

  it('키가 없거나 자리표시자·길이가 다르면 null (fail-closed)', async () => {
    const { d1 } = createDb();
    for (const v of [undefined, '', '   ', '<TOKEN_KEY_V1>', btoa('short'), 'not-base64!!']) {
      expect(keyMaterial(makeEnv(d1, v === undefined ? {} : { TOKEN_KEY_V1: v })), String(v)).toBeNull();
    }
    expect(keyMaterial(makeEnv(d1, { TOKEN_KEY_V1: TEST_KEY_B64 }))).not.toBeNull();
    expect(KEY_SECRET_NAME).toBe('TOKEN_KEY_V1');
  });

  it('D1 에서 온 값 형태를 모두 받아준다', () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(toBytes(u)).toBe(u);
    expect(toBytes(u.buffer)).toEqual(u);
    expect(toBytes([1, 2, 3])).toEqual(u);
    expect(toBytes('nope')).toBeNull();
  });
});

describe('WP3 기본값·설정', () => {
  it('기본은 꺼짐이고 "true" 일 때만 켜진다', async () => {
    const { d1 } = createDb();
    for (const v of [undefined, 'false', 'FALSE', '1', 'yes', 'True', '']) {
      expect(isEnabled(makeEnv(d1, v === undefined ? {} : { TOKEN_REFRESH_ENABLED: v })), String(v)).toBe(false);
    }
    expect(isEnabled(makeEnv(d1, { TOKEN_REFRESH_ENABLED: 'true' }))).toBe(true);
  });

  it('꺼져 있으면 외부 호출 0건 · DB 변경 0건', async () => {
    const c = await ctx({ TOKEN_REFRESH_ENABLED: 'false' });
    await seedToken(c);
    const r = await refreshAllTokens(c.db, c.env, deps(), { cafe24: fakeProvider(c, () => ({ status: 200, body: okBody(1) })) });
    expect(r).toEqual({ results: [], skipped: 'disabled' });
    expect(c.calls).toEqual([]);
    expect(journals(c.sqlite)).toEqual([]);
  });

  it('키가 없으면 실행하지 않는다', async () => {
    const c = await ctx();
    await seedToken(c);
    const noKey = { ...c.env, TOKEN_KEY_V1: '<TOKEN_KEY_V1>' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await refreshAllTokens(c.db, noKey, deps(), { cafe24: fakeProvider(c, () => ({ status: 200, body: okBody(1) })) });
    expect(r.skipped).toBe('no_key');
    expect(c.calls).toEqual([]);
    spy.mockRestore();
  });

  it('켜져 있어도 토큰 행이 없으면 아무것도 하지 않는다', async () => {
    const c = await ctx();
    const r = await refreshAllTokens(c.db, c.env, deps(), {});
    expect(r).toEqual({ results: [], skipped: null });
    expect(c.calls).toEqual([]);
  });

  it('실행권 행이 없으면 아무것도 하지 않는다 (① 이 언제나 0행)', async () => {
    const c = await ctx();
    await seedToken(c);
    c.sqlite.prepare('DELETE FROM token_lease WHERE token_id = ?').run(TOKEN_ID);
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, () => ({ status: 200, body: okBody(1) })), deps());
    expect(r.outcome).toBe('lease_taken');
    expect(c.calls).toEqual([]);
  });
});

describe('WP3 ①–⑥ 흐름', () => {
  it('정상: 새 토큰 저장 + version 증가 + journal applied + 실행권 해제', async () => {
    const c = await ctx();
    await seedToken(c, 'refresh-token-000');
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(r).toMatchObject({ outcome: 'applied', dispatched: true });
    expect(c.calls).toEqual([{ refreshToken: 'refresh-token-000' }]); // 지금 토큰으로 호출

    const row = tokenRow(c.sqlite);
    expect(row.version).toBe(2);
    expect(await open(c.key, { ciphertext: toBytes(row.ciphertext)!, iv: toBytes(row.iv)! })).toBe('refresh-token-001-new');
    expect(row.expires_at).toBe('2026-10-01T00:00:00.000Z');

    const [j] = journals(c.sqlite);
    expect(j).toMatchObject({ outcome: 'applied', token_id: TOKEN_ID });
    expect(j!.ciphertext).not.toBeNull(); // ③ 선기록이 남아 있다
    expect(lease(c.sqlite).lease_until).toBe(EPOCH); // ⑥ 해제됨
  });

  it('① 동시 실행 2개 → 한쪽만 실행권, 다른 쪽은 외부 요청 0건', async () => {
    const c = await ctx();
    await seedToken(c);
    const provider = fakeProvider(c, (n) => ({ status: 200, body: okBody(n) }));
    const row = tokenRow(c.sqlite);
    const [a, b] = await Promise.all([
      refreshOne(c.db, c.key, row, provider, deps({ holder: 'A' })),
      refreshOne(c.db, c.key, row, provider, deps({ holder: 'B' })),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['applied', 'lease_taken']);
    expect(c.calls).toHaveLength(1); // 외부 요청은 한 번뿐
  });

  it('② 실행권 남은 시간이 모자라면 요청을 보내지 않고 해제한다', async () => {
    const c = await ctx();
    await seedToken(c);
    const r = await refreshOne(
      c.db,
      c.key,
      tokenRow(c.sqlite),
      fakeProvider(c, () => ({ status: 200, body: okBody(1) })),
      deps({ leaseMs: 10_000 }), // 요청 제한 30초 + 여유 30초보다 짧다
    );
    expect(r).toMatchObject({ outcome: 'lease_too_short', dispatched: false });
    expect(c.calls).toEqual([]);
    expect(journals(c.sqlite)).toEqual([]); // 시작 기록도 남기지 않는다
    expect(lease(c.sqlite).lease_until).toBe(EPOCH);
  });

  it('②-1 시작 기록이 실패하면 외부 요청을 보내지 않는다', async () => {
    const c = await ctx();
    await seedToken(c);
    // 읽기는 되고 INSERT 만 실패하는 상황
    c.sqlite.exec("CREATE TRIGGER t_journal_fail BEFORE INSERT ON token_refresh_journal BEGIN SELECT RAISE(ABORT, 'test_insert_blocked'); END;");
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, () => ({ status: 200, body: okBody(1) })), deps());
    expect(r).toMatchObject({ outcome: 'journal_start_failed', dispatched: false });
    expect(c.calls).toEqual([]);
    expect(lease(c.sqlite).lease_until).toBe(EPOCH);
    const audits = c.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'token_refresh_failed'").all();
    expect(audits).toHaveLength(1);
    spy.mockRestore();
  });

  it('응답 유실 → unknown + 자동 재시도 없음 + 다음 실행도 시작하지 않음', async () => {
    const c = await ctx();
    await seedToken(c);
    const provider = fakeProvider(c, () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    const first = await refreshOne(c.db, c.key, tokenRow(c.sqlite), provider, deps());
    expect(first).toMatchObject({ outcome: 'unknown', dispatched: true });
    expect(journals(c.sqlite)[0]).toMatchObject({ outcome: 'unknown' });
    expect(c.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'token_refresh_unknown'").all()).toHaveLength(1);
    expect(tokenRow(c.sqlite).version).toBe(1); // 토큰은 그대로

    // 다음 실행은 ① 을 시작하지 않는다 (차단)
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(second.outcome).toBe('blocked');
    expect(c.calls).toHaveLength(1); // 재시도 없음
    spy.mockRestore();
  });

  it('③ 응답을 파싱하기 전에 암호문으로 먼저 기록한다', async () => {
    const c = await ctx();
    await seedToken(c);
    // 2xx 인데 해석 불가 → 선기록은 남고 저장은 하지 않는다
    await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, () => ({ status: 200, body: '{깨진 JSON' })), deps());
    const [j] = journals(c.sqlite);
    expect(j).toMatchObject({ outcome: 'unknown' });
    expect(j!.ciphertext).not.toBeNull();
    expect(await open(c.key, { ciphertext: toBytes(j!.ciphertext)!, iv: toBytes(j!.iv)! })).toBe('{깨진 JSON');
    expect(tokenRow(c.sqlite).version).toBe(1);
  });

  it('2xx 가 아니면 회전이 없었다고 보고 다시 시도할 수 있는 실패로 둔다', async () => {
    const c = await ctx();
    await seedToken(c);
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, () => ({ status: 401, body: '{"error":"invalid_grant"}' })), deps());
    expect(r).toMatchObject({ outcome: 'failed', dispatched: true });
    expect(journals(c.sqlite)[0]).toMatchObject({ outcome: 'failed' });
    // 차단되지 않는다 → 다음 실행이 다시 시도한다
    const again = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(again.outcome).toBe('applied');
  });

  it('④⑤ 버전이 그 사이 바뀌면 conflict 로 보존하고 새 토큰을 버리지 않는다', async () => {
    const c = await ctx();
    await seedToken(c);
    const row = tokenRow(c.sqlite);
    // 외부 호출 중에 다른 실행이 버전을 올린 상황
    const provider: ProviderAdapter = {
      name: 'cafe24',
      async call(req) {
        c.calls.push({ refreshToken: req.refreshToken });
        c.sqlite.prepare('UPDATE tokens SET version = version + 1 WHERE token_id = ?').run(TOKEN_ID);
        return { status: 200, body: okBody(9) };
      },
      parse: cafe24Adapter.parse,
    };
    const r = await refreshOne(c.db, c.key, row, provider, deps());
    expect(r).toMatchObject({ outcome: 'conflict', dispatched: true });
    // 핵심: 우리 값이 남의 값을 덮어쓰지 않았다
    const after = tokenRow(c.sqlite);
    expect(after.version).toBe(2); // 다른 실행이 올린 값 그대로 (3 이 되면 덮어쓴 것)
    expect(await open(c.key, { ciphertext: toBytes(after.ciphertext)!, iv: toBytes(after.iv)! })).toBe('refresh-token-000');
    expect(after.last_refresh_journal_id ?? null).toBeNull();
    const [j] = journals(c.sqlite);
    expect(j).toMatchObject({ outcome: 'conflict' });
    // 새 토큰은 선기록에 남아 있다
    expect(await open(c.key, { ciphertext: toBytes(j!.ciphertext)!, iv: toBytes(j!.iv)! })).toContain('refresh-token-009-new');
    expect(c.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'token_refresh_conflict'").all()).toHaveLength(1);
    expect(lease(c.sqlite).lease_until).toBe(EPOCH);

    // conflict 도 다음 실행을 차단한다
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const next = await refreshOne(c.db, c.key, tokenRow(c.sqlite), provider, deps());
    expect(next.outcome).toBe('blocked');
    spy.mockRestore();
  });

  it('⑥ 만료 뒤 다른 실행이 가져간 실행권을 이전 보유자가 풀지 못한다', async () => {
    const c = await ctx();
    await seedToken(c);
    // A 가 외부 요청을 보내는 사이에 실행권이 넘어간 상황을 만든다
    const provider: ProviderAdapter = {
      name: 'cafe24',
      async call(req) {
        c.calls.push({ refreshToken: req.refreshToken });
        c.sqlite.prepare('UPDATE token_lease SET holder = ?, lease_until = ? WHERE token_id = ?').run('B', '2999-01-01T00:00:00.000Z', TOKEN_ID);
        return { status: 200, body: okBody(5) };
      },
      parse: cafe24Adapter.parse,
    };
    await refreshOne(c.db, c.key, tokenRow(c.sqlite), provider, deps({ holder: 'A' }));
    // A 의 해제는 B 의 실행권을 건드리면 안 된다
    expect(lease(c.sqlite)).toMatchObject({ holder: 'B', lease_until: '2999-01-01T00:00:00.000Z' });
  });

  it('실행이 중간에 죽어 실행권이 끝난 in_progress → 다음 실행 차단', async () => {
    const c = await ctx();
    await seedToken(c);
    c.sqlite
      .prepare(
        "INSERT INTO token_refresh_journal (token_id, holder, started_at, outcome, detail_json, lease_until) VALUES (?, 'dead', ?, 'in_progress', '{}', ?)",
      )
      .run(TOKEN_ID, NOW.toISOString(), new Date(NOW.getTime() - 60_000).toISOString());
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(r.outcome).toBe('blocked');
    expect(c.calls).toEqual([]);
    spy.mockRestore();
  });

  it('아직 살아 있는 in_progress 는 "다른 실행이 도는 중" 으로 본다', async () => {
    const c = await ctx();
    await seedToken(c);
    c.sqlite
      .prepare(
        "INSERT INTO token_refresh_journal (token_id, holder, started_at, outcome, detail_json, lease_until) VALUES (?, 'other', ?, 'in_progress', '{}', ?)",
      )
      .run(TOKEN_ID, NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString());
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(r.outcome).toBe('lease_taken');
    expect(c.calls).toEqual([]);
  });

  it('차단 규칙 표', () => {
    const base: JournalRow = {
      id: 1, token_id: TOKEN_ID, holder: 'x', started_at: NOW.toISOString(), finished_at: null,
      outcome: 'applied', ciphertext: null, iv: null, detail_json: '{}', key_version: 1, lease_until: null,
    };
    expect(blockedBy(null, NOW)).toBeNull();
    expect(blockedBy(base, NOW)).toBeNull();
    expect(blockedBy({ ...base, outcome: 'failed' }, NOW)).toBeNull();
    expect(blockedBy({ ...base, outcome: 'unknown' }, NOW)).toBe('unknown');
    expect(blockedBy({ ...base, outcome: 'conflict' }, NOW)).toBe('conflict');
    expect(blockedBy({ ...base, outcome: 'in_progress', lease_until: null }, NOW)).toBe('stuck_in_progress');
    expect(blockedBy({ ...base, outcome: 'in_progress', lease_until: '어제' }, NOW)).toBe('stuck_in_progress');
    expect(blockedBy({ ...base, outcome: 'in_progress', lease_until: new Date(NOW.getTime() + 1000).toISOString() }, NOW)).toBe('running');
  });

  it('토큰을 풀 수 없으면 요청을 보내지 않는다', async () => {
    const c = await ctx();
    await seedToken(c);
    c.sqlite.prepare('UPDATE tokens SET ciphertext = ? WHERE token_id = ?').run(new Uint8Array([1, 2, 3]), TOKEN_ID);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(r).toMatchObject({ outcome: 'decrypt_failed', dispatched: false });
    expect(c.calls).toEqual([]);
    expect(lease(c.sqlite).lease_until).toBe(EPOCH);
    spy.mockRestore();
  });

  it('cafe24 어댑터는 아직 설정되지 않아 요청을 보내지 않는다 (차단도 하지 않는다)', async () => {
    const c = await ctx();
    await seedToken(c);
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), cafe24Adapter, deps());
    expect(r).toMatchObject({ outcome: 'failed', dispatched: false });
    expect(journals(c.sqlite)[0]).toMatchObject({ outcome: 'failed' });
    expect(blockedBy(await latestJournal(c.db, TOKEN_ID), NOW)).toBeNull();
  });

  it('모르는 provider 는 건너뛴다', async () => {
    const c = await ctx();
    await seedToken(c);
    c.sqlite.prepare('UPDATE tokens SET provider = ? WHERE token_id = ?').run('nowhere', TOKEN_ID);
    const r = await refreshAllTokens(c.db, c.env, deps(), {});
    expect(r.results).toEqual([{ token_id: TOKEN_ID, outcome: 'unknown_provider', dispatched: false }]);
  });
});

describe('WP3 비밀값 누출', () => {
  it('평문 토큰이 D1 어디에도 없다', async () => {
    const c = await ctx();
    await seedToken(c, 'SUPER-SECRET-REFRESH');
    await refreshOne(
      c.db,
      c.key,
      tokenRow(c.sqlite),
      fakeProvider(c, () => ({ status: 200, body: JSON.stringify({ refresh_token: 'NEXT-SECRET-REFRESH' }) })),
      deps(),
    );
    const tables = ['tokens', 'token_lease', 'token_refresh_journal', 'audit_log'];
    for (const t of tables) {
      const rows = c.sqlite.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
      const text = JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v));
      expect(text, t).not.toContain('SUPER-SECRET-REFRESH');
      expect(text, t).not.toContain('NEXT-SECRET-REFRESH');
    }
  });

  it('로그·감사기록에 토큰 값이 없다', async () => {
    const c = await ctx();
    await seedToken(c, 'SUPER-SECRET-REFRESH');
    const logs: unknown[][] = [];
    const spyE = vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a));
    const spyW = vi.spyOn(console, 'warn').mockImplementation((...a) => void logs.push(a));
    const spyL = vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a));
    await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, () => { throw new Error('boom'); }), deps());
    expect(JSON.stringify(logs)).not.toContain('SUPER-SECRET-REFRESH');
    const audits = c.sqlite.prepare('SELECT detail_json FROM audit_log').all() as { detail_json: string }[];
    expect(JSON.stringify(audits)).not.toContain('SUPER-SECRET-REFRESH');
    spyE.mockRestore();
    spyW.mockRestore();
    spyL.mockRestore();
  });
});

describe('WP3 시각 형식', () => {
  const RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it('저장되는 시각은 모두 YYYY-MM-DDTHH:MM:SS.sssZ', async () => {
    const c = await ctx();
    await seedToken(c);
    await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    const l = lease(c.sqlite);
    expect(l.lease_until).toMatch(RE);
    expect(EPOCH).toMatch(RE);
    const [j] = journals(c.sqlite);
    expect(j!.started_at).toMatch(RE);
    expect(j!.finished_at).toMatch(RE);
    expect(j!.lease_until).toMatch(RE);
    const t = tokenRow(c.sqlite);
    expect(t.updated_at).toMatch(RE);
    expect(t.expires_at).toMatch(RE);
  });

  it('provider 가 다른 모양의 시각을 줘도 한 형식으로 바꾼다', () => {
    expect(normalizeIso('2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(normalizeIso('2026-10-01T09:00:00+09:00')).toBe('2026-10-01T00:00:00.000Z');
    for (const bad of ['어제', '', null, undefined, 123, '2026-13-01T00:00:00Z']) expect(normalizeIso(bad), String(bad)).toBeNull();
  });

  it('실행권 시각 형식이 섞이면 실행권을 가져가지 않는다', async () => {
    const c = await ctx();
    await seedToken(c);
    // 밀리초 없는 형식이 들어가면 문자열 비교가 틀어진다 → 그런 값은 만들지 않는다
    c.sqlite.prepare('UPDATE token_lease SET lease_until = ? WHERE token_id = ?').run('2999-01-01T00:00:00Z', TOKEN_ID);
    const r = await refreshOne(c.db, c.key, tokenRow(c.sqlite), fakeProvider(c, (n) => ({ status: 200, body: okBody(n) })), deps());
    expect(r.outcome).toBe('lease_taken');
    expect(c.calls).toEqual([]);
  });
});

describe('WP3 상태 보기', () => {
  it('토큰별 상태를 내되 값·암호문은 내려보내지 않는다', async () => {
    const c = await ctx();
    await seedToken(c);
    const list = await tokenStatuses(c.db, NOW);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual(
      ['account_ref', 'expires_at', 'key_version', 'last_attempt_at', 'last_outcome', 'provider', 'state', 'token_id', 'updated_at', 'version'],
    );
    expect(JSON.stringify(list)).not.toContain('ciphertext');
    expect(list[0]!.state).toBe('ok');
  });

  it('72시간 안에 만료면 expiring, 만료 시각이 없으면 no_data', async () => {
    const c = await ctx();
    await seedToken(c, 'x', { expires_at: new Date(NOW.getTime() + 24 * 3600_000).toISOString() });
    expect((await tokenStatuses(c.db, NOW))[0]!.state).toBe('expiring');
    c.sqlite.prepare('UPDATE tokens SET expires_at = NULL WHERE token_id = ?').run(TOKEN_ID);
    expect((await tokenStatuses(c.db, NOW))[0]!.state).toBe('no_data');
  });

  it('충돌·확인 불가는 그대로 드러난다', async () => {
    const c = await ctx();
    await seedToken(c);
    for (const outcome of ['conflict', 'unknown']) {
      c.sqlite
        .prepare(
          "INSERT INTO token_refresh_journal (token_id, holder, started_at, outcome, detail_json, lease_until) VALUES (?, 'x', ?, ?, '{}', ?)",
        )
        .run(TOKEN_ID, NOW.toISOString(), outcome, NOW.toISOString());
      expect((await tokenStatuses(c.db, NOW))[0]!.state).toBe(outcome);
    }
  });

  it('관리 API 는 ADMIN 전용이고 암호문을 주지 않는다', async () => {
    const h = await harness({ ...ENABLED });
    seedOrg(h.sqlite);
    expect((await h.call('/api/admin/tokens', { token: await h.token(STAFF) })).status).toBe(403);
    const body = await json(await h.call('/api/admin/tokens', { token: await h.token(ADMIN) }));
    expect(body).toMatchObject({ enabled: true, tokens: [] });
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|iv|TOKEN_KEY/);
  });
});

describe('WP3 KPI 연결 (SYS.TOKEN_EXPIRY)', () => {
  async function ready(over: Partial<Env> = {}) {
    const h = await harness({ ...ENABLED, ...over });
    seedOrg(h.sqlite);
    return h;
  }

  it('토큰이 없으면 "준비 중" 카드 그대로', async () => {
    const h = await ready();
    await refreshInternalKpis(h.env.DB, 'production', { now: () => NOW });
    const body = await json(await h.call('/api/kpi/SYS.TOKEN_EXPIRY', { token: await h.token(ADMIN) }));
    expect(body.kpi).toMatchObject({ display_status: 'unavailable' });
    expect(body.kpi.measure.value).toBeNull();
  });

  it('토큰이 있으면 값이 나오고, 충돌·확인 불가가 있으면 error 로 바뀐다', async () => {
    const h = await ready();
    const key = await importKey(keyMaterial(h.env)!);
    const sealed = await seal(key, 'refresh-token-000');
    await h.env.DB.batch(
      createTokenStmts(
        h.env.DB,
        {
          token_id: TOKEN_ID,
          provider: 'cafe24',
          account_ref: 'mall:<MALL_ID>',
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          key_version: sealed.keyVersion,
          expires_at: new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
        },
        NOW.toISOString(),
      ),
    );
    await refreshInternalKpis(h.env.DB, 'production', { now: () => NOW });
    const ok = (await json(await h.call('/api/kpi/SYS.TOKEN_EXPIRY', { token: await h.token(ADMIN) }))).kpi;
    expect(ok).toMatchObject({ display_status: 'ok' });
    expect(ok.measure.value).toBe(1); // 만료 임박 1건
    expect(ok.breakdown.map((b: { key: string }) => b.key)).toContain(`token:${TOKEN_ID}`);

    // P1 상황 (충돌) → error. 알림 발송은 없다.
    h.sqlite
      .prepare(
        "INSERT INTO token_refresh_journal (token_id, holder, started_at, outcome, detail_json, lease_until) VALUES (?, 'x', ?, 'conflict', '{}', ?)",
      )
      .run(TOKEN_ID, NOW.toISOString(), NOW.toISOString());
    await refreshInternalKpis(h.env.DB, 'production', { now: () => NOW });
    const bad = (await json(await h.call('/api/kpi/SYS.TOKEN_EXPIRY', { token: await h.token(ADMIN) }))).kpi;
    expect(bad).toMatchObject({ display_status: 'error' });
    expect(bad.measure.value).toBeNull(); // 오류는 0 으로 바꾸지 않는다
    expect(bad.error).toMatchObject({ code: 'SOURCE_AUTH', retryable: false });
    expect(bad.last_success_at).not.toBeNull(); // 마지막 정상 시각은 지우지 않는다
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM kpi_cache')).toBeGreaterThan(0);
  });
});
