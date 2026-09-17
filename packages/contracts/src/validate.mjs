// FIRMMIT ONE KPI 요약 봉투 v1.2 검증기 (Node 진입점)
// 순서: ① 원문 토큰 검사 ② JSON.parse ③ 스키마(ajv 2020 + formats) ④ 의미 검사.
// ①②는 JSON.parse(reviver + context.source) 한 번으로 수행하고, 원문 오류가 있으면 스키마 검사 전에 거부한다.
// 어느 단계든 오류가 1건이라도 있으면 거부(fail-closed). 오류는 모두 {layer, rule, path, message}.
//
// 주의: 이 진입점은 node:fs 와 ajv 런타임 컴파일(new Function)을 쓴다 →
// Cloudflare Workers 에서는 동작하지 않는다. Worker 는 ./worker.mjs 를 쓴다.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkSourceTextAccess, parseWithRawCheck, ruleSwitch, semanticErrors } from './core.mjs';

export {
  MAX_SAFE_INTEGER_TEXT,
  FUTURE_SKEW_MS,
  TZ_OFFSET_MINUTES,
  RUNTIME_RULES,
  parseDateTime,
  parseDateAtLocalMidnight,
  localDate,
  checkSourceTextAccess,
  buildRuleByPointer,
} from './core.mjs';

export const SCHEMA_URL = new URL('../schema/kpi-summary-v1.2.json', import.meta.url);
export const kpiSummarySchemaV12 = Object.freeze(JSON.parse(readFileSync(SCHEMA_URL, 'utf8')));

// ---------------------------------------------------------------- 자체 확인

/** 형식 검사기가 실제로 켜져 있는지 확인. 잘못된 date-time이 통과하면 throw. */
export function checkFormatCanary(ajv) {
  const dt = ajv.compile({ type: 'string', format: 'date-time' });
  const d = ajv.compile({ type: 'string', format: 'date' });
  const r = {
    'date-time "not-a-time" 거부': !dt('not-a-time'),
    'date-time "2026-10-05T23:10:04Z" 허용': dt('2026-10-05T23:10:04Z'),
    'date "2026-02-30" 거부': !d('2026-02-30'),
    'date "2026-10-05" 허용': d('2026-10-05'),
  };
  if (!r['date-time "not-a-time" 거부']) throw new Error('format checker inactive');
  const bad = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) throw new Error(`format checker misconfigured: ${bad.join(', ')}`);
  return r;
}

// ---------------------------------------------------------------- 스키마 오류 → 규칙 ID

// 스키마의 모든 하위 객체 → 가장 가까운 규칙 ID($comment "measure.*"/"kpi.*"/"period.*")
function buildRuleIndex(schema) {
  const index = new WeakMap();
  const walk = (node, rule) => {
    if (node === null || typeof node !== 'object') return;
    const own = typeof node.$comment === 'string' && /^(measure|kpi|period)\./.test(node.$comment) ? node.$comment : rule;
    index.set(node, own);
    for (const v of Object.values(node)) walk(v, own);
  };
  walk(schema, null);
  return index;
}

// ---------------------------------------------------------------- 검증기

/**
 * 검증기 생성. 운영 코드는 validateEnvelope()만 쓴다.
 * @param {object} [opts]
 * @param {object} [opts.schema] 시험용 스키마(변이 시험)
 * @param {Record<string, boolean>} [opts.unsafeTestRuleOverrides] 시험 전용: 규칙 ID → false면 그 규칙을 끈다
 */
export function createValidator(opts = {}) {
  const schema = opts.schema ?? kpiSummarySchemaV12;
  const on = ruleSwitch(opts.unsafeTestRuleOverrides ?? {});

  const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
  addFormats(ajv);
  const formatCanary = checkFormatCanary(ajv);
  checkSourceTextAccess();
  const schemaValidate = ajv.compile(schema);
  const ruleIndex = buildRuleIndex(schema);

  function schemaErrors(doc) {
    if (schemaValidate(doc)) return [];
    return schemaValidate.errors.map((e) => ({
      layer: 'schema',
      rule: ruleIndex.get(e.parentSchema) ?? `schema.${e.keyword}`,
      path: e.instancePath || '/',
      message: `${e.keyword}: ${e.message}`,
      schemaPath: e.schemaPath,
    }));
  }

  function validate(rawText) {
    // ①② 원문 토큰 검사 + 파싱
    const parsed = parseWithRawCheck(rawText, on);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    // ③ 스키마
    const se = schemaErrors(parsed.doc);
    if (se.length) return { ok: false, errors: se };
    // ④ 의미
    let me;
    try {
      me = semanticErrors(parsed.doc, on);
    } catch (e) {
      me = [{ layer: 'semantic', rule: 'sem.internal', path: '', message: `의미 검사 중 예외: ${e.message}` }];
    }
    return { ok: me.length === 0, errors: me };
  }

  /** 스키마만 적용(원문·의미 검사 없음). 스키마 단독 사용자(Python 등)와 같은 판정. */
  function validateSchemaOnly(doc) {
    const errors = schemaErrors(doc);
    return { ok: errors.length === 0, errors };
  }

  return { validate, validateSchemaOnly, formatCanary };
}

// 기본 검증기(모듈 로드 시 형식 검사기·원문 접근 자체 확인)
const defaultValidator = createValidator();
export const formatCanaryResult = defaultValidator.formatCanary;

/** 운영용: 원문 JSON 텍스트 → {ok, errors[]} */
export function validateEnvelope(rawText) {
  return defaultValidator.validate(rawText);
}
