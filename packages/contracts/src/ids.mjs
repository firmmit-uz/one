// FIRMMIT ONE 공통 ID 검사기 (R4 §3, Phase 1.5 확정 대상)
//
// 두 가지 상태가 있다.
//  - confirmed: R4 §3.2 표에 정규식이 그대로 적혀 있는 것. 문서의 정규식을 글자 그대로 옮겼다.
//  - draft    : R4 에 형식 예시만 있고 정규식이 없는 것. 예시에서 만든 제안이며 FIRMMIT 확인이 필요하다.
//
// 원칙(R4 §3.1)
//  1. 불변·재사용 금지  2. 행번호·이름·전화번호에서 파생 금지
//  3. 표시 번호(FIRMMITuz-001 등)는 별칭이지 ID 가 아니다
//  4. 대문자 ASCII + 하이픈. 앞뒤 공백·다른 글자가 붙으면 거부(fail-closed)
//
// 이 파일은 발급을 하지 않는다. 발급은 각 정본 시스템이 하고,
// ID 레지스트리 Worker(firmmit-idreg)는 정본 시스템·운영 주체가 정해진 뒤에 만든다(§7 보류).

/** 법인 코드 (R4 §3.1-6). 퍼밋프레시가 별도 법인인지는 미확인. */
export const LEGAL_ENTITIES = Object.freeze(['KRFM', 'UZGL', 'UZIT']);

/** 문서 유형 (R4 §3.2 DOCUMENT) */
export const DOC_KINDS = Object.freeze(['QT', 'CT', 'IV', 'PO', 'PM', 'TR', 'RP']);

export const ID_TYPES = Object.freeze({
  // ---------------- 확정 (R4 §3.2 에 정규식이 적힌 것) ----------------
  CUS: {
    status: 'confirmed',
    pattern: /^CUS-[A-Z]{2}-\d{6}$/,
    label: '거래처(고객·매입처·파트너 공통)',
    issuer: 'KR: 농자재 유통 시스템 거래처 마스터 / UZ·해외: idreg',
    examples: ['CUS-KR-001204', 'CUS-UZ-000031', 'CUS-SG-000002'],
    source: 'R4 §3.2',
  },
  PRD: {
    status: 'confirmed',
    pattern: /^PRD-(AG|GH|FP|EQ)-\d{5}$/,
    label: '품목 (AG 농자재 · GH 온실 자재 · FP 농산물 · EQ 장비)',
    issuer: '농자재 단가표(AG·FP) / 견적 카탈로그(GH) / idreg(EQ)',
    examples: ['PRD-AG-00123', 'PRD-GH-00001'],
    source: 'R4 §3.2',
  },
  SKU: {
    status: 'confirmed',
    // R4 의 정규식을 그대로 옮김. PRD 는 분류를 AG|GH|FP|EQ 로 좁히는데
    // SKU 는 [A-Z]{2} 라서 더 넓다 → 문서상의 차이이므로 FIRMMIT 확인 대상(보고서에 기록).
    pattern: /^PRD-[A-Z]{2}-\d{5}-\d{2}$/,
    label: '포장·판매 단위',
    issuer: 'PRODUCT 와 같음',
    examples: ['PRD-AG-00123-01'],
    source: 'R4 §3.2',
  },
  ORD: {
    status: 'confirmed',
    // 원본키는 채널이 준 값을 그대로 쓰므로 대소문자를 모두 허용한다(R4 정규식 그대로).
    pattern: /^ORD:(C24|NSS|UZW|NJJ):[A-Za-z0-9-]{4,40}$/,
    label: '주문 (네임스페이스형)',
    issuer: '각 판매 채널. 내부 전표만 ORD-KR-{YYMM}-{5자리} 신규 발급',
    examples: ['ORD:C24:20261005-0001', 'ORD:NJJ:ORD-KR-2609-00012'],
    source: 'R4 §3.2',
  },
  PRJ: {
    status: 'confirmed',
    pattern: /^PRJ-[A-Z]{2}-\d{4}-\d{3}$/,
    label: '고객 건설 프로젝트',
    issuer: 'idreg 프로젝트 등록부(신설) — 건설사업부·해외사업부 입력',
    examples: ['PRJ-UZ-2026-004'],
    source: 'R4 §3.2',
  },
  EMP: {
    status: 'confirmed',
    pattern: /^EMP-(KR|UZ)-\d{4}$/,
    label: '직원 (로그인 이메일은 속성이지 ID 가 아님)',
    issuer: '경영지원(인사 명부) → idreg 등록',
    examples: ['EMP-KR-0012', 'EMP-UZ-0007'],
    source: 'R4 §3.2',
  },

  // ---------------- 초안 (R4 에 예시만 있고 정규식이 없는 것) ----------------
  QUO: {
    status: 'draft',
    // ORD 와 같은 네임스페이스형으로 맞춘 제안
    pattern: /^QUO:(GH|NJJ):[A-Za-z0-9-]{4,40}$/,
    label: '견적 (네임스페이스형)',
    issuer: '견적 앱 D1(온실) / 농자재 Worker(농자재)',
    examples: ['QUO:GH:FMQ-1a2b3c4d', 'QUO:NJJ:2026-0098'],
    source: 'R4 §3.2 예시에서 제안 — 확인 필요',
  },
  DOC: {
    status: 'draft',
    pattern: /^DOC-(KRFM|UZGL|UZIT)-(QT|CT|IV|PO|PM|TR|RP)-\d{4}-\d{5}$/,
    label: '문서 (QT 견적 · CT 계약 · IV 인보이스 · PO 발주 · PM 품의서 · TR 번역 · RP 보고)',
    issuer: '문서를 만드는 시스템',
    examples: ['DOC-UZGL-PM-2026-00001'],
    source: 'R4 §3.2 예시에서 제안 — 확인 필요',
  },
  SITE: {
    status: 'draft',
    // 동·라인을 / 로 나눈다: SITE-KR-ICHEON-VF · SITE-KR-ICHEON-VF/A · …/A-1
    pattern: /^SITE-[A-Z]{2}-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\/[A-Z0-9]+(?:-[A-Z0-9]+)*){0,2}$/,
    label: '농장·현장 (보조 키)',
    issuer: 'idreg',
    examples: ['SITE-KR-ICHEON-VF', 'SITE-KR-ICHEON-VF/A', 'SITE-KR-ICHEON-VF/A-1', 'SITE-UZ-AKIS'],
    source: 'R4 §3.2 예시에서 제안 — 확인 필요',
  },
  PL: {
    status: 'draft',
    // 시장·통화별로 나눈다. 버전은 연월(2026.09) 또는 앱 버전(19.0) 둘 다 쓰이고 있다.
    pattern: /^PL-(KR|UZ)-(KRW|UZS|USD)-(?:\d{4}\.\d{2}|\d+\.\d+)$/,
    label: '가격표',
    issuer: '각 가격 정본',
    examples: ['PL-KR-KRW-2026.09', 'PL-UZ-KRW-19.0', 'PL-UZ-UZS-2026.09'],
    source: 'R4 §3.2 예시에서 제안 — 확인 필요',
  },
  CC: {
    status: 'draft',
    pattern: /^CC-(KRFM|UZGL|UZIT)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
    label: '비용센터 (내부 원가 구분 — PROJECT 와 섞지 않는다)',
    issuer: '회계관리',
    examples: ['CC-UZGL-OFFICE', 'CC-UZGL-AKIS', 'CC-KRFM-NURSERY-01'],
    source: 'R4 §3.2 예시에서 제안 — 확인 필요',
  },
});

export const CONFIRMED_TYPES = Object.freeze(Object.keys(ID_TYPES).filter((t) => ID_TYPES[t].status === 'confirmed'));
export const DRAFT_TYPES = Object.freeze(Object.keys(ID_TYPES).filter((t) => ID_TYPES[t].status === 'draft'));

/**
 * ID 1건 검사.
 * @param {string} type ID_TYPES 의 키
 * @param {unknown} value
 * @returns {{ok:boolean, type:string, status?:string, reason?:string}}
 */
export function validateId(type, value) {
  const spec = ID_TYPES[type];
  if (!spec) return { ok: false, type, reason: 'unknown_type' };
  if (typeof value !== 'string') return { ok: false, type, status: spec.status, reason: 'not_a_string' };
  // 앞뒤 공백·제어문자는 잘라서 통과시키지 않는다 (같은 대상에 두 가지 표기가 생기는 것을 막는다)
  if (value !== value.trim()) return { ok: false, type, status: spec.status, reason: 'surrounding_whitespace' };
  if (!spec.pattern.test(value)) return { ok: false, type, status: spec.status, reason: 'pattern_mismatch' };
  return { ok: true, type, status: spec.status };
}

/** 검사만 하고 boolean 을 돌려준다. */
export function isValidId(type, value) {
  return validateId(type, value).ok;
}

/** 형식만 보고 유형을 알아낸다. 여러 유형에 맞으면(SKU ⊂ PRD 같은 경우) 더 긴 쪽을 고른다. */
export function detectIdType(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const hits = Object.keys(ID_TYPES).filter((t) => ID_TYPES[t].pattern.test(value));
  if (hits.length === 0) return null;
  // SKU 는 PRD 보다 길다 — 더 구체적인(정규식이 긴) 쪽을 고른다
  return hits.sort((a, b) => ID_TYPES[b].pattern.source.length - ID_TYPES[a].pattern.source.length)[0];
}

/** 잘못된 ID 면 예외 (fail-closed 가 필요한 호출부용) */
export function assertId(type, value) {
  const r = validateId(type, value);
  if (!r.ok) throw new Error(`invalid_id: ${type} (${r.reason})`);
  return value;
}
