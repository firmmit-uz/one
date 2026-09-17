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
