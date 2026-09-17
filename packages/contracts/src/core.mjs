// KPI 요약 봉투 v1.2 — 스키마 밖 검사(원문 토큰 · 의미)와 시각 계산.
//
// 이 파일에는 Node 전용 API(node:fs 등)와 Ajv 런타임 컴파일(new Function)이 없다.
// Node 진입점(src/validate.mjs)과 Cloudflare Workers 진입점(src/worker.mjs)이 같은 코드를 쓴다.
// Workers 는 eval·new Function 을 허용하지 않으므로(공식 문서 "JavaScript and web standards",
// 2026-09-17 확인) 스키마 검사는 각 진입점이 따로 준비한다.

export const MAX_SAFE_INTEGER_TEXT = '9007199254740991'; // Number.MAX_SAFE_INTEGER
export const FUTURE_SKEW_MS = 5 * 60 * 1000; // generated_at + 5분
// period.tz → UTC 오프셋(분). 세 지역 모두 현재 일광절약시간 없음.
export const TZ_OFFSET_MINUTES = Object.freeze({ 'Asia/Seoul': 540, 'Asia/Tashkent': 300, UTC: 0 });

/** 스키마 밖에서 검사하는 규칙(ID → 설명). 시험에서만 개별로 끌 수 있다. */
export const RUNTIME_RULES = Object.freeze({
  'raw.int_lexical': 'money·count 값 원문은 -?(0|[1-9]\\d*) 형식만(소수점·지수 표기 금지)',
  'raw.int_range': 'money·count 값 원문 절대값 ≤ 9007199254740991(텍스트 비교)',
  'raw.neg_zero': 'money·count 값 원문 -0 금지',
  'sem.kpi_id_unique': '한 봉투 안 kpi_id 중복 금지',
  'sem.converted_currency': '한 KPI 안 converted money(최상위·compare·breakdown)의 currency ∈ {fx.quote, USD}',
  'sem.period_order': 'period.start ≤ period.end',
  'sem.data_as_of_not_future': 'data_as_of(날짜면 period.tz의 그날 00:00) ≤ generated_at + 5분',
  'sem.updated_at_not_future': 'updated_at ≤ generated_at + 5분',
  'sem.fx_as_of_not_future': 'fx.as_of ≤ generated_at의 날짜 + 1일(period.tz 기준; CBU는 다음 날 적용 환율을 전날 공시할 수 있음 — 공시 시점 재확인 필요)',
  'sem.last_success_not_future': 'error.last_success_at ≤ generated_at',
  'sem.compare_kind': 'compare.previous/target의 kind = 최상위 measure kind',
  'sem.compare_currency': 'money 비교값의 currency = 최상위 currency(어느 한쪽이 converted면 제외)',
  'sem.null_when_error': 'status error/unavailable이면 breakdown·compare 값도 전부 null',
  'sem.money_no_decimals': 'money에는 decimals 금지(minor_exponent가 담당)',
  'sem.no_personal': 'sensitivity "personal" 거부(R4 §2.3 규칙 4)',
});

const INT_TOKEN_RE = /^-?(0|[1-9]\d*)$/;
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)$/;

function utcMs(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, ms);
  return t.getTime();
}

/** RFC 3339 date-time → epoch ms. 형식이 다르면 NaN(호출 측에서 거부). */
export function parseDateTime(text) {
  const m = typeof text === 'string' ? DATE_TIME_RE.exec(text) : null;
  if (!m) return NaN;
  const frac = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  let t = utcMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], frac);
  if (!m[8]) {
    const off = (+m[10]) * 60 + (m[11] ? +m[11] : 0);
    t -= (m[9] === '-' ? -off : off) * 60000;
  }
  return t;
}

/** YYYY-MM-DD를 tz의 그날 00:00으로 → epoch ms. */
export function parseDateAtLocalMidnight(text, tz) {
  const m = typeof text === 'string' ? DATE_RE.exec(text) : null;
  const off = TZ_OFFSET_MINUTES[tz];
  if (!m || off === undefined) return NaN;
  return utcMs(+m[1], +m[2], +m[3]) - off * 60000;
}

/** epoch ms → tz 기준 달력 날짜 YYYY-MM-DD. */
export function localDate(ms, tz) {
  const off = TZ_OFFSET_MINUTES[tz];
  if (!Number.isFinite(ms) || off === undefined) return null;
  return new Date(ms + off * 60000).toISOString().slice(0, 10);
}

/** JSON.parse reviver가 원문 토큰(context.source)을 주는지 확인. 없으면 원문 검사가 꺼지므로 throw. */
export function checkSourceTextAccess() {
  let src;
  JSON.parse('{"v":1.0}', function (key, value, context) {
    if (key === 'v') src = context?.source;
    return value;
  });
  if (src !== '1.0') throw new Error('JSON.parse source text access unsupported (raw token check would be inactive)');
  return true;
}

export function pathIndex(root) {
  const map = new Map();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    map.set(node, path);
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}/${i}`));
    else for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  };
  walk(root, '');
  return map;
}

/**
 * ①② 원문 토큰 검사 + JSON.parse.
 * @returns {{ok:true, doc:unknown} | {ok:false, errors:object[]}}
 */
export function parseWithRawCheck(rawText, on = () => true) {
  if (typeof rawText !== 'string') {
    return { ok: false, errors: [{ layer: 'parse', rule: 'input.type', path: '', message: '입력은 JSON 원문 문자열이어야 함' }] };
  }
  const rawHits = [];
  let doc;
  try {
    doc = JSON.parse(rawText, function (key, value, context) {
      if (key === 'value' && typeof value === 'number' && this && typeof this === 'object' && !Array.isArray(this)
        && (this.kind === 'money' || this.kind === 'count')) {
        const src = context?.source;
        const add = (rule, message) => rawHits.push({ holder: this, rule, message: `${message} (원문 ${JSON.stringify(src)}, kind ${this.kind})` });
        if (typeof src !== 'string') {
          add('raw.source_unavailable', '원문 토큰을 읽을 수 없음');
        } else {
          if (on('raw.int_lexical') && !INT_TOKEN_RE.test(src)) add('raw.int_lexical', '정수 표기가 아님(소수점·지수 금지)');
          if (on('raw.neg_zero') && src === '-0') add('raw.neg_zero', '-0 금지');
          const digits = src.startsWith('-') ? src.slice(1) : src;
          if (on('raw.int_range') && /^\d+$/.test(digits)
            && (digits.length > MAX_SAFE_INTEGER_TEXT.length
              || (digits.length === MAX_SAFE_INTEGER_TEXT.length && digits > MAX_SAFE_INTEGER_TEXT))) {
            add('raw.int_range', '절대값이 9007199254740991 초과');
          }
        }
      }
      return value;
    });
  } catch (e) {
    return { ok: false, errors: [{ layer: 'parse', rule: 'json.syntax', path: '', message: e.message }] };
  }
  if (rawHits.length) {
    const paths = pathIndex(doc);
    return {
      ok: false,
      errors: rawHits.map((h) => ({ layer: 'raw', rule: h.rule, path: `${paths.get(h.holder) ?? '?'}/value`, message: h.message })),
    };
  }
  return { ok: true, doc };
}

function measuresOf(k, p) {
  const list = [[`${p}/measure`, k.measure]];
  for (const w of ['previous', 'target']) if (k.compare?.[w]) list.push([`${p}/compare/${w}`, k.compare[w]]);
  (k.breakdown ?? []).forEach((b, j) => { if (b?.measure) list.push([`${p}/breakdown/${j}/measure`, b.measure]); });
  return list.filter(([, m]) => m && typeof m === 'object');
}

/** ④ 의미 검사. 예외는 호출 측에서 sem.internal 로 바꾼다. */
export function semanticErrors(doc, on) {
  const errs = [];
  const add = (rule, path, message) => errs.push({ layer: 'semantic', rule, path, message });
  const G = parseDateTime(doc.generated_at);
  // 기준 시각을 해석할 수 없으면 시각 규칙을 판단할 수 없으므로 항상 거부(끌 수 없음)
  if (!Number.isFinite(G)) add('sem.generated_at_parse', '/generated_at', `generated_at(${doc.generated_at}) 해석 불가`);
  const seen = new Map();

  (doc.kpis ?? []).forEach((k, i) => {
    const p = `/kpis/${i}`;
    const tz = k.period?.tz;
    const m = k.measure ?? {};

    if (on('sem.kpi_id_unique')) {
      if (seen.has(k.kpi_id)) add('sem.kpi_id_unique', `${p}/kpi_id`, `kpi_id ${k.kpi_id} 중복(${seen.get(k.kpi_id)}와 같음)`);
      else seen.set(k.kpi_id, p);
    }

    if (on('sem.converted_currency')) {
      const allowed = new Set(['USD']);
      if (k.fx?.quote) allowed.add(k.fx.quote);
      for (const [mp, x] of measuresOf(k, p)) {
        if (x.kind === 'money' && x.converted === true && !allowed.has(x.currency)) {
          add('sem.converted_currency', `${mp}/currency`, `환산값 통화 ${x.currency}는 fx.quote(${k.fx?.quote ?? '없음'}) 또는 USD여야 함`);
        }
      }
    }

    if (on('sem.period_order') && k.period && k.period.start !== undefined && k.period.end !== undefined) {
      const { start, end } = k.period;
      if (!DATE_RE.test(start) || !DATE_RE.test(end) || start > end) add('sem.period_order', `${p}/period`, `period.start(${start}) ≤ period.end(${end}) 위반`);
    }

    if (on('sem.data_as_of_not_future') && k.data_as_of !== null && k.data_as_of !== undefined) {
      const v = k.data_as_of;
      const t = DATE_RE.test(v) ? parseDateAtLocalMidnight(v, tz) : parseDateTime(v);
      if (!Number.isFinite(t) || !Number.isFinite(G) || t > G + FUTURE_SKEW_MS) {
        add('sem.data_as_of_not_future', `${p}/data_as_of`, `data_as_of(${v})가 generated_at(${doc.generated_at}) + 5분보다 뒤이거나 해석 불가`);
      }
    }

    if (on('sem.updated_at_not_future')) {
      const t = parseDateTime(k.updated_at);
      if (!Number.isFinite(t) || !Number.isFinite(G) || t > G + FUTURE_SKEW_MS) {
        add('sem.updated_at_not_future', `${p}/updated_at`, `updated_at(${k.updated_at})가 generated_at + 5분보다 뒤이거나 해석 불가`);
      }
    }

    if (on('sem.fx_as_of_not_future') && k.fx) {
      const gDate = localDate(G, tz);
      const gNext = gDate === null ? null : new Date(Date.parse(gDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      if (!DATE_RE.test(k.fx.as_of) || gNext === null || k.fx.as_of > gNext) {
        add('sem.fx_as_of_not_future', `${p}/fx/as_of`, `fx.as_of(${k.fx.as_of})가 generated_at 날짜(${gDate ?? '해석 불가'}, ${tz}) + 1일보다 뒤`);
      }
    }

    if (on('sem.last_success_not_future') && k.error && k.error.last_success_at !== null && k.error.last_success_at !== undefined) {
      const t = parseDateTime(k.error.last_success_at);
      if (!Number.isFinite(t) || !Number.isFinite(G) || t > G) {
        add('sem.last_success_not_future', `${p}/error/last_success_at`, `last_success_at(${k.error.last_success_at})가 generated_at보다 뒤이거나 해석 불가`);
      }
    }

    for (const w of ['previous', 'target']) {
      const c = k.compare?.[w];
      if (!c || typeof c !== 'object') continue;
      if (on('sem.compare_kind') && c.kind !== m.kind) {
        add('sem.compare_kind', `${p}/compare/${w}/kind`, `비교값 kind ${c.kind} ≠ 최상위 kind ${m.kind}`);
      }
      if (on('sem.compare_currency') && c.kind === 'money' && m.kind === 'money'
        && c.converted !== true && m.converted !== true && c.currency !== m.currency) {
        add('sem.compare_currency', `${p}/compare/${w}/currency`, `비교값 통화 ${c.currency} ≠ 최상위 통화 ${m.currency}`);
      }
    }

    if (on('sem.null_when_error') && (k.status === 'error' || k.status === 'unavailable')) {
      for (const [mp, x] of measuresOf(k, p)) {
        if (mp === `${p}/measure`) continue; // 최상위는 스키마(kpi.status_value)가 담당
        if (x.value !== null) add('sem.null_when_error', `${mp}/value`, `status ${k.status}인데 값이 null이 아님`);
      }
    }

    if (on('sem.money_no_decimals')) {
      for (const [mp, x] of measuresOf(k, p)) {
        if (x.kind === 'money' && Object.hasOwn(x, 'decimals')) add('sem.money_no_decimals', `${mp}/decimals`, 'money에는 decimals 금지(minor_exponent 사용)');
      }
    }

    if (on('sem.no_personal') && k.sensitivity === 'personal') {
      add('sem.no_personal', `${p}/sensitivity`, 'sensitivity personal 값은 KPI 봉투로 받지 않음');
    }
  });

  return errs;
}

/** 시험용 규칙 끄기 함수 만들기 (모르는 규칙 ID 는 거부) */
export function ruleSwitch(overrides = {}) {
  for (const id of Object.keys(overrides)) {
    if (!(id in RUNTIME_RULES)) throw new Error(`unknown rule: ${id}`);
  }
  return (id) => overrides[id] !== false;
}

/**
 * 스키마 포인터 → 규칙 ID 표에서, ajv 오류의 schemaPath 에 맞는 규칙을 찾는다.
 * (가장 긴 접두사가 이긴다. 없으면 null)
 */
export function ruleFromSchemaPath(ruleByPointer, schemaPath) {
  if (typeof schemaPath !== 'string') return null;
  let p = schemaPath.startsWith('#') ? schemaPath.slice(1) : schemaPath;
  for (;;) {
    const hit = ruleByPointer[p];
    if (hit) return hit;
    const i = p.lastIndexOf('/');
    if (i < 0) return null;
    p = p.slice(0, i);
  }
}

/** 스키마를 걸어 "JSON 포인터 → 규칙 ID" 표를 만든다 (빌드 시점·시험에서 사용). */
export function buildRuleByPointer(schema) {
  const out = {};
  const walk = (node, pointer, rule) => {
    if (node === null || typeof node !== 'object') return;
    const own = typeof node.$comment === 'string' && /^(measure|kpi|period)\./.test(node.$comment) ? node.$comment : rule;
    if (own) out[pointer] = own;
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${pointer}/${i}`, own));
    else for (const [k, v] of Object.entries(node)) walk(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, own);
  };
  walk(schema, '', null);
  return out;
}
