# @firmmit-one/contracts — KPI 요약 봉투 계약 v1.2

하위 시스템(견적·농자재·FINO 등)이 FIRMMIT ONE에 보내는 **KPI 요약 봉투**의 계약이다.
설계 근거는 R4 설계서 §2.2(스키마 전문·예시)와 §2.3(ONE 쪽 규칙)이다.

- 스키마: `schema/kpi-summary-v1.2.json` (JSON Schema 2020-12)
- 진입점 2개 (판정은 서로 같다 — 85개 사례로 시험)
  | 쓰는 곳 | import | 스키마 검사 방식 |
  |---|---|---|
  | Node (시험·도구) | `@firmmit-one/contracts` → `src/validate.mjs` | Ajv 가 실행 중에 컴파일 (`new Function`) + `node:fs` 로 스키마 읽기 |
  | **Cloudflare Workers** | `@firmmit-one/contracts/worker` → `src/worker.mjs` | **빌드 시점 사전 컴파일본** (`src/generated/schema-validator.mjs`) |
- 공용 코드: `src/core.mjs` — 원문 토큰 검사 · 의미 검사 · 시각 계산 (Node 전용 API 없음)
- 공통 ID 검사기: `@firmmit-one/contracts/ids` → `src/ids.mjs` (R4 §3.2, 확정 6종 · 초안 5종)
- 예시: `examples/kpi-summary-v1.2.example.json` (R4 §2.2 예시와 같음)

> **Worker 에서 `src/validate.mjs` 를 import 하지 않는다.** Workers 는 `eval` 과 `new Function` 을 허용하지 않는다
> (공식 문서 "JavaScript and web standards", 2026-09-17 확인). `nodejs_compat` 으로 우회하지 않는다.

## 사전 컴파일 검사기

```bash
npm run build:validator -w @firmmit-one/contracts
```

- 만드는 것: `src/generated/schema-validator.mjs`(Ajv standalone, ESM) · `src/generated/schema-meta.mjs`(스키마 SHA-256, 규칙 포인터 표)
- 생성물은 **저장소에 포함한다**. 스키마를 고치면 다시 만들어야 하고, 안 하면 `test/worker.test.mjs` 의 해시 비교가 실패한다.
- 형식(format) 검사는 `ajv-formats/dist/formats.js` 의 실제 구현을 그대로 import 한다(그 파일에는 `require`·`eval`·`new Function` 이 없다).
- Ajv 가 박아 넣는 `require("ajv/dist/runtime/ucs2length")` 는 빌드 스크립트가 같은 구현으로 바꾼다.
- 생성물·번들에 금지 구문이 없는지 빌드와 시험에서 모두 확인한다.

## 실행

Node 22 이상이 필요하다(`JSON.parse` reviver의 `context.source` 사용).

```bash
# 모노레포 루트(/home/claude/firmmit-one)에서
npm ci
npm test -w @firmmit-one/contracts

# 또는 이 폴더에서
npm test
```

`npm test`는 사전 컴파일 검사기를 먼저 만든 뒤 다섯 단계를 차례로 실행하고, 하나라도 실패하면 종료코드가 0이 아니다.

| 단계 | 파일 | 실패 조건 |
|---|---|---|
| 검사기 생성 | `scripts/build-validator.mjs` | 생성물에 금지 구문(`eval`·`new Function`·`node:`·`require`) |
| 케이스 표 | `test/run-cases.mjs` | v1.2 불일치 1건 이상, 형식 검사 카나리아 실패 |
| 변이 시험 | `test/mutate.mjs` | 검출되지 않은(생존) 변이 1건 이상, 기준선 실패 |
| 외부 검증 재현 | `test/semantic.test.mjs` | 증거 해시 불일치, GPT 결론(v1.0 15건·v1.1 0건·변이 10/10) 재현 실패, P01·P02가 v1.2에서 의도한 규칙으로 거부되지 않음 |
| Worker 진입점 | `test/worker.test.mjs` | 스키마 해시 불일치(= 다시 만들어야 함), 금지 구문, 형식 카나리아 실패, 85개 사례에서 Node 진입점과 판정·거부 계층·규칙이 다름 |
| 공통 ID | `test/ids.test.mjs` | 유형별 통과·거부 사례 불일치, 확정 6종/초안 5종 구분 깨짐 |

### lock 파일

- 모노레포에서는 **루트 `package-lock.json`이 정본**이다(npm workspaces). `ajv`·`ajv-formats`는 루트 `node_modules`에 설치된다.
- `packages/contracts/package-lock.json`은 이 폴더만 떼어 쓸 때(모노레포 밖에서 `npm ci`) 쓰는 **단독 반출용**이다. 모노레포 안에서는 npm이 이 파일을 쓰지 않는다.

## 사용법

```js
import { validateEnvelope } from '@firmmit-one/contracts';

const text = await response.text();       // 파싱하기 전 원문 텍스트를 넘긴다
const { ok, errors } = validateEnvelope(text);
if (!ok) {
  // errors: [{ layer: 'parse'|'raw'|'schema'|'semantic', rule, path, message }]
  // 캐시에 쓰지 말고 error로 처리(fail-closed)
}
```

`JSON.parse`가 끝난 객체를 넘기면 안 된다. `1.0`·`1e3`·`-0` 같은 원문 표기는 파싱 뒤에는 구분할 수 없다.

## 검사 계층

순서대로 검사하고, 한 계층에서 오류가 나오면 **그 계층의 오류를 모두 돌려주고 거부**한다(뒤 계층은 실행하지 않음).

| 순서 | 계층 | 하는 일 |
|---|---|---|
| ①② | 원문(`raw`) + 파싱(`parse`) | `JSON.parse(text, reviver)` 한 번으로 수행. reviver가 `context.source`로 money·count 값의 원문 토큰을 검사 |
| ③ | 스키마(`schema`) | Ajv2020(`allErrors`, `strict:false`) + ajv-formats. 오류마다 스키마 `$comment`의 규칙 ID를 붙임 |
| ④ | 의미(`semantic`) | 스키마로 표현할 수 없는 조건. 내부 예외도 거부로 처리 |

모듈을 불러올 때 두 가지를 자체 확인하고, 실패하면 **예외를 던진다**(검사가 조용히 꺼진 채로 운영되지 않게).

- 형식 검사 카나리아: `"not-a-time"`이 date-time으로 통과하면 `format checker inactive`
- 원문 접근: reviver에서 `context.source`를 못 받으면 `JSON.parse source text access unsupported`

## 규칙표

### 스키마 규칙(`$comment` 규칙 ID)

| 규칙 ID | 내용 |
|---|---|
| `measure.money` | 통화·단위·소수 자릿수 한 묶음(KRW 0 · USD 2 · UZS 2), 정수, ±9,007,199,254,740,991. money가 아닌 종류는 currency·minor_exponent 금지 |
| `measure.count` | 0 이상 정수, 단위 count/person |
| `measure.ratio` | 숫자 ±100,000, 단위 percent |
| `measure.quantity` | 숫자 ±1e12, 단위 kg·g·mS/cm·pH·Brix·N·mm·cm·day·hour·second |
| `measure.timestamp` | date-time, 단위 datetime |
| `measure.state` | 대문자 코드 `^[A-Z][A-Z0-9_]{1,31}$`, 단위 state |
| `measure.fx_rate` | 환율(1 USD = n KRW·UZS). 단위 `KRW/USD`·`UZS/USD`, 값 0 초과 1e9 이하 또는 null |
| `measure.converted_money_only` | `converted:true`는 money에서만 |
| `kpi.status_value` | ok·stale·partial → 값 필수, error 객체 금지 / error·unavailable → 최상위 값 null + error 객체 필수 |
| `kpi.converted_fx.measure` · `.compare_previous` · `.compare_target` · `.breakdown` | 해당 위치에 converted 값이 있으면 fx 필수 |
| `kpi.fx_quote_krw` · `kpi.fx_quote_uzs` | 최상위가 converted KRW(UZS)면 fx.quote도 KRW(UZS). USD는 base라 허용 |
| `kpi.fx_requires_converted` | converted 값이 하나도 없으면 fx 금지 |
| `period.instant_no_range` | type instant면 start·end 금지 |
| `period.season_id` | type season이면 season_id 필수 |
| (키워드) | schema_version `"1.2"`, kpis 1개 이상, kpi_id `^[A-Z]{2,4}\.[A-Z0-9_]{2,40}$`(REF.FX 허용), generated_at·updated_at date-time, data_as_of null·date·date-time, fx.rate > 0 |

### 런타임 규칙(`src/validate.mjs`)

| 규칙 ID | 계층 | 내용 |
|---|---|---|
| `raw.int_lexical` | 원문 | money·count 값 원문은 `-?(0\|[1-9]\d*)`만(소수점·지수 표기 금지) |
| `raw.int_range` | 원문 | money·count 값 원문 절대값 ≤ 9007199254740991(텍스트 비교) |
| `raw.neg_zero` | 원문 | `-0` 금지 |
| `sem.kpi_id_unique` | 의미 | 한 봉투 안 kpi_id 중복 금지 |
| `sem.converted_currency` | 의미 | 한 KPI 안의 모든 converted money(최상위·compare·breakdown) currency ∈ {fx.quote, USD} |
| `sem.period_order` | 의미 | period.start ≤ period.end |
| `sem.data_as_of_not_future` | 의미 | data_as_of(날짜면 period.tz의 그날 00:00) ≤ generated_at + 5분 |
| `sem.updated_at_not_future` | 의미 | updated_at ≤ generated_at + 5분 |
| `sem.fx_as_of_not_future` | 의미 | fx.as_of ≤ generated_at의 날짜 + 1일(period.tz 기준) |
| `sem.last_success_not_future` | 의미 | error.last_success_at ≤ generated_at |
| `sem.compare_kind` | 의미 | compare.previous/target의 kind = 최상위 kind |
| `sem.compare_currency` | 의미 | money 비교값 currency = 최상위 currency(어느 한쪽이 converted면 제외) |
| `sem.null_when_error` | 의미 | status error/unavailable이면 breakdown·compare 값도 전부 null |
| `sem.money_no_decimals` | 의미 | money에 decimals 금지(minor_exponent가 담당) |
| `sem.no_personal` | 의미 | sensitivity `personal` 거부(R4 §2.3 규칙 4) |

끌 수 없는 검사: 입력이 문자열이 아님(`input.type`), JSON 문법 오류(`json.syntax`), 원문 토큰을 읽을 수 없음(`raw.source_unavailable`), generated_at 해석 불가(`sem.generated_at_parse`).
런타임 규칙은 `createValidator({ unsafeTestRuleOverrides })`로 하나씩 끌 수 있으나 **변이 시험 전용**이다. 운영 코드는 `validateEnvelope()`만 쓴다.

## 시험 구성

- `test/cases.mjs`: 케이스 85개. 각 케이스는 `{ id, desc, expect, layer, schemaOnly?, build() }`.
  - C01–C27: v1.1 시험과 같은 입력 변형·같은 기대값을 v1.2 예시 기준으로 옮김. 예시에 USD 환산 병기 값이 생겨서, 원래 fx를 지우던 케이스는 병기 값도 함께 지우고(`dropFx`), C12는 breakdown 값도 null로 둔다(v1.2 의미 규칙).
  - C28–C85: v1.2 추가(fx_rate, 환산 위치별 fx, 기간, 원문 토큰, 의미 규칙, 경계 대조군).
- 판정 기준(v1.2): ① 전체 결과(accept/reject) ② 거부한 **첫 계층** ③ **스키마 단독** 결과(스키마 파일만 쓰는 소비자용) — 셋 다 기대와 같아야 PASS. ③이 있어서 원문 검사와 겹치는 스키마 범위 조건(money minimum·maximum)도 변이 시험에서 검출된다.
- v1.0·v1.1 열은 v1.2 봉투의 `schema_version`만 바꿔 스키마 단독으로 본 **비교값**이다(종료코드에 영향 없음).

### 최근 실행 결과(2026-09-16, Node v22.22.2, ajv 8.20.0, ajv-formats 3.0.1)

| 항목 | 결과 |
|---|---|
| 케이스 | 85개 = 대조군 20 + 거부 65(원문 9 · 스키마 42 · 의미 14) |
| 불일치 | v1.0 54건(C01–C27 중 15건) · v1.1 31건(C01–C27 중 0건) · **v1.2 0건** |
| 변이 | **60/60 검출**(스키마 45 · 런타임 규칙 15) |
| 외부 검증 재현 | 17/17 통과(증거 해시 6, v1.0 15건·v1.1 0건, GPT 변이 10/10, P01·P02 각 4항목) |
| 종료코드 | 0 |

## 형식 검사 의존성 주의

JSON Schema의 `format`은 검증기 설정에 따라 **검사하지 않고 통과**시킬 수 있다.

- **ajv**: `ajv-formats`를 추가해야 한다. 이 패키지는 로드 시 카나리아로 확인한다.
- **Python jsonschema**: `FormatChecker()`를 넘기는 것만으로는 부족하고, date-time 검사에는 `rfc3339-validator`가 필요하다. `pip install "jsonschema[format]"`로 설치한다. 없으면 **date-time 검사가 오류 없이 조용히 꺼진다.**

이 환경에서 확인한 결과(jsonschema 4.26.0, 스키마 단독 84개 케이스 — C85 추가 전 측정):

| Python 환경 | `'date-time' in FormatChecker().checkers` | v1.2 스키마 단독 불일치 | GPT `recheck.py` 사본 |
|---|---|---|---|
| jsonschema만(rfc3339-validator 없음) | False | 4건(C03·C07·C23·C40) | v1.0 불일치 16건(C03 추가) → assert 실패 |
| `jsonschema[format]` | True | 0건(ajv와 같음) | v1.0 15건 · v1.1 0건 재현 |

Python에서 쓸 때는 시작할 때 다음처럼 확인한다.

```python
from jsonschema import Draft202012Validator, FormatChecker
fc = FormatChecker()
assert 'date-time' in fc.checkers and not fc.conforms('not-a-time', 'date-time'), 'format checker inactive'
validator = Draft202012Validator(schema, format_checker=fc)
```

스키마만 쓰는 소비자는 원문 토큰·의미 검사를 하지 않는다. 운영 수신 경로는 반드시 `validateEnvelope()`(또는 같은 규칙의 구현)을 쓴다.

## 알려진 한계

1. **원천 → D1 → API → 화면 왕복 시험은 허브 구현 후**에 한다(미실시). 여기서는 봉투 계약만 시험했다.
2. **Cloudflare Workers 적용 방식은 미확인**이다. ajv는 스키마를 런타임에 코드로 컴파일한다. Workers는 문자열 코드 생성(`new Function`)을 허용하지 않는 것으로 알려져 있어 ajv standalone 사전 컴파일이 필요할 수 있다. 스키마 로드도 `node:fs`를 쓰므로 허브 구현 때 바꿔야 한다. 현재 `ajv`·`ajv-formats`는 devDependencies이므로, 런타임에 쓰려면 dependencies로 옮기거나 사전 컴파일 결과를 포함한다.
3. **JSON 중복 키**: `JSON.parse`는 같은 키 중 마지막 값만 남기므로, 원문 검사도 마지막 값만 본다. 중복 키 자체의 거부는 구현하지 않았다.
4. **환산 산술은 검사하지 않는다.** 예를 들어 USD 병기 값이 KRW 값 ÷ fx.rate와 맞는지는 보지 않는다. 통화 조합(fx.quote 또는 USD)만 검사한다.
5. **fx.as_of 날짜 규칙**: CBU가 다음 날 적용 환율을 전날 공시할 수 있어 generated_at 날짜 + 1일까지 허용한다(C85 대조군, +2일은 C75로 거부). CBU 공시 시점은 **미확인** — 수집기 구현 때 확인한다.
6. **시간대 표**: `Asia/Seoul` +09:00, `Asia/Tashkent` +05:00, `UTC`의 고정 오프셋을 쓴다(세 곳 모두 현재 일광절약시간 없음). period.tz 목록을 늘리면 `TZ_OFFSET_MINUTES`도 함께 고친다.
7. **금액 범위**: ±9,007,199,254,740,991 최소단위까지만 받는다. 더 큰 금액은 v2에서 정수 문자열로 확장한다(R4 §2.2).
8. **한 번에 한 계층의 오류만** 돌려준다. 스키마 오류가 있으면 의미 오류는 보고하지 않는다.
