// WP2: KPI 정의·신선도 기준·상태 우선순위 (R4 §1.0 · §2.3)
export const KPI_SYSTEM = 'one';
export const KPI_ACTOR = 'system:kpi';

export const KPI_STATUSES = ['ok', 'stale', 'partial', 'error', 'unavailable'] as const;
export type KpiStatus = (typeof KPI_STATUSES)[number];

/** 상태 우선순위 (R4 §2.3 규칙 1). 숫자가 클수록 먼저다. */
const STATUS_RANK: Record<KpiStatus, number> = { ok: 0, partial: 1, stale: 2, unavailable: 3, error: 4 };

export function worstStatus(a: KpiStatus, b: KpiStatus): KpiStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export const TIERS = ['T-RT', 'T-OPS', 'T-DAY', 'T-BANK', 'T-WEEK', 'T-MONTH', 'T-REF', 'T-SYS'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * 등급별 stale 기준 (초). R4 §1.0 의 표를 옮긴 것이다.
 *
 * 주의: T-OPS·T-DAY·T-BANK 는 R4 에서 영업일 달력을 함께 본다.
 * 달력 파일(KR_COMPANY_BUSINESS_DAY 등)은 이번 범위 밖이라 여기서는 경과 시간만 본다.
 * 이번에 실제로 쓰는 KPI 는 전부 T-SYS 라 영향이 없다 — 외부 소스를 붙일 때(G03) 달력을 함께 넣는다.
 */
export const TIER_STALE_SECONDS: Record<Tier, number> = {
  'T-RT': 15 * 60,
  'T-OPS': 60 * 60,
  'T-DAY': 26 * 60 * 60,
  'T-BANK': 26 * 60 * 60,
  'T-WEEK': 8 * 24 * 60 * 60,
  'T-MONTH': 35 * 24 * 60 * 60,
  'T-REF': 36 * 60 * 60,
  'T-SYS': 15 * 60,
};

/** 달력이 필요한 등급인지 (응답의 stale.calendar 에 표시) */
export const TIER_CALENDAR: Record<Tier, string | null> = {
  'T-RT': null,
  'T-OPS': 'KR_COMPANY_BUSINESS_DAY',
  'T-DAY': 'KR_COMPANY_BUSINESS_DAY',
  'T-BANK': 'KR_BANK_DAY',
  'T-WEEK': null,
  'T-MONTH': null,
  'T-REF': 'UZ_BUSINESS_DAY',
  'T-SYS': null,
};

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}

export function isKpiStatus(v: unknown): v is KpiStatus {
  return typeof v === 'string' && (KPI_STATUSES as readonly string[]).includes(v);
}

export interface KpiDefRow {
  system: string;
  kpi_id: string;
  definition_version: string;
  name_ko: string;
  unit: string;
  tier: string;
  clock_basis: string;
  verdict_source: string;
  definition_note: string;
  created_at: string;
}

export interface KpiCacheRow {
  system: string;
  kpi_id: string;
  definition_version: string;
  scope_key: string;
  value_json: string;
  status: string;
  data_as_of: string | null;
  updated_at: string;
  fetched_at: string;
  last_success_at: string | null;
}

export interface KpiVisibilityRow {
  kpi_id: string;
  group_name: string;
  level: 'summary' | 'detail';
}

/** 전역(그룹으로 나뉘지 않는) KPI 의 범위 키 */
export const GLOBAL_SCOPE = '*';

/** 이번에 실제 값을 내는 내부 KPI */
export const INTERNAL_KPIS = ['SYS.UPTIME', 'SYS.KPI_STALE_COUNT', 'SYS.PHASE0'] as const;
/** 아직 값이 없는 "준비 중" 카드 (WP3 에서 SYS.TOKEN_EXPIRY 가 값과 연결된다) */
export const UNAVAILABLE_KPIS = ['SYS.P1_UNACKED', 'SYS.TOKEN_EXPIRY', 'SYS.TLS_EXPIRY'] as const;

export const PHASE0_ITEMS = 14; // 런북 v2.2 게이트 G1 V0–V13
export const PHASE0_STATES = ['pending', 'passed', 'failed', 'na'] as const;
export type Phase0State = (typeof PHASE0_STATES)[number];
