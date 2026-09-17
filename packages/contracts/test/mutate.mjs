// 변이 시험: v1.2 스키마의 방어 조건을 하나씩 제거한 변이 + 런타임 규칙을 하나씩 끈 변이.
// 각 변이마다 전체 케이스를 돌려 "하나 이상의 케이스 판정(결과·거부 계층·스키마 단독 결과)이 기대와 달라지면" 검출.
// 미검출(생존) 변이가 1건이라도 있으면 exitCode=1.
import { createValidator, kpiSummarySchemaV12, RUNTIME_RULES } from '../src/validate.mjs';
import { failuresV12 } from './lib.mjs';

const clone = () => structuredClone(kpiSummarySchemaV12);
const defs = (s) => s.$defs;
function ruleEntry(s, id) {
  for (const arr of [defs(s).measure.allOf, defs(s).kpi.allOf, defs(s).kpi.properties.period.allOf]) {
    const i = arr.findIndex((r) => r.$comment === id);
    if (i >= 0) return { arr, i, rule: arr[i] };
  }
  throw new Error(`rule not found: ${id}`);
}
const removeRule = (id) => (s) => { const { arr, i } = ruleEntry(s, id); arr.splice(i, 1); };
const delKey = (obj, key) => {
  if (!obj || !(key in obj)) throw new Error(`key not found: ${key}`);
  delete obj[key];
};
const thenValue = (s, id) => ruleEntry(s, id).rule.then.properties.value;
const thenProps = (s, id) => ruleEntry(s, id).rule.then.properties;

const SCHEMA_MUTANTS = [
  ['money 조건 제거', removeRule('measure.money')],
  ['money minimum 제거', (s) => delKey(thenValue(s, 'measure.money'), 'minimum')],
  ['money maximum 제거', (s) => delKey(thenValue(s, 'measure.money'), 'maximum')],
  ['money 통화·단위·자릿수 묶음(oneOf) 제거', (s) => delKey(ruleEntry(s, 'measure.money').rule.then, 'oneOf')],
  ['money 외 종류의 currency·minor_exponent 금지(else) 제거', (s) => delKey(ruleEntry(s, 'measure.money').rule, 'else')],
  ['count 조건 제거', removeRule('measure.count')],
  ['count minimum 제거', (s) => delKey(thenValue(s, 'measure.count'), 'minimum')],
  ['count unit 제거', (s) => delKey(thenProps(s, 'measure.count'), 'unit')],
  ['ratio 조건 제거', removeRule('measure.ratio')],
  ['ratio unit 제거', (s) => delKey(thenProps(s, 'measure.ratio'), 'unit')],
  ['ratio 범위(min·max) 제거', (s) => { const v = thenValue(s, 'measure.ratio'); delKey(v, 'minimum'); delKey(v, 'maximum'); }],
  ['quantity 조건 제거', removeRule('measure.quantity')],
  ['quantity 범위(min·max) 제거', (s) => { const v = thenValue(s, 'measure.quantity'); delKey(v, 'minimum'); delKey(v, 'maximum'); }],
  ['timestamp 조건 제거', removeRule('measure.timestamp')],
  ['timestamp unit 제거', (s) => delKey(thenProps(s, 'measure.timestamp'), 'unit')],
  ['state 조건 제거', removeRule('measure.state')],
  ['state unit 제거', (s) => delKey(thenProps(s, 'measure.state'), 'unit')],
  ['fx_rate 조건 제거', removeRule('measure.fx_rate')],
  ['fx_rate unit 제거', (s) => delKey(thenProps(s, 'measure.fx_rate'), 'unit')],
  ['fx_rate exclusiveMinimum 제거', (s) => delKey(thenValue(s, 'measure.fx_rate'), 'exclusiveMinimum')],
  ['fx_rate maximum 제거', (s) => delKey(thenValue(s, 'measure.fx_rate'), 'maximum')],
  ['unit 목록에서 KRW/USD 제거', (s) => { const e = defs(s).measure.properties.unit.enum; e.splice(e.indexOf('KRW/USD'), 1); }],
  ['converted는 money만 조건 제거', removeRule('measure.converted_money_only')],
  ['status→value null 조건(then.properties) 제거', (s) => delKey(ruleEntry(s, 'kpi.status_value').rule.then, 'properties')],
  ['status→error 필수(then.required) 제거', (s) => delKey(ruleEntry(s, 'kpi.status_value').rule.then, 'required')],
  ['status else의 not-required-error 제거', (s) => delKey(ruleEntry(s, 'kpi.status_value').rule.else, 'not')],
  ['status else의 값 not-null 제거', (s) => delKey(ruleEntry(s, 'kpi.status_value').rule.else, 'properties')],
  ['converted→fx(최상위) 제거', removeRule('kpi.converted_fx.measure')],
  ['converted→fx(compare.previous) 제거', removeRule('kpi.converted_fx.compare_previous')],
  ['converted→fx(compare.target) 제거', removeRule('kpi.converted_fx.compare_target')],
  ['converted→fx(breakdown) 제거', removeRule('kpi.converted_fx.breakdown')],
  ['환산 일치 KRW→fx.quote KRW 제거', removeRule('kpi.fx_quote_krw')],
  ['환산 일치 UZS→fx.quote UZS 제거', removeRule('kpi.fx_quote_uzs')],
  ['converted 없으면 fx 금지 제거', removeRule('kpi.fx_requires_converted')],
  ['data_as_of 형식 제거', (s) => { defs(s).kpi.properties.data_as_of = {}; }],
  ['updated_at 형식 제거', (s) => delKey(defs(s).kpi.properties.updated_at, 'format')],
  ['generated_at 형식 제거', (s) => delKey(s.properties.generated_at, 'format')],
  ['fx.rate exclusiveMinimum 제거', (s) => delKey(defs(s).kpi.properties.fx.properties.rate, 'exclusiveMinimum')],
  ['period.start 형식 제거', (s) => delKey(defs(s).kpi.properties.period.properties.start, 'format')],
  ['kpis minItems 제거', (s) => delKey(s.properties.kpis, 'minItems')],
  ['instant에 start/end 금지 제거', removeRule('period.instant_no_range')],
  ['season→season_id 필수 제거', removeRule('period.season_id')],
  ['kpi_id 패턴을 v1.1({3,40})로 되돌림', (s) => { defs(s).kpi.properties.kpi_id.pattern = '^[A-Z]{2,4}\\.[A-Z0-9_]{3,40}$'; }],
  ['kpi_id 패턴 제거', (s) => delKey(defs(s).kpi.properties.kpi_id, 'pattern')],
  ['schema_version const 제거', (s) => { s.properties.schema_version = { type: 'string' }; }],
];

const results = [];

// 기준선: 변이 없는 상태에서 실패 0건이어야 변이 결과를 믿을 수 있다
const baseline = failuresV12(createValidator());
if (baseline.length) {
  console.log(`# 기준선 실패 ${baseline.length}건 — 변이 시험 무효: ${baseline.map((f) => f.id).join(',')}`);
  process.exitCode = 1;
} else {
  for (const [name, apply] of SCHEMA_MUTANTS) {
    const s = clone();
    apply(s);
    const f = failuresV12(createValidator({ schema: s }));
    results.push({ kind: '스키마', name, killedBy: f.map((x) => x.id) });
  }
  for (const id of Object.keys(RUNTIME_RULES)) {
    const f = failuresV12(createValidator({ unsafeTestRuleOverrides: { [id]: false } }));
    results.push({ kind: '런타임', name: `${id} 끔`, killedBy: f.map((x) => x.id) });
  }

  console.log('# 종류\t변이\t결과\t검출 케이스');
  for (const r of results) {
    console.log(`${r.kind}\t${r.name}\t${r.killedBy.length ? 'KILLED' : 'SURVIVED'}\t${r.killedBy.join(',') || '-'}`);
  }
  const survived = results.filter((r) => r.killedBy.length === 0);
  const nSchema = results.filter((r) => r.kind === '스키마').length;
  console.log(`# 변이 검출 ${results.length - survived.length}/${results.length} (스키마 ${nSchema} · 런타임 규칙 ${results.length - nSchema})`);
  if (survived.length) console.log(`# 생존 변이: ${survived.map((r) => r.name).join(' / ')}`);
  process.exitCode = survived.length ? 1 : 0;
}
console.log(`# mutate 종료코드 ${process.exitCode}`);
