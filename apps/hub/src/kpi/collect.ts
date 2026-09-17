// WP2: ONE 내부 KPI 수집 — 계약 v1.2 봉투를 만들어 검증한 뒤 kpi_cache 에 저장한다.
//
// 내부 KPI 도 외부 소스와 똑같이 봉투 → 검증 → 저장 경로를 탄다.
// 우리 봉투가 계약을 어기면 저장하지 않는다(fail-closed). 그러면 기존 캐시가 그대로 남아 늙고,
// 15분(T-SYS)이 지나면 화면에 "지연" 으로 나타난다.
import { validateEnvelope } from '@firmmit-one/contracts/worker';
import { GLOBAL_SCOPE, KPI_SYSTEM, type KpiStatus } from './defs';
import { PHASE0_ITEMS } from './defs';

export interface Measure {
  kind: 'count' | 'state' | 'ratio' | 'timestamp';
  value: number | string | null;
  unit: 'count' | 'state' | 'percent' | 'datetime';
  decimals?: number;
}

export interface EnvelopeKpi {
  kpi_id: string;
  definition_version: string;
  status: KpiStatus;
  measure: Measure;
  period: { type: 'instant'; tz: 'UTC' };
  updated_at: string;
  data_as_of: string | null;
  quality?: { level: 'verified' | 'unverified' | 'estimated'; flags?: string[] };
  breakdown?: { key: string; measure: Measure }[];
  sensitivity?: 'internal' | 'department' | 'finance';
  // 계약 v1.2 의 오류 코드 목록 (schema/kpi-summary-v1.2.json 의 error.code enum)
  error?: {
    code: 'SOURCE_TIMEOUT' | 'SOURCE_AUTH' | 'SOURCE_RATE_LIMIT' | 'SOURCE_SCHEMA' | 'UPSTREAM_DOWN' | 'NOT_IMPLEMENTED' | 'DEFINITION_PENDING' | 'DATA_NOT_CENTRALIZED';
    retryable: boolean;
    detail?: string;
  };
}

export interface Envelope {
  schema_version: '1.2';
  request_id: string;
  generated_at: string;
  source: { system: 'one'; source_version: string; environment: 'production' | 'staging' };
  kpis: EnvelopeKpi[];
}

export const HUB_SOURCE_VERSION = '1.0.0';

const count = (value: number | null): Measure => ({ kind: 'count', value, unit: 'count' });
const state = (value: string): Measure => ({ kind: 'state', value, unit: 'state' });

export function makeEnvelope(requestId: string, now: Date, kpis: EnvelopeKpi[], environment: 'production' | 'staging'): Envelope {
  return {
    schema_version: '1.2',
    request_id: requestId,
    generated_at: now.toISOString(),
    source: { system: KPI_SYSTEM, source_version: HUB_SOURCE_VERSION, environment },
    kpis,
  };
}

/** 준비 중 카드 (값 없음, 오류 코드로 이유를 남긴다) */
export function unavailableKpi(kpiId: string, now: Date, detail: string): EnvelopeKpi {
  return {
    kpi_id: kpiId,
    definition_version: '1.0',
    status: 'unavailable',
    measure: count(null),
    period: { type: 'instant', tz: 'UTC' },
    updated_at: now.toISOString(),
    data_as_of: null,
    quality: { level: 'verified', flags: [] },
    error: { code: 'NOT_IMPLEMENTED', retryable: false, detail },
    sensitivity: 'internal',
  };
}

// ---------------------------------------------------------------- SYS.UPTIME

export interface UptimeInput {
  app_id: string;
  state: 'UP' | 'DOWN' | 'UNKNOWN';
  last_checked_at: string | null;
}

/** 현재 DOWN 인 점검 대상 앱 수 + 앱별 상태. (24시간 가용률은 이력 표가 없어 이번 범위 밖) */
export function uptimeKpi(rows: UptimeInput[], now: Date): EnvelopeKpi {
  const down = rows.filter((r) => r.state === 'DOWN').length;
  const checked = rows.map((r) => r.last_checked_at).filter((v): v is string => typeof v === 'string').sort();
  const lastChecked = checked.length ? checked[checked.length - 1]! : null;
  return {
    kpi_id: 'SYS.UPTIME',
    definition_version: '1.0',
    status: 'ok',
    measure: count(down),
    period: { type: 'instant', tz: 'UTC' },
    updated_at: now.toISOString(),
    // 점검 기록이 아직 없으면 "데이터 기준일" 도 없다 (0 으로 바꾸지 않는다)
    data_as_of: lastChecked,
    quality: { level: 'verified', flags: [] },
    breakdown: [
      { key: 'monitored', measure: count(rows.length) },
      ...rows.map((r) => ({ key: `app:${r.app_id}`, measure: state(r.state) })),
    ],
    sensitivity: 'internal',
  };
}

// ---------------------------------------------------------------- SYS.KPI_STALE_COUNT

/** stale·error 상태 KPI 수. breakdown 은 열람 그룹별 수(읽는 쪽에서 자기 그룹만 남긴다). */
export function staleCountKpi(
  perKpi: { kpi_id: string; status: KpiStatus }[],
  visibility: { kpi_id: string; group_name: string }[],
  now: Date,
): EnvelopeKpi {
  const bad = new Set(perKpi.filter((k) => k.status === 'stale' || k.status === 'error').map((k) => k.kpi_id));
  const byGroup = new Map<string, number>();
  for (const v of visibility) {
    if (!byGroup.has(v.group_name)) byGroup.set(v.group_name, 0);
    if (bad.has(v.kpi_id)) byGroup.set(v.group_name, (byGroup.get(v.group_name) ?? 0) + 1);
  }
  return {
    kpi_id: 'SYS.KPI_STALE_COUNT',
    definition_version: '1.0',
    status: 'ok',
    measure: count(bad.size),
    period: { type: 'instant', tz: 'UTC' },
    updated_at: now.toISOString(),
    data_as_of: now.toISOString(),
    quality: { level: 'verified', flags: [] },
    breakdown: [...byGroup.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 49)
      .map(([g, n]) => ({ key: `group:${g}`, measure: count(n) })),
    sensitivity: 'internal',
  };
}

// ---------------------------------------------------------------- SYS.PHASE0

export interface Phase0Row {
  item_id: string;
  state: string;
  sort: number;
}

/** 게이트 G1 통과 수. 미시험(pending)·실패·해당없음은 통과로 세지 않는다. */
export function phase0Kpi(rows: Phase0Row[], now: Date): EnvelopeKpi {
  const passed = rows.filter((r) => r.state === 'passed').length;
  const lastUpdate = now.toISOString();
  return {
    kpi_id: 'SYS.PHASE0',
    definition_version: '1.0',
    status: 'ok',
    measure: count(passed),
    period: { type: 'instant', tz: 'UTC' },
    updated_at: lastUpdate,
    data_as_of: lastUpdate,
    // 사람이 손으로 넣은 값
    quality: { level: 'unverified', flags: ['MANUAL_ENTRY'] },
    breakdown: [
      { key: 'total', measure: count(PHASE0_ITEMS) },
      ...[...rows].sort((a, b) => a.sort - b.sort).map((r) => ({ key: `item:${r.item_id}`, measure: state(r.state.toUpperCase()) })),
    ],
    sensitivity: 'internal',
  };
}

// ---------------------------------------------------------------- SYS.TOKEN_EXPIRY (WP3)

export interface TokenStatusInput {
  token_id: string;
  provider: string;
  state: 'ok' | 'expiring' | 'conflict' | 'unknown' | 'running' | 'no_data';
}

/**
 * 연동 토큰 상태. 값 = 만료 임박(72시간 안) 토큰 수.
 * 충돌·확인 불가(P1 상황)가 하나라도 있으면 error 로 표시한다 — 알림 발송은 없다(Phase 3).
 * 계약상 error 일 때는 모든 값이 null 이어야 하므로 그때는 세부를 붙이지 않는다.
 */
export function tokenExpiryKpi(rows: TokenStatusInput[], now: Date): EnvelopeKpi {
  const p1 = rows.filter((r) => r.state === 'conflict' || r.state === 'unknown');
  const base = {
    kpi_id: 'SYS.TOKEN_EXPIRY',
    definition_version: '1.0',
    period: { type: 'instant', tz: 'UTC' } as const,
    updated_at: now.toISOString(),
    data_as_of: now.toISOString(),
    quality: { level: 'verified' as const, flags: [] },
    sensitivity: 'internal' as const,
  };
  if (p1.length > 0) {
    return {
      ...base,
      status: 'error',
      measure: count(null),
      // 계약의 오류 코드 중 "연동 인증이 끊긴 상태" 에 가장 가까운 것을 쓴다.
      // 토큰 값·암호문은 넣지 않는다(토큰 ID 와 상태만).
      error: {
        code: 'SOURCE_AUTH',
        retryable: false,
        detail: p1.map((r) => `${r.token_id}:${r.state}`).join(',').slice(0, 200),
      },
    };
  }
  return {
    ...base,
    status: 'ok',
    measure: count(rows.filter((r) => r.state === 'expiring').length),
    breakdown: [
      { key: 'total', measure: count(rows.length) },
      ...rows.slice(0, 48).map((r) => ({ key: `token:${r.token_id}`, measure: state(r.state.toUpperCase()) })),
    ],
  };
}

// ---------------------------------------------------------------- 저장

export interface CollectedKpi {
  kpi: EnvelopeKpi;
  scopeKey: string;
}

export interface ValidatedEnvelope {
  ok: boolean;
  text: string;
  errors: { rule: string; path: string; message: string }[];
}

/** 봉투를 원문 JSON 으로 만들어 계약 v1.2 로 검증한다 (외부 소스와 같은 경로). */
export function buildAndValidate(envelope: Envelope): ValidatedEnvelope {
  const text = JSON.stringify(envelope);
  const r = validateEnvelope(text);
  return { ok: r.ok, text, errors: r.errors.map((e) => ({ rule: e.rule, path: e.path, message: e.message })) };
}

export const UPSERT_CACHE_SQL = `INSERT INTO kpi_cache
  (system, kpi_id, definition_version, scope_key, value_json, status, data_as_of, updated_at, fetched_at, last_success_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(system, kpi_id, definition_version, scope_key) DO UPDATE SET
  value_json = excluded.value_json,
  status = excluded.status,
  data_as_of = excluded.data_as_of,
  updated_at = excluded.updated_at,
  fetched_at = excluded.fetched_at,
  -- 마지막 정상 시각은 지우지 않는다: 오류가 나도 "마지막 정상값" 표시에 쓰인다
  last_success_at = COALESCE(excluded.last_success_at, kpi_cache.last_success_at)`;

export function cacheStmt(db: D1Database, kpi: EnvelopeKpi, fetchedAt: string, scopeKey = GLOBAL_SCOPE): D1PreparedStatement {
  // 값이 있는 상태에서만 last_success_at 을 갱신한다 (오류를 0 으로 바꾸지 않기 위함)
  const lastSuccess = kpi.status === 'error' || kpi.status === 'unavailable' ? null : fetchedAt;
  return db
    .prepare(UPSERT_CACHE_SQL)
    .bind(
      KPI_SYSTEM,
      kpi.kpi_id,
      kpi.definition_version,
      scopeKey,
      JSON.stringify(kpi),
      kpi.status,
      kpi.data_as_of,
      kpi.updated_at,
      fetchedAt,
      lastSuccess,
    );
}
