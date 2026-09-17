import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { isHealthyStatus, nextState, probe, runUptimeChecks } from '../src/uptime';
import { ADMIN, count, createDb, harness, json, makeEnv, NOW, seedOrg, STAFF } from './helpers';

type Behavior = number | 'throw' | 'hang' | { head: number; get: number };

function mockFetch(behaviors: Map<string, Behavior>) {
  const calls: { url: string; method: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const b = behaviors.get(url) ?? 200;
    if (b === 'throw') throw new TypeError('network down');
    if (b === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }
    const status = typeof b === 'number' ? b : method === 'HEAD' ? b.head : b.get;
    return new Response(method === 'HEAD' ? null : 'body', { status });
  });
  return { fn, calls };
}

const FINO = 'https://firmmit-fino.vercel.app';

function onlyFino() {
  const { sqlite, d1 } = createDb();
  sqlite.prepare("UPDATE app_registry SET health_url = NULL WHERE app_id <> 'fino'").run();
  return { sqlite, d1, db: d1 as unknown as D1Database };
}

const state = (sqlite: ReturnType<typeof onlyFino>['sqlite']) =>
  sqlite.prepare("SELECT * FROM uptime_state WHERE app_id = 'fino'").get() as Record<string, unknown> | undefined;
const audits = (sqlite: ReturnType<typeof onlyFino>['sqlite']) =>
  count(sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'uptime_state_change'");

describe('가용성 점검', () => {
  it('UP → 1회 실패 UP 유지 → 2회 연속 DOWN → 계속 DOWN → 복구 UP, 변화 때만 감사 1건', async () => {
    const { sqlite, db } = onlyFino();
    sqlite
      .prepare("INSERT INTO uptime_state (app_id, state, consecutive_failures, last_checked_at, last_change_at) VALUES ('fino', 'UP', 0, ?, ?)")
      .run('2026-09-16T11:00:00.000Z', '2026-09-10T00:00:00.000Z');
    const b = new Map<string, Behavior>();
    const { fn } = mockFetch(b);
    let t = NOW.getTime();
    const deps = { fetch: fn, now: () => new Date((t += 300_000)), timeoutMs: 50 };

    b.set(FINO, 503);
    expect(await runUptimeChecks(db, deps)).toEqual({ checked: 1, changes: 0, errors: 0 });
    expect(state(sqlite)).toMatchObject({ state: 'UP', consecutive_failures: 1, last_status_code: 503, last_change_at: '2026-09-10T00:00:00.000Z' });
    expect(audits(sqlite)).toBe(0);

    b.set(FINO, 'throw');
    expect((await runUptimeChecks(db, deps)).changes).toBe(1);
    expect(state(sqlite)).toMatchObject({ state: 'DOWN', consecutive_failures: 2, last_status_code: null });
    expect(state(sqlite)!.last_change_at).toBe(state(sqlite)!.last_checked_at);
    expect(audits(sqlite)).toBe(1);

    b.set(FINO, 'hang'); // 시간 초과
    await runUptimeChecks(db, deps);
    expect(state(sqlite)).toMatchObject({ state: 'DOWN', consecutive_failures: 3 });
    expect(audits(sqlite)).toBe(1);

    b.set(FINO, 200);
    expect((await runUptimeChecks(db, deps)).changes).toBe(1);
    expect(state(sqlite)).toMatchObject({ state: 'UP', consecutive_failures: 0, last_status_code: 200 });
    expect(audits(sqlite)).toBe(2);

    await runUptimeChecks(db, deps);
    expect(audits(sqlite)).toBe(2);

    const rows = sqlite.prepare("SELECT actor_email, target, detail_json FROM audit_log WHERE action = 'uptime_state_change' ORDER BY id").all() as {
      actor_email: string;
      target: string;
      detail_json: string;
    }[];
    expect(rows.map((r) => JSON.parse(r.detail_json))).toEqual([
      { from: 'UP', to: 'DOWN', consecutive_failures: 2, status_code: null },
      { from: 'DOWN', to: 'UP', consecutive_failures: 0, status_code: 200 },
    ]);
    expect(rows[0]).toMatchObject({ actor_email: 'system:cron', target: 'app:fino' });
  });

  it('처음 상태(기록 없음): 1회 실패는 UNKNOWN 유지, 첫 성공은 UP 으로 1건 기록', async () => {
    const { sqlite, db } = onlyFino();
    const b = new Map<string, Behavior>([[FINO, 500]]);
    const deps = { fetch: mockFetch(b).fn, now: () => NOW };
    await runUptimeChecks(db, deps);
    expect(state(sqlite)).toMatchObject({ state: 'UNKNOWN', consecutive_failures: 1, last_change_at: null });
    expect(audits(sqlite)).toBe(0);
    b.set(FINO, 200);
    await runUptimeChecks(db, deps);
    expect(state(sqlite)).toMatchObject({ state: 'UP' });
    expect(audits(sqlite)).toBe(1);
  });

  it('HEAD 405 → GET 재시도, 리다이렉트 따라가지 않음, 5초 제한 신호 전달', async () => {
    const { db } = onlyFino();
    const b = new Map<string, Behavior>([[FINO, { head: 405, get: 200 }]]);
    const m = mockFetch(b);
    await runUptimeChecks(db, { fetch: m.fn, now: () => NOW });
    expect(m.calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    const init = m.fn.mock.calls[0]![1]!;
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('점검 대상: health_url 있고 미연결 아님 (시드 기준 9개)', async () => {
    const { d1 } = createDb();
    const m = mockFetch(new Map());
    const r = await runUptimeChecks(d1 as unknown as D1Database, { fetch: m.fn, now: () => NOW });
    expect(r.checked).toBe(9);
    expect(m.calls.every((c) => c.url.startsWith('https://'))).toBe(true);
    expect(m.calls.map((c) => c.url)).not.toContain('https://t.me/firmmit_global');
  });

  it('상태 코드 판정', () => {
    for (const c of [200, 204, 301, 302, 304, 401, 403]) expect(isHealthyStatus(c)).toBe(true);
    for (const c of [400, 404, 429, 500, 502, 503]) expect(isHealthyStatus(c)).toBe(false);
    expect(nextState(null, false)).toEqual({ state: 'UNKNOWN', consecutive_failures: 1 });
    expect(nextState({ state: 'DOWN', consecutive_failures: 5 }, true)).toEqual({ state: 'UP', consecutive_failures: 0 });
  });

  it('https 가 아닌 주소는 요청하지 않음', async () => {
    const m = mockFetch(new Map());
    expect(await probe('http://example.test', { fetch: m.fn, now: () => NOW })).toEqual({ ok: false, status: null });
    expect(m.fn).not.toHaveBeenCalled();
  });

  it('scheduled 핸들러: 운영 설정 오류면 점검하지 않음, 정상이면 waitUntil 로 실행', async () => {
    const { d1 } = createDb();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const m = mockFetch(new Map());
    vi.stubGlobal('fetch', m.fn);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ctrl = { cron: '*/5 * * * *', scheduledTime: NOW.getTime(), noRetry() {} } as unknown as ScheduledController;
      await worker.scheduled!(ctrl, makeEnv(d1, { DEV_FAKE_IDENTITY: 'x@example.test' }), ctx);
      expect(waits).toHaveLength(0);
      expect(m.fn).not.toHaveBeenCalled();
      await worker.scheduled!(ctrl, makeEnv(d1), ctx);
      await Promise.all(waits);
      expect(m.fn).toHaveBeenCalledTimes(9);
    } finally {
      vi.unstubAllGlobals();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('GET /api/status', () => {
  async function setup() {
    const h = await harness();
    seedOrg(h.sqlite);
    h.sqlite
      .prepare(
        "INSERT INTO uptime_state (app_id, state, consecutive_failures, last_checked_at, last_change_at, last_status_code) VALUES ('fino', 'DOWN', 3, '2026-09-16T11:55:00.000Z', '2026-09-16T11:50:00.000Z', 502), ('nongjajae', 'UP', 0, '2026-09-16T11:56:00.000Z', NULL, 200)",
      )
      .run();
    return h;
  }

  it('직원: 전체 요약 + 볼 수 있는 앱의 상태만 (상세 없음)', async () => {
    const h = await setup();
    const body = await json(await h.call('/api/status', { token: await h.token(STAFF) }));
    expect(body.detail).toBe(false);
    expect(body.summary).toEqual({ up: 1, down: 1, unknown: 7, monitored: 9 });
    expect(body.last_checked_at).toBe('2026-09-16T11:56:00.000Z');
    const fino = body.items.find((i: { app_id: string }) => i.app_id === 'fino');
    expect(fino).toEqual({ app_id: 'fino', name: expect.any(Object), state: 'DOWN' });
    expect(body.items.map((i: { app_id: string }) => i.app_id)).not.toContain('icheon-vfarm');
    expect(JSON.stringify(body)).not.toContain('502');
  });

  it('ADMIN: 상세 포함', async () => {
    const h = await setup();
    const body = await json(await h.call('/api/status', { token: await h.token(ADMIN) }));
    expect(body.detail).toBe(true);
    expect(body.items).toHaveLength(9);
    expect(body.items.find((i: { app_id: string }) => i.app_id === 'fino')).toMatchObject({
      state: 'DOWN',
      consecutive_failures: 3,
      last_status_code: 502,
      last_change_at: '2026-09-16T11:50:00.000Z',
    });
  });

  it('DB 오류 → 500 오류 상태 (0 이나 빈 목록으로 바꾸지 않음)', async () => {
    const h = await setup();
    const t = await h.token(STAFF);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sqlite.exec('ALTER TABLE uptime_state RENAME TO uptime_state_gone');
    const res = await h.call('/api/status', { token: t });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: { code: 'internal_error', message: 'Internal error' } });
    errSpy.mockRestore();
  });
});
