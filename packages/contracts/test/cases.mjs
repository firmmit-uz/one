// KPI 요약 봉투 v1.2 시험 케이스.
// 각 케이스: { id, desc, expect, layer, schemaOnly?, build() }
//  - expect: 전체 파이프라인(validateEnvelope) 기대 결과 'accept' | 'reject'
//  - layer: 거부 케이스는 "처음 거부해야 하는 계층", 대조군은 주로 시험하는 계층('raw' | 'schema' | 'semantic')
//  - schemaOnly: 스키마 파일만 쓸 때(Python 등) 기대 결과. 생략 시 규칙으로 유도:
//      accept → accept, layer schema → reject, layer semantic → accept. layer raw는 반드시 명시.
//  - build(): 봉투 객체 또는 원문 JSON 문자열(원문 토큰 시험용)
// C01–C27은 기존(v1.1) 케이스와 같은 입력 변형·같은 기대값을 v1.2 예시 기준으로 옮긴 것이다.
import { readFileSync } from 'node:fs';

export const EXAMPLE_URL = new URL('../examples/kpi-summary-v1.2.example.json', import.meta.url);
export const exampleText = readFileSync(EXAMPLE_URL, 'utf8');
const base = JSON.parse(exampleText);

export const clone = () => structuredClone(base);
const k = (o) => o.kpis[0];
const money = (value, cur, exp, extra = {}) => ({ kind: 'money', value, unit: cur, currency: cur, minor_exponent: exp, ...extra });
const count = (value) => ({ kind: 'count', value, unit: 'count' });
// fx를 빼면서 converted 병기 값도 함께 뺀다(기존 케이스의 "delete fx" 의도 유지)
const dropFx = (o) => {
  delete k(o).fx;
  k(o).breakdown = k(o).breakdown.filter((b) => b.measure.converted !== true);
};
const nullBreakdown = (o) => { for (const b of k(o).breakdown) b.measure.value = null; };
const refFx = (over = {}) => ({
  kpi_id: 'REF.FX',
  definition_version: '1.0',
  status: 'ok',
  measure: { kind: 'fx_rate', value: 1358.12, unit: 'KRW/USD' },
  period: { type: 'instant', tz: 'Asia/Tashkent' },
  updated_at: '2026-10-05T23:00:00Z',
  data_as_of: '2026-10-05',
  quality: { level: 'verified', flags: [] },
  breakdown: [{ key: 'UZS', measure: { kind: 'fx_rate', value: 11775, unit: 'UZS/USD' } }],
  sensitivity: 'internal',
  drilldown_app: 'quote-backoffice',
  ...over,
});

const mut = (f) => () => { const o = clone(); f(o); return o; };
const rawReplace = (from, to, src = () => JSON.stringify(base)) => () => {
  const t = src();
  if (!t.includes(from)) throw new Error(`rawReplace: "${from}" not found`);
  return t.replace(from, to);
};

export const CASES = [];
const add = (id, desc, expect, layer, build, extra = {}) => CASES.push({ id, desc, expect, layer, build, ...extra });

// ---------------------------------------------------------------- C01–C27(기존)
add('C01', '정상 예시(대조군)', 'accept', 'schema', mut(() => {}));
add('C02', '모르는 통화 EUR', 'reject', 'schema', mut((o) => { k(o).measure.currency = 'EUR'; }));
add('C03', 'generated_at 잘못된 문자열', 'reject', 'schema', mut((o) => { o.generated_at = 'not-a-time'; }));
add('C04', '단위 KRW · 통화 USD 불일치', 'reject', 'schema', mut((o) => { k(o).measure.currency = 'USD'; k(o).measure.minor_exponent = 2; }));
add('C05', 'KRW 소수 자릿수 2', 'reject', 'schema', mut((o) => { k(o).measure.minor_exponent = 2; }));
add('C06', 'status ok인데 값 null', 'reject', 'schema', mut((o) => { k(o).measure.value = null; }));
add('C07', 'data_as_of 잘못된 문자열', 'reject', 'schema', mut((o) => { k(o).data_as_of = 'not-a-time'; }));
add('C08', '건수 -1.5', 'reject', 'raw', mut((o) => { k(o).breakdown[0].measure.value = -1.5; }), { schemaOnly: 'reject' });
add('C09', '건수 "pending"', 'reject', 'schema', mut((o) => { k(o).breakdown[0].measure.value = 'pending'; }));
add('C10', '안전 범위 밖 정수 금액(원문 9007199254740993)', 'reject', 'raw',
  rawReplace('"value":1452313905', '"value":9007199254740993'), { schemaOnly: 'reject' });
add('C11', '금액 소수 1.5', 'reject', 'raw', mut((o) => { k(o).measure.value = 1.5; }), { schemaOnly: 'reject' });
add('C12', 'unavailable + 값 null + error(대조군)', 'accept', 'schema', mut((o) => {
  k(o).status = 'unavailable'; k(o).measure.value = null;
  k(o).error = { code: 'NOT_IMPLEMENTED', retryable: false, last_success_at: null };
  dropFx(o); nullBreakdown(o); // v1.2: 오류 상태면 breakdown 값도 null
}));
add('C13', 'error인데 error 객체 없음', 'reject', 'schema', mut((o) => { k(o).status = 'error'; k(o).measure.value = null; }));
add('C14', '건수에 단위 percent', 'reject', 'schema', mut((o) => { k(o).breakdown[0].measure.unit = 'percent'; }));
add('C15', 'USD 소수 자릿수 0', 'reject', 'schema', mut((o) => { k(o).measure = money(100, 'USD', 0); dropFx(o); }));
add('C16', 'UZS 소수 자릿수 2(대조군)', 'accept', 'schema', mut((o) => { k(o).measure = money(1177500, 'UZS', 2); dropFx(o); }));
add('C17', 'data_as_of 날짜·시각 형식(대조군)', 'accept', 'schema', mut((o) => { k(o).data_as_of = '2026-09-16T08:00:00+09:00'; }));
add('C18', 'data_as_of null(미확인, 대조군)', 'accept', 'schema', mut((o) => { k(o).data_as_of = null; }));
add('C19', '환산값인데 fx 없음', 'reject', 'schema', mut((o) => { k(o).measure.converted = true; dropFx(o); }));
add('C20', '비율 값 "abc"', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'ratio', value: 'abc', unit: 'percent' }; dropFx(o); }));
add('C21', '건수에 currency 필드', 'reject', 'schema', mut((o) => { k(o).breakdown[0].measure.currency = 'KRW'; }));
add('C22', 'error인데 값이 있음', 'reject', 'schema', mut((o) => { k(o).status = 'error'; k(o).error = { code: 'SOURCE_TIMEOUT', retryable: true, last_success_at: null }; }));
add('C23', '시각 KPI 값이 잘못된 문자열', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'timestamp', value: 'yesterday', unit: 'datetime' }; dropFx(o); }));
add('C24', '금액 음수 정수(환불, 대조군)', 'accept', 'schema', mut((o) => { k(o).measure.value = -50000; }));
add('C25', '수량 KPI 값 "abc"·단위 KRW', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'quantity', value: 'abc', unit: 'KRW' }; dropFx(o); }));
add('C26', '상태 KPI 값 소문자 자유문장', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'state', value: 'maybe ok', unit: 'state' }; dropFx(o); }));
add('C27', '수량·상태 정상값(대조군)', 'accept', 'schema', mut((o) => {
  k(o).measure = { kind: 'quantity', value: 5984, unit: 'g' };
  k(o).breakdown = [{ key: 'zone:A', measure: { kind: 'state', value: 'NORMAL', unit: 'state' } }];
  delete k(o).fx;
}));

// ---------------------------------------------------------------- 스키마 계층(v1.2 추가)
add('C28', 'REF.FX 환율 KPI(fx_rate, 1 USD = n KRW·UZS, 대조군)', 'accept', 'schema', mut((o) => { o.kpis = [refFx()]; }));
add('C29', 'fx_rate 단위 USD', 'reject', 'schema', mut((o) => { o.kpis = [refFx()]; k(o).measure.unit = 'USD'; }));
add('C30', 'fx_rate 값 0', 'reject', 'schema', mut((o) => { o.kpis = [refFx()]; k(o).measure.value = 0; }));
add('C31', 'fx_rate 값 1e9 초과(1000000001)', 'reject', 'schema', mut((o) => { o.kpis = [refFx()]; k(o).measure.value = 1000000001; }));
add('C32', 'fx_rate unavailable + 값 null(대조군)', 'accept', 'schema', mut((o) => {
  o.kpis = [refFx({ status: 'unavailable', error: { code: 'UPSTREAM_DOWN', retryable: true, last_success_at: '2026-10-05T12:00:00Z' } })];
  k(o).measure.value = null; nullBreakdown(o);
}));
add('C33', 'kpi_id 형식 위반(gh.pipeline)', 'reject', 'schema', mut((o) => { k(o).kpi_id = 'gh.pipeline'; }));
add('C34', 'schema_version "1.1"', 'reject', 'schema', mut((o) => { o.schema_version = '1.1'; }));
add('C35', 'kpis 빈 배열', 'reject', 'schema', mut((o) => { o.kpis = []; }));
add('C36', 'instant 기간에 start', 'reject', 'schema', mut((o) => { k(o).period.start = '2026-10-01'; }));
add('C37', 'season 기간에 season_id 없음', 'reject', 'schema', mut((o) => { k(o).period = { type: 'season', start: '2025-11-01', end: '2026-06-30', tz: 'Asia/Seoul' }; }));
add('C38', 'season 기간 + season_id(대조군)', 'accept', 'schema', mut((o) => { k(o).period = { type: 'season', start: '2025-11-01', end: '2026-06-30', tz: 'Asia/Seoul', season_id: '2025-26' }; }));
add('C39', 'period.start 없는 날짜(2026-02-30)', 'reject', 'schema', mut((o) => { k(o).period = { type: 'mtd', start: '2026-02-30', end: '2026-10-05', tz: 'Asia/Seoul' }; }));
add('C40', 'updated_at 잘못된 문자열', 'reject', 'schema', mut((o) => { k(o).updated_at = 'not-a-time'; }));
add('C41', 'fx.rate 0', 'reject', 'schema', mut((o) => { k(o).fx.rate = 0; }));
add('C42', 'status ok인데 error 객체 있음', 'reject', 'schema', mut((o) => { k(o).error = { code: 'SOURCE_TIMEOUT', retryable: true, last_success_at: null }; }));
add('C43', '건수 -1(정수)', 'reject', 'schema', mut((o) => { k(o).breakdown[0].measure.value = -1; }));
add('C44', '비율 단위 count', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'ratio', value: 12.5, unit: 'count' }; dropFx(o); }));
add('C45', '비율 100001%', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'ratio', value: 100001, unit: 'percent' }; dropFx(o); }));
add('C46', '수량 1e12 초과(1000000000001 g)', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'quantity', value: 1000000000001, unit: 'g' }; dropFx(o); }));
add('C47', '시각 KPI 단위 day', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'timestamp', value: '2026-10-05T23:00:00Z', unit: 'day' }; dropFx(o); }));
add('C48', '상태 KPI 단위 count', 'reject', 'schema', mut((o) => { k(o).measure = { kind: 'state', value: 'NORMAL', unit: 'count' }; dropFx(o); }));
add('C49', 'compare.previous 환산인데 fx 없음(외부 P01형)', 'reject', 'schema', mut((o) => {
  dropFx(o); k(o).compare = { previous: money(100, 'KRW', 0, { converted: true }) };
}));
add('C50', 'compare.target 환산인데 fx 없음', 'reject', 'schema', mut((o) => {
  dropFx(o); k(o).compare = { target: money(110000000, 'USD', 2, { converted: true }), target_source: '2026 사업계획' };
}));
add('C51', 'breakdown 환산값 있는데 fx 없음', 'reject', 'schema', mut((o) => { delete k(o).fx; }));
add('C52', 'fx가 있는데 환산값 없음(v1.1 예시의 모순)', 'reject', 'schema', mut((o) => {
  k(o).breakdown = k(o).breakdown.filter((b) => b.measure.converted !== true);
}));
add('C53', '건수에 converted:true', 'reject', 'schema', mut((o) => { k(o).breakdown[0].measure.converted = true; }));
add('C54', '최상위 KRW 환산인데 fx.quote UZS(외부 P02형)', 'reject', 'schema', mut((o) => {
  k(o).measure.converted = true; k(o).fx.quote = 'UZS'; k(o).fx.rate = 11775;
}));
add('C55', '최상위 UZS 환산인데 fx.quote KRW', 'reject', 'schema', mut((o) => {
  k(o).measure = money(1177500, 'UZS', 2, { converted: true });
}));
add('C56', '최상위 KRW 환산 + fx.quote KRW(대조군)', 'accept', 'schema', mut((o) => { k(o).measure.converted = true; }));
add('C57', '최상위 USD 환산 + fx.quote UZS(USD는 base, 대조군)', 'accept', 'schema', mut((o) => {
  k(o).measure = money(106935610, 'USD', 2, { converted: true }); k(o).fx.quote = 'UZS'; k(o).fx.rate = 11775;
}));

// ---------------------------------------------------------------- 원문 계층
add('C58', '금액 원문 1452313905.0', 'reject', 'raw', rawReplace('"value":1452313905', '"value":1452313905.0'), { schemaOnly: 'accept' });
add('C59', '금액 원문 지수 표기 1.452313905e9', 'reject', 'raw', rawReplace('"value":1452313905', '"value":1.452313905e9'), { schemaOnly: 'accept' });
add('C60', '금액 원문 -0', 'reject', 'raw', rawReplace('"value":1452313905', '"value":-0'), { schemaOnly: 'accept' });
add('C61', '금액 원문 -9007199254740993', 'reject', 'raw', rawReplace('"value":1452313905', '"value":-9007199254740993'), { schemaOnly: 'reject' });
add('C62', '건수 원문 4.0', 'reject', 'raw', rawReplace('"value":4,', '"value":4.0,'), { schemaOnly: 'accept' });
add('C63', '건수 원문 9007199254740992', 'reject', 'raw', rawReplace('"value":4,', '"value":9007199254740992,'), { schemaOnly: 'reject' });
add('C64', '금액 원문 9007199254740991(안전 정수 최대, 대조군)', 'accept', 'raw', rawReplace('"value":1452313905', '"value":9007199254740991'));
add('C65', '금액 원문 -9007199254740991(대조군)', 'accept', 'raw', rawReplace('"value":1452313905', '"value":-9007199254740991'));
add('C66', '비율 원문 12.50(금액·건수 외 소수 허용, 대조군)', 'accept', 'raw',
  rawReplace('"value":12.5,', '"value":12.50,', () => {
    const o = clone(); k(o).measure = { kind: 'ratio', value: 12.5, unit: 'percent', decimals: 1 }; dropFx(o);
    return JSON.stringify(o);
  }));

// ---------------------------------------------------------------- 의미 계층
add('C67', 'kpi_id 중복', 'reject', 'semantic', mut((o) => { o.kpis.push(structuredClone(k(o))); }));
add('C68', 'breakdown 환산 UZS인데 fx.quote KRW', 'reject', 'semantic', mut((o) => {
  k(o).breakdown[2].measure = money(1259170000, 'UZS', 2, { converted: true });
}));
add('C69', 'period.start > period.end', 'reject', 'semantic', mut((o) => { k(o).period = { type: 'mtd', start: '2026-10-05', end: '2026-10-01', tz: 'Asia/Seoul' }; }));
add('C70', 'data_as_of 미래 날짜(2026-10-07)', 'reject', 'semantic', mut((o) => { k(o).data_as_of = '2026-10-07'; }));
add('C71', 'data_as_of = generated_at + 5분(경계, 대조군)', 'accept', 'semantic', mut((o) => { k(o).data_as_of = '2026-10-05T23:15:04Z'; }));
add('C72', 'data_as_of = generated_at + 5분 1초', 'reject', 'semantic', mut((o) => { k(o).data_as_of = '2026-10-05T23:15:05Z'; }));
add('C73', 'data_as_of 날짜 = generated_at의 서울 날짜(대조군)', 'accept', 'semantic', mut((o) => { k(o).data_as_of = '2026-10-06'; }));
add('C74', 'updated_at = generated_at + 6분', 'reject', 'semantic', mut((o) => { k(o).updated_at = '2026-10-05T23:16:04Z'; }));
add('C75', 'fx.as_of가 generated_at 날짜(서울 10-06) + 1일보다 뒤', 'reject', 'semantic', mut((o) => { k(o).fx.as_of = '2026-10-08'; }));
add('C85', 'fx.as_of = generated_at 날짜 + 1일(CBU 전날 공시, 대조군)', 'accept', 'semantic', mut((o) => { k(o).fx.as_of = '2026-10-07'; }));
add('C76', 'fx.as_of = generated_at 날짜(서울 10-06, 대조군)', 'accept', 'semantic', mut((o) => { k(o).fx.as_of = '2026-10-06'; }));
add('C77', 'error.last_success_at이 generated_at보다 뒤', 'reject', 'semantic', mut((o) => {
  k(o).status = 'error'; k(o).measure.value = null;
  k(o).error = { code: 'SOURCE_TIMEOUT', retryable: true, last_success_at: '2026-10-05T23:10:05Z' };
  dropFx(o); nullBreakdown(o);
}));
add('C78', 'compare.previous 종류 불일치(금액 KPI에 건수)', 'reject', 'semantic', mut((o) => { k(o).compare = { previous: count(3) }; }));
add('C79', 'compare.previous 통화 불일치(KRW KPI에 UZS, 환산 아님)', 'reject', 'semantic', mut((o) => { k(o).compare = { previous: money(100, 'UZS', 2) }; }));
add('C80', 'compare 전기 KRW + 목표 USD 환산(대조군)', 'accept', 'semantic', mut((o) => {
  k(o).compare = {
    previous: money(1300000000, 'KRW', 0), previous_period: '2026-09-01/2026-09-05',
    target: money(110000000, 'USD', 2, { converted: true }), target_source: '2026 사업계획',
  };
}));
add('C81', 'error 상태인데 breakdown 값 있음', 'reject', 'semantic', mut((o) => {
  k(o).status = 'error'; k(o).measure.value = null;
  k(o).error = { code: 'SOURCE_TIMEOUT', retryable: true, last_success_at: null };
  dropFx(o);
}));
add('C82', 'unavailable 상태인데 compare 값 있음', 'reject', 'semantic', mut((o) => {
  k(o).status = 'unavailable'; k(o).measure.value = null;
  k(o).error = { code: 'NOT_IMPLEMENTED', retryable: false, last_success_at: null };
  dropFx(o); nullBreakdown(o);
  k(o).compare = { previous: money(100, 'KRW', 0) };
}));
add('C83', '금액에 decimals', 'reject', 'semantic', mut((o) => { k(o).measure.decimals = 0; }));
add('C84', 'sensitivity personal', 'reject', 'semantic', mut((o) => { k(o).sensitivity = 'personal'; }));

// ---------------------------------------------------------------- 유틸
export function schemaOnlyExpectation(c) {
  if (c.schemaOnly) return c.schemaOnly;
  if (c.expect === 'accept') return 'accept';
  if (c.layer === 'schema') return 'reject';
  if (c.layer === 'semantic') return 'accept';
  throw new Error(`${c.id}: layer raw 거부 케이스는 schemaOnly를 명시해야 함`);
}

/** 케이스 → 원문 텍스트 */
export function rawTextOf(c) {
  const b = c.build();
  return typeof b === 'string' ? b : JSON.stringify(b);
}

// 중복 ID 방지
{
  const ids = CASES.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate case id');
  for (const c of CASES) schemaOnlyExpectation(c);
}
