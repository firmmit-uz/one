// WP2: KPI 게이트웨이 수직 슬라이스 (봉투 → 검증 → 신선도 재계산 → 캐시 → 권한 필터 → 화면)
import { describe, expect, it, vi } from 'vitest';
import { validateEnvelope } from '@firmmit-one/contracts/worker';
import { makeEnvelope, uptimeKpi, phase0Kpi, staleCountKpi, unavailableKpi } from '../src/kpi/collect';
import { displayStatus, recomputeStale, refreshInternalKpis, viewLevelFor } from '../src/kpi/gateway';
import { TIER_STALE_SECONDS, worstStatus } from '../src/kpi/defs';
import { checkEvidenceRef } from '../src/kpi/phase0';
import { fetchFromSource, scopeKeyOf, type KpiSource } from '../src/kpi/source';
import { ADMIN, count, harness, json, NOW, seedOrg, seedUser, STAFF } from './helpers';
import type { Harness } from './helpers';

const ENV = 'production';

async function refreshed(h: Harness, at: Date = NOW) {
  h.clock.now = at;
  return refreshInternalKpis(h.env.DB, ENV, { now: () => at, requestId: 'test-refresh' });
}

function seedUptime(h: Harness, rows: [string, 'UP' | 'DOWN' | 'UNKNOWN', number][]) {
  const stmt = h.sqlite.prepare(
    'INSERT INTO uptime_state (app_id, state, consecutive_failures, last_checked_at, last_change_at, last_status_code) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [app, state, failures] of rows) stmt.run(app, state, failures, NOW.toISOString(), NOW.toISOString(), state === 'UP' ? 200 : 503);
}

describe('WP2 봉투 만들기', () => {
  const env = (kpi: ReturnType<typeof uptimeKpi>) => JSON.stringify(makeEnvelope('req-12345678', NOW, [kpi], 'production'));

  it('내부 KPI 봉투도 계약 v1.2 를 그대로 통과한다', () => {
    const cases = [
      uptimeKpi([{ app_id: 'nongjajae', state: 'UP', last_checked_at: NOW.toISOString() }], NOW),
      phase0Kpi([{ item_id: 'V0', state: 'passed', sort: 0 }, { item_id: 'V1', state: 'pending', sort: 1 }], NOW),
      staleCountKpi([{ kpi_id: 'SYS.UPTIME', status: 'stale' }], [{ kpi_id: 'SYS.UPTIME', group_name: 'ALL' }], NOW),
      unavailableKpi('SYS.TOKEN_EXPIRY', NOW, '토큰 갱신 모듈이 꺼져 있음'),
    ];
    for (const k of cases) {
      const r = validateEnvelope(env(k));
      expect(r.ok, `${k.kpi_id}: ${r.errors.map((e) => `${e.rule}@${e.path}`).join(',')}`).toBe(true);
    }
  });

  it('점검 기록이 없으면 data_as_of 는 null (0 으로 바꾸지 않는다)', () => {
    const k = uptimeKpi([{ app_id: 'x', state: 'UNKNOWN', last_checked_at: null }], NOW);
    expect(k.data_as_of).toBeNull();
    expect(k.measure.value).toBe(0); // DOWN 이 0건인 것과 "모름" 은 다르다
    expect(validateEnvelope(env(k)).ok).toBe(true);
  });

  it('준비 중 카드는 값이 null 이고 오류 코드가 붙는다', () => {
    const k = unavailableKpi('SYS.P1_UNACKED', NOW, '알림센터가 아직 없음');
    expect(k.status).toBe('unavailable');
    expect(k.measure.value).toBeNull();
    expect(k.error?.code).toBe('NOT_IMPLEMENTED');
    expect(validateEnvelope(env(k)).ok).toBe(true);
  });

  it('통과 수는 passed 만 센다 (미시험·실패·해당없음 제외)', () => {
    const rows = [
      { item_id: 'V0', state: 'passed', sort: 0 },
      { item_id: 'V1', state: 'pending', sort: 1 },
      { item_id: 'V2', state: 'failed', sort: 2 },
      { item_id: 'V3', state: 'na', sort: 3 },
    ];
    expect(phase0Kpi(rows, NOW).measure.value).toBe(1);
  });
});

describe('WP2 신선도 재계산', () => {
  const def = {
    system: 'one',
    kpi_id: 'SYS.UPTIME',
    definition_version: '1.0',
    name_ko: '앱 가용성',
    unit: 'count',
    tier: 'T-SYS',
    clock_basis: 'updated_at',
    verdict_source: 'one',
    definition_note: '',
    created_at: NOW.toISOString(),
  };

  it('T-SYS 기준 15분', () => {
    expect(TIER_STALE_SECONDS['T-SYS']).toBe(900);
    const fresh = recomputeStale(def, { updated_at: NOW.toISOString(), data_as_of: null }, new Date(NOW.getTime() + 900_000));
    expect(fresh.is_stale).toBe(false); // 정각은 아직 아님
    const stale = recomputeStale(def, { updated_at: NOW.toISOString(), data_as_of: null }, new Date(NOW.getTime() + 900_001 + 999));
    expect(stale.is_stale).toBe(true);
    expect(stale.verdict_source).toBe('one');
  });

  it('기준 시각을 해석할 수 없으면 stale (fail-closed)', () => {
    const r = recomputeStale(def, { updated_at: '어제', data_as_of: null }, NOW);
    expect(r).toMatchObject({ is_stale: true, age_seconds: null });
  });

  it('clock_basis 가 data_as_of 면 그 값을 본다', () => {
    const d = { ...def, clock_basis: 'data_as_of' };
    const old = new Date(NOW.getTime() - 3600_000).toISOString();
    const r = recomputeStale(d, { updated_at: NOW.toISOString(), data_as_of: old }, NOW);
    expect(r.basis).toBe('data_as_of');
    expect(r.is_stale).toBe(true);
  });

  it('소스가 ok 라고 해도 ONE 이 stale 로 판정하면 stale', () => {
    const stale = { is_stale: true } as ReturnType<typeof recomputeStale>;
    expect(displayStatus('ok', stale)).toBe('stale');
    // 오류가 더 세다
    expect(displayStatus('error', stale)).toBe('error');
    expect(displayStatus('unavailable', stale)).toBe('unavailable');
    expect(worstStatus('partial', 'stale')).toBe('stale');
    expect(worstStatus('ok', 'partial')).toBe('partial');
    // 모르는 상태는 오류로 본다
    expect(displayStatus('nonsense', { is_stale: false } as ReturnType<typeof recomputeStale>)).toBe('error');
  });
});

describe('WP2 권한 필터', () => {
  const vis = [
    { kpi_id: 'SYS.UPTIME', group_name: 'ALL', level: 'summary' as const },
    { kpi_id: 'SYS.UPTIME', group_name: 'ADMIN', level: 'detail' as const },
    { kpi_id: 'SYS.PHASE0', group_name: 'ADMIN', level: 'detail' as const },
  ];

  it('그룹에 맞는 가장 높은 수준을 준다', () => {
    expect(viewLevelFor('SYS.UPTIME', vis, new Set(['ALL']))).toBe('summary');
    expect(viewLevelFor('SYS.UPTIME', vis, new Set(['ALL', 'ADMIN']))).toBe('detail');
    expect(viewLevelFor('SYS.PHASE0', vis, new Set(['ALL']))).toBeNull();
    expect(viewLevelFor('SYS.UPTIME', vis, new Set())).toBeNull();
  });
});

describe('WP2 수직 슬라이스 (직원 1명 · KPI 1개, 끝에서 끝까지)', () => {
  async function ready() {
    const h = await harness();
    seedOrg(h.sqlite);
    // 직원에게 ALL 그룹을 준다 (동기화 뒤 상태를 흉내)
    h.sqlite.prepare('INSERT INTO access_group_snapshot (group_name, email, synced_at) VALUES (?, ?, ?)').run('ALL', STAFF, NOW.toISOString());
    seedUptime(h, [['nongjajae', 'UP', 0], ['amim', 'DOWN', 2], ['icheon-vfarm', 'UP', 0]]);
    await refreshed(h);
    return h;
  }

  it('수집 → 저장 → 조회: 직원은 요약, 관리자는 상세', async () => {
    const h = await ready();
    const staff = await json(await h.call('/api/kpi', { token: await h.token(STAFF) }));
    const ids = staff.kpis.map((k: { kpi_id: string }) => k.kpi_id).sort();
    expect(ids).toEqual(['SYS.KPI_STALE_COUNT', 'SYS.UPTIME']);
    const up = staff.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.UPTIME');
    expect(up).toMatchObject({ display_status: 'ok', view_level: 'summary' });
    expect(up.measure).toEqual({ kind: 'count', value: 1, unit: 'count' }); // DOWN 1건
    expect(up.breakdown).toBeUndefined(); // 요약에는 앱별 상태를 주지 않는다
    expect(up.stale).toMatchObject({ is_stale: false, basis: 'updated_at', threshold_seconds: 900, verdict_source: 'one' });

    const admin = await json(await h.call('/api/kpi', { token: await h.token(ADMIN) }));
    const adminIds = admin.kpis.map((k: { kpi_id: string }) => k.kpi_id).sort();
    expect(adminIds).toEqual(['SYS.KPI_STALE_COUNT', 'SYS.P1_UNACKED', 'SYS.PHASE0', 'SYS.TLS_EXPIRY', 'SYS.TOKEN_EXPIRY', 'SYS.UPTIME']);
    const adminUp = admin.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.UPTIME');
    expect(adminUp.view_level).toBe('detail');
    expect(adminUp.breakdown.map((b: { key: string }) => b.key)).toContain('app:amim');
    expect(admin.summary).toMatchObject({ visible: 6, stale: 0, error: 0, unavailable: 3 });
  });

  it('권한을 회수하면(그룹에서 빠지면) 다음 조회에서 사라진다', async () => {
    const h = await ready();
    const t = await h.token(STAFF);
    expect((await json(await h.call('/api/kpi', { token: t }))).kpis.length).toBe(2);
    h.sqlite.prepare('DELETE FROM access_group_snapshot WHERE email = ? AND group_name = ?').run(STAFF, 'ALL');
    const after = await json(await h.call('/api/kpi', { token: t }));
    expect(after.kpis).toEqual([]);
    expect(after.summary.visible).toBe(0);
  });

  it('볼 수 없는 KPI 는 응답에 아예 없고, 개별 조회는 404 (존재 여부를 흘리지 않음)', async () => {
    const h = await ready();
    const t = await h.token(STAFF);
    const body = await json(await h.call('/api/kpi', { token: t }));
    expect(JSON.stringify(body)).not.toContain('SYS.PHASE0');
    const res = await h.call('/api/kpi/SYS.PHASE0', { token: t });
    expect(res.status).toBe(404);
    // 아예 없는 KPI 와 같은 응답
    expect((await h.call('/api/kpi/SYS.NOPE', { token: t })).status).toBe(404);
    // 관리자에게는 보인다
    expect((await h.call('/api/kpi/SYS.PHASE0', { token: await h.token(ADMIN) })).status).toBe(200);
  });

  it('15분이 지나면 지연으로 바뀌고 지연 KPI 수에 반영된다', async () => {
    const h = await ready();
    const later = new Date(NOW.getTime() + 20 * 60_000);
    h.clock.now = later;
    const body = await json(await h.call('/api/kpi', { token: await h.token(ADMIN) }));
    const up = body.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.UPTIME');
    expect(up.display_status).toBe('stale');
    expect(up.source_status).toBe('ok'); // 소스 신고와 ONE 판정을 따로 보여준다
    expect(up.age_seconds).toBe(1200);
    expect(body.summary.stale).toBeGreaterThanOrEqual(3);

    // 다시 수집하면 회복되고, 지연 KPI 수도 0 이 된다
    await refreshed(h, later);
    const fresh = await json(await h.call('/api/kpi', { token: await h.token(ADMIN) }));
    expect(fresh.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.UPTIME').display_status).toBe('ok');
    expect(fresh.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.KPI_STALE_COUNT').measure.value).toBe(0);
  });

  it('지연 KPI 수의 breakdown 은 요약 수준에서 자기 그룹만 보인다', async () => {
    const h = await ready();
    const staff = await json(await h.call('/api/kpi', { token: await h.token(STAFF) }));
    const sc = staff.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.KPI_STALE_COUNT');
    const keys = (sc.breakdown ?? []).map((b: { key: string }) => b.key);
    expect(keys).toEqual(['group:ALL']);

    const admin = await json(await h.call('/api/kpi', { token: await h.token(ADMIN) }));
    const adminSc = admin.kpis.find((k: { kpi_id: string }) => k.kpi_id === 'SYS.KPI_STALE_COUNT');
    expect(adminSc.breakdown.map((b: { key: string }) => b.key)).toContain('group:BREAKGLASS');
  });

  it('조회 감사는 감사 체인에 넣지 않고 구조화 로그만 남긴다', async () => {
    const h = await ready();
    const before = count(h.sqlite, 'SELECT COUNT(*) FROM audit_log');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await h.call('/api/kpi', { token: await h.token(ADMIN) });
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(before);
    const line = spy.mock.calls.find((c) => c[0] === 'kpi_read');
    expect(line).toBeDefined();
    expect(JSON.parse(String(line?.[1]))).toMatchObject({ actor_email: ADMIN });
    spy.mockRestore();
  });

  it('모르는 질의 변수는 거부', async () => {
    const h = await ready();
    const res = await h.call('/api/kpi?all=1', { token: await h.token(ADMIN) });
    expect(res.status).toBe(400);
  });

  it('캐시가 깨져 있으면 그 KPI 를 내보내지 않는다 (0 으로 바꾸지 않음)', async () => {
    const h = await ready();
    // json_valid CHECK 가 깨진 JSON 자체는 막는다 → 형태가 다른 값 두 가지로 확인한다
    h.sqlite.prepare("UPDATE kpi_cache SET value_json = '[]' WHERE kpi_id = 'SYS.UPTIME'").run();
    // 객체이지만 measure 가 없는 경우도 내보내지 않는다 (undefined 를 값처럼 보여주면 안 된다)
    h.sqlite.prepare(`UPDATE kpi_cache SET value_json = '{"kpi_id":"SYS.PHASE0"}' WHERE kpi_id = 'SYS.PHASE0'`).run();
    const body = await json(await h.call('/api/kpi', { token: await h.token(ADMIN) }));
    const ids = body.kpis.map((k: { kpi_id: string }) => k.kpi_id);
    expect(ids).not.toContain('SYS.UPTIME');
    expect(ids).not.toContain('SYS.PHASE0');
    for (const k of body.kpis) expect(k.measure).toBeTruthy();
  });

  it('마지막 정상 시각은 오류가 나도 지워지지 않는다', async () => {
    const h = await ready();
    const before = h.sqlite.prepare("SELECT last_success_at FROM kpi_cache WHERE kpi_id = 'SYS.UPTIME'").get() as { last_success_at: string };
    expect(before.last_success_at).toBe(NOW.toISOString());
    // 준비 중 카드는 처음부터 성공한 적이 없다
    const never = h.sqlite.prepare("SELECT last_success_at FROM kpi_cache WHERE kpi_id = 'SYS.TOKEN_EXPIRY'").get() as { last_success_at: string | null };
    expect(never.last_success_at).toBeNull();
  });
});

describe('WP2 Phase 0 체크리스트 (허브 ADMIN 관리 입력)', () => {
  async function ready() {
    const h = await harness();
    seedOrg(h.sqlite);
    return h;
  }

  it('증적 칸은 주소·이메일·비밀값 형태를 거부한다', () => {
    const bad = [
      'https://example.invalid/evidence',
      'http://x.test',
      'admin@example.invalid',
      'deadbeefdeadbeefdeadbeef0123',
      'AKIAIOSFODNN7EXAMPLEKEYVALUE1234',
      '별첨 <script>',
      '증적: https://…',
    ];
    for (const v of bad) expect(checkEvidenceRef(v).ok, v).toBe(false);
    for (const v of ['별첨 S-6 7행', '별첨 S-2 앱 사용 행 (B1 교차확인)', 'V13 실측 2026-09-16', '재검수 K6']) {
      expect(checkEvidenceRef(v).ok, v).toBe(true);
    }
  });

  it('통과 표시에는 증적 참조가 있어야 한다', async () => {
    const h = await ready();
    const t = await h.token(ADMIN);
    const noEvidence = await h.call('/api/admin/phase0/V0', { token: t, body: { state: 'passed' } });
    expect(noEvidence.status).toBe(400);
    expect((await json(noEvidence)).error.message).toContain('evidence_required');

    const badEvidence = await h.call('/api/admin/phase0/V0', { token: t, body: { state: 'passed', evidence_ref: 'https://x.test' } });
    expect(badEvidence.status).toBe(400);

    const ok = await h.call('/api/admin/phase0/V0', { token: t, body: { state: 'passed', evidence_ref: '별첨 S-1 3행', reason: '실측 완료' } });
    expect(ok.status).toBe(200);
    expect((await json(ok)).item).toMatchObject({ item_id: 'V0', state: 'passed', updated_by: ADMIN });
  });

  it('변경 + 감사기록이 한 batch 로 남는다', async () => {
    const h = await ready();
    const t = await h.token(ADMIN);
    await h.call('/api/admin/phase0/V1', { token: t, body: { state: 'failed', evidence_ref: '별첨 S-1 4행' } });
    const last = h.sqlite.prepare('SELECT action, target, detail_json FROM audit_log ORDER BY id DESC LIMIT 1').get() as {
      action: string;
      target: string;
      detail_json: string;
    };
    expect(last).toMatchObject({ action: 'phase0_update', target: 'phase0:V1' });
    expect(JSON.parse(last.detail_json)).toMatchObject({ from: { state: 'pending' }, to: { state: 'failed' } });
  });

  it('같은 값으로 다시 저장하면 409, 없는 항목은 404, 형식 밖 항목은 400', async () => {
    const h = await ready();
    const t = await h.token(ADMIN);
    await h.call('/api/admin/phase0/V2', { token: t, body: { state: 'na' } });
    expect((await h.call('/api/admin/phase0/V2', { token: t, body: { state: 'na' } })).status).toBe(409);
    expect((await h.call('/api/admin/phase0/V14', { token: t, body: { state: 'na' } })).status).toBe(400);
    expect((await h.call('/api/admin/phase0/X1', { token: t, body: { state: 'na' } })).status).toBe(400);
  });

  it('관리자가 아니면 읽기·쓰기 모두 403', async () => {
    const h = await ready();
    const t = await h.token(STAFF);
    expect((await h.call('/api/admin/phase0', { token: t })).status).toBe(403);
    expect((await h.call('/api/admin/phase0/V0', { token: t, body: { state: 'na' } })).status).toBe(403);
  });

  it('체크리스트 14개(V0–V13)가 미시험 상태로 시작한다', async () => {
    const h = await ready();
    const body = await json(await h.call('/api/admin/phase0', { token: await h.token(ADMIN) }));
    expect(body.total).toBe(14);
    expect(body.passed).toBe(0);
    expect(body.items.map((i: { item_id: string }) => i.item_id)).toEqual(
      ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13'],
    );
  });

  it('체크리스트를 바꾸면 다음 수집에서 SYS.PHASE0 값이 따라 바뀐다', async () => {
    const h = await ready();
    const t = await h.token(ADMIN);
    await refreshed(h);
    expect((await json(await h.call('/api/kpi/SYS.PHASE0', { token: t }))).kpi.measure.value).toBe(0);
    await h.call('/api/admin/phase0/V0', { token: t, body: { state: 'passed', evidence_ref: '별첨 S-1 3행' } });
    await h.call('/api/admin/phase0/V1', { token: t, body: { state: 'passed', evidence_ref: '별첨 S-1 4행' } });
    await refreshed(h);
    const kpi = (await json(await h.call('/api/kpi/SYS.PHASE0', { token: t }))).kpi;
    expect(kpi.measure.value).toBe(2);
    expect(kpi.breakdown.find((b: { key: string }) => b.key === 'total').measure.value).toBe(14);
    expect(kpi.quality).toMatchObject({ level: 'unverified', flags: ['MANUAL_ENTRY'] });
  });
});

describe('WP2 외부 소스 어댑터 (가짜 소스 — 실제 연결 없음)', () => {
  const baseKpi = (over: Record<string, unknown> = {}) => ({
    kpi_id: 'DIST.ORDERS_PENDING',
    definition_version: '1.0',
    status: 'ok',
    measure: { kind: 'count', value: 7, unit: 'count' },
    period: { type: 'instant', tz: 'Asia/Seoul' },
    updated_at: '2026-09-16T11:59:00Z',
    data_as_of: '2026-09-16',
    quality: { level: 'verified', flags: [] },
    sensitivity: 'department',
    ...over,
  });
  const envelope = (kpis: unknown[]) =>
    JSON.stringify({
      schema_version: '1.2',
      request_id: 'src-12345678',
      generated_at: NOW.toISOString(),
      source: { system: 'nongjajae', source_version: '4.6.1', environment: 'production' },
      kpis,
    });
  const source = (text: string | (() => Promise<string>)): KpiSource => ({
    summary: typeof text === 'string' ? async () => text : text,
  });
  const req = { request_id: 'src-12345678', actor_email: STAFF };

  it('정상 봉투는 받아들이고 범위 키를 만든다', async () => {
    const r = await fetchFromSource(source(envelope([baseKpi()])), req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.system).toBe('nongjajae');
    expect(r.kpis[0]).toMatchObject({ kpi_id: 'DIST.ORDERS_PENDING', status: 'ok', scope_key: 'instant|Asia/Seoul' });
  });

  it('스키마 위반은 받지 않는다 (error)', async () => {
    const r = await fetchFromSource(source(envelope([baseKpi({ status: 'nonsense' })])), req);
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_SCHEMA' });
  });

  it('제한시간을 넘기면 SOURCE_TIMEOUT', async () => {
    const slow = source(() => new Promise<string>((res) => setTimeout(() => res(envelope([baseKpi()])), 200)));
    const r = await fetchFromSource(slow, req, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_TIMEOUT' });
  });

  it('소스가 죽으면 UPSTREAM_DOWN', async () => {
    const r = await fetchFromSource({ summary: async () => { throw new Error('boom'); } }, req);
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_DOWN' });
  });

  it('원문이 아닌 객체를 돌려주면 거부 (원문 토큰 검사를 못 하게 되므로)', async () => {
    const r = await fetchFromSource({ summary: async () => ({ schema_version: '1.2' }) as unknown as string }, req);
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_SCHEMA' });
  });

  it('소스가 ok 를 보냈어도 kpi_def 기준으로는 stale 일 수 있다', async () => {
    const old = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString(); // T-OPS 기준 1시간을 넘김
    const r = await fetchFromSource(source(envelope([baseKpi({ updated_at: old })])), req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = {
      system: 'nongjajae', kpi_id: 'DIST.ORDERS_PENDING', definition_version: '1.0', name_ko: '', unit: 'count',
      tier: 'T-OPS', clock_basis: 'updated_at', verdict_source: 'one', definition_note: '', created_at: old,
    };
    const verdict = recomputeStale(def, { updated_at: r.kpis[0]!.updated_at, data_as_of: null }, NOW);
    expect(verdict.is_stale).toBe(true);
    expect(displayStatus(r.kpis[0]!.status, verdict)).toBe('stale');
  });

  it('통화가 다른 값을 합치려는 봉투는 거부', async () => {
    const mixed = baseKpi({
      measure: { kind: 'money', value: 1000, unit: 'KRW', currency: 'KRW', minor_exponent: 0 },
      compare: { previous: { kind: 'money', value: 900, unit: 'UZS', currency: 'UZS', minor_exponent: 2 } },
    });
    const r = await fetchFromSource(source(envelope([mixed])), req);
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_SCHEMA' });
    if (r.ok) return;
    expect(r.rules).toContain('sem.compare_currency');
  });

  it('sensitivity personal 은 거부 (개인정보는 KPI 봉투로 받지 않는다)', async () => {
    const r = await fetchFromSource(source(envelope([baseKpi({ sensitivity: 'personal' })])), req);
    expect(r).toMatchObject({ ok: false, code: 'SOURCE_SCHEMA' });
    if (r.ok) return;
    expect(r.rules).toContain('sem.no_personal');
  });

  it('null 과 0 을 구분한다', async () => {
    const zero = await fetchFromSource(source(envelope([baseKpi({ measure: { kind: 'count', value: 0, unit: 'count' } })])), req);
    expect(zero.ok).toBe(true);
    if (zero.ok) expect((zero.kpis[0]!.raw.measure as { value: number }).value).toBe(0);
    // 값이 null 인데 status 가 ok 면 계약 위반
    const nul = await fetchFromSource(source(envelope([baseKpi({ measure: { kind: 'count', value: null, unit: 'count' } })])), req);
    expect(nul.ok).toBe(false);
  });

  it('범위 키는 기간·시간대·통화를 구분한다', () => {
    expect(scopeKeyOf({ period: { type: 'mtd', tz: 'Asia/Seoul', start: '2026-09-01', end: '2026-09-16' } })).toBe(
      'mtd|Asia/Seoul|2026-09-01|2026-09-16',
    );
    expect(scopeKeyOf({ period: { type: 'instant', tz: 'UTC' }, measure: { currency: 'UZS' } })).toBe('instant|UTC|UZS');
    expect(scopeKeyOf({})).toBe('*');
  });
});

describe('WP2 수집 실패 처리', () => {
  it('계약을 어긴 봉투는 저장하지 않는다 (기존 캐시가 남아 늙는다)', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    await refreshed(h);
    const before = h.sqlite.prepare("SELECT updated_at FROM kpi_cache WHERE kpi_id = 'SYS.UPTIME'").get() as { updated_at: string };

    // kpi_def 의 정의 버전을 바꿔 캐시 키를 어긋나게 만들면(= 저장 실패 상황) 기존 행은 그대로다
    h.sqlite.prepare("DELETE FROM app_registry WHERE app_id NOT IN ('nongjajae')").run();
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const r = await refreshed(h, later);
    expect(r.rejected).toEqual([]);
    const after = h.sqlite.prepare("SELECT updated_at FROM kpi_cache WHERE kpi_id = 'SYS.UPTIME'").get() as { updated_at: string };
    expect(after.updated_at).not.toBe(before.updated_at);
  });

  it('시험 직원이 없어도 수집은 성공한다 (기본값 0명)', async () => {
    const h = await harness();
    const r = await refreshed(h);
    expect(r.rejected).toEqual([]);
    expect(r.written).toBe(6);
  });
});

describe('WP2 응답 형식', () => {
  it('R4 §2.3 필드가 모두 있다', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'v@example.test', groups: ['ALL'] });
    await refreshed(h);
    const body = await json(await h.call('/api/kpi', { token: await h.token('v@example.test') }));
    const k = body.kpis[0];
    for (const f of ['kpi_id', 'definition_version', 'status', 'display_status', 'source_status', 'measure', 'period',
      'updated_at', 'data_as_of', 'fetched_at', 'last_success_at', 'age_seconds', 'stale', 'view_level']) {
      expect(Object.keys(k), f).toContain(f);
    }
    for (const f of ['is_stale', 'basis', 'basis_at', 'threshold_seconds', 'age_seconds', 'calendar', 'verdict_source']) {
      expect(Object.keys(k.stale), f).toContain(f);
    }
    expect(body).toMatchObject({ as_of: expect.any(String), summary: expect.any(Object) });
  });
});

describe('WP2 응답 형식 문서 (docs/kpi-response.schema.json)', () => {
  it('실제 응답이 문서 스키마를 그대로 통과한다 (D1 → API → 화면 왕복)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const { HUB_DIR } = await import('./helpers');

    const schema = JSON.parse(readFileSync(join(HUB_DIR, 'docs', 'kpi-response.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    // 형식 검사기가 실제로 켜져 있는지 먼저 확인
    expect(ajv.compile({ type: 'string', format: 'date-time' })('not-a-time')).toBe(false);
    const validate = ajv.compile(schema);

    const h = await harness();
    seedOrg(h.sqlite);
    h.sqlite.prepare('INSERT INTO access_group_snapshot (group_name, email, synced_at) VALUES (?, ?, ?)').run('ALL', STAFF, NOW.toISOString());
    seedUptime(h, [['nongjajae', 'UP', 0], ['amim', 'DOWN', 2]]);
    await refreshed(h);

    for (const who of [ADMIN, STAFF]) {
      const body = await json(await h.call('/api/kpi', { token: await h.token(who) }));
      expect(validate(body), `${who}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
    }
    // 개별 조회도 같은 kpiView 모양이어야 한다 (목록 스키마에 넣어 확인)
    const one = await json(await h.call('/api/kpi/SYS.UPTIME', { token: await h.token(ADMIN) }));
    expect(Object.keys(one).sort()).toEqual(['as_of', 'kpi']);
    const wrapped = { as_of: one.as_of, summary: { visible: 1, stale: 0, error: 0, unavailable: 0 }, kpis: [one.kpi] };
    expect(validate(wrapped), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);

    // 지연 상태에서도 형식이 유지된다
    // 30분 뒤: T-SYS(15분) 기준으로는 지연이지만 시험용 토큰(1시간)은 아직 살아 있다
    h.clock.now = new Date(NOW.getTime() + 30 * 60_000);
    const staleRes = await h.call('/api/kpi', { token: await h.token(ADMIN) });
    expect(staleRes.status).toBe(200);
    const stale = await json(staleRes);
    expect(validate(stale), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    expect(stale.summary.stale).toBeGreaterThan(0);
  });
});
