// WP2: KPI 게이트웨이 — 수집(Cron) · 신선도 재계산 · 권한 필터 · 응답 조립 (R4 §2.1 · §2.3)
//
// 흐름: 봉투 생성 → 계약 v1.2 검증 → kpi_def 기준 stale 재계산 → kpi_cache 저장
//       → 요청자 그룹으로 필터(권한 없는 KPI 는 응답에서 아예 제거) → 표시용 필드 추가
import type { Principal } from '../authz';
import { tokenStatuses } from '../tokens/refresh';
import {
  buildAndValidate,
  cacheStmt,
  makeEnvelope,
  phase0Kpi,
  staleCountKpi,
  tokenExpiryKpi,
  unavailableKpi,
  uptimeKpi,
  type EnvelopeKpi,
  type Phase0Row,
  type UptimeInput,
} from './collect';
import {
  GLOBAL_SCOPE,
  isKpiStatus,
  isTier,
  KPI_SYSTEM,
  TIER_CALENDAR,
  TIER_STALE_SECONDS,
  UNAVAILABLE_KPIS,
  worstStatus,
  type KpiCacheRow,
  type KpiDefRow,
  type KpiStatus,
  type KpiVisibilityRow,
} from './defs';

export interface KpiDeps {
  now: () => Date;
  requestId?: string;
}

// ---------------------------------------------------------------- 신선도 재계산

export interface StaleVerdict {
  is_stale: boolean;
  basis: 'updated_at' | 'data_as_of';
  basis_at: string | null;
  threshold_seconds: number;
  age_seconds: number | null;
  calendar: string | null;
  verdict_source: 'one';
}

/**
 * ONE 이 kpi_def 기준으로 다시 판정한다 (소스의 자기 신고는 참고만).
 * 기준 시각을 해석할 수 없으면 stale 로 본다(fail-closed).
 */
export function recomputeStale(def: KpiDefRow, row: Pick<KpiCacheRow, 'updated_at' | 'data_as_of'>, now: Date): StaleVerdict {
  const tier = isTier(def.tier) ? def.tier : 'T-SYS';
  const basis = def.clock_basis === 'data_as_of' ? 'data_as_of' : 'updated_at';
  const basisAt = basis === 'data_as_of' ? row.data_as_of : row.updated_at;
  const threshold = TIER_STALE_SECONDS[tier];
  const t = basisAt === null ? NaN : Date.parse(basisAt);
  if (!Number.isFinite(t)) {
    return { is_stale: true, basis, basis_at: basisAt, threshold_seconds: threshold, age_seconds: null, calendar: TIER_CALENDAR[tier], verdict_source: 'one' };
  }
  const age = Math.floor((now.getTime() - t) / 1000);
  return {
    is_stale: age > threshold,
    basis,
    basis_at: basisAt,
    threshold_seconds: threshold,
    age_seconds: age,
    calendar: TIER_CALENDAR[tier],
    verdict_source: 'one',
  };
}

/** 소스가 보낸 status 와 ONE 의 stale 판정을 합친다 (우선순위: error > unavailable > stale > partial > ok) */
export function displayStatus(sourceStatus: string, stale: StaleVerdict): KpiStatus {
  const base: KpiStatus = isKpiStatus(sourceStatus) ? sourceStatus : 'error';
  return stale.is_stale ? worstStatus(base, 'stale') : base;
}

// ---------------------------------------------------------------- 권한

export type ViewLevel = 'summary' | 'detail';

/** 요청자가 이 KPI 를 볼 수 있는 수준. 볼 수 없으면 null (응답에서 아예 뺀다) */
export function viewLevelFor(kpiId: string, visibility: KpiVisibilityRow[], groups: Set<string>): ViewLevel | null {
  let level: ViewLevel | null = null;
  for (const v of visibility) {
    if (v.kpi_id !== kpiId || !groups.has(v.group_name)) continue;
    if (v.level === 'detail') return 'detail';
    level = 'summary';
  }
  return level;
}

// ---------------------------------------------------------------- 응답 조립

export interface KpiView {
  kpi_id: string;
  definition_version: string;
  name_ko: string;
  tier: string;
  status: KpiStatus;
  display_status: KpiStatus;
  source_status: string;
  measure: unknown;
  period: unknown;
  updated_at: string;
  data_as_of: string | null;
  fetched_at: string;
  last_success_at: string | null;
  age_seconds: number | null;
  stale: StaleVerdict;
  view_level: ViewLevel;
  quality?: unknown;
  breakdown?: { key: string; measure: unknown }[];
  error?: unknown;
  sensitivity?: unknown;
  drilldown_app?: unknown;
}

/** breakdown 을 요청자 수준에 맞게 줄인다. 그룹별 값은 자기 그룹 것만 남긴다. */
function filterBreakdown(kpi: EnvelopeKpi, level: ViewLevel, groups: Set<string>): { key: string; measure: unknown }[] | undefined {
  const items = kpi.breakdown;
  if (!items) return undefined;
  if (level === 'detail') return items;
  // 요약 수준: 그룹별 세부는 자기 그룹만, 그 밖의 세부는 숨긴다
  const mine = items.filter((b) => {
    if (!b.key.startsWith('group:')) return false;
    return groups.has(b.key.slice('group:'.length));
  });
  return mine.length ? mine : undefined;
}

export function toView(def: KpiDefRow, row: KpiCacheRow, level: ViewLevel, groups: Set<string>, now: Date): KpiView | null {
  // 깨졌거나 모양이 다른 캐시는 내보내지 않는다 (0·빈 값으로 바꾸지 않음)
  let kpi: EnvelopeKpi;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    kpi = parsed as EnvelopeKpi;
    if (typeof kpi.measure !== 'object' || kpi.measure === null) return null;
  } catch {
    return null;
  }
  const stale = recomputeStale(def, row, now);
  const display = displayStatus(row.status, stale);
  const view: KpiView = {
    kpi_id: def.kpi_id,
    definition_version: def.definition_version,
    name_ko: def.name_ko,
    tier: def.tier,
    status: display,
    display_status: display,
    source_status: row.status,
    measure: kpi.measure,
    period: kpi.period,
    updated_at: row.updated_at,
    data_as_of: row.data_as_of,
    fetched_at: row.fetched_at,
    last_success_at: row.last_success_at,
    age_seconds: stale.age_seconds,
    stale,
    view_level: level,
  };
  if (kpi.quality) view.quality = kpi.quality;
  if (kpi.error) view.error = kpi.error;
  if (kpi.sensitivity) view.sensitivity = kpi.sensitivity;
  const bd = filterBreakdown(kpi, level, groups);
  if (bd) view.breakdown = bd;
  return view;
}

export interface KpiListResult {
  as_of: string;
  summary: { visible: number; stale: number; error: number; unavailable: number };
  kpis: KpiView[];
}

export async function listKpis(db: D1Database, p: Principal, now: Date, only?: string): Promise<KpiListResult> {
  const [defsRes, visRes, cacheRes] = await db.batch([
    db.prepare('SELECT * FROM kpi_def WHERE system = ? ORDER BY kpi_id').bind(KPI_SYSTEM),
    db.prepare('SELECT kpi_id, group_name, level FROM kpi_visibility'),
    db.prepare('SELECT * FROM kpi_cache WHERE system = ? AND scope_key = ?').bind(KPI_SYSTEM, GLOBAL_SCOPE),
  ]);
  const defs = (defsRes?.results ?? []) as unknown as KpiDefRow[];
  const visibility = (visRes?.results ?? []) as unknown as KpiVisibilityRow[];
  const cache = new Map(((cacheRes?.results ?? []) as unknown as KpiCacheRow[]).map((r) => [`${r.kpi_id}\t${r.definition_version}`, r]));
  const groups = new Set(p.groups);

  const kpis: KpiView[] = [];
  for (const def of defs) {
    if (only !== undefined && def.kpi_id !== only) continue;
    const level = viewLevelFor(def.kpi_id, visibility, groups);
    if (level === null) continue; // 권한 없음 → 응답에서 제거
    const row = cache.get(`${def.kpi_id}\t${def.definition_version}`);
    if (!row) continue; // 아직 수집되지 않음
    const view = toView(def, row, level, groups, now);
    if (view) kpis.push(view);
  }
  const summary = {
    visible: kpis.length,
    stale: kpis.filter((k) => k.display_status === 'stale').length,
    error: kpis.filter((k) => k.display_status === 'error').length,
    unavailable: kpis.filter((k) => k.display_status === 'unavailable').length,
  };
  const fetched = kpis.map((k) => k.fetched_at).sort();
  return { as_of: fetched.length ? fetched[fetched.length - 1]! : now.toISOString(), summary, kpis };
}

// ---------------------------------------------------------------- 수집 (Cron */5)

export interface RefreshResult {
  written: number;
  rejected: { kpi_id: string; rules: string[] }[];
}

/**
 * 내부 KPI 를 다시 계산해 캐시에 넣는다.
 * 계약 검증에 실패한 봉투는 저장하지 않는다 → 기존 캐시가 늙어 화면에 "지연" 으로 나타난다.
 */
export async function refreshInternalKpis(db: D1Database, environment: string, deps: KpiDeps): Promise<RefreshResult> {
  const now = deps.now();
  const requestId = deps.requestId ?? `kpi-${crypto.randomUUID()}`;
  const env: 'production' | 'staging' = environment === 'production' ? 'production' : 'staging';
  const fetchedAt = now.toISOString();

  const [appsRes, upRes, phaseRes, visRes] = await db.batch([
    db.prepare("SELECT app_id FROM app_registry WHERE health_url IS NOT NULL AND status <> 'not_connected' ORDER BY app_id"),
    db.prepare('SELECT app_id, state, last_checked_at FROM uptime_state'),
    db.prepare('SELECT item_id, state, sort FROM phase0_checklist ORDER BY sort'),
    db.prepare('SELECT kpi_id, group_name, level FROM kpi_visibility'),
  ]);
  const monitored = (appsRes?.results ?? []) as { app_id: string }[];
  const upMap = new Map(((upRes?.results ?? []) as { app_id: string; state: string; last_checked_at: string | null }[]).map((r) => [r.app_id, r]));
  const uptimeRows: UptimeInput[] = monitored.map((a) => {
    const s = upMap.get(a.app_id);
    const st = s?.state === 'UP' || s?.state === 'DOWN' ? s.state : 'UNKNOWN';
    return { app_id: a.app_id, state: st, last_checked_at: s?.last_checked_at ?? null };
  });
  const phase0 = (phaseRes?.results ?? []) as unknown as Phase0Row[];
  const visibility = (visRes?.results ?? []) as unknown as KpiVisibilityRow[];

  // WP3: 토큰 행이 있으면 SYS.TOKEN_EXPIRY 가 실제 값을 낸다. 없으면 "준비 중" 카드 그대로.
  const tokens = await tokenStatuses(db, now);
  const first: EnvelopeKpi[] = [
    uptimeKpi(uptimeRows, now),
    phase0Kpi(phase0, now),
    ...UNAVAILABLE_KPIS.filter((id) => !(id === 'SYS.TOKEN_EXPIRY' && tokens.length > 0)).map((id) =>
      unavailableKpi(id, now, UNAVAILABLE_DETAIL[id]),
    ),
    ...(tokens.length > 0 ? [tokenExpiryKpi(tokens, now)] : []),
  ];

  const rejected: RefreshResult['rejected'] = [];
  const accepted = filterValid(first, requestId, now, env, rejected);
  if (accepted.length) await db.batch(accepted.map((k) => cacheStmt(db, k, fetchedAt)));

  // 지연 KPI 수는 방금 저장한 내용까지 반영해서 계산한다
  const defsRes = await db.prepare('SELECT * FROM kpi_def WHERE system = ?').bind(KPI_SYSTEM).all<KpiDefRow>();
  const cacheRows = await db
    .prepare('SELECT * FROM kpi_cache WHERE system = ? AND scope_key = ?')
    .bind(KPI_SYSTEM, GLOBAL_SCOPE)
    .all<KpiCacheRow>();
  const defs = new Map((defsRes.results ?? []).map((d) => [`${d.kpi_id}\t${d.definition_version}`, d]));
  const perKpi = (cacheRows.results ?? [])
    // 지연 KPI 수 자신은 지금 다시 쓰는 중이므로 세지 않는다 (자기 자신을 지연으로 세는 것을 막는다)
    .filter((r) => r.kpi_id !== 'SYS.KPI_STALE_COUNT')
    .map((r) => {
      const def = defs.get(`${r.kpi_id}\t${r.definition_version}`);
      const status = def ? displayStatus(r.status, recomputeStale(def, r, now)) : ('error' as KpiStatus);
      return { kpi_id: r.kpi_id, status };
    });

  const second = filterValid([staleCountKpi(perKpi, visibility, now)], requestId, now, env, rejected);
  if (second.length) await db.batch(second.map((k) => cacheStmt(db, k, fetchedAt)));

  return { written: accepted.length + second.length, rejected };
}

const UNAVAILABLE_DETAIL: Record<(typeof UNAVAILABLE_KPIS)[number], string> = {
  'SYS.P1_UNACKED': '알림센터가 아직 없음 (Phase 3)',
  'SYS.TOKEN_EXPIRY': '토큰 갱신 모듈이 꺼져 있음',
  'SYS.TLS_EXPIRY': 'TLS 점검이 아직 없음',
};

/** 봉투를 검증해 통과한 KPI 만 돌려준다. 실패한 것은 rejected 에 쌓고 저장하지 않는다. */
function filterValid(
  kpis: EnvelopeKpi[],
  requestId: string,
  now: Date,
  env: 'production' | 'staging',
  rejected: RefreshResult['rejected'],
): EnvelopeKpi[] {
  const out: EnvelopeKpi[] = [];
  for (const kpi of kpis) {
    const r = buildAndValidate(makeEnvelope(requestId, now, [kpi], env));
    if (r.ok) out.push(kpi);
    else rejected.push({ kpi_id: kpi.kpi_id, rules: [...new Set(r.errors.map((e) => e.rule))] });
  }
  return out;
}
