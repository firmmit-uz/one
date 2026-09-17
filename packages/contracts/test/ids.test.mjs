// 공통 ID 검사기 시험 (R4 §3.2). 실패가 하나라도 있으면 exitCode=1.
import { CONFIRMED_TYPES, DRAFT_TYPES, ID_TYPES, detectIdType, isValidId, validateId, assertId } from '../src/ids.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  if (!ok) console.log(`FAIL\t${name}${detail ? '\t' + detail : ''}`);
};
const group = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}${detail ? '\t' + detail : ''}`);
};

// 유형별 통과·거부 사례
const TABLE = {
  CUS: {
    pass: ['CUS-KR-001204', 'CUS-UZ-000031', 'CUS-SG-000002', 'CUS-KR-000000'],
    fail: [
      ['소문자 접두어', 'cus-KR-001204'],
      ['소문자 국가', 'CUS-kr-001204'],
      ['자리수 부족', 'CUS-KR-00120'],
      ['자리수 초과', 'CUS-KR-0012045'],
      ['국가 3글자', 'CUS-KOR-001204'],
      ['앞에 글자', 'XCUS-KR-001204'],
      ['뒤에 글자', 'CUS-KR-001204X'],
      ['앞뒤 공백', ' CUS-KR-001204 '],
      ['가운데 공백', 'CUS-KR- 001204'],
      ['구분자 다름', 'CUS_KR_001204'],
      ['줄바꿈 뒤에 붙임', 'CUS-KR-001204\nCUS-KR-000001'],
      ['빈 값', ''],
    ],
  },
  PRD: {
    pass: ['PRD-AG-00123', 'PRD-GH-00001', 'PRD-FP-99999', 'PRD-EQ-00042'],
    fail: [
      ['허용 밖 분류', 'PRD-XX-00123'],
      ['소문자 분류', 'PRD-ag-00123'],
      ['자리수 부족', 'PRD-AG-0012'],
      ['자리수 초과', 'PRD-AG-001234'],
      ['SKU 형태', 'PRD-AG-00123-01'],
      ['앞뒤 공백', 'PRD-AG-00123 '],
    ],
  },
  SKU: {
    pass: ['PRD-AG-00123-01', 'PRD-GH-00001-99'],
    fail: [
      ['SKU 꼬리 없음', 'PRD-AG-00123'],
      ['꼬리 자리수', 'PRD-AG-00123-1'],
      ['꼬리 자리수 초과', 'PRD-AG-00123-011'],
      ['소문자', 'prd-ag-00123-01'],
      ['앞뒤 공백', ' PRD-AG-00123-01'],
    ],
  },
  ORD: {
    // 원본키는 채널이 준 값 그대로 — 대소문자를 모두 허용한다(R4 정규식)
    pass: ['ORD:C24:20261005-0001', 'ORD:NSS:abcd', 'ORD:UZW:Order-2026-7', 'ORD:NJJ:ORD-KR-2609-00012'],
    fail: [
      ['허용 밖 채널', 'ORD:XXX:20261005-0001'],
      ['소문자 채널', 'ORD:c24:20261005-0001'],
      ['소문자 접두어', 'ord:C24:20261005-0001'],
      ['원본키 짧음', 'ORD:C24:abc'],
      ['원본키 김', `ORD:C24:${'a'.repeat(41)}`],
      ['원본키에 허용 밖 글자', 'ORD:C24:0001/0002'],
      ['하이픈 구분자', 'ORD-C24-20261005'],
      ['앞뒤 공백', 'ORD:C24:20261005-0001 '],
    ],
  },
  PRJ: {
    pass: ['PRJ-UZ-2026-004', 'PRJ-KR-2025-001'],
    fail: [
      ['연도 자리수', 'PRJ-UZ-26-004'],
      ['일련번호 자리수', 'PRJ-UZ-2026-04'],
      ['소문자 국가', 'PRJ-uz-2026-004'],
      ['뒤에 글자', 'PRJ-UZ-2026-004A'],
    ],
  },
  EMP: {
    pass: ['EMP-KR-0012', 'EMP-UZ-0007'],
    fail: [
      ['허용 밖 지역', 'EMP-SG-0012'],
      ['자리수 부족', 'EMP-KR-012'],
      ['자리수 초과', 'EMP-KR-00012'],
      ['소문자 접두어', 'emp-KR-0012'],
      ['이메일', 'staff1@example.invalid'],
    ],
  },
  QUO: {
    pass: ['QUO:GH:FMQ-1a2b3c4d', 'QUO:NJJ:2026-0098'],
    fail: [
      ['허용 밖 구분', 'QUO:XX:FMQ-1a2b3c4d'],
      ['원본키 짧음', 'QUO:GH:abc'],
      ['하이픈 구분자', 'QUO-GH-FMQ-1a2b3c4d'],
      ['소문자 접두어', 'quo:GH:FMQ-1a2b3c4d'],
    ],
  },
  DOC: {
    pass: ['DOC-UZGL-PM-2026-00001', 'DOC-KRFM-CT-2026-00042', 'DOC-UZIT-IV-2025-99999'],
    fail: [
      ['허용 밖 법인', 'DOC-XXXX-PM-2026-00001'],
      ['허용 밖 유형', 'DOC-UZGL-ZZ-2026-00001'],
      ['일련번호 자리수', 'DOC-UZGL-PM-2026-0001'],
      ['표시 번호(별칭)', 'FIRMMITuz-001'],
      ['소문자 유형', 'DOC-UZGL-pm-2026-00001'],
    ],
  },
  SITE: {
    pass: ['SITE-KR-ICHEON-VF', 'SITE-KR-ICHEON-VF/A', 'SITE-KR-ICHEON-VF/A-1', 'SITE-UZ-AKIS'],
    fail: [
      ['소문자', 'SITE-kr-ICHEON-VF'],
      ['국가 3글자', 'SITE-KOR-ICHEON'],
      ['빈 이름', 'SITE-KR-'],
      ['하위 3단계 초과', 'SITE-KR-ICHEON-VF/A/1/2'],
      ['공백 포함', 'SITE-KR-ICHEON VF'],
    ],
  },
  PL: {
    pass: ['PL-KR-KRW-2026.09', 'PL-UZ-KRW-19.0', 'PL-UZ-UZS-2026.09', 'PL-UZ-USD-1.0'],
    fail: [
      ['허용 밖 시장', 'PL-SG-KRW-2026.09'],
      ['허용 밖 통화', 'PL-KR-EUR-2026.09'],
      ['버전 없음', 'PL-KR-KRW'],
      ['버전 형식', 'PL-KR-KRW-2026-09'],
      ['소문자 접두어', 'pl-KR-KRW-2026.09'],
    ],
  },
  CC: {
    pass: ['CC-UZGL-OFFICE', 'CC-UZGL-AKIS', 'CC-KRFM-NURSERY-01'],
    fail: [
      ['허용 밖 법인', 'CC-XXXX-OFFICE'],
      ['소문자 코드', 'CC-UZGL-office'],
      ['빈 코드', 'CC-UZGL-'],
      ['프로젝트 ID', 'PRJ-UZ-2026-004'],
    ],
  },
};

check('표에 모든 유형이 있다', Object.keys(TABLE).length === Object.keys(ID_TYPES).length,
  `${Object.keys(TABLE).length}/${Object.keys(ID_TYPES).length}`);

for (const [type, t] of Object.entries(TABLE)) {
  const bad = [];
  for (const v of t.pass) if (!isValidId(type, v)) bad.push(`통과해야 함: ${JSON.stringify(v)}`);
  for (const [why, v] of t.fail) if (isValidId(type, v)) bad.push(`거부해야 함(${why}): ${JSON.stringify(v)}`);
  // 문서의 예시가 실제로 통과하는지도 확인
  for (const v of ID_TYPES[type].examples) if (!isValidId(type, v)) bad.push(`문서 예시 실패: ${JSON.stringify(v)}`);
  group(`${type} (${ID_TYPES[type].status}) 통과 ${t.pass.length} · 거부 ${t.fail.length}`, bad.length === 0, bad.join(' | '));
}

// 상태 구분
group('확정 6종 / 초안 5종', CONFIRMED_TYPES.length === 6 && DRAFT_TYPES.length === 5,
  `확정 ${CONFIRMED_TYPES.join(',')} / 초안 ${DRAFT_TYPES.join(',')}`);
group('초안 유형은 status 가 draft 로 표시된다', DRAFT_TYPES.every((t) => validateId(t, ID_TYPES[t].examples[0]).status === 'draft'));

// 모르는 유형·잘못된 입력
group('모르는 유형은 거부', validateId('NOPE', 'CUS-KR-001204').reason === 'unknown_type');
group('문자열이 아니면 거부', [null, undefined, 123, {}, ['CUS-KR-001204']].every((v) => validateId('CUS', v).reason === 'not_a_string'));
group('앞뒤 공백은 잘라서 통과시키지 않는다', validateId('CUS', ' CUS-KR-001204').reason === 'surrounding_whitespace');

// 유형 알아내기
const detect = [
  ['CUS-KR-001204', 'CUS'],
  ['PRD-AG-00123', 'PRD'],
  ['PRD-AG-00123-01', 'SKU'],
  ['ORD:C24:20261005-0001', 'ORD'],
  ['EMP-KR-0012', 'EMP'],
  ['없는값', null],
];
group('형식으로 유형 알아내기 (SKU 는 PRD 보다 구체적인 쪽)', detect.every(([v, t]) => detectIdType(v) === t),
  detect.map(([v]) => `${v}→${detectIdType(v)}`).join(' '));

// assertId
let threw = false;
try {
  assertId('CUS', 'nope');
} catch {
  threw = true;
}
group('assertId 는 잘못된 ID 에 예외', threw && assertId('CUS', 'CUS-KR-001204') === 'CUS-KR-001204');

// 정규식에 전역 플래그가 없어야 한다(lastIndex 때문에 두 번째 호출이 달라지는 사고 방지)
group('정규식에 g 플래그 없음', Object.values(ID_TYPES).every((s) => !s.pattern.global));
group('같은 값을 두 번 검사해도 결과가 같다',
  Object.entries(ID_TYPES).every(([t, s]) => isValidId(t, s.examples[0]) && isValidId(t, s.examples[0])));

const failed = results.filter((x) => !x.ok).length;
console.log(`# ids.test ${results.length - failed}/${results.length} 통과 (확정 ${CONFIRMED_TYPES.length}종 · 초안 ${DRAFT_TYPES.length}종)`);
process.exitCode = failed ? 1 : 0;
console.log(`# ids.test 종료코드 ${process.exitCode}`);
