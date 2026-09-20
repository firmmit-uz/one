<p align="right"><img src="../logo.svg" alt="FIRMMIT" width="120"></p>

# FIRMMIT ONE 변경표 v2.3

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-09-17 (같은 날 Z35·Z36 보강) |
| 앞 판 | 변경표 v2.2 (2026-09-16) |
| 이번 범위 | Phase 1.5 **WP1–WP3** + TV 쇼룸 **WP4** — 로컬 제작·시험까지 |
| 배포 | **하지 않음.** 게이트 G1(V0–V13) 통과 + 박선기 대표 승인 뒤 FIRMMIT 직원이 직접 |
| 계정 접속 | **없음.** 로그인·배포·원격 D1·Secret 등록 전부 하지 않았다 |
| 외부 호출 | **없음.** 모든 연동은 가짜 서버·고정 응답으로만 시험했다 (시험이 외부 요청 0건을 확인한다) |

상태는 네 가지만 쓴다.

- **수정함** — 바꿨고 독립 재검수 전
- **재시험 통과** — 자동 시험으로 확인
- **운영 검증 대기** — 실제 계정·시스템에서만 확인 가능
- **보류** — FIRMMIT 결정 필요

---

## 1. 변경 항목

| ID | 위치 | 근거 | 내용 | 확인 방법 | 결과 | 상태 | 남은 운영 시험 |
|---|---|---|---|---|---|---|---|
| Z01 | 저장소 전체 | 인수인계서 §1 | 인수 직후 기준 시험이 §1 기준값과 같은지 먼저 확인 | 7개 명령 실행 | 허브 135/135 · 변이 9/9 · 계약 85건 불일치 0 · 변이 60/60 · 의미 17/17 · 번들 137.12 KiB — 전부 일치 | 재시험 통과 | — |
| Z02 | `apps/hub/src/groupsync.ts` (신규) | WP1 | Access 그룹 목록을 15분마다 읽어 사본 자동 교체. 허용 목록 8개만, 이메일 규칙만, `require` 는 로그인 방식 조건만 | `test/groupsync.test.ts` 35건 | 통과 | 재시험 통과 | G01 |
| Z03 | `migrations/0004_groupsync.sql` (신규) | WP1 | `group_sync_state` — 시도·실패 사유·연속 실패·지연 감사 표시. 시각은 24자 한 형식만(CHECK) | 마이그레이션 적용 후 시험 | 통과 | 재시험 통과 | G02 |
| Z04 | `src/index.ts` | WP1 | `scheduled()` 를 `controller.cron` 값으로 나누는 구조로 변경. 모르는 값은 경고만 | `cronJob()` 시험 | 통과 | 재시험 통과 | — |
| Z05 | `src/admin.ts` | WP1 | 사본 교체 SQL 을 공용 함수로 분리. **자동 모드에서 수동 입력은 409 `auto_sync_enabled`** (수동 입력이 동기화 시각을 갱신해 실패를 가리는 것을 막는다) | 시험 2건 + 변이 1건 | 통과 | 재시험 통과 | — |
| Z06 | `public/app.js` · `i18n.js` | WP1 | 관리 화면 "그룹 동기화" — 방식·마지막 성공·마지막 시도·실패 사유·다음 예정 (ko·uz-Latn·ru). 자동 모드에서는 수동 입력란을 닫는다 | 화면 시험 2장 추가 | 통과 | 재시험 통과 | — |
| Z07 | `test/headers.test.ts` | 인수인계서 §1 단서 | `wrangler.jsonc` 의 `vars`·`crons` 정확 비교를 새 값으로 갱신(`toEqual` 유지). 비밀값이 설정에 없는지도 함께 검사 | 시험 | 통과 | 재시험 통과 | — |
| Z08 | `packages/contracts/src/core.mjs` (신규) | WP2-A | 원문 토큰 검사·의미 검사·시각 계산을 Node 전용 API 없는 공용 모듈로 분리. 두 진입점이 같은 코드를 쓴다 | 기존 85건 재실행 | 불일치 0 | 재시험 통과 | — |
| Z09 | `src/worker.mjs` · `scripts/build-validator.mjs` · `src/generated/*` (신규) | WP2-A | Workers 용 진입점 + 빌드 시점 Ajv standalone 사전 컴파일. 형식 검사는 ajv-formats 실제 구현을 import. Ajv 가 박아 넣는 `require("ajv/dist/runtime/ucs2length")` 는 같은 구현으로 치환 | `test/worker.test.mjs` 17건 | 85개 사례에서 판정·거부 계층·규칙 완전 일치 | 재시험 통과 | — |
| Z10 | `apps/hub/test/bundle-check.mjs` (신규) | WP2-A | `build:dry` 산출물에 `eval`·`new Function`·`node:`·`require` 가 없는지 확인. **산출물이 없으면 건너뛰지 않고 실패** | `npm run test:bundle` | 9/9 통과, 금지 구문 0건 | 재시험 통과 | — |
| Z11 | `migrations/0005_kpi.sql` (신규) | WP2-B | `kpi_visibility`(KPI×그룹 열람 수준) · `phase0_checklist`(V0–V13) · `kpi_def` 6행 | 시험 | 통과 | 재시험 통과 | G02 |
| Z12 | `src/kpi/*` (신규) | WP2-B | 봉투 생성 → 계약 v1.2 검증 → `kpi_def` 기준 stale 재계산 → `kpi_cache` → 권한 필터 → R4 §2.3 표시 필드. `GET /api/kpi`·`/api/kpi/:id` | `test/kpi.test.ts` 39건 + 변이 3건 | 통과 | 재시험 통과 | G02·G03 |
| Z13 | `SYS.UPTIME` 정의 | **R4 §1.6 과 다름** | R4 는 "16개 시스템 24시간 가용률". `uptime_state` 에 이력이 없고 점검 대상이 9개라 **현재 DOWN 앱 수**만 낸다. 이력 표는 만들지 않았다 | `kpi_def.definition_note` 에 기록 | 화면에 현재 상태만 표시 | 수정함 | 이력 표 설계(Phase 2) |
| Z14 | KPI 조회 감사 | **R4 §2.1 ⑥ 과 다름** | 조회를 `audit_log`(해시 체인)에 넣지 않고 `kpi_read` 구조화 로그만 남긴다. 조회마다 체인에 쓰면 경합·용량이 커지고 **감사 보존 기간이 아직 결정되지 않았다** | 시험: 조회 뒤 `audit_log` 증가 0 | 통과 | **보류** | 보존 기간 결정과 함께 확정 |
| Z15 | `src/kpi/phase0.ts` + 관리 API | WP2-B | 게이트 G1 체크리스트 관리 입력. **통과 표시에는 증적 참조 필수**, 증적에 주소·이메일·비밀값 형태 금지. 변경 + 감사 한 batch | 시험 6건 + 변이 1건 | 통과 | 재시험 통과 | — |
| Z16 | `public/app.js` · `styles.css` · `i18n.js` | WP2-B · R4 §2.4 | 홈 상단 고정 줄(데이터 기준·지연 KPI·다운) + 시스템 카드. 아이콘+글자+색, "표로 보기", 새로 나빠진 KPI 만 `aria-live` 로 한 번 알림 | 화면 시험 | 통과, 콘솔 오류 0 | 재시험 통과 | — |
| Z17 | `apps/hub/docs/kpi-response.schema.json` (신규) | WP2-B 완료 기준 | `/api/kpi` 응답 형식을 JSON Schema 로 문서화하고 **실제 응답으로 검증**(관리자·직원·지연 상태 3가지) | 시험 1건 | 통과 | 재시험 통과 | — |
| Z18 | `packages/contracts/src/ids.mjs` (신규) | WP2-C · R4 §3.2 | 공통 ID 검사기. 확정 6종(CUS·PRD·SKU·ORD·PRJ·EMP)은 R4 정규식 그대로 | `test/ids.test.mjs` 21건 | 통과 | 재시험 통과 | — |
| Z19 | 초안 ID 5종 | R4 에 정규식 없음 | QUO·DOC·SITE·PL·CC 는 예시에서 정규식을 만들고 `status: 'draft'` 로 표시 | 시험 | 통과 | **보류** | §4 질문 2 |
| Z20 | `migrations/0006_tokens.sql` (신규) | WP3 | 선기록에 `key_version`·`lease_until`, 토큰에 `last_refresh_journal_id`, 색인 | 시험 | 통과 | 재시험 통과 | G02 |
| Z21 | `src/tokens/crypto.ts` (신규) | WP3 | WebCrypto AES-GCM. 키는 Worker Secret `TOKEN_KEY_V1`, 없거나 자리표시자·길이 불일치면 실행하지 않는다. 복호 실패는 예외 대신 null | 시험 5건 | 통과 | 재시험 통과 | — |
| Z22 | `src/tokens/refresh.ts` (신규) | WP3 · R2 §1.4 | ①–⑥ 을 순서 그대로. 응답 유실 → `unknown`(자동 재시도 금지, 다음 실행 차단), 죽은 `in_progress` 차단 | `test/tokens.test.ts` 36건 + 변이 5건 | 통과 | 재시험 통과 | G02 |
| Z23 | ④ + journal `applied` 묶는 방식 | **R2 에서 `[재확인 필요]` 였던 항목** | 조건부 SQL 로 구현. "우리가 쓴 행" 판정은 **선기록 id** 로 한다 — version 이나 시각만으로는 그 사이 다른 실행이 쓴 것과 구분되지 않는다(시험으로 확인) | 충돌 시험: 토큰 값·버전이 덮어써지지 않음 | 통과 | **운영 검증 대기** | G02 (원격 D1 batch) |
| Z24 | 2xx 인데 해석 불가 | R2 에 없는 구분 | 2xx + 파싱 실패는 회전이 일어났을 수 있으므로 `unknown`(차단). 2xx 가 아니면 회전이 없었다고 보고 다시 시도할 수 있는 `failed` | 시험 2건 | 통과 | 수정함 | §4 질문 3 |
| Z25 | `SYS.TOKEN_EXPIRY` | WP2 "준비 중" → WP3 값 연결 | 만료 임박(72시간) 토큰 수. 충돌·확인 불가가 있으면 `error`(P1 상황). **알림 발송 없음** | 시험 2건 | 통과 | 재시험 통과 | — |
| Z26 | `GET /api/admin/tokens` + 화면 | WP3 | 토큰별 상태만(정상·만료 임박·충돌·확인 불가·갱신 중·만료 정보 없음). **값·암호문은 내려보내지 않는다** | 시험 4건 | 통과 | 재시험 통과 | — |
| Z27 | `wrangler.jsonc` | WP1·WP3 | `CF_ACCOUNT_ID` 자리표시자 · `TOKEN_REFRESH_ENABLED: "false"` · Cron `*/15`·`0 * * * *` 추가. 비밀값은 넣지 않음 | 시험(정확 비교) | 통과 | 재시험 통과 | — |
| Z28 | Cron 계정 합계 | R1 §5 (Free 5개) | 허브 3개(`*/5`·`*/15`·`0 * * * *`) + BAND 브리지 1개 = **4개**. 여유 1개. R1 의 `25 23 * * *` 는 넣지 않았다 | README 4.1 에 기록 | — | 수정함 | — |
| Z29 | `EPOCH` 값 | **R2 문서와 다름** | R2 §1.4 ⑥ 은 `'1970-01-01T00:00:00Z'`(밀리초 없음). 시각 형식 통일 규칙(밀리초 3자리)에 맞춰 `'1970-01-01T00:00:00.000Z'` 로 쓴다 — 섞이면 문자열 비교가 틀어진다 | 시험 2건(형식 섞임 거부 포함) | 통과 | 수정함 | — |
| Z30 | `apps/showroom/**` (신규) | WP4 | TV 쇼룸. 별도 Worker, D1·Access·쿠키·Cron·비밀값 없음, 외부 요청 0건, 브라우저 저장소 미사용 | 시험 29 + 27건 | 통과 | 재시험 통과 | G09 |
| Z31 | `content/manifest.json` | WP4 · G10 | **승인된 콘텐츠가 없어 전부 자리표시자**. `release.status: "sample"` 이라 화면에 "샘플 — 승인 전" 고정 표시, 모든 항목의 승인자는 `"SAMPLE"` | 시험 3건 | 통과 | **보류** | G10 (승인 콘텐츠·승인자) |
| Z32 | 쇼룸 QR | WP4 | 빌드 시점에 SVG 로 생성(실행 중 생성 없음). **독립 디코더(OpenCV)로 다시 읽어** 공개 주소와 일치 확인 | 시험 1건(3개) | 통과 | 재시험 통과 | 실제 휴대폰 확인(G09) |
| Z33 | `test/mutation.mjs` | 인수인계서 품질 기준 | 변이 9개 → **24개** (WP1 5 · WP2 5 · WP3 5 추가). `docs` 를 복사 목록에 추가 | `npm run test:mutation` | 24/24 검출 | 재시험 통과 | — |
| Z34 | `package-lock.json` | 인수인계서 §1 단서 | 작업공간(`apps/showroom`)·의존성(`@firmmit-one/contracts`·`ajv-formats`·`ajv`·`qrcode-generator`) 추가로 갱신 | 새 사본에서 `npm ci` | 통과 | 재시험 통과 | — |
| **Z35** | `src/tokens/refresh.ts` · `migrations/0006` | **Z23 자체 점검 결과 수정** | ④ batch 의 두 문장이 **같은 pre-state(`version = token.version`)** 만 조건으로 보게 바꿨다. 판정은 토큰 UPDATE 의 `meta.changes` **하나로만** 한다. 어긋난 경우(있을 수 없음)는 구조화 로그 + 기록 정정 | 시험 2건 신규(가시성 없음·기록만 적용됨) + 변이 3건 | 통과 | 수정함 | G02 (원격 D1 batch) |
| **Z36** | `apps/showroom/public/app.js` | **WP4 자체 점검 결과 수정** | 시계 조작 `?now=YYYY-MM-DD` 를 **로컬(127.0.0.1·localhost)에서만** 받는다. 배포본에서는 무시 → 주소창으로 승인 기간을 우회할 수 없다 | 시험 9건 신규(호스트별·형식별 + 코드 규칙 2건) | 통과 | 수정함 | — |

---

### 1-1. Z35 · Z36 은 왜 고쳤나

리뷰를 맡기기 전에 스스로 다시 읽다가 찾은 것이다. **둘 다 시험은 전부 통과하고 있었다.**

| | Z35 (토큰 갱신) | Z36 (쇼룸 시계) |
|---|---|---|
| 예전 코드 | journal 문장이 **앞 문장이 방금 쓴** `version + 1` · `last_refresh_journal_id` 를 `EXISTS` 로 확인 | `?now=` 를 호스트 구분 없이 받음 |
| 로컬에서 안 걸린 이유 | `node:sqlite` FakeD1 은 순차 실행이라 앞 문장 결과가 항상 보인다 | 시험 서버가 `127.0.0.1` 이라 배포 상황과 구분되지 않는다 |
| 틀어지면 | 원격 D1 이 batch 안에서 그 가시성을 보장하지 않을 경우 **성공한 갱신이 전부 `conflict`** → 토큰 차단 → 관리자 재인증 | 주소창만 고쳐 **만료·게시 전 항목을 TV 에 표시** 가능 (`draft`·`withdrawn` 은 여전히 안 보인다) |
| 지금 | 두 문장의 조건이 같은 pre-state 만 본다. batch 가 트랜잭션이면 되고, **read-your-write 는 필요 없다** | 로컬이 아니면 `?now=` 를 읽지 않는다. `forcedDate()` 를 내보내 호스트별로 직접 시험한다 |
| 남은 가정 | "batch 는 트랜잭션이다" (공식 문서에 명시된 성질) — 그래도 G02 에서 확인한다 | 없음 |

---

## 2. 시험 결과표

명령은 저장소 루트에서, `WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false` 를 켠 상태로 실행했다. Node v22.22.2.

| # | 명령 | 인수 시점(기준값) | 작업 뒤 | 종료코드 | 판정 |
|---|---|---|---|---|---|
| 1 | `npm test -w packages/contracts` | 사례 85건 · 불일치 0 / 변이 60/60 / 의미 17/17 | 사례 **85건 · 불일치 0** / 변이 **60/60** / 의미 **17/17** / **Worker 17/17**(신규) / **ID 21/21**(신규) | 0 | ✅ 유지 + 증가 |
| 2 | `npm test -w apps/hub` | 8파일 · **135/135** | 11파일 · **247/247** (Z35 시험 2건 추가) | 0 | ✅ 증가 |
| 3 | `npm run typecheck -w apps/hub` | 오류 0 | 오류 **0** | 0 | ✅ |
| 4 | `npm run test:mutation -w apps/hub` | **9/9** 검출 | **27/27** 검출 · 미검출 0 (Z35 변이 3건 추가) | 0 | ✅ 증가 |
| 5 | `npm run test:bundle -w apps/hub` | (없음) | **9/9** · 금지 구문 **0건** | 0 | ✅ 신규 |
| 6 | `npm run build:dry -w apps/hub` | 약 **137 KiB** | **605.9 KiB** (gzip 약 94.5) | 0 | 기록만 — §3 |
| 7 | `npm run test:ui -w apps/hub` | 13장 · 콘솔 오류 0 | **14장 + 1흐름** · 콘솔 오류 0 · 실패 0 | 0 | ✅ 증가 |
| 8 | `npm test -w apps/showroom` | (없음) | **38/38** · 콘텐츠 문제 0건 (Z36 시험 9건 추가) | 0 | ✅ 신규 |
| 9 | `npm run test:ui -w apps/showroom` | (없음) | **27/27** · 캡처 7장 · 외부 요청 0 · 콘솔 오류 0 | 0 | ✅ 신규 |
| 10 | `npm ci` (새로 푼 사본) | 통과 | 통과 | 0 | ✅ |

**시험 수·검출 수는 어느 것도 줄지 않았다.**

### 번들 크기가 늘어난 이유

137.12 KiB → 605.97 KiB (gzip 34.96 → 94.47 KiB).

| 더해진 것 | 크기 |
|---|---|
| 사전 컴파일 검사기 `schema-validator.mjs` | 약 259 KiB |
| `ajv-formats/dist/formats.js` (형식 검사 실제 구현) | 약 20 KiB |
| WP1·WP2·WP3 소스와 화면 | 나머지 |

Workers 한도는 **비압축 64 MiB**(Free·Paid 동일, "There is no compressed size limit").
출처: <https://developers.cloudflare.com/workers/platform/limits/> (2026-09-17 확인). 여유가 크다.
Free 플랜 CPU 10 ms/요청은 조회 경로(캐시 읽기)만 타므로 문제되지 않으나,
Cron 의 봉투 검증 6건에 대한 실제 CPU 사용량은 **운영 검증 대기**다.

---

## 3. 파일 해시 (SHA-256 앞 12자리)

| 파일 | 해시 |
|---|---|
| `apps/hub/migrations/0004_groupsync.sql` | `c844c1ee96b0` |
| `apps/hub/migrations/0005_kpi.sql` | `99f3d313cba3` |
| `apps/hub/migrations/0006_tokens.sql` | `8a37dd079ffa` (Z35 로 주석 갱신) |
| `packages/contracts/schema/kpi-summary-v1.2.json` | `8ed9ab2ece1f` (바뀌지 않음) |
| `packages/contracts/src/generated/schema-validator.mjs` | `9ea7420e6f2f` |
| `packages/contracts/src/generated/schema-meta.mjs` | `8fa98dd8a1ec` |
| `packages/contracts/src/ids.mjs` | `bb0c8674d86e` |
| `apps/hub/docs/kpi-response.schema.json` | `33585bc588b2` |
| `apps/showroom/content/manifest.schema.json` | `854b9f83cf51` |
| `apps/showroom/content/manifest.json` | `bb8fac7f0cdc` |
| `apps/hub/src/tokens/refresh.ts` (Z35) | `5655a374fc72` |
| `apps/showroom/public/app.js` (Z36) | `db141430dea5` |

스키마 해시는 사전 컴파일 검사기 안에도 들어 있다 — 스키마를 고치고 `build:validator` 를 다시 돌리지 않으면 시험이 실패한다.

---

## 4. 남은 운영 검증 (G01–G10 중 이번 작업이 건드린 것)

| ID | 이번 작업과의 관계 | 확인해야 할 것 |
|---|---|---|
| **G01** | WP1 그룹 동기화 · 권한 판정 | 실제 Access 그룹 API 응답 모양(특히 `result_info` 유무, `require` 규칙의 실제 형태), 읽기 전용 토큰 권한, 실제 JWT 로 그룹에서 빠진 직원이 거부되는지 |
| **G02** | WP1·WP2·WP3 의 D1 동작 전부 | 원격 D1 의 batch·조건부 UPDATE·트리거·`json_valid` 동작. 특히 **Z23→Z35**(④ + journal applied 를 한 batch 로 묶는 조건부 SQL)는 로컬 `node:sqlite` 에서만 확인했다. Z35 로 read-your-write 의존은 없앴고, 남은 가정은 "batch 는 트랜잭션" 하나다 |
| **G03** | WP2 외부 소스 | 농자재·견적 등 실제 소스의 필드·금액. 지금은 어댑터 인터페이스와 가짜 소스 왕복까지만 |
| **G09** | WP4 TV 쇼룸 | 실제 TV·리모컨·24시간 연속·재부팅·절전·네트워크 단절 (`apps/showroom/README.md` §5 체크리스트) |
| **G10** | WP4 콘텐츠 | 승인된 콘텐츠·승인자·표시 언어. 지금은 전부 자리표시자이고 "샘플 — 승인 전" 이 계속 표시된다 |

G04(카카오봇)·G05(CCTV)·G06(스마트스토어·프레시)·G07(알림)·G08(백업 복원)은 이번 작업에서 건드리지 않았다.

---

## 5. 확인하지 못한 것 `[재확인 필요]`

| 항목 | 지금 어떻게 해 두었나 | 확인 방법 |
|---|---|---|
| Access 그룹 목록 응답에 `result_info` 가 있는지 | 있으면 쓰고, 없으면 "마지막 쪽이 `per_page` 미만" 으로 판정 (양쪽 모두 시험) | 읽기 전용 토큰으로 1회 호출해 응답 확인 |
| `require` 규칙의 실제 모양 | 로그인 방식 조건(`login_method`·`auth_method`)만 허용하고 구성원 계산에 쓰지 않음. 그 밖은 동기화 전체 실패 | 실제 Access 그룹 설정 확인 |
| `email_list` 규칙 지원 | **지원하지 않고 실패 처리.** 목록 조회 API 를 공식 문서로 확인하지 않았다 | 목록 조회 API 확인 후 별도 시험과 함께 추가 |
| 원격 D1 batch 안에서 앞 문장 결과를 뒤 문장이 보는지 | **더 이상 기대지 않는다(Z35).** 두 문장이 같은 pre-state 만 본다 | G02 (staging D1) — 확인해도 코드는 그대로 |
| cafe24 몰 ID·앱 등록·실제 갱신 주소 | 자리표시자. 어댑터는 호출하면 `provider_not_configured` 로 끝난다 | 앱 등록·최초 인증 뒤 |
| Cron 실행의 CPU 사용량(Free 10 ms) | 번들 크기만 기록 | 배포 후 실측 |
| 쇼룸 최종 주소 | 정해지지 않음. `show.firmmit.com` 은 개설·승인된 사실이 없다 | FIRMMIT 결정 |
| 사내 TV 해상도·리모컨 키 코드 | 1920/3840 과 표준 키 + 기기별 keyCode 몇 가지를 넣어 둠 | G09 현장 |

---

## 6. FIRMMIT 에 물을 것

| # | 질문 | 왜 필요한가 | 지금 처리 |
|---|---|---|---|
| 1 | **감사기록 보존 기간** | KPI 조회 감사를 체인에 넣을지(Z14)가 여기에 걸려 있다 | 구조화 로그만 (보류) |
| 2 | **초안 ID 5종 정규식** 승인 — `QUO:(GH\|NJJ):…` · `DOC-(KRFM\|UZGL\|UZIT)-(QT\|CT\|IV\|PO\|PM\|TR\|RP)-YYYY-#####` · `SITE-KR-ICHEON-VF/A-1` 형태 · `PL-(KR\|UZ)-(KRW\|UZS\|USD)-버전` · `CC-법인-코드` | 발급을 시작하면 되돌리기 어렵다 | `status: 'draft'` 로 표시 |
| 3 | **SKU 와 PRD 의 분류 코드 차이** — R4 §3.2 에서 PRD 는 `(AG\|GH\|FP\|EQ)` 로 좁히는데 SKU 는 `[A-Z]{2}` 로 넓다. 의도한 것인가 | 같은 품목을 두 가지로 쓸 수 있게 된다 | R4 정규식 그대로 구현 |
| 4 | **토큰 갱신에서 "2xx 인데 해석 불가"** 를 차단 대상으로 볼지(Z24) | 차단하면 관리자 재인증이 필요하고, 안 하면 죽은 토큰으로 계속 시도한다 | 차단(`unknown`)으로 구현 |
| 5 | **쇼룸 승인 콘텐츠·승인자(직책)·표시 언어** | G10. 지금은 전부 자리표시자다 | 샘플 + "승인 전" 고정 표시 |
| 6 | **쇼룸 최종 주소** 와 TV 기기·키오스크 설정 담당 | 배포·현장 시험(G09) | workers.dev 임시, 방문객 화면에 주소 노출 안 함 |
| 7 | **Workers Paid 전환 여부** | Free CPU 10 ms/요청 — Cron 의 봉투 검증 부하 | 번들·경로를 보고서에 기록 |
| 8 | **읽기 전용 Cloudflare API 토큰** 발급 담당자 | WP1 자동 동기화를 켜는 조건 | 절차를 README 4-8a 에 자리표시자로 작성 |
| 9 | **관리자 재인증 절차**(토큰 충돌·확인 불가 해제) | 이번 범위 밖이라 그 상태가 되면 사람이 풀어야 한다 | 차단 상태 유지 + 화면 표시 |

---

## 7. 이번 작업에서 **하지 않은** 것

- 계정 로그인 · 배포 · 원격 D1 변경 · Secret 등록 (`--dry-run` 만 실행)
- 실제 외부 API 호출 (cafe24 · 네이버 · Cloudflare API · Google · Slack · Telegram · 카카오)
- 알림 발송 코드 (Phase 3) — P1 상황은 감사기록 1건 + KPI 상태로만 남긴다
- 하위 앱에 값을 쓰는 기능 (Phase 4)
- 기존 마이그레이션 `0001`–`0003` 수정, 기존 시험 삭제·완화
- 기존 앱(농자재·견적·이천·FINO·AMIM·카카오 봇) 코드 수정
- `참고자료/` 를 저장소에 넣기
- 확인되지 않은 주소(스마트스토어·퍼밋프레시·쇼룸 최종 주소) 추정 입력

---

# 부록 A. R3 CCTV 1단계 (2026-09-19 추가)

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-09-19 |
| 지시 | FIRMMIT — "허브 화면에서 CCTV 영상을 직접 본다" · **승인** |
| 범위 | **이번 인수인계 범위(Phase 1.5) 밖**이다. 인수인계서 §8-5 의 `CCTV(R3)` 를 FIRMMIT 요청으로 착수했다 |
| 만든 곳 | 허브만. 중계 서버·카메라 설정·배포는 하지 않았다 |
| 계정 접속 | **없음.** 실제 카메라·중계 서버 호출 0건 (전부 가짜 서버) |
| 배포 | **하지 않음.** `CCTV_ENABLED` 기본 `"false"` |

## A-1. 왜 이 구조인가

FIRMMIT 확인: **Tapo 는 휴대폰 앱 전용이고 웹 콘솔이 없다.** 그래서 허브에 넣을 웹 주소가 없다.
공식 문서상 Tapo 는 **RTSP/ONVIF** 를 내보낸다(`rtsp://아이디:비밀번호@카메라IP:554/stream1`, 사내망 전용).
그런데 브라우저는 RTSP 를 재생하지 못한다. 그래서 사이에 **중계 서버**가 반드시 필요하다.

```
[Tapo 카메라] --RTSP(사내망)--> [중계 서버] --HTTPS--> [허브 Worker] --같은 출처--> [브라우저]
                                   └ 카메라 계정·비밀번호는 여기에만 있다
```

허브가 **직접 받아서 같은 출처로 전달**하게 한 이유 네 가지:

| # | 이유 |
|---|---|
| 1 | 중계 서버 주소를 브라우저에 직접 주면 **보안 헤더(CSP)를 풀어야 한다** → 풀지 않았다 |
| 2 | 중계 서버 **접속표가 브라우저로 나가지 않는다** |
| 3 | 영상 요청 하나하나가 허브의 **인증·권한 검사**를 지난다 |
| 4 | 관리자가 넣는 것은 **경로뿐**이라, 허브가 엉뚱한 서버로 요청하게 만들 수 없다 |

## A-2. 변경 항목

| ID | 위치 | 근거 | 내용 | 확인 방법 | 결과 | 상태 | 남은 운영 시험 |
|---|---|---|---|---|---|---|---|
| **Z37** | `migrations/0007_cctv.sql` (신규) | R3 | `cctv_cameras` 표. 이름은 한국어만, **중계 서버 안에서의 경로만** 저장(주소·계정 없음). 재생 방식은 `mp4`·`snapshot` 둘뿐. 미연결↔경로 짝을 CHECK 로 강제. **시드 행 없음**(실제 카메라를 확인하지 못해 추정하지 않았다) | 표 제약 시험 2건 | 통과 | 재시험 통과 | G11 |
| **Z38** | `src/cctv.ts` (신규 · 308줄) | R3 | 설정 확인(fail-closed) · 재생 판정 한 군데(`playTarget`) · 같은 출처 전달(프록시) · 목록·열람·재생 API | `test/cctv.test.ts` 39건 | 통과 | 재시험 통과 | G11 |
| **Z39** | `src/cctv.ts` | 설계 원칙 1 | **기본 꺼짐**(`CCTV_ENABLED !== "true"` 면 전부 꺼짐) · 중계 서버 주소는 https·계정/경로/질의 없는 것만 · 자리표시자면 꺼진 것과 같게 | 설정 시험 4건 + 변이 2건 | 통과 | 재시험 통과 | — |
| **Z40** | `src/cctv.ts` | 보안 | **경로 검사 2중**: 글자 검사(`/` 시작·`//`·`..`·역슬래시·제어문자)와 **되감기 검사**(합쳐 본 결과가 정말 그 서버 안인가). 서로 다른 입력을 하나씩 맡는다 — `/live/..%2fsecret` 는 앞이, `/live/%2e%2e/secret`·`/a#b` 는 뒤가 잡는다 | 경로 시험(정상 4·거부 15) + 변이 2건 | 통과 | 재시험 통과 | — |
| **Z41** | `src/cctv.ts` | 보안 | **응답 형식 흰 목록**: `mp4`→`video/mp4`, `snapshot`→`image/jpeg` 만 통과. 그 밖(HTML·자바스크립트·SVG 포함)은 502 → 허브 출처로 실행 가능한 내용이 들어오지 못한다. 상태 코드도 200·206 만 통과 | 형식 5종·상태 7종 시험 + 변이 2건 | 통과 | 재시험 통과 | — |
| **Z42** | `src/cctv.ts` | 설계 원칙 6 | 브라우저 머리말은 **`Range` 하나만** 중계 서버로 넘긴다(쿠키·Access 표 안 넘김). 돌려줄 때도 정해진 4개만 넘긴다. 접속표는 중계 서버로만 간다 | 머리말 시험 4건 + 변이 1건 | 통과 | 재시험 통과 | — |
| **Z43** | `src/cctv.ts` · `src/audit.ts` | 설계 원칙 2 | 열람을 시작하면 **감사기록 1건**(`cctv_view_open`). **주소·경로는 기록하지 않는다.** 영상 조각마다 남기면 체인이 넘치므로 조각은 구조화 로그만 | 감사 시험 4건 | 통과 | 재시험 통과 | — |
| **Z44** | `src/admin.ts` | 허브 ADMIN 관리 입력 | 카메라 등록·수정 `POST /api/admin/cctv`. 기존 규칙 그대로(ADMIN 확인·CSRF·입력 검증·변경+감사 **한 batch**). **상태를 따로 받지 않는다** — 경로가 없으면 미연결, 있으면 연결이라 어긋날 수 없다 | 관리 시험 6건 | 통과 | 재시험 통과 | — |
| **Z45** | `public/app.js` · `i18n.js` · `index.html` · `styles.css` | R3 · FIRMMIT 지시 | CCTV 화면(ADMIN 에게만 탭 노출, 서버가 다시 막는다). 영상은 `<video>`, 사진은 `<img>` 2초 새로고침. **문구는 한국어만** — `t()` 가 없는 키를 한국어로 대체하므로 우즈베크어·러시아어 화면에서도 한국어로 보인다 | 화면 3장 + 재생 흐름 1 | 통과 | 재시험 통과 | G11 |
| **Z46** | `test/headers.test.ts` · `wrangler.jsonc` | 인수인계서 §5 함정 | 변수 2개(`CCTV_ENABLED`·`CCTV_RELAY_ORIGIN`) 추가 → `vars` **정확 비교를 새 값으로 갱신**(부분 비교로 완화하지 않았다). 접속표가 설정 값에 들어가지 않는지 검사 추가 | `headers.test.ts` | 통과 | 재시험 통과 | — |
| **Z47** | `test/headers.test.ts` | 보안 | **CSP 전제를 시험으로 못 박았다** — `media-src` 를 두지 않아 `default-src 'self'` 가 적용된다(같은 출처 영상만 재생). 누가 `media-src` 를 넣거나 `default-src` 를 넓히면 시험이 실패한다 | CSP 시험 1건 | 통과 | 재시험 통과 | — |
| **Z49** | `src/cctv.ts` · `src/env.ts` · `wrangler.jsonc` | 중계 프로그램 실제 확인 | **인증 방식을 고쳤다.** 처음에 `Authorization: Bearer` 로 만들었으나 실제 중계 프로그램(go2rtc)은 **Basic 인증**을 쓰고, Cloudflare Tunnel 과 함께 쓰면 **서비스 토큰 머리말 2개**를 쓴다 → `CCTV_RELAY_AUTH` 로 `none`·`basic`·`cf-access` 중 고르게 바꿨다. **방법을 정해 놓고 값이 없으면 재생 거부**(조용히 익명으로 부르지 않는다) | 인증 시험 6건 + 변이 2건 | 통과 | 수정함 | G11 |
| **Z51** | `apps/hub/docs/cctv-relay/go2rtc.example.yaml` (신규) · `README.md` 4.3 · `test/cctv.test.ts` | FIRMMIT 확인 — 카메라는 **AKIS 온실**(Yuqori Chirchiq) | 설치 절차·설정 보기를 **AKIS 기준 실제 값**으로 확정(`akis-gh1` 등). 온실 현장 항목(습기·정전·무선·현지 업로드) 추가. **문서에 적은 값이 실제로 통과하는지 시험 3건으로 고정** — 문서와 코드가 어긋나면 현장에서 시간을 잃는다 | 시험 3건 신규 | 통과 | 재시험 통과 | G11 |
| **Z50** | `apps/hub/README.md` 4.3 | FIRMMIT 지시 "방법을 찾아" | **타슈켄트 현장 설치 절차**를 단계별로 작성 — 카메라 계정 발급 · go2rtc 설치·설정 · 절전 해제 · Cloudflare Tunnel · 잠그기 2가지 · 허브 Secret·변수 · 카메라 등록 · 해외 구간 대역폭 주의 | 문서 | — | 운영 검증 대기 | G11 |
| **Z48** | `src/cctv.ts` | 인수인계서 §9-3 | 자리표시자 검사가 주소·형식 검사와 **겹쳐** 변이가 살아남았다 → 겹치는 검사를 없애 관문을 한 군데로 모았다(동작은 그대로, 시험으로 확인) | 변이 36/36 미검출 0 | 통과 | 수정함 | — |

## A-3. 시험 결과표

| # | 명령 | 이번 작업 전 | 작업 뒤 | 종료코드 | 판정 |
|---|---|---|---|---|---|
| 1 | `npm test -w packages/contracts` | 85건·불일치 0 / 60/60 / 17/17 / 17/17 / 21/21 | **동일** | 0 | ✅ 유지 |
| 2 | `npm test -w apps/hub` | 11파일 · **247/247** | 12파일 · **294/294** (+47) | 0 | ✅ 증가 |
| 3 | `npm run typecheck -w apps/hub` | 오류 0 | 오류 **0** | 0 | ✅ |
| 4 | `npm run test:mutation -w apps/hub` | **27/27** | **38/38** 검출 · 미검출 0 (+11) | 0 | ✅ 증가 |
| 5 | `npm run test:bundle -w apps/hub` | 9/9 · 금지 0건 | **9/9** · 금지 **0건** | 0 | ✅ 유지 |
| 6 | `npm run build:dry -w apps/hub` | 605.9 KiB | **617.9 KiB** (gzip 97.3) | 0 | 기록만 (+12.0 KiB) |
| 7 | `npm run test:ui -w apps/hub` | 14장 + 흐름 1 | **17장 + 흐름 2** · 콘솔 오류 0 · 실패 0 | 0 | ✅ 증가 |
| 8 | `npm test -w apps/showroom` | 38/38 | **38/38** | 0 | ✅ 유지 |
| 9 | `npm run test:ui -w apps/showroom` | 27/27 | **27/27** · 외부 요청 0 | 0 | ✅ 유지 |
| 10 | `npm ci` (새 사본) | 통과 | 통과 (**의존성 추가 없음**) | 0 | ✅ |

**시험 수·검출 수는 어느 것도 줄지 않았다.**

## A-4. 파일 해시 (SHA-256 앞 12자리)

| 파일 | 해시 |
|---|---|
| `apps/hub/migrations/0007_cctv.sql` | `8189a3d183ee` |
| `apps/hub/src/cctv.ts` | `6722ad86a704` |
| `apps/hub/test/cctv.test.ts` | `43baa9789e24` |
| `apps/hub/test/fixtures/cctv-test-pattern.jpg` | `bb38068f99b0` |

`0001`–`0006` 마이그레이션과 §3 의 기존 해시 12개는 **바뀌지 않았다.**

## A-5. 남은 운영 검증

| ID | 무엇을 확인 | 틀리면 고칠 곳 |
|---|---|---|
| **G11** (신규) | 실제 중계 서버·카메라 연결 · **브라우저에서 H.264 영상 재생** · 대역폭 · Worker CPU·요청 수 | `src/cctv.ts` · 중계 서버 설정 |
| **G02** | `cctv_cameras` 저장 + 감사기록이 원격 D1 batch 에서 한 덩어리로 도는지 | `src/admin.ts` |

## A-6. `[재확인 필요]`

| # | 항목 | 지금 어떻게 해 두었나 |
|---|---|---|
| 0 | **중계 PC 위치** | 카메라는 **타슈켄트**, 사무실 PC 는 **천안** 이라고 확인받았다. RTSP 는 같은 망에서만 열리므로 **중계 PC 는 타슈켄트 현지에 있어야 한다**. 보는 곳은 어디든 상관없다 |
| 1 | **브라우저 영상 재생** | 시험 환경에서 H.264 로 인코딩할 수 없어 **사진(JPEG) 방식만** 브라우저에서 실제로 띄워 확인했다. 영상 방식은 같은 경로·같은 CSP 규칙을 쓰지만 재생 자체는 확인하지 못했다 |
| 2 | **사내 중계 서버 존재 여부** | 천안 통합관제센터에 쓸 수 있는 서버가 있는지 확인하지 못했다. 없으면 이 기능은 켤 수 없다 |
| 3 | **Tapo 웹 콘솔 없음** | FIRMMIT 확인에 따랐다. 공식 문서를 직접 열어 확인하려 했으나 작업 환경의 네트워크 정책이 `tp-link.com`·`tapo.com` 을 막았다 |
| 4 | **근로자 감시 관련 법령** | 열람 기록(감사기록)과 ADMIN 제한은 넣었으나, 한국·우즈베키스탄 법령 판단은 하지 않았다. **노무·법무 검토 필요** |
| 5 | **Worker 로 영상을 중계할 때의 비용·한도** | 요청 수·전송량·CPU 를 실측하지 않았다. Free 플랜 10 ms/요청은 전달 경로라 여유가 있을 것으로 보지만 확인하지 않았다 |
| 6 | **우즈베키스탄 현지 업로드 회선** | 1080p 실시간은 카메라 1대당 대략 2~4 Mbps 로 보았으나 실측하지 않았다. 좁으면 저화질(`stream2`)·사진 방식으로 바꾼다 |
| 7 | **go2rtc·cloudflared 배포처와 버전** | 2026-09-19 웹 검색으로 확인했고 공식 저장소로 보이나, 작업 환경의 네트워크 정책 때문에 **직접 열어 확인하지 못했다**. 내려받기 전에 다시 확인한다 |

## A-7. FIRMMIT 에 물을 것 (추가)

| # | 질문 | 왜 필요한가 | 지금 처리 |
|---|---|---|---|
| 10 | **사내에 중계 서버로 쓸 장비가 있는가** (천안 관제센터 등) | 없으면 이 기능을 켤 수 없다 | 꺼진 상태로 두었다 |
| 11 | **경영진이 사외·우즈베키스탄에서도 보는가** | 사내만이면 보안 통로가 필요 없다 | 양쪽 모두 되는 구조(같은 출처 전달)로 만들었다 |
| 12 | **카메라 몇 대·어느 시설인가** | 대수에 따라 화질·방식이 달라진다 | 등록 화면만 만들고 **카메라는 넣지 않았다** |
| 13 | **녹화 다시보기도 필요한가** | 저장장치가 따로 필요하다 | **실시간만** 만들었다 |
| 14 | **경영진 전용 Access 그룹을 따로 만들 것인가** | 지금 허용 목록 8개에 경영진 그룹이 없다 | `ADMIN` 그룹으로 두었다 |

## A-8. 이번 추가 작업에서 **하지 않은** 것

- 중계 서버 구축·설정 · Cloudflare Tunnel 개설 · 카메라 계정 발급 (전부 FIRMMIT 인프라 작업)
- 실제 카메라·중계 서버 호출 (가짜 서버만)
- HLS·WebRTC 재생 · 녹화 다시보기 · 움직임 감지 · 화면 분할(여러 대 동시 보기)
- 기존 마이그레이션 `0001`–`0006` 수정, 기존 시험 삭제·완화
- 보안 헤더 완화 (CSP 그대로 — 오히려 시험으로 못 박았다)
- 커밋·푸시


---

# 부록 B. 디자인 개편 · 코드 리뷰 결함 수정 (2026-09-20, Z52–Z71)

브랜치 `claude/happy-pascal-62c6z1` 의 두 번째 묶음이다. 순서: `CLAUDE.md` 기준 숫자 실측 갱신 → 디자인 시안 A·B 단계 반영 → `/code-review`(high) 2회로 결함 16건 → 전부 수정.

## B-1. 변경 항목

| ID | 위치 | 상태 | 내용 |
|---|---|---|---|
| Z52 | `CLAUDE.md` | 수정함 | 기준 시험 숫자가 Phase 1.5 시작 시점 옛 값(135/135 · 9/9 · 137 KiB · 13장)이었다. 9개 명령을 다시 돌려 실측값으로 갱신, §5 기준선을 괄호로 병기 |
| Z53 | `public/styles.css` | 수정함 | **디자인 A단계** — 시안(1a 확정)의 토큰·여백·계층·상태 표현만 반영. 마크업·동작 불변 |
| Z54 | `public/app.js` `index.html` `i18n.js` `styles.css` | 수정함 | **디자인 B단계** — 요약 띠 배지 · "준비 중" 지표 뒤로 · 390px 목록 접기 · 탭 축약 · 표 행 펼치기 |
| Z55 | `src/cctv.ts` | 수정함 | **[치명]** `redirect:'error'` 는 workerd 가 거부(TypeError) → 실제 Worker 에서 모든 `/play` 가 502. `'manual'` 로 바꾸고 3xx 는 200/206 검사가 거부. 시험·변이 고정 |
| Z56 | `src/cctv.ts` | 수정함 | 허브→중계 요청에 `Cache-Control: no-cache` — 가장자리 캐시로 멈춘 사진이 실시간처럼 보이는 일 방지 |
| Z57 | `src/cctv.ts` `README.md` | 수정함 | `CCTV_RELAY_AUTH` 가 비어 있으면 익명('none')으로 부르던 것을 **거부**로 (fail-closed). 'none' 도 적어서 골라야 한다 |
| Z58 | `public/styles.css` | 수정함 | A단계에서 입력칸·보조 단추 테두리 대비가 1.28:1 로 떨어진 것을 `--line-strong` 으로 복구. 비활성 단추는 팔레트 안 색(`--muted`/`--muted-bg`, 7:1) + `not-allowed` |
| Z59 | `migrations/0008_cctv_view.sql` `src/cctv.ts` | 수정함 | **열람 세션 토큰** — `/open` 이 감사기록과 **한 batch** 로 토큰을 남기고, `/play` 는 같은 카메라·같은 사람·15분 안의 토큰이 있어야 연다. 주소를 직접 쳐서 감사기록 없이 보던 구멍을 막았다. 토큰은 감사기록에 넣지 않는다 |
| Z60 | `src/cctv.ts` `src/admin.ts` | 수정함 | `relayReady(env)` 한 곳 — 켜짐·주소·**인증 설정** 셋을 같이 본다. 목록이 "볼 수 있음" 인데 재생이 인증 오류로 막히던 어긋남 제거 (세 곳 중복 → 한 곳) |
| Z61 | `src/cctv.ts` | 수정함 | `HEAD /play` 는 405 — Hono 가 HEAD 를 GET 으로 보내 아무도 읽지 않을 영상 연결이 열리던 것 |
| Z62 | `src/cctv.ts` | 수정함 | `Range` 규격: `bytes=-`(양쪽 빈 값)는 넘기지 않는다 |
| Z63 | `src/cctv.ts` | 수정함 | 역슬래시 검사 제거 — URL 파서가 경로의 `\` 를 `/` 로 바꿔 되감기 검사에서 걸리므로 **중복 방어**였다(변이 미검출). 질의 안 `\` 는 출처를 벗어나지 않으므로 허용, 시험으로 고정 |
| Z64 | `src/guard.ts` `src/admin.ts` `src/cctv.ts` `src/validate.ts` | 수정함 | ADMIN 관문을 `requireHubAdmin` 한 곳으로, `CONTROL_RE` 는 `validate.ts` 에서 내보내 재선언 제거, `FAIL_STATUS` 의 도달 불가 404 분기 제거 |
| Z65 | `public/app.js` `i18n.js` | 수정함 | **관리 화면 카메라 등록 폼** — 문구·README 가 가리키던 "관리 화면" 이 실제로 없었다. 경로만 받고, 비우면 미연결 |
| Z66 | `public/i18n.js` | 수정함 | CCTV 서버 오류 코드 10종의 사람 문구 — 중계 PC 정전이 "서버 오류" 로 보이던 것 |
| Z67 | `public/app.js` | 수정함 | 사진 새로고침을 `setInterval` 에서 **앞 그림이 다 온 뒤 다음 청함** 으로 — 느린 회선에서 요청이 겹쳐 쌓이지 않게 |
| Z68 | `public/app.js` `styles.css` | 수정함 | 접기·표 펼침을 CSS `nth-child` 고정값에서 **JS 가 붙인 클래스**(`more-item`·`col-keep`) 로 — `table()` 은 `keep` 으로 남길 열을 표마다 정한다 |
| Z69 | `public/app.js` `test/ui_screens.py` | 수정함 | **회귀 수정**: B단계 표 펼침이 CCTV 표에서 상태 배지와 "영상 보기" 단추를 숨겼다. `keep:[3,4]` 로 복구하고 390px 흐름 시험으로 고정 |
| Z70 | `test/mutation.mjs` | 수정함 | 새 방어마다 변이 추가 — https 전용 · 사용자정보 · 경로/질의/조각 · Range 목록 · basic `:` · 준비 판정 인증 · 열람 세션 · HEAD · 빈 인증 · 자동 따라가기 · no-cache |
| Z71 | `test/cctv.test.ts` `test/ui-server.ts` | 수정함 | 시험 환경은 `CCTV_RELAY_AUTH: 'none'` 을 **명시** (Z57 의 fail-closed 와 맞춤). 열람 토큰 도우미 `playPath` |

## B-2. 시험 결과표

| # | 명령 | 부록 A 뒤 | 부록 B 뒤 | 판정 |
|---|---|---|---|---|
| 1 | `npm test -w packages/contracts` | 85건·불일치 0 / 60/60 / 17/17 / 17/17 / 21/21 | 동일 | 유지 |
| 2 | `npm test -w apps/hub` | 12파일 · 294/294 | 12파일 · **303/303** | 증가 |
| 3 | `npm run typecheck -w apps/hub` | 오류 0 | 오류 0 | 유지 |
| 4 | `npm run test:mutation -w apps/hub` | 38/38 · 미검출 0 | **48/48 · 미검출 0** | 증가 |
| 5 | `npm run test:bundle -w apps/hub` | 9/9 · 금지 0건 | 9/9 · 금지 0건 | 유지 |
| 6 | `npm run build:dry -w apps/hub` | 617.9 KiB | 618.8 KiB | 기록만 |
| 7 | `npm run test:ui -w apps/hub` | 17장 + 흐름 2 | **18장 + 흐름 3** · 실패 0 | 증가 |
| 8 | `npm test -w apps/showroom` | 38/38 | 38/38 | 유지 |
| 9 | `npm run test:ui -w apps/showroom` | 27/27 · 외부 요청 0 | 동일 | 유지 |

`0001`–`0007` 마이그레이션과 기존 해시는 **바뀌지 않았다.** `0008_cctv_view.sql` 이 새로 추가됐다.

## B-3. 남은 운영 검증

| ID | 무엇을 확인 | 틀리면 고칠 곳 |
|---|---|---|
| **G11** | 실제 중계 서버 연결 · **H.264 재생** · `redirect:'manual'` 이 실제 Worker 에서 정상인지 · 열람 토큰 15분 안에서 영상 구간 요청이 끊기지 않는지 | `src/cctv.ts` |
| **G02** | `cctv_view_sessions` 삽입 + 감사기록이 원격 D1 batch 에서 한 덩어리로 도는지 | `src/cctv.ts` |
| **G12** (신규) | 디자인 반영 뒤 실제 휴대폰(390px 급)에서 접기·표 펼침·탭 축약 확인 | `public/*` |

## B-4. `[재확인 필요]`

| # | 항목 |
|---|---|
| 1 | `redirect:'manual'` 거부 문구는 **workerd 바이너리 문자열**로 확인했다. 실제 배포 환경에서 재생 1회 실측 필요 (G11) |
| 2 | 다크 모드(C단계)는 시안 토큰 12쌍만 있고 적용하지 않았다 |
| 3 | 「다운 앱 수」 지표 카드의 배지는 `display_status`(측정 상태) 를 따르므로 값이 1이어도 "정상" 이다. 시안은 "장애" 로 그렸으나 KPI 계약 변경이라 두었다 — FIRMMIT 판단 필요 |

## B-5. 코드 리뷰 3차 (Z72–Z80) · 보안 검토

`/code-review`(high) 3차 9건 → 전부 수정. `security-review`(하위 분석 + 거짓 양성 필터) → **HIGH·MEDIUM 0건**.

| ID | 위치 | 상태 | 내용 |
|---|---|---|---|
| Z72 | `public/app.js` | 수정함 | 재생기마다 자기 타이머·생사 표시 — 떼어낸 옛 재생기의 `load`/`error` 가 새 재생기를 멈추거나 덮어쓰던 것. mp4 도 같은 정지 경로 |
| Z73 | `wrangler.jsonc` `test/headers.test.ts` `README.md` | 수정함 | 배포 기본값 `CCTV_RELAY_AUTH` 를 `"none"` → 자리표시자 `<CCTV_RELAY_AUTH>` (모르는 방식이라 거부). Z57 fail-closed 가 기본값에 뚫려 있었다. vars 정확 비교 갱신 |
| Z74 | `src/cctv.ts` | 수정함 · **[재확인 필요]** | 요청 머리말 `no-cache` 만으로 Cloudflare 가장자리 캐시(.jpeg/.mp4 기본 캐시)를 건너뛰는지 불확실 → `cf: { cacheEverything: false }` 병기, G11 실측 항목 추가. 중계 호스트 Bypass Cache 규칙 권고 |
| Z75 | `src/cctv.ts` | 수정함 | 응답 코드·형식이 어긋나 거부할 때 업스트림 본문 `cancel()` — 안 읽을 영상이 온실 업로드 회선을 계속 타지 않게 |
| Z76 | `public/app.js` | 수정함 | 열람 토큰 15분 만료 뒤 재생이 끊기면 **한 번** 다시 열어(열람 기록 1건 더) 이어 본다. 또 끊기면 안내 |
| Z77 | `public/i18n.js` | 수정함 | `relay_configured=false` 안내가 "주소 없음" 만 말하던 것 → 주소 **또는 인증** 설정 |
| Z78 | `public/i18n.js` | 수정함 | 감사 동작 라벨 `action_cctv_view_open`·`cctv_camera_create`·`cctv_camera_update` 3개 언어 — 감사 표에 원시 코드가 보이던 것 |
| Z79 | `test/cctv.test.ts` | 수정함 | 동어반복 단언 제거 → `expires_at = opened_at + 15분` 실제 검증. 본문 취소·`cf` 옵션·자리표시자 거부 시험 추가 |
| Z80 | `src/admin.ts` | 수정함 | 카메라 등록의 `before` 를 batch 준비 함수 **안**에서 읽음 — `runAudited` 재시도 시 감사기록이 묵은 값을 담지 않게 |

시험: hub **304/304** · 변이 **50/50** 미검출 0 · typecheck 0 · 화면 18장 + 흐름 3 실패 0 · 번들 619.1 KiB.

보안 검토가 본 경계: `/api/cctv/*` 권한(인증→CSRF→주체→`requireHubAdmin`) · SSRF(호스트는 env, 경로만 입력) · 전달 콘텐츠 XSS(형식 정확 일치·nosniff·CSP) · 저장 필드 XSS(`textContent`) · SQLi(바인딩) · 열람 토큰(UUID·카메라+사람+만료) · 비밀값 노출 없음. 기준 미만 관찰 1건: 퍼센트 인코딩 점 구간(`%2e%2e`)은 호스트 고정이라 경로만 제어 — G11 에서 중계 서버 동작 확인 권장.

## B-6. 코드 리뷰 4차 (Z81–Z90)

`/code-review`(high) 4차 10건 → 전부 수정. 서버 쪽은 "solid" 판정, 남은 것은 화면·시험 강도였다.

| ID | 위치 | 상태 | 내용 |
|---|---|---|---|
| Z81 | `public/app.js` | 수정함 | mp4 정지 시 `pause()`·`src` 제거·`load()` 로 매체 자원을 실제로 놓고, `render()` 첫 줄에서 `stopCctv()` — 닫기·화면 이동 뒤에도 진행형 스트림이 살아 있던 것 |
| Z82 | `public/app.js` | 수정함 | `errorText()` 가 `t()` 처럼 ko 로 되돌아감 — CCTV 오류 문구(ko 전용)가 러시아어·우즈베크어 화면에서 "서버 오류" 로만 보이던 것 |
| Z83 | `public/app.js` | 수정함 | 카메라 등록 폼의 정렬 칸 기본값 `'0'` 제거 — 재등록 때 순서가 0 으로 튀던 것. 비우면 이전 값 유지 (시험 고정) |
| Z84 | `public/app.js` | 수정함 | 요약 띠: 숫자가 아니면(null·빈값·문자) 0 으로 바꿔 초록으로 칠하지 않고 회색 `—` (null ≠ 0) |
| Z85 | `public/app.js` | 수정함 | 표 접기는 **`keep` 을 준 표만** — 기본은 아무 열도 숨기지 않는다. B단계가 기존 관리 표(사용자·토큰·감사)의 상태·동작 열을 휴대폰에서 숨기던 회귀. 시스템 상태 표는 `keep:[1]` 명시 |
| Z86 | `test/cctv.test.ts` `test/mutation.mjs` | 수정함 | 카메라 이름 규칙 위반은 **400** 으로만 (404 허용하면 검사를 지워도 통과). `cameraIdParam`·`sortNumber` 변이 추가 |
| Z87 | `public/app.js` | 수정함 | 끊기면 같은 경로로 2번 다시 청한 뒤에야 한 번 다시 연다 — 잠깐 끊긴 것에 열람 기록이 늘고 재열람 기회를 태우던 것 |
| Z88 | `public/app.js` `test/cctv.test.ts` | 수정함 | `/open` 응답에 `play_path` 가 없으면 토큰 없는 경로로 위장하지 않고 응답 형식 오류로 알림. 시험 도우미도 2xx 에 `play_path` 가 없으면 실패 |
| Z89 | `src/cctv.ts` | 수정함 | `/play` 가 카메라 행과 열람 토큰을 **한 번의 D1 왕복(batch)** 으로 읽음 — 사진 방식은 2초마다 오는 요청 |
| Z90 | `src/cctv.ts` `src/admin.ts` | 수정함 | 목록 응답을 `cameraList()` 한 곳에서 — 뷰어·관리 화면이 `playable` 에서 어긋나지 않게 |

## B-7. 코드 리뷰 5차 (Z91–Z100)

`/code-review`(high) 5차 10건 → 전부 수정.

| ID | 위치 | 상태 | 내용 |
|---|---|---|---|
| Z91 | `public/app.js` | 수정함 | 다른 카메라의 `/open` 이 실패해 무대를 갈아엎을 때도 `stopCctv()` 먼저 — 보고 있던 mp4 스트림이 살아남던 것 |
| Z92 | `public/app.js` | 수정함 | 재열람을 오류 횟수 추정이 아니라 `/open` 이 준 **`expires_at` 기준으로 예약**(만료 30초 전) — 30분 뒤 조용히 죽던 것. 만료 뒤 오류는 바로 재열람, 만료 전 오류는 2번까지 재청 |
| Z93 | `src/cctv.ts` | 수정함 | 압축된 응답(`content-encoding` ≠ identity) 거부 — Worker 가 몸통을 풀면 넘긴 `content-length` 와 어긋나 재생이 깨진다 |
| Z94 | `src/cctv.ts` | 수정함 | 구간 요청은 시작 ≤ 끝일 때만 넘기고, 중계 서버 416 은 **416** 으로(502 로 위장하지 않음) |
| Z95 | `public/app.js` | 수정함 | 무대를 갈아엎는 모든 경로가 `stopCctv()` 를 거치므로 떼어낸 사진 재생기의 타이머가 한 번 더 청하던 일이 없어짐 |
| Z96 | `public/app.js` | 수정함 | 재생기 정지 함수 **하나**가 타이머·매체 자원(mp4 `pause`·`src` 제거·`load`)을 같이 놓는다 — 정지 경로 둘이 갈라져 있던 것 |
| Z97 | `public/app.js` | 수정함 | 경고 띠 마크업 중복 → `warnAlert(key)` |
| Z98 | `src/admin.ts` | 수정함 | 카메라 저장 응답을 다시 읽지 않고 저장한 값으로 만든다 — 왕복 1회 감소, 동시 저장의 남의 결과를 돌려줄 창 제거 |
| Z99 | `scripts/dev-seed.sql` | 수정함 | 가짜 카메라 2대를 '천안 정문'·'/live/…' 같은 **추정 값·연결됨** 대신 `test-cam-*`·`example`·**미연결** 로 — CLAUDE.md "확인 안 된 주소 추정 금지·미연결을 연결됨으로 표시 금지" |
| Z100 | `src/cctv.ts` `src/app.ts` | 수정함 | 몸통 **멈춤 감시** 30초 — 머리말만 오고 얼어붙은 중계 연결을 끊고 브라우저 쪽도 오류로 끝내 재생기가 영원히 돌지 않게. 시험에서는 `cctvIdleTimeoutMs` 로 줄인다 |

시험: hub **310/310** · 변이 **56/56** 미검출 0 · typecheck 0 · 화면 18장 + 흐름 3 실패 0 · 번들 621.5 KiB. 새 시험 5건(구간 순서 · 416 · 압축 거부 · 멈춤 감시 단위/경로) · 변이 4건.
