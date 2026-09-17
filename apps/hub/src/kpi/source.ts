// WP2: 외부 소스 어댑터 인터페이스 (Service Binding RPC, 제한시간 3초)
//
// **이번 범위에서는 시험 안의 가짜 소스로만 왕복한다.**
// wrangler.jsonc 에 실제 서비스 바인딩을 넣지 않는다 — 농자재·이천·BAND 연결은 G03 이후다.
// 여기 있는 것은 "ONE 쪽 인터페이스 + 검증 경로" 까지이고, 하위 앱 코드는 건드리지 않는다.
import { validateEnvelope } from '@firmmit-one/contracts/worker';
import { GLOBAL_SCOPE, isKpiStatus, type KpiStatus } from './defs';

export const SOURCE_TIMEOUT_MS = 3000;

/** 하위 시스템이 구현할 RPC. 원문 JSON 문자열을 돌려준다(원문 토큰 검사를 위해 문자열이어야 한다). */
export interface KpiSource {
  summary(req: { request_id: string; actor_email: string; kpi_ids?: string[] }): Promise<string>;
}

export interface SourceKpi {
  kpi_id: string;
  definition_version: string;
  status: KpiStatus;
  updated_at: string;
  data_as_of: string | null;
  raw: Record<string, unknown>;
  scope_key: string;
}

export type SourceResult =
  | { ok: true; system: string; kpis: SourceKpi[] }
  | { ok: false; code: 'SOURCE_TIMEOUT' | 'SOURCE_SCHEMA' | 'UPSTREAM_DOWN'; detail: string; rules?: string[] };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('timed out', 'TimeoutError')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * 소스에서 봉투를 받아 계약 v1.2 로 검증한다.
 * 실패하면 값을 받지 않는다(fail-closed) — 캐시가 남아 있으면 그 값이 늙어 stale 로 표시된다.
 */
export async function fetchFromSource(
  source: KpiSource,
  req: { request_id: string; actor_email: string; kpi_ids?: string[] },
  opts: { timeoutMs?: number } = {},
): Promise<SourceResult> {
  let text: string;
  try {
    text = await withTimeout(source.summary(req), opts.timeoutMs ?? SOURCE_TIMEOUT_MS);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, code: 'SOURCE_TIMEOUT', detail: 'source did not answer in time' };
    return { ok: false, code: 'UPSTREAM_DOWN', detail: 'source call failed' };
  }
  if (typeof text !== 'string') return { ok: false, code: 'SOURCE_SCHEMA', detail: 'source must return raw JSON text' };

  const r = validateEnvelope(text);
  if (!r.ok) {
    return { ok: false, code: 'SOURCE_SCHEMA', detail: 'envelope rejected', rules: [...new Set(r.errors.map((e) => e.rule))] };
  }
  const doc = JSON.parse(text) as { source: { system: string }; kpis: Record<string, unknown>[] };
  return {
    ok: true,
    system: doc.source.system,
    kpis: doc.kpis.map((k) => ({
      kpi_id: String(k.kpi_id),
      definition_version: String(k.definition_version),
      status: isKpiStatus(k.status) ? k.status : 'error',
      updated_at: String(k.updated_at),
      data_as_of: typeof k.data_as_of === 'string' ? k.data_as_of : null,
      raw: k,
      scope_key: scopeKeyOf(k),
    })),
  };
}

/**
 * 캐시 키의 범위 부분 (R4 §2.3 규칙 6: system + kpi_id + definition_version + scope_key).
 * 기간·통화·시간대가 다르면 다른 값이므로 키를 나눈다.
 */
export function scopeKeyOf(k: Record<string, unknown>): string {
  const period = (k.period ?? {}) as Record<string, unknown>;
  const measure = (k.measure ?? {}) as Record<string, unknown>;
  const parts = [period.type, period.tz, period.start, period.end, period.season_id, measure.currency]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .join('|');
  return parts === '' ? GLOBAL_SCOPE : parts;
}
