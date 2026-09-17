// WP1: Access 그룹 사본 자동 동기화 (실제 외부 호출 없음 — 전부 가짜 fetch)
import { describe, expect, it, vi } from 'vitest';
import { cronJob, UPTIME_CRON } from '../src/index';
import {
  GROUP_SYNC_CRON,
  groupSyncConfig,
  isAutoSyncEnabled,
  nextGroupSyncAt,
  parseGroups,
  runGroupSync,
  type GroupSyncDeps,
} from '../src/groupsync';
import { ADMIN, ADMIN2, count, createDb, harness, json, makeEnv, NOW, seedOrg, seedUser, setSynced, STAFF } from './helpers';
import type { FakeD1 } from './d1-adapter';
import type { DatabaseSync } from 'node:sqlite';

// 시험용 값 (실제 계정 정보 아님)
const ACCOUNT = 'acct-test-0001';
const TOKEN = 'test-token_0123456789';
const AUTO_ENV = { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN };

const emailRule = (e: string) => ({ email: { email: e } });

function group(name: string, include: string[], exclude: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id: `id-${name.toLowerCase()}`,
    name,
    include: include.map(emailRule),
    exclude: exclude.map(emailRule),
    require: [],
    ...extra,
  };
}

/** 필수 7개 그룹이 모두 있고 ADMIN·BREAKGLASS 가 비어 있지 않은 기본 응답 */
function defaultGroups(over: Record<string, unknown>[] = []) {
  return [
    group('ALL', [ADMIN, ADMIN2, STAFF]),
    group('ADMIN', [ADMIN, ADMIN2]),
    group('BREAKGLASS', ['break@example.invalid']),
    group('NONGJAJAE', [STAFF]),
    group('CONSTRUCTION', []),
    group('RND', []),
    group('UZ', []),
    ...over,
  ];
}

interface FakeCall {
  url: string;
  init?: RequestInit;
}

interface FakeApi {
  calls: FakeCall[];
  deps: GroupSyncDeps;
}

type PageSpec =
  | { status?: number; body?: unknown; text?: string; throws?: Error }
  | ((page: number) => { status?: number; body?: unknown; text?: string; throws?: Error });

function okBody(result: unknown[], info?: Record<string, unknown>) {
  return { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) };
}

function fakeApi(pages: PageSpec[] | PageSpec, clock: { now: Date }, opts: Partial<GroupSyncDeps> = {}): FakeApi {
  const calls: FakeCall[] = [];
  const list = Array.isArray(pages) ? pages : [pages];
  const deps: GroupSyncDeps = {
    now: () => clock.now,
    requestId: 'test-request',
    ...opts,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const spec = list[Math.min(calls.length - 1, list.length - 1)]!;
      const s = typeof spec === 'function' ? spec(calls.length) : spec;
      if (s.throws) throw s.throws;
      const text = s.text ?? JSON.stringify(s.body ?? okBody([]));
      return new Response(text, { status: s.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  return { calls, deps };
}

function ctx(): { sqlite: DatabaseSync; d1: FakeD1; clock: { now: Date } } {
  const { sqlite, d1 } = createDb();
  return { sqlite, d1, clock: { now: NOW } };
}

function snapshotPairs(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare('SELECT group_name, email FROM access_group_snapshot ORDER BY group_name, email').all() as {
    group_name: string;
    email: string;
  }[]).map((r) => `${r.group_name}:${r.email}`);
}

function auditActions(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);
}

function syncedAt(sqlite: DatabaseSync): string | null {
  const r = sqlite.prepare("SELECT last_success_at FROM sync_state WHERE key = 'access_groups'").get() as
    | { last_success_at: string }
    | undefined;
  return r?.last_success_at ?? null;
}

function syncState(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT * FROM group_sync_state WHERE key = 'access_groups'").get() as
    | {
        last_attempt_at: string;
        last_outcome: string;
        last_failure_code: string | null;
        consecutive_failures: number;
        stale_audited_at: string | null;
      }
    | undefined;
}

describe('WP1 설정', () => {
  it('계정 ID·토큰이 모두 있어야 자동 모드', () => {
    expect(isAutoSyncEnabled(makeEnv({} as FakeD1, AUTO_ENV))).toBe(true);
    expect(isAutoSyncEnabled(makeEnv({} as FakeD1))).toBe(false);
    expect(isAutoSyncEnabled(makeEnv({} as FakeD1, { CF_ACCOUNT_ID: ACCOUNT }))).toBe(false);
    expect(isAutoSyncEnabled(makeEnv({} as FakeD1, { CF_API_TOKEN: TOKEN }))).toBe(false);
  });

  it('자리표시자·빈 값·형식 밖 값은 자동 모드가 아님 (fail-closed)', () => {
    const cases = [
      { CF_ACCOUNT_ID: '<CF_ACCOUNT_ID>', CF_API_TOKEN: TOKEN },
      { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: '<CF_API_TOKEN>' },
      { CF_ACCOUNT_ID: '   ', CF_API_TOKEN: TOKEN },
      { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: '' },
      { CF_ACCOUNT_ID: 'acct/../../etc', CF_API_TOKEN: TOKEN },
      { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'bad token\nX-Evil: 1' },
      { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'short' },
    ];
    for (const v of cases) expect(groupSyncConfig(makeEnv({} as FakeD1, v))).toBeNull();
  });

  it('다음 예정 시각은 15분 경계', () => {
    expect(nextGroupSyncAt(new Date('2026-09-16T12:00:00.000Z'))).toBe('2026-09-16T12:15:00.000Z');
    expect(nextGroupSyncAt(new Date('2026-09-16T12:14:59.999Z'))).toBe('2026-09-16T12:15:00.000Z');
    expect(nextGroupSyncAt(new Date('2026-09-16T12:59:00.000Z'))).toBe('2026-09-16T13:00:00.000Z');
  });

  it('Cron 값으로 작업을 나눈다 (모르는 값은 null)', () => {
    expect(cronJob(UPTIME_CRON)).toBe('uptime');
    expect(cronJob(GROUP_SYNC_CRON)).toBe('group_sync');
    expect(cronJob('0 * * * *')).toBe('token_refresh'); // WP3 에서 추가
    expect(cronJob('')).toBeNull();
    expect(cronJob('25 23 * * *')).toBeNull(); // R1 계획의 T-DAY 는 아직 없다
  });
});

describe('WP1 응답 해석', () => {
  it('정상: 구성원 = include − exclude, 소문자·중복 제거·정렬', () => {
    const r = parseGroups(
      defaultGroups().map((g) =>
        g.name === 'ALL'
          ? group('ALL', ['  B@Example.Invalid ', 'b@example.invalid', 'a@example.invalid', 'c@example.invalid'], ['c@EXAMPLE.invalid'])
          : g,
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups.find((g) => g.group_name === 'ALL')!.emails).toEqual(['a@example.invalid', 'b@example.invalid']);
  });

  it('허용 목록 밖 그룹은 무시', () => {
    const r = parseGroups(defaultGroups([group('FIRMMIT-IT', ['it@example.invalid']), group('FIRMMIT-ICHEON-PILOT', ['p@example.invalid'])]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups.map((g) => g.group_name)).toEqual(['ALL', 'ADMIN', 'BREAKGLASS', 'NONGJAJAE', 'CONSTRUCTION', 'RND', 'UZ', 'FINANCE']);
  });

  it('FINANCE 가 없으면 구성원 0명 (정상)', () => {
    const r = parseGroups(defaultGroups());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups.find((g) => g.group_name === 'FINANCE')!.emails).toEqual([]);
  });

  it('필수 그룹이 하나라도 없으면 전체 실패', () => {
    for (const missing of ['ALL', 'ADMIN', 'BREAKGLASS', 'NONGJAJAE', 'CONSTRUCTION', 'RND', 'UZ']) {
      const r = parseGroups(defaultGroups().filter((g) => g.name !== missing));
      expect(r, missing).toEqual({ ok: false, code: 'missing_group' });
    }
  });

  it('ADMIN·BREAKGLASS 가 0명이면 실패 (관리자 잠김 방지)', () => {
    expect(parseGroups(defaultGroups().map((g) => (g.name === 'ADMIN' ? group('ADMIN', []) : g)))).toEqual({
      ok: false,
      code: 'admin_group_empty',
    });
    expect(
      parseGroups(defaultGroups().map((g) => (g.name === 'BREAKGLASS' ? group('BREAKGLASS', ['x@example.invalid'], ['x@example.invalid']) : g))),
    ).toEqual({ ok: false, code: 'admin_group_empty' });
  });

  it('빈 그룹은 정상 (해당 그룹 전원 제거)', () => {
    const r = parseGroups(defaultGroups().map((g) => (g.name === 'NONGJAJAE' ? group('NONGJAJAE', []) : g)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups.find((g) => g.group_name === 'NONGJAJAE')!.emails).toEqual([]);
  });

  it('이메일 외 규칙은 전체 실패', () => {
    const others = [
      { everyone: {} },
      { email_domain: { domain: 'example.invalid' } },
      { email_list: { id: 'list-1' } },
      { ip: { ip: '1.2.3.0/24' } },
      { geo: { country_code: 'KR' } },
      { group: { id: 'g1' } },
      { login_method: { id: 'idp-1' } },
      // 이메일 규칙이지만 다른 키가 붙은 경우 — 엄격한 키 검사만 잡아낸다
      { email: { email: 'x@example.invalid' }, everyone: {} },
      { email: { email: 'x@example.invalid', domain: 'example.invalid' } },
      'not-an-object',
      null,
    ];
    for (const rule of others) {
      const r = parseGroups(defaultGroups().map((g) => (g.name === 'ALL' ? { ...group('ALL', [ADMIN]), include: [rule] } : g)));
      expect(r).toEqual({ ok: false, code: 'unknown_rule' });
    }
  });

  it('이메일 형식이 아니면 실패', () => {
    for (const bad of ['not-an-email', '', '  ', 'a@', '@b.invalid', 123, null]) {
      const r = parseGroups(
        defaultGroups().map((g) => (g.name === 'ALL' ? { ...group('ALL', []), include: [{ email: { email: bad } }] } : g)),
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(['invalid_email', 'unknown_rule']).toContain(r.code);
    }
  });

  it('require: 로그인 방식 조건만 허용하고 구성원 계산에 쓰지 않음', () => {
    const ok = parseGroups(
      defaultGroups().map((g) =>
        g.name === 'ALL' ? { ...group('ALL', [ADMIN]), require: [{ login_method: { id: 'idp-1' } }, { auth_method: { auth_method: 'otp' } }] } : g,
      ),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.groups.find((g) => g.group_name === 'ALL')!.emails).toEqual([ADMIN]);

    const bad = parseGroups(
      defaultGroups().map((g) => (g.name === 'ALL' ? { ...group('ALL', [ADMIN]), require: [{ email: { email: ADMIN } }] } : g)),
    );
    expect(bad).toEqual({ ok: false, code: 'unknown_rule' });
  });

  it('같은 그룹 이름이 두 번 오면 실패', () => {
    expect(parseGroups(defaultGroups([group('ALL', ['dup@example.invalid'])]))).toEqual({ ok: false, code: 'duplicate_group' });
  });

  it('그룹 객체·규칙 배열 형태가 다르면 실패', () => {
    expect(parseGroups(['x'])).toEqual({ ok: false, code: 'invalid_response' });
    expect(parseGroups(defaultGroups().map((g) => (g.name === 'ALL' ? { ...g, include: 'nope' } : g)))).toEqual({
      ok: false,
      code: 'invalid_response',
    });
  });

  it('이름 없는 그룹은 건너뜀', () => {
    const r = parseGroups([{ id: 'x', include: [emailRule(ADMIN)] }, ...defaultGroups()]);
    expect(r.ok).toBe(true);
  });
});

describe('WP1 동기화 실행', () => {
  it('정상 1쪽: 사본 교체 + sync_state 갱신 + 감사 1건', async () => {
    const { sqlite, d1, clock } = ctx();
    const api = fakeApi({ body: okBody(defaultGroups()) }, clock);
    const r = await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, AUTO_ENV), api.deps);

    expect(r).toMatchObject({ ok: true, changed: true, groups: 8, members: 7 });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/groups?page=1&per_page=100`);
    expect(new Headers(api.calls[0]!.init!.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(snapshotPairs(sqlite)).toEqual([
      `ADMIN:${ADMIN}`,
      `ADMIN:${ADMIN2}`,
      `ALL:${ADMIN}`,
      `ALL:${ADMIN2}`,
      `ALL:${STAFF}`,
      'BREAKGLASS:break@example.invalid',
      `NONGJAJAE:${STAFF}`,
    ]);
    expect(syncedAt(sqlite)).toBe(NOW.toISOString());
    expect(auditActions(sqlite)).toEqual(['group_snapshot_sync']);
    expect(syncState(sqlite)).toMatchObject({ last_outcome: 'success', last_failure_code: null, consecutive_failures: 0 });
  });

  it('result_info 로 2쪽 이상 읽음', async () => {
    const { sqlite, d1, clock } = ctx();
    const all = defaultGroups();
    const api = fakeApi(
      [
        { body: okBody(all.slice(0, 4), { page: 1, per_page: 4, count: 4, total_count: 7, total_pages: 2 }) },
        { body: okBody(all.slice(4), { page: 2, per_page: 4, count: 3, total_count: 7, total_pages: 2 }) },
      ],
      clock,
      { perPage: 4 },
    );
    const r = await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, AUTO_ENV), api.deps);
    expect(r).toMatchObject({ ok: true });
    expect(api.calls.map((c) => c.url.split('?')[1])).toEqual(['page=1&per_page=4', 'page=2&per_page=4']);
    expect(snapshotPairs(sqlite)).toHaveLength(7);
  });

  it('result_info 가 없으면 "마지막 쪽이 per_page 미만" 으로 판정', async () => {
    const { sqlite, d1, clock } = ctx();
    const all = defaultGroups();
    const api = fakeApi([{ body: okBody(all.slice(0, 4)) }, { body: okBody(all.slice(4)) }], clock, { perPage: 4 });
    const r = await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, AUTO_ENV), api.deps);
    expect(r).toMatchObject({ ok: true });
    expect(api.calls).toHaveLength(2);
    expect(snapshotPairs(sqlite)).toHaveLength(7);
  });

  it('쪽이 끝없이 이어지면 최대 쪽수에서 실패 (무한 반복 방지)', async () => {
    const { sqlite, d1, clock } = ctx();
    const api = fakeApi({ body: okBody(defaultGroups()) }, clock, { perPage: 7, maxPages: 3 });
    const r = await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, AUTO_ENV), api.deps);
    expect(r).toEqual({ ok: false, code: 'too_many_pages' });
    expect(api.calls).toHaveLength(3);
    expect(snapshotPairs(sqlite)).toEqual([]);
  });

  it('실패해도 기존 사본과 sync_state 를 그대로 둔다', async () => {
    const failures: { name: string; spec: PageSpec; code: string }[] = [
      { name: '401', spec: { status: 401, body: { success: false, errors: [{ code: 10000 }] } }, code: 'api_http_401' },
      { name: '403', spec: { status: 403, body: { success: false, errors: [] } }, code: 'api_http_403' },
      { name: '500', spec: { status: 500, text: 'oops' }, code: 'api_http_500' },
      { name: '429', spec: { status: 429, text: '' }, code: 'api_http_429' },
      { name: '제한시간', spec: { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }, code: 'api_timeout' },
      { name: '네트워크', spec: { throws: new TypeError('network') }, code: 'api_network' },
      { name: '잘못된 JSON', spec: { text: '{not json' }, code: 'invalid_json' },
      { name: 'success:false', spec: { body: { success: false, errors: [], result: [] } }, code: 'api_not_ok' },
      { name: 'result 아님', spec: { body: { success: true, result: { a: 1 } } }, code: 'invalid_response' },
      { name: '필수 그룹 누락', spec: { body: okBody(defaultGroups().filter((g) => g.name !== 'UZ')) }, code: 'missing_group' },
      {
        name: '알 수 없는 규칙',
        spec: { body: okBody(defaultGroups().map((g) => (g.name === 'RND' ? { ...group('RND', []), include: [{ everyone: {} }] } : g))) },
        code: 'unknown_rule',
      },
      { name: 'ADMIN 0명', spec: { body: okBody(defaultGroups().map((g) => (g.name === 'ADMIN' ? group('ADMIN', []) : g))) }, code: 'admin_group_empty' },
    ];

    for (const f of failures) {
      const { sqlite, d1, clock } = ctx();
      seedOrg(sqlite);
      const before = snapshotPairs(sqlite);
      const beforeSynced = syncedAt(sqlite);
      const api = fakeApi(f.spec, clock);
      const r = await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, AUTO_ENV), api.deps);
      expect(r, f.name).toEqual({ ok: false, code: f.code });
      expect(snapshotPairs(sqlite), f.name).toEqual(before);
      expect(syncedAt(sqlite), f.name).toBe(beforeSynced);
      expect(syncState(sqlite), f.name).toMatchObject({ last_outcome: 'failure', last_failure_code: f.code, consecutive_failures: 1 });
      expect(auditActions(sqlite), f.name).toEqual(['group_sync_failed']);
    }
  });

  it('같은 사유로 연속 실패하면 감사기록은 1건, 사유가 바뀌면 1건 추가', async () => {
    const { sqlite, d1, clock } = ctx();
    seedOrg(sqlite);
    const env = makeEnv(d1, AUTO_ENV);
    const run = (spec: PageSpec) => runGroupSync(d1 as unknown as D1Database, env, fakeApi(spec, clock).deps);

    await run({ status: 401, text: '{}' });
    await run({ status: 401, text: '{}' });
    await run({ status: 401, text: '{}' });
    expect(auditActions(sqlite)).toEqual(['group_sync_failed']);
    expect(syncState(sqlite)).toMatchObject({ consecutive_failures: 3, last_failure_code: 'api_http_401' });

    await run({ text: '{bad' });
    expect(auditActions(sqlite)).toEqual(['group_sync_failed', 'group_sync_failed']);
    expect(syncState(sqlite)).toMatchObject({ consecutive_failures: 4, last_failure_code: 'invalid_json' });
  });

  it('사본이 30분을 넘기면 group_sync_stale 감사 1건만 (회복 전까지 반복 없음)', async () => {
    const { sqlite, d1, clock } = ctx();
    seedOrg(sqlite);
    const env = makeEnv(d1, AUTO_ENV);
    clock.now = new Date(NOW.getTime() + 31 * 60 * 1000);
    const run = (spec: PageSpec) => runGroupSync(d1 as unknown as D1Database, env, fakeApi(spec, clock).deps);

    await run({ status: 500, text: '' });
    expect(auditActions(sqlite)).toEqual(['group_sync_failed', 'group_sync_stale']);
    await run({ status: 500, text: '' });
    await run({ status: 500, text: '' });
    expect(auditActions(sqlite)).toEqual(['group_sync_failed', 'group_sync_stale']);

    // 회복하면 stale 표시가 지워져 다음 지연 때 다시 1건 남는다
    await run({ body: okBody(defaultGroups()) });
    expect(syncState(sqlite)).toMatchObject({ last_outcome: 'success', stale_audited_at: null, consecutive_failures: 0 });
  });

  it('변경이 없으면 감사기록을 남기지 않는다', async () => {
    const { sqlite, d1, clock } = ctx();
    const env = makeEnv(d1, AUTO_ENV);
    const run = () => runGroupSync(d1 as unknown as D1Database, env, fakeApi({ body: okBody(defaultGroups()) }, clock).deps);

    const first = await run();
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(auditActions(sqlite)).toEqual(['group_snapshot_sync']);

    clock.now = new Date(NOW.getTime() + 15 * 60 * 1000);
    const second = await run();
    expect(second).toMatchObject({ ok: true, changed: false, added: 0, removed: 0 });
    expect(auditActions(sqlite)).toEqual(['group_snapshot_sync']);
    // 내용은 그대로여도 동기화 시각은 갱신된다
    expect(syncedAt(sqlite)).toBe(clock.now.toISOString());
  });

  it('설정이 없으면 외부 호출 0건 · DB 변경 0건', async () => {
    const { sqlite, d1, clock } = ctx();
    seedOrg(sqlite);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = fakeApi({ body: okBody(defaultGroups()) }, clock);
    for (const env of [{}, { CF_ACCOUNT_ID: ACCOUNT }, { CF_ACCOUNT_ID: '<CF_ACCOUNT_ID>', CF_API_TOKEN: TOKEN }]) {
      const r = await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, env), api.deps);
      expect(r).toEqual({ ok: false, code: 'config_error' });
    }
    expect(api.calls).toEqual([]);
    expect(auditActions(sqlite)).toEqual([]);
    expect(syncState(sqlite)).toBeUndefined();
    expect(spy.mock.calls.every((c) => c[0] === 'config_error')).toBe(true);
    spy.mockRestore();
  });

  it('토큰 값은 로그·감사기록에 남지 않는다', async () => {
    const { sqlite, d1, clock } = ctx();
    const api = fakeApi({ status: 401, text: '{}' }, clock);
    await runGroupSync(d1 as unknown as D1Database, makeEnv(d1, AUTO_ENV), api.deps);
    const rows = sqlite.prepare('SELECT detail_json FROM audit_log').all() as { detail_json: string }[];
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain(ACCOUNT);
  });
});

describe('WP1 권한 반영', () => {
  async function syncedHarness(groups: Record<string, unknown>[]) {
    const h = await harness(AUTO_ENV);
    seedOrg(h.sqlite);
    const api = fakeApi({ body: okBody(groups) }, h.clock);
    const r = await runGroupSync(h.env.DB, h.env, api.deps);
    return { h, r };
  }

  it('모든 그룹에서 빠진 직원은 같은 JWT 로도 403', async () => {
    const { h, r } = await syncedHarness(defaultGroups().map((g) => (g.name === 'ALL' ? group('ALL', [ADMIN, ADMIN2]) : g.name === 'NONGJAJAE' ? group('NONGJAJAE', []) : g)));
    expect(r).toMatchObject({ ok: true });
    const t = await h.token(STAFF);
    const res = await h.call('/api/me', { token: t });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('no_access_group');
  });

  it('일부 그룹에서만 빠지면 그 그룹 상한에 기대던 권한만 무시', async () => {
    const { h } = await syncedHarness(defaultGroups().map((g) => (g.name === 'NONGJAJAE' ? group('NONGJAJAE', []) : g)));
    const me = await json(await h.call('/api/me', { token: await h.token(STAFF) }));
    expect(me.groups).toEqual(['ALL']);
    expect(me.roles).toEqual([]); // nongjajae OPERATOR 는 상한이 없어 무시됨
  });

  it('동기화 실패가 30분 넘게 이어지면 비ADMIN 쓰기 거부', async () => {
    const h = await harness(AUTO_ENV);
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'op@example.test', groups: ['ADMIN'], grants: [{ app_id: 'hub', role: 'OPERATOR' }] });
    h.clock.now = new Date(NOW.getTime() + 31 * 60 * 1000);
    await runGroupSync(h.env.DB, h.env, fakeApi({ status: 500, text: '' }, h.clock).deps);

    const res = await h.call('/api/admin/users', { token: await h.token('op@example.test'), body: {} });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('group_snapshot_stale');
  });
});

describe('WP1 수동 입력과의 관계', () => {
  const body = {
    groups: [
      { group_name: 'ADMIN', emails: [ADMIN] },
      { group_name: 'ALL', emails: [ADMIN, STAFF] },
    ],
  };

  it('자동 모드에서는 수동 입력이 409 auto_sync_enabled', async () => {
    const h = await harness(AUTO_ENV);
    seedOrg(h.sqlite);
    const res = await h.call('/api/admin/group-snapshot', { token: await h.token(ADMIN), body });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('auto_sync_enabled');
    // 거부됐으므로 사본·동기화 시각은 그대로
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM access_group_snapshot')).toBe(3);
    expect(syncedAt(h.sqlite)).toBe(NOW.toISOString());
  });

  it('자동 모드가 아니면 수동 입력이 지금처럼 동작', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const res = await h.call('/api/admin/group-snapshot', { token: await h.token(ADMIN), body });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ groups: 2, members: 3 });
    expect(auditActions(h.sqlite)).toEqual(['group_snapshot_replace']);
  });

  it('관리 화면에 동기화 상태가 나온다', async () => {
    const h = await harness(AUTO_ENV);
    seedOrg(h.sqlite);
    await runGroupSync(h.env.DB, h.env, fakeApi({ status: 401, text: '{}' }, h.clock).deps);
    const data = await json(await h.call('/api/admin/users', { token: await h.token(ADMIN) }));
    expect(data.snapshot.sync).toMatchObject({
      auto: true,
      next_run_at: '2026-09-16T12:15:00.000Z',
      last_outcome: 'failure',
      last_failure_code: 'api_http_401',
      consecutive_failures: 1,
    });
  });

  it('자동 모드가 아니면 next_run_at 은 null', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const data = await json(await h.call('/api/admin/users', { token: await h.token(ADMIN) }));
    expect(data.snapshot.sync).toMatchObject({ auto: false, next_run_at: null, last_outcome: null, consecutive_failures: 0 });
  });
});

describe('WP1 시각 형식', () => {
  it('저장되는 시각은 모두 YYYY-MM-DDTHH:MM:SS.sssZ', async () => {
    const { sqlite, d1, clock } = ctx();
    const env = makeEnv(d1, AUTO_ENV);
    await runGroupSync(d1 as unknown as D1Database, env, fakeApi({ body: okBody(defaultGroups()) }, clock).deps);
    clock.now = new Date(NOW.getTime() + 60_000);
    await runGroupSync(d1 as unknown as D1Database, env, fakeApi({ status: 500, text: '' }, clock).deps);

    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const st = syncState(sqlite)!;
    expect(st.last_attempt_at).toMatch(re);
    expect(syncedAt(sqlite)).toMatch(re);
    for (const r of sqlite.prepare('SELECT synced_at FROM access_group_snapshot').all() as { synced_at: string }[]) {
      expect(r.synced_at).toMatch(re);
    }
  });

  it('setSynced 없이 처음 실행해도 상태 표가 하나만 생긴다', async () => {
    const { sqlite, d1, clock } = ctx();
    setSynced(sqlite, null);
    const env = makeEnv(d1, AUTO_ENV);
    await runGroupSync(d1 as unknown as D1Database, env, fakeApi({ status: 500, text: '' }, clock).deps);
    await runGroupSync(d1 as unknown as D1Database, env, fakeApi({ status: 500, text: '' }, clock).deps);
    expect(count(sqlite, 'SELECT COUNT(*) FROM group_sync_state')).toBe(1);
  });
});
