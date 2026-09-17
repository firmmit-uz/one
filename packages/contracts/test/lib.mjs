// 시험 공용 도구
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkFormatCanary } from '../src/validate.mjs';
import { CASES, rawTextOf, schemaOnlyExpectation } from './cases.mjs';

export const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
export const LEGACY = {
  '1.0': readJson('./fixtures/legacy/kpi-summary-v1.0.json'),
  '1.1': readJson('./fixtures/legacy/kpi-summary-v1.1.json'),
};

/** 스키마 단독 ajv 검증 함수(형식 검사 카나리아 포함) */
export function schemaValidator(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  checkFormatCanary(ajv);
  const v = ajv.compile(schema);
  return (doc) => v(doc);
}

const verdict = (ok) => (ok ? 'accept' : 'reject');

/**
 * v1.2 판정: 파이프라인(결과 + 처음 거부한 계층)과 스키마 단독 결과를 모두 기대값과 비교.
 * @returns {{pipeline:string, layer:string|null, rules:string[], schemaOnly:string, pass:boolean, why:string[]}}
 */
export function evaluateV12(c, validator) {
  const text = rawTextOf(c);
  const r = validator.validate(text);
  const got = verdict(r.ok);
  const layer = r.ok ? null : r.errors[0].layer;
  const rules = [...new Set(r.errors.map((e) => e.rule))];
  let so;
  try {
    so = verdict(validator.validateSchemaOnly(JSON.parse(text)).ok);
  } catch {
    so = 'reject';
  }
  const why = [];
  if (got !== c.expect) why.push(`결과 ${got}≠${c.expect}`);
  if (got === 'reject' && c.expect === 'reject' && layer !== c.layer) why.push(`계층 ${layer}≠${c.layer}`);
  if (so !== schemaOnlyExpectation(c)) why.push(`스키마단독 ${so}≠${schemaOnlyExpectation(c)}`);
  return { pipeline: got, layer, rules, schemaOnly: so, pass: why.length === 0, why };
}

/** 이전 버전 스키마 단독 판정(비교용). v1.2 봉투의 schema_version만 해당 버전으로 바꾼다. */
export function evaluateLegacy(c, version, validate) {
  let doc;
  try {
    doc = JSON.parse(rawTextOf(c));
  } catch {
    return { got: 'reject', pass: c.expect === 'reject' };
  }
  if (doc && doc.schema_version === '1.2') doc.schema_version = version;
  const got = verdict(validate(doc));
  return { got, pass: got === c.expect };
}

/** 케이스 전체를 v1.2 검증기로 돌려 실패 목록 반환(변이 시험용) */
export function failuresV12(validator) {
  const out = [];
  for (const c of CASES) {
    const e = evaluateV12(c, validator);
    if (!e.pass) out.push({ id: c.id, why: e.why });
  }
  return out;
}

export { CASES };
