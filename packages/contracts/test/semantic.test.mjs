// 외부(GPT) 검증 증거 재현 + v1.2 판정 확인. 실패가 하나라도 있으면 exitCode=1.
// 증거 원본: FIRMMIT_ONE_v2_1_Version_Check(recheck.py, Python jsonschema 4.26.0 + FormatChecker)
// 여기서는 같은 입력을 ajv(2020-12 + ajv-formats)로 다시 돌린다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createValidator, kpiSummarySchemaV12 } from '../src/validate.mjs';
import { LEGACY, schemaValidator } from './lib.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}${detail ? '\t' + detail : ''}`);
};
const fx = (rel) => new URL(`./fixtures/${rel}`, import.meta.url);
const load = (rel) => JSON.parse(readFileSync(fx(rel), 'utf8'));
const sha = (rel) => createHash('sha256').update(readFileSync(fx(rel))).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1) 고정 입력이 증거 원본과 같은 파일인지(EVIDENCE_SHA256.json 기준)
const manifest = load('external/EVIDENCE_SHA256.json');
const pairs = [
  ['external/additional_fx_probes_input.json', 'additional_fx_probes_input.json'],
  ['external/original_cases_v1_0.json', 'original_cases_v1_0.json'],
  ['external/original_cases_v1_1.json', 'original_cases_v1_1.json'],
  ['external/original_mutations_rerun_python.json', 'original_mutations_rerun_python.json'],
  ['legacy/kpi-summary-v1.0.json', 'source/kpi_v1_0.json'],
  ['legacy/kpi-summary-v1.1.json', 'source/kpi_v1_1.json'],
];
for (const [local, key] of pairs) check(`증거 해시 일치: ${key}`, sha(local) === manifest[key], sha(local).slice(0, 12));

// 2) 기존 27개 입력: v1.0 불일치 15건, v1.1 0건(GPT recheck-output과 같은 ID)
const GPT_V10_IDS = ['C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C14', 'C15', 'C19', 'C20', 'C21', 'C22', 'C25', 'C26'];
const cases = { '1.0': load('external/original_cases_v1_0.json'), '1.1': load('external/original_cases_v1_1.json') };
const mismatches = (schema, list) => {
  const v = schemaValidator(schema);
  return list.filter((c) => v(c.data) !== (c.expected === 'accept')).map((c) => c.id);
};
const m10 = mismatches(LEGACY['1.0'], cases['1.0']);
const m11 = mismatches(LEGACY['1.1'], cases['1.1']);
check('ajv 재현: v1.0 27건 중 불일치 15건(GPT와 같은 ID)', cases['1.0'].length === 27 && same(m10, GPT_V10_IDS), `${m10.length}건 ${m10.join(',')}`);
check('ajv 재현: v1.1 27건 중 불일치 0건', cases['1.1'].length === 27 && m11.length === 0, `${m11.length}건`);

// 3) GPT가 다시 적용한 변이 10개: 모두 검출 + 검출 케이스 ID도 같음
const gptMut = load('external/original_mutations_rerun_python.json');
const MUT = {
  remove_measure_money: (s) => s.$defs.measure.allOf.splice(0, 1),
  remove_measure_count: (s) => s.$defs.measure.allOf.splice(1, 1),
  remove_measure_ratio: (s) => s.$defs.measure.allOf.splice(2, 1),
  remove_measure_quantity: (s) => s.$defs.measure.allOf.splice(3, 1),
  remove_measure_timestamp: (s) => s.$defs.measure.allOf.splice(4, 1),
  remove_measure_state: (s) => s.$defs.measure.allOf.splice(5, 1),
  remove_status_value: (s) => s.$defs.kpi.allOf.splice(0, 1),
  remove_converted_fx: (s) => s.$defs.kpi.allOf.splice(1, 1),
  remove_data_as_of_format: (s) => { s.$defs.kpi.properties.data_as_of = {}; },
  remove_money_maximum: (s) => { delete s.$defs.measure.allOf[0].then.properties.value.maximum; },
};
let mutOk = 0;
for (const g of gptMut) {
  const s = structuredClone(LEGACY['1.1']);
  MUT[g.mutation](s);
  const ids = mismatches(s, cases['1.1']);
  if (ids.length > 0 && same(ids, g.mismatch_cases)) mutOk++;
  else console.log(`\t  변이 ${g.mutation}: ajv ${ids.join(',')} / GPT ${g.mismatch_cases.join(',')}`);
}
check('ajv 재현: GPT 변이 10개 모두 검출·검출 케이스 동일', gptMut.length === 10 && mutOk === 10, `${mutOk}/${gptMut.length}`);

// 4) 외부 추가 시험 P01·P02
const probes = load('external/additional_fx_probes_input.json');
const v11 = schemaValidator(LEGACY['1.1']);
const v12 = createValidator();
const EXPECTED_RULE = { P01: 'kpi.converted_fx.compare_previous', P02: 'kpi.fx_quote_krw' };
for (const p of probes) {
  check(`${p.id} v1.1 스키마는 통과(GPT 관찰 재현): ${p.name}`, v11(p.data) === true);

  const unpatched = v12.validate(JSON.stringify(p.data));
  check(`${p.id} 원본 그대로(schema_version 1.1)는 v1.2에서 버전 불일치로 거부`, !unpatched.ok && unpatched.errors.some((e) => e.rule === 'schema.const' && e.path === '/schema_version'),
    [...new Set(unpatched.errors.map((e) => e.rule))].join(','));

  const doc = structuredClone(p.data);
  doc.schema_version = '1.2';
  const r = v12.validate(JSON.stringify(doc));
  const rules = [...new Set(r.errors.map((e) => e.rule))];
  check(`${p.id} schema_version만 1.2로 바꾸면 v1.2가 거부하고, 거부 규칙은 ${EXPECTED_RULE[p.id]}뿐`,
    !r.ok && same(rules, [EXPECTED_RULE[p.id]]) && r.errors.every((e) => e.layer === 'schema'), rules.join(','));

  // 이중 방어: 해당 스키마 규칙을 지워도 런타임 의미 검사(sem.converted_currency)가 거부
  const s = structuredClone(kpiSummarySchemaV12);
  const arr = s.$defs.kpi.allOf;
  arr.splice(arr.findIndex((x) => x.$comment === EXPECTED_RULE[p.id]), 1);
  const r2 = createValidator({ schema: s }).validate(JSON.stringify(doc));
  const rules2 = [...new Set(r2.errors.map((e) => e.rule))];
  check(`${p.id} 스키마 규칙을 지워도 의미 검사 sem.converted_currency가 거부`, !r2.ok && same(rules2, ['sem.converted_currency']), rules2.join(','));
}

const failed = results.filter((x) => !x.ok).length;
console.log(`# semantic.test ${results.length - failed}/${results.length} 통과`);
process.exitCode = failed ? 1 : 0;
console.log(`# semantic.test 종료코드 ${process.exitCode}`);
