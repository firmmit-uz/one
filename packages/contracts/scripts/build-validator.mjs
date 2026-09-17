// 사전 컴파일 검사기 생성 (Cloudflare Workers 용)
//
// 왜 필요한가: Workers 는 eval 과 new Function 을 허용하지 않는다
// (공식 문서 "JavaScript and web standards", 2026-09-17 확인).
// Ajv 는 스키마를 실행 중에 코드로 만들어 쓰므로 Worker 안에서 그대로 쓸 수 없다.
// → 빌드 시점에 Ajv standalone 으로 검사 함수를 만들어 저장소에 넣고, Worker 는 그것만 import 한다.
//
// 형식(format) 검사는 ajv-formats 의 실제 구현(dist/formats.js)을 그대로 import 한다.
// 그 파일에는 require·eval·new Function 이 없어 번들에 안전하게 들어간다(시험으로 확인).
//
// 실행: npm run build:validator -w packages/contracts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { _ } from 'ajv';
import { buildRuleByPointer } from '../src/core.mjs';
import { checkFormatCanary } from '../src/validate.mjs';

const SCHEMA_URL = new URL('../schema/kpi-summary-v1.2.json', import.meta.url);
const OUT_DIR = new URL('../src/generated/', import.meta.url);
const VALIDATOR_OUT = new URL('schema-validator.mjs', OUT_DIR);
const META_OUT = new URL('schema-meta.mjs', OUT_DIR);

const schemaText = readFileSync(SCHEMA_URL, 'utf8');
const schema = JSON.parse(schemaText);
const schemaSha256 = createHash('sha256').update(schemaText, 'utf8').digest('hex');

// 형식 검사기가 실제로 켜져 있는지 먼저 확인 (꺼진 채로 생성하면 의미가 없다)
const canaryAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(canaryAjv);
checkFormatCanary(canaryAjv);

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  // verbose: 오류에 parentSchema 를 붙인다 → Node 진입점과 똑같은 방식으로 규칙 ID 를 찾는다.
  // ($ref 하위 스키마의 schemaPath 는 그 하위 스키마 기준 상대 경로라서 경로만으로는 구분할 수 없다)
  verbose: true,
  code: {
    source: true,
    esm: true,
    // 생성 코드가 참조할 형식 표. 아래에서 import 문을 붙여 준다.
    formats: _`formats`,
  },
});
addFormats(ajv);
const validate = ajv.compile(schema);
let body = standaloneCode(ajv, validate);

// Ajv 는 ucs2length 를 `require(...)` 문자열로 박아 넣는다(ajv/dist/runtime/ucs2length.js 의 `.code`).
// ESM 생성에서도 바뀌지 않으므로 여기서 같은 구현을 안에 넣고 참조를 바꾼다.
const UCS2LENGTH_CALL = 'require("ajv/dist/runtime/ucs2length").default';
const UCS2LENGTH_SRC = `// ajv/dist/runtime/ucs2length.js 의 구현을 그대로 옮김 (require 제거용)
function ucs2length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  let value;
  while (pos < len) {
    length++;
    value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      value = str.charCodeAt(pos);
      if ((value & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}
`;
const ucs2Hits = body.split(UCS2LENGTH_CALL).length - 1;
body = body.split(UCS2LENGTH_CALL).join('ucs2length');

// 생성 코드 안에 박힌 스키마 객체들을 내보낸다.
// Worker 진입점이 이 객체로 "스키마 노드 → 규칙 ID" 표를 만들어, Node 진입점과 같은 규칙을 낸다.
const schemaConsts = [...body.matchAll(/(?:^|[;\n])const (schema\d+) = \{/g)].map((m) => m[1]);
if (schemaConsts.length === 0) {
  console.error('생성 코드에서 스키마 상수를 찾지 못함 — 규칙 ID 표를 만들 수 없음');
  process.exitCode = 1;
}
body += `\nexport const embeddedSchemas = [${schemaConsts.join(', ')}];\n`;

const header = `// 자동 생성 파일 — 직접 고치지 마세요.
// 만든 것: packages/contracts/scripts/build-validator.mjs
// 원본 스키마: schema/kpi-summary-v1.2.json (SHA-256 ${schemaSha256})
// Cloudflare Workers 용 사전 컴파일 검사기 (실행 중 코드 생성 없음).
import ajvFormats from 'ajv-formats/dist/formats.js';
const formats = ajvFormats.fullFormats;
${ucs2Hits > 0 ? UCS2LENGTH_SRC : ''}`;

mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
writeFileSync(fileURLToPath(VALIDATOR_OUT), `${header}\n${body}`);

const ruleByPointer = buildRuleByPointer(schema);
const meta = `// 자동 생성 파일 — 직접 고치지 마세요.
// 만든 것: packages/contracts/scripts/build-validator.mjs
export const SCHEMA_SHA256 = ${JSON.stringify(schemaSha256)};
export const SCHEMA_ID = ${JSON.stringify(schema.$id ?? null)};
/** 스키마 JSON 포인터 → 규칙 ID($comment). ajv 오류의 schemaPath 를 규칙으로 바꾸는 데 쓴다. */
export const RULE_BY_POINTER = Object.freeze(${JSON.stringify(ruleByPointer, null, 2)});
`;
writeFileSync(fileURLToPath(META_OUT), meta);

// 생성물 자체 점검: Worker 금지 구문이 들어가지 않았는지 (주석 줄은 제외하고 본문만 본다)
const generated = readFileSync(fileURLToPath(VALIDATOR_OUT), 'utf8');
const codeOnly = generated.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
const banned = [/\bnew Function\b/, /(^|[^.\w])eval\s*\(/, /\bnode:/, /\brequire\s*\(/];
const hits = banned.filter((re) => re.test(codeOnly)).map((re) => String(re));
if (hits.length) {
  console.error(`생성물에 Worker 에서 쓸 수 없는 구문이 있음: ${hits.join(', ')}`);
  process.exitCode = 1;
}
console.log(`# ucs2length require 치환 ${ucs2Hits}건`);
console.log(`# 내보낸 스키마 상수 ${schemaConsts.length}개: ${schemaConsts.join(', ')}`);

console.log(`# 스키마 SHA-256 ${schemaSha256}`);
console.log(`# 검사기 ${(generated.length / 1024).toFixed(1)} KiB → src/generated/schema-validator.mjs`);
console.log(`# 규칙 포인터 ${Object.keys(ruleByPointer).length}개 → src/generated/schema-meta.mjs`);
console.log(`# 빌드 종료코드 ${process.exitCode ?? 0}`);
