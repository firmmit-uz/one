// KPI 요약 봉투 v1.2 검증기 — Cloudflare Workers 진입점
//
// Node 진입점(./validate.mjs)과 다른 점은 ③ 스키마 검사뿐이다.
//  - Node : ajv 가 실행 중에 스키마를 코드로 만든다 (new Function) + node:fs 로 스키마 파일을 읽는다
//  - Worker: 빌드 시점에 만들어 둔 사전 컴파일 검사기(src/generated/schema-validator.mjs)만 쓴다
// ① 원문 토큰 검사 ② JSON.parse ④ 의미 검사는 ./core.mjs 로 공용이다.
//
// Workers 는 eval 과 new Function 을 허용하지 않는다
// (공식 문서 "JavaScript and web standards", 2026-09-17 확인).
import { parseWithRawCheck, ruleFromSchemaPath, ruleSwitch, semanticErrors } from './core.mjs';
import { embeddedSchemas, validate as compiledValidate } from './generated/schema-validator.mjs';
import { RULE_BY_POINTER, SCHEMA_ID, SCHEMA_SHA256 } from './generated/schema-meta.mjs';

export { SCHEMA_ID, SCHEMA_SHA256 };
export { RUNTIME_RULES } from './core.mjs';

// 생성 코드 안에 박힌 스키마 객체 → 가장 가까운 규칙 ID($comment).
// Node 진입점(validate.mjs)의 buildRuleIndex 와 같은 방식이라 규칙 ID 가 서로 같다.
// ($ref 하위 스키마의 schemaPath 는 그 하위 스키마 기준이라 경로만으로는 구분할 수 없다)
const ruleIndex = new WeakMap();
for (const root of embeddedSchemas ?? []) {
  const walk = (node, rule) => {
    if (node === null || typeof node !== 'object') return;
    const own = typeof node.$comment === 'string' && /^(measure|kpi|period)\./.test(node.$comment) ? node.$comment : rule;
    if (!ruleIndex.has(node)) ruleIndex.set(node, own);
    for (const v of Object.values(node)) walk(v, own);
  };
  walk(root, null);
}

/** 사전 컴파일 검사기의 오류 → Node 진입점과 같은 모양 {layer, rule, path, message} */
export function schemaErrorsFromCompiled(errors) {
  return (errors ?? []).map((e) => ({
    layer: 'schema',
    rule: ruleIndex.get(e.parentSchema) ?? ruleFromSchemaPath(RULE_BY_POINTER, e.schemaPath) ?? `schema.${e.keyword}`,
    path: e.instancePath || '/',
    message: `${e.keyword}: ${e.message}`,
    schemaPath: e.schemaPath,
  }));
}

/** 스키마만 적용 (원문·의미 검사 없음). 이미 파싱된 객체를 받는다. */
export function validateSchemaOnly(doc) {
  const ok = compiledValidate(doc);
  return { ok, errors: ok ? [] : schemaErrorsFromCompiled(compiledValidate.errors) };
}

/**
 * 운영용: 원문 JSON 텍스트 → {ok, errors[]}
 * @param {string} rawText
 * @param {{unsafeTestRuleOverrides?: Record<string, boolean>}} [opts] 시험 전용
 */
export function validateEnvelope(rawText, opts = {}) {
  const on = ruleSwitch(opts.unsafeTestRuleOverrides ?? {});
  // ①② 원문 토큰 검사 + 파싱
  const parsed = parseWithRawCheck(rawText, on);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  // ③ 스키마 (사전 컴파일)
  const se = validateSchemaOnly(parsed.doc);
  if (!se.ok) return { ok: false, errors: se.errors };
  // ④ 의미
  let me;
  try {
    me = semanticErrors(parsed.doc, on);
  } catch (e) {
    me = [{ layer: 'semantic', rule: 'sem.internal', path: '', message: `의미 검사 중 예외: ${e.message}` }];
  }
  return { ok: me.length === 0, errors: me };
}
