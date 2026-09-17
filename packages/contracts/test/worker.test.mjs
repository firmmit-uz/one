// 사전 컴파일 검사기(Worker 진입점) 시험.
//  - 생성물이 현재 스키마에서 나온 것인지 (SHA-256)
//  - Worker 에서 쓸 수 없는 구문이 없는지 (eval · new Function · node: · require)
//  - 형식 검사기가 실제로 켜져 있는지 (생성된 검사기에 직접 잘못된 날짜를 넣어 본다)
//  - 85개 사례 전부에서 Node 진입점과 같은 판정·같은 거부 계층·같은 규칙을 내는지
// 실패가 하나라도 있으면 exitCode=1.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createValidator } from '../src/validate.mjs';
import { validateEnvelope as workerValidate, validateSchemaOnly as workerSchemaOnly, SCHEMA_SHA256 } from '../src/worker.mjs';
import { validate as compiled } from '../src/generated/schema-validator.mjs';
import { CASES } from './cases.mjs';
import { rawTextOf } from './cases.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}${detail ? '\t' + detail : ''}`);
};
const url = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(url(rel), 'utf8');

// 1) 생성물이 현재 스키마에서 나왔는가
const schemaText = read('../schema/kpi-summary-v1.2.json');
const schemaSha = createHash('sha256').update(schemaText, 'utf8').digest('hex');
check('생성 검사기가 현재 스키마와 같은 해시 (다르면 build:validator 를 다시 돌려야 함)', schemaSha === SCHEMA_SHA256, schemaSha.slice(0, 12));

// 2) Worker 금지 구문 없음 (주석 줄 제외)
const generated = read('../src/generated/schema-validator.mjs');
const codeOnly = generated.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const banned = { 'new Function': /\bnew Function\b/, 'eval(': /(^|[^.\w])eval\s*\(/, 'node:': /\bnode:/, 'require(': /\brequire\s*\(/ };
for (const [name, re] of Object.entries(banned)) check(`생성 검사기에 ${name} 없음`, !re.test(codeOnly));
check('생성 검사기가 형식 표를 ajv-formats 구현에서 가져옴', generated.includes("import ajvFormats from 'ajv-formats/dist/formats.js'"));

// 3) 형식 검사 카나리아 — 생성된 검사기에 직접 넣어 본다
//    (Node 쪽 checkFormatCanary 는 ajv 인스턴스를 받으므로 사전 컴파일본에는 쓸 수 없다)
const example = JSON.parse(read('../examples/kpi-summary-v1.2.example.json'));
const withField = (mutate) => {
  const o = structuredClone(example);
  mutate(o);
  return o;
};
const formatProbes = [
  ['date-time "not-a-time" 거부', withField((o) => { o.generated_at = 'not-a-time'; }), false],
  ['date-time 정상값 허용', withField(() => {}), true],
  ['date "2026-02-30" 거부 (없는 날짜)', withField((o) => { o.kpis[0].data_as_of = '2026-02-30'; }), false],
  ['date "2026-13-01" 거부 (없는 달)', withField((o) => { o.kpis[0].data_as_of = '2026-13-01'; }), false],
  ['date-time 초 없음 거부', withField((o) => { o.kpis[0].updated_at = '2026-10-05T23:10Z'; }), false],
  ['date-time 시간대 표시 없음 거부', withField((o) => { o.kpis[0].updated_at = '2026-10-05T23:10:04'; }), false],
];
for (const [name, doc, expectOk] of formatProbes) {
  const ok = compiled(doc) === true;
  check(`형식 카나리아(사전 컴파일): ${name}`, ok === expectOk, ok ? 'accept' : (compiled.errors ?? []).map((e) => e.keyword).join(','));
}

// 4) 85개 사례: Node 진입점과 같은 판정
const node = createValidator();
const diffs = [];
for (const c of CASES) {
  const text = rawTextOf(c);
  const a = node.validate(text);
  const b = workerValidate(text);
  const layer = (r) => (r.ok ? null : r.errors[0].layer);
  const rules = (r) => [...new Set(r.errors.map((e) => e.rule))].sort().join(',');
  const why = [];
  if (a.ok !== b.ok) why.push(`판정 ${a.ok}≠${b.ok}`);
  if (layer(a) !== layer(b)) why.push(`계층 ${layer(a)}≠${layer(b)}`);
  if (rules(a) !== rules(b)) why.push(`규칙 [${rules(a)}]≠[${rules(b)}]`);
  // 스키마 단독 판정도 같아야 한다
  let soA, soB;
  try {
    const doc = JSON.parse(text);
    soA = node.validateSchemaOnly(doc).ok;
    soB = workerSchemaOnly(doc).ok;
  } catch {
    soA = soB = false;
  }
  if (soA !== soB) why.push(`스키마단독 ${soA}≠${soB}`);
  if (why.length) diffs.push(`${c.id}: ${why.join('; ')}`);
}
check(`사전 컴파일본과 Node 검사기가 ${CASES.length}개 사례에서 같은 판정`, diffs.length === 0, diffs.slice(0, 5).join(' | ') || `${CASES.length}/${CASES.length}`);

// 5) 시험용 규칙 끄기가 Worker 진입점에서도 동작 (변이 시험이 의미를 가지려면 필요)
const goodText = JSON.stringify(example);
check('정상 예시는 Worker 진입점에서 통과', workerValidate(goodText).ok === true);
const personal = JSON.stringify(withField((o) => { o.kpis[0].sensitivity = 'personal'; }));
check('sensitivity personal 은 Worker 진입점에서도 거부', workerValidate(personal).ok === false,
  workerValidate(personal).errors.map((e) => e.rule).join(','));
check('규칙을 끄면 통과 (규칙이 실제로 동작하고 있었다는 증거)',
  workerValidate(personal, { unsafeTestRuleOverrides: { 'sem.no_personal': false } }).ok === true);
let threw = false;
try {
  workerValidate(goodText, { unsafeTestRuleOverrides: { 'sem.nope': false } });
} catch {
  threw = true;
}
check('모르는 규칙 ID 를 끄려 하면 거부', threw);

const failed = results.filter((x) => !x.ok).length;
console.log(`# worker.test ${results.length - failed}/${results.length} 통과`);
process.exitCode = failed ? 1 : 0;
console.log(`# worker.test 종료코드 ${process.exitCode}`);
