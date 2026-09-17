// 케이스 표: v1.0(스키마만, 비교용) · v1.1(스키마만) · v1.2(validateEnvelope 전체 + 스키마 단독)
// v1.2 불일치가 1건이라도 있으면 exitCode=1
import { createValidator, formatCanaryResult, checkSourceTextAccess } from '../src/validate.mjs';
import { CASES, LEGACY, schemaValidator, evaluateV12, evaluateLegacy } from './lib.mjs';

let fail = false;

console.log('# 형식 검사 카나리아(ajv-formats)');
for (const [k, v] of Object.entries(formatCanaryResult)) {
  console.log(`#   ${k}: ${v ? '예' : '아니오'}`);
  if (!v) fail = true;
}
console.log(`#   JSON.parse 원문 토큰 접근(context.source): ${checkSourceTextAccess() ? '사용 가능' : '불가'} (Node ${process.version})`);

const v12 = createValidator();
const legacy = { '1.0': schemaValidator(LEGACY['1.0']), '1.1': schemaValidator(LEGACY['1.1']) };

const rows = [];
const mism = { '1.0': [], '1.1': [], '1.2': [] };
for (const c of CASES) {
  const l0 = evaluateLegacy(c, '1.0', legacy['1.0']);
  const l1 = evaluateLegacy(c, '1.1', legacy['1.1']);
  const e = evaluateV12(c, v12);
  if (!l0.pass) mism['1.0'].push(c.id);
  if (!l1.pass) mism['1.1'].push(c.id);
  if (!e.pass) mism['1.2'].push(c.id);
  const mark = (p) => (p ? 'O' : 'X');
  rows.push([
    c.id, c.expect, c.layer,
    `${l0.got}(${mark(l0.pass)})`,
    `${l1.got}(${mark(l1.pass)})`,
    `${e.pipeline}${e.layer ? '@' + e.layer : ''}`,
    e.schemaOnly,
    e.pass ? 'PASS' : `FAIL ${e.why.join('; ')}`,
    e.rules.join(',') || '-',
    c.desc,
  ]);
}

console.log('# id\t기대\t계층\tv1.0\tv1.1\tv1.2(전체@거부계층)\tv1.2스키마단독\t판정\t거부 규칙\t설명');
for (const r of rows) console.log(r.join('\t'));

const orig = (ids) => ids.filter((id) => Number(id.slice(1)) <= 27);
const accept = CASES.filter((c) => c.expect === 'accept').length;
const byLayer = (l) => CASES.filter((c) => c.expect === 'reject' && c.layer === l).length;
console.log(`# 케이스 ${CASES.length}개 = 대조군(accept) ${accept} + 거부 ${CASES.length - accept}(원문 ${byLayer('raw')} · 스키마 ${byLayer('schema')} · 의미 ${byLayer('semantic')})`);
console.log(`# v1.0 불일치 ${mism['1.0'].length}건(C01–C27 중 ${orig(mism['1.0']).length}건): ${mism['1.0'].join(',') || '-'}`);
console.log(`# v1.1 불일치 ${mism['1.1'].length}건(C01–C27 중 ${orig(mism['1.1']).length}건): ${mism['1.1'].join(',') || '-'}`);
console.log(`# v1.2 불일치 ${mism['1.2'].length}건: ${mism['1.2'].join(',') || '-'}  (판정 = 전체 결과 + 거부 계층 + 스키마 단독 결과)`);
console.log('# 참고: v1.0/v1.1 열은 v1.2 봉투의 schema_version만 바꿔 스키마 단독으로 본 비교값이다.');

if (mism['1.2'].length > 0) fail = true;
process.exitCode = fail ? 1 : 0;
console.log(`# run-cases 종료코드 ${process.exitCode}`);
