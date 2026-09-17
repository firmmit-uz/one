# FIRMMIT ONE — 코드 리뷰 요청서 (GPT 용)

작성 2026-09-17 · 대상 커밋 `11f3aa5` · 저장소 <https://github.com/firmmit-uz/one> (branch `firmmit/brave-bardeen-0nolbj`)

> **한 줄 요청** — Phase 1.5(WP1–WP4)로 새로 쓴 코드 약 3,000줄에서 **실제로 깨지는 것**을 찾아 달라.
> 취향·스타일 의견은 받지 않는다. "이 입력에서 이렇게 틀린다"를 쓸 수 있는 것만 달라.

---

## 0. 리뷰어가 먼저 알아야 할 것

| 항목 | 내용 |
|---|---|
| 무엇인가 | FIRMMIT(스마트팜 기기 제조 · 딸기 수출) 사내 앱을 한곳에서 여는 **직원 허브**(Cloudflare Worker + D1) + 방문객용 **TV 쇼룸**(정적 Worker) |
| 이번 범위 | Phase 1.5 = WP1 Access 그룹 동기화 · WP2 KPI 게이트웨이 + 공통 ID 검사기 · WP3 외부 토큰 갱신 · WP4 TV 쇼룸 |
| 배포 상태 | **배포 안 됨.** 로컬 제작·시험까지만. 게이트 G1(V0–V13) 14개 전부 통과 + 대표 승인 뒤 FIRMMIT 직원이 직접 배포 |
| 외부 연동 | **실제 호출 0건.** 전부 가짜 서버(mock fetch)·고정 응답(fixture) |
| 비밀값 | 저장소에 없음. 전부 `<...>` 자리표시자, 시험 이메일은 `@example.invalid` |
| 저장소 공개 여부 | **공개(public).** 그래서 리뷰 시 실제 계정 ID·주소·실명을 새로 적어 넣으면 안 된다 |

### 설계 근거 문서 약어

리뷰 중 아래 약어가 나오면 **FIRMMIT 내부 설계 문서**다. 이 저장소에 없고 리뷰어에게도 주지 않는다.
해당 항목은 "문서를 못 보므로 판단 보류"라고 적어 주면 된다.

| 약어 | 내용 |
|---|---|
| R1 | 인프라·Cron·요금제 한도 |
| R2 | 외부 연동 API (cafe24 토큰 회전 프로토콜 §1.4 ①–⑥) |
| R4 | KPI 정의(§1.6, §2.1, §2.3, §2.4) · 공통 ID 체계(§3.2) · 알림 · UX |
| 런북 v2.2 | 배포 게이트 G1(V0–V13) · 운영 검증 G01–G10 |

---

## 1. 리뷰 범위

### 봐 달라는 것 (우선순위 순)

| 순위 | 대상 | 파일 |
|---|---|---|
| 1 | **토큰 갱신 동시성** — 두 실행이 겹칠 때 토큰이 깨지는가 | `apps/hub/src/tokens/refresh.ts` (456줄) |
| 2 | **fail-closed 구멍** — 설정 누락·이상 응답이 "정상"으로 흘러가는 경로 | `groupsync.ts` · `kpi/*` · `tokens/*` |
| 3 | **권한 우회** — 열람 수준(`viewLevelFor`)과 필터를 통과해 값이 새는 경로 | `apps/hub/src/kpi/gateway.ts` (304줄) |
| 4 | **Workers 런타임 비호환** — 사전 컴파일 검사기가 Worker 에서 실제로 도는가 | `packages/contracts/src/worker.mjs` · `scripts/build-validator.mjs` |
| 5 | **정규식 오탐/누락** — 공통 ID 6종 + 초안 5종 | `packages/contracts/src/ids.mjs` (159줄) |
| 6 | **쇼룸 정보 유출** — 방문객 화면에 내부 정보가 보이는 경로 | `apps/showroom/public/app.js` · `scripts/check-content.mjs` |
| 7 | **시험이 실제로 무엇을 막는가** — 통과하는데 버그를 못 잡는 시험 | `apps/hub/test/*` · `packages/contracts/test/*` |

### 보지 않아도 되는 것

- 기존 코드 `auth.ts` · `authz.ts` · `audit.ts` · 마이그레이션 `0001`–`0003` (이번에 건드리지 않았다)
- 코드 스타일 · 네이밍 · 주석 분량 · 파일 분할 취향
- "이렇게도 만들 수 있다" 류의 대안 설계 (근거 문서 R1·R2·R4 를 못 보는 상태에서는 판단 불가)
- 아래 §5 "이미 닫힌 것" 목록

---

## 2. 재현 방법

```bash
git clone https://github.com/firmmit-uz/one && cd one && git checkout 11f3aa5
node -v                               # v22.13 이상 (확인 시점 v22.22.2)
npm ci
export WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false

npm test -w packages/contracts        # 사례 85 · 변이 60 · 의미 17 · Worker 17 · ID 21
npm test -w apps/hub                  # 11파일 245건
npm run typecheck -w apps/hub         # 오류 0
npm run test:mutation -w apps/hub     # 변이 24/24 검출
npm run test:bundle -w apps/hub       # 번들에 eval·new Function·node: 없음 9/9
npm run build:dry -w apps/hub         # 605.97 KiB (배포 아님)
npm test -w apps/showroom             # 29/29
```

화면 시험(`npm run test:ui`)은 Python Playwright + `opencv-python-headless` 가 필요하다. 리뷰에 필수는 아니다.

**전달물 ZIP** `FIRMMIT_ONE_WP1-WP4_2026-09-17.zip`
SHA-256 `7a9760ebcb947f350daeb2250f5e159cb0725c8465984fe1b7793ec718f1eba3` (147개 추적 파일, `git archive 11f3aa5`)

---

## 3. 만든 것 요약

| WP | 무엇 | 핵심 파일 | 시험 |
|---|---|---|---|
| **WP1** | Cloudflare Access 그룹 목록을 15분마다 읽어 D1 사본을 교체. 허용 목록 8개 그룹만, 이메일 규칙만 해석 | `src/groupsync.ts` 510줄 · `migrations/0004` | 35건 + 변이 5 |
| **WP2-A** | KPI 봉투 계약 v1.2 검사기를 **Workers 에서 돌 수 있게** — 빌드 시점 Ajv standalone 사전 컴파일 (Workers 는 `eval`·`new Function` 금지) | `contracts/src/{core,worker}.mjs` · `scripts/build-validator.mjs` | 85 사례 Node·Worker 판정 완전 일치 |
| **WP2-B** | KPI 게이트웨이: 봉투 생성 → 계약 검증 → stale 재계산 → 캐시 → **열람 권한 필터** → 표시 필드. `GET /api/kpi` | `src/kpi/*` 886줄 · `migrations/0005` | 39건 + 변이 3 |
| **WP2-C** | 공통 ID 검사기 — 확정 6종(CUS·PRD·SKU·ORD·PRJ·EMP) + 초안 5종(`status:'draft'`) | `contracts/src/ids.mjs` | 21건 |
| **WP3** | 외부 토큰(cafe24 등) 회전 갱신. **기본 꺼짐**(`TOKEN_REFRESH_ENABLED: "false"`), 가짜 서버로만 시험 | `src/tokens/*` 604줄 · `migrations/0006` | 36건 + 변이 5 |
| **WP4** | TV 쇼룸 — 허브와 **코드·데이터·세션·D1 완전 분리**. 저장소·비밀값·Cron 없음, 외부 요청 0건 | `apps/showroom/**` | 29 + 27건 |

### 지켜야 하는 불변식 (여기가 깨지면 그게 결함이다)

1. **fail-closed** — 설정 누락·자리표시자·알 수 없는 값·검증 실패는 **거부**한다. 오류를 0으로 바꾸지 않는다. `null ≠ 0`.
2. **D1 변경 + 감사기록은 한 batch.** 감사기록은 추가 전용(해시 체인).
3. **문자열 비교 시각은 `YYYY-MM-DDTHH:MM:SS.sssZ` 한 형식만.** 형식이 섞이면 문자열 비교가 틀어진다.
4. **토큰 값·암호문은 서버 밖으로 나가지 않는다.** 화면에는 상태만.
5. **쇼룸은 허브 API 를 부르지 않는다.** 브라우저 저장소는 Service Worker Cache Storage 만.
6. **미연결은 미연결.** 확인 안 된 주소를 추정해 넣거나 "연결됨"으로 표시하지 않는다.

---

## 4. 우선 검토 지점 — **내가 의심하는 곳**

아래 8개는 내가 직접 짚은 곳이다. 전부 "내가 틀렸을 수 있다"고 보고 판정해 달라.
①②는 **실제 결함일 가능성이 높다고 본다.** 아직 고치지 않았다 — 리뷰 판정을 받고 고치려고 남겨 두었다.

---

### ① `refresh.ts:345` — batch 안에서 앞 문장 결과를 뒤 문장이 못 보면, **성공한 갱신이 전부 `conflict` 로 판정된다** 🔴

`apps/hub/src/tokens/refresh.ts:317–345`

```ts
const batch = await db.batch([
  db.prepare('UPDATE tokens SET ciphertext=?, ..., version = version + 1, last_refresh_journal_id=? WHERE token_id=? AND version=?')...,
  db.prepare("UPDATE token_refresh_journal SET outcome='applied', finished_at=? WHERE id=? AND outcome='in_progress' "
           + "AND EXISTS (SELECT 1 FROM tokens WHERE token_id=? AND version=? AND last_refresh_journal_id=?)")
    .bind(finishedAt, journalId, token.token_id, token.version + 1, journalId),
]);
const tokenChanged   = (batch[0]?.meta?.changes ?? 0) > 0;
const journalApplied = (batch[1]?.meta?.changes ?? 0) > 0;
if (!tokenChanged || !journalApplied) { /* conflict → 토큰 차단, 관리자 재인증 필요 */ }
```

두 번째 문장의 `EXISTS` 는 **첫 문장이 방금 쓴 `version + 1` 과 `last_refresh_journal_id`** 를 본다는 전제다.
로컬 `node:sqlite` FakeD1 에서는 순차 실행이라 보인다. 원격 D1 의 batch 가 같은 보장을 하는지는 **확인하지 못했다**(§6).

- 이 전제가 틀리면: 갱신은 **성공했는데**(토큰 행은 새 값) `journalApplied === false` 라서 `conflict` 판정 → 토큰 차단 → 사람이 재인증해야 함. 즉 **모든 정상 갱신이 실패로 뒤집힌다.**
- 내 생각의 수정안: 결과 판정은 `tokenChanged`(= `meta.changes`) **하나로만** 하고, 선기록(journal)은 그 뒤 별도 문장으로 맞춘다. 선기록이 `in_progress` 로 남는 것은 다음 실행의 "죽은 in_progress" 회수 경로가 이미 처리한다.
- **판정 요청:** (a) 원격 D1 batch 의 read-your-write 보장 여부를 공식 문서로 확인해 달라. (b) 보장되더라도 이 이중 조건이 필요한가, 아니면 단일 조건이 더 안전한가.
- 참고: `token.version` 만으로 "우리가 쓴 행"을 가릴 수 없어서 `last_refresh_journal_id` 를 넣은 것이다(시험으로 확인 — 그 사이 다른 실행이 쓴 것과 구분되지 않았다). 그 판단 자체도 봐 달라.

---

### ② `app.js:323` — 시험용 시계 조작이 **운영 화면에 그대로 나간다** 🔴

`apps/showroom/public/app.js:321–324`

```js
// 시계 조작 시험용: ?now=YYYY-MM-DD 는 표시 기간 판단에만 쓴다
const forced = params.get('now');
const now = forced && /^\d{4}-\d{2}-\d{2}$/.test(forced) ? new Date(`${forced}T12:00:00Z`) : new Date();
```

TV 쇼룸은 방문객이 보는 화면이고, 표시 여부는 `publish_from`·`expires_at` 으로 정해진다.
이 파라미터가 배포본에 남으면 **주소창만 고치면 승인 기간 밖 콘텐츠(만료된 것·게시 전인 것)를 띄울 수 있다.**

- 완화 요소: `status: "draft"`·`"withdrawn"` 은 이 경로로도 안 보인다. 기간(`published` + 날짜)만 우회된다. 쇼룸 URL 은 공개 주소가 아니고 화면에 적지 않는다.
- 그래도 "회수는 기간을 짧게 잡는 것이 유일한 방어"라고 README 에 써 놓은 것과 정면으로 어긋난다.
- 내 생각의 수정안: 빌드 시점에 제거하거나(시험용 빌드에만 포함), 표시 규칙 함수 `visibleItems(content, today)` 만 시험에서 직접 부르고 화면 코드에서는 파라미터를 읽지 않는다.
- **판정 요청:** 이게 실제로 막아야 할 구멍인가, 아니면 과한 걱정인가. 막는다면 어느 쪽이 나은가.

---

### ③ `groupsync.ts` — 그룹 하나의 규칙이 이상하면 **동기화 전체가 실패한다**

`apps/hub/src/groupsync.ts:190–205`. 8개 그룹 중 하나에 모르는 규칙(`email_list` 등)이 있으면 `{ ok:false }` 로 전체를 버리고, 기존 사본과 `sync_state` 를 그대로 둔다.

- 의도: fail-closed. 일부만 반영하면 "동기화됐다"고 표시되면서 실제로는 빠진 사람이 남는다.
- 위험: 한 그룹의 사소한 설정 변경이 **8개 그룹 전부의 동기화를 멈춘다.** 멈춘 동안 사본은 낡아 가고, `group_sync_stale` 감사만 한 번 남는다.
- **판정 요청:** 전체 실패가 맞는가, 아니면 그룹 단위 실패(성공한 그룹만 반영 + 실패 그룹은 이전 값 유지 + 명시적 "부분 실패" 상태)가 더 안전한가. 후자라면 "부분 반영을 정상으로 오인"하는 문제를 어떻게 막아야 하나.

---

### ④ `gateway.ts:186, 265` — `scope_key = GLOBAL_SCOPE` 만 읽는다

`listKpis` 가 `kpi_cache` 에서 **전역 범위 행만** 읽는다. 지금은 KPI 6종이 전부 전역(`SYS.*`)이라 맞지만, 부서·사이트 범위 KPI 가 들어오면 조용히 빠진다(오류가 아니라 **안 보이는 것**으로).

- **판정 요청:** 범위가 늘어날 때 이 코드가 조용히 틀리는 것을 막을 방법. 지금 단계에서 막아야 하나, 아니면 Phase 2 로 미뤄도 되나.

---

### ⑤ `build-validator.mjs` — Ajv 가 박아 넣은 `require` 를 문자열 치환으로 걷어낸다

Ajv standalone 출력에 `require("ajv/dist/runtime/ucs2length")` 가 들어가는데, Workers 에서 돌지 않으므로 **같은 구현을 인라인하고 호출부를 문자열로 치환**했다. 빌드 뒤 금지 구문(`eval`·`new Function`·`node:`·`require`) 자체 검사도 한다.

- 위험: Ajv 버전이 올라가 출력 모양이 바뀌면 치환이 **조용히 안 먹을** 수 있다.
- 지금 방어: `npm run test:bundle` 9건이 배포 산출물에서 금지 구문을 검사하고, **산출물이 없으면 건너뛰지 않고 실패**한다. 규칙 ID 대조는 85 사례를 Node·Worker 두 진입점으로 돌려 완전 일치를 확인한다.
- **판정 요청:** 이 방어가 충분한가. 치환이 실패했는데 시험이 통과하는 경우가 있는가.

---

### ⑥ `ids.mjs` — 정규식 11종

확정 6종은 R4 §3.2 원문 그대로 옮겼고, 초안 5종은 예시에서 내가 만들었다(`status:'draft'` 표시).

- **판정 요청:** 각 정규식에서 **통과하면 안 되는데 통과하는 문자열**과 **막히면 안 되는데 막히는 문자열**. 특히 앵커(`^…$`), 유니코드, 숫자 자릿수, 대소문자.
- 이미 아는 이상 한 가지: `PRD` 는 분류를 `(AG|GH|FP|EQ)` 로 좁히는데 `SKU` 는 `[A-Z]{2}` 로 넓다. R4 원문이 그렇다 — 의도 확인을 FIRMMIT 에 물어 둔 상태(§7 질문 3).

---

### ⑦ 시험이 실제로 무엇을 막는가

변이 시험 24개가 전부 검출된다고는 하지만, **변이 시험이 찾는 문자열을 지우면 같이 지워진다**(`test/mutation.mjs` 를 함께 고쳐야 한다).

- **판정 요청:** 통과하는데 버그를 못 잡는 시험, 또는 "검출됐다"가 실제로는 다른 이유로 실패한 것. 특히 `test/tokens.test.ts` 의 충돌 시험(토큰 값·버전이 덮어써지지 않음을 확인)과 `test/groupsync.test.ts` 의 허용 목록 변이.

---

### ⑧ 시각 형식

`EPOCH = '1970-01-01T00:00:00.000Z'` 등 **모든 시각을 밀리초 3자리 형식 한 가지로** 통일했다(D1 CHECK 로도 강제). R2 문서는 밀리초 없는 형식을 쓴다 — 의도적으로 다르게 갔다(§5 Z29).

- **판정 요청:** 형식이 섞여 문자열 비교가 틀어지는 경로가 남아 있는가. `new Date().toISOString()` 이 아닌 경로로 시각이 만들어지는 곳이 있는가.

---

## 5. 설계 문서와 **다르게** 간 것 (의도적 · 재검토 환영)

| ID | 문서 | 문서대로면 | 실제 구현 | 왜 |
|---|---|---|---|---|
| Z13 | R4 §1.6 | `SYS.UPTIME` = 16개 시스템 24시간 가용률 | **현재 DOWN 앱 수**만 | 이력 표가 없고 점검 대상이 9개다. 이력 표 설계는 Phase 2 |
| Z14 | R4 §2.1 ⑥ | KPI 조회를 `audit_log` 해시 체인에 기록 | 체인에 넣지 않고 `kpi_read` **구조화 로그만** | 조회마다 체인에 쓰면 경합·용량이 커진다. **감사 보존 기간이 아직 미결정** → 보류 |
| Z23 | R2 `[재확인 필요]` | (미정) | ④ + journal `applied` 를 **조건부 SQL 한 batch** 로. "우리가 쓴 행" 판정은 선기록 id | §4 ① 참조 — **여기를 제일 의심한다** |
| Z24 | R2 에 구분 없음 | (없음) | 2xx + 파싱 실패 = `unknown`(차단) / 비-2xx = `failed`(재시도 가능) | 2xx 면 회전이 일어났을 수 있다. 차단하면 재인증이 필요하고, 안 하면 죽은 토큰으로 계속 시도한다 |
| Z29 | R2 §1.4 ⑥ | `'1970-01-01T00:00:00Z'` | `'1970-01-01T00:00:00.000Z'` | 시각 형식 통일(불변식 3). 섞이면 문자열 비교가 틀어진다 |

이 5건은 **근거를 적어 두고 의도적으로 다르게 간 것**이다. "문서와 다르다"는 지적만으로는 결함이 아니다 —
**다르게 간 쪽이 실제로 틀린 결과를 내는 경우**를 보여 주면 고친다.

---

## 6. 이미 닫힌 것 — **재검토하지 말 것**

아래는 이전 단계(v2.1 인수인계서 H01–H06, 변경표 v2.2)에서 시험 증적과 함께 닫혔다.
다시 지적하면 리뷰 결과에서 걸러야 하므로 미리 적는다.

- 인증(`auth.ts`) · 권한(`authz.ts`) · CSRF · 감사 트리거 · 보안 헤더 — 이번에 **약화하지 않았다**. `test/headers.test.ts` 가 `wrangler.jsonc` 를 정확 비교한다
- 마이그레이션 `0001`–`0003` 수정 금지 — 새 번호 `0004`(WP1) · `0005`(WP2) · `0006`(WP3) 로만 추가
- 기존 시험 삭제·완화 금지 — 시험 수·검출 수는 **어느 것도 줄지 않았다**(§8 표)
- 번들 크기 137 KiB → 606 KiB 증가 — 사전 컴파일 검사기(259 KiB) + ajv-formats(20 KiB) 때문이고, Workers 한도는 비압축 64 MiB 다(공식 문서 2026-09-17 확인). **크기 자체는 결함이 아니다**
- 기존 앱 재개발 · 알림 발송 · 하위 앱 쓰기(Phase 4) — **범위 밖이다**. "없다"는 지적은 결함이 아니다

---

## 7. 확인하지 못한 것 `[재확인 필요]`

이것들은 **내가 모른다는 것을 알고 있는 것**이다. 리뷰어가 공식 문서로 답을 찾아 주면 가장 도움이 된다.

| # | 항목 | 지금 어떻게 해 두었나 | 원하는 답 |
|---|---|---|---|
| 1 | **원격 D1 batch 안에서 앞 문장 결과를 뒤 문장이 보는가** | 보인다고 가정 + `meta.changes` 이중 확인 | **공식 문서 근거.** §4 ① 의 전제다 |
| 2 | Access 그룹 목록 응답에 `result_info` 가 있는가 | 있으면 쓰고, 없으면 "마지막 쪽이 `per_page` 미만"으로 판정(양쪽 시험) | 실제 응답 모양 |
| 3 | `require` 규칙의 실제 형태 | 로그인 방식 조건(`login_method`·`auth_method`)만 허용, 구성원 계산에 쓰지 않음. 그 밖은 전체 실패 | 실제 Access 설정에서 쓰이는 규칙 종류 |
| 4 | `email_list` 규칙 | **지원 안 함 → 실패 처리.** 목록 조회 API 를 공식 문서로 확인 못 했다 | 목록 조회 API 존재 여부 |
| 5 | cafe24 몰 ID·앱 등록·실제 갱신 주소 | 자리표시자. 호출하면 `provider_not_configured` 로 끝난다 | (FIRMMIT 결정 사항 — 리뷰 대상 아님) |
| 6 | Cron 실행의 CPU 사용량 (Free 10 ms/요청) | 번들 크기만 기록 | 봉투 검증 6건의 대략적 CPU 비용 추정 |

---

## 8. 현재 시험 상태 (리뷰 전 기준선)

| 명령 | 결과 |
|---|---|
| `npm test -w packages/contracts` | 사례 **85건 · 불일치 0** / 변이 **60/60** / 의미 **17/17** / Worker **17/17** / ID **21/21** |
| `npm test -w apps/hub` | 11파일 **245/245** |
| `npm run typecheck -w apps/hub` | 오류 **0** |
| `npm run test:mutation -w apps/hub` | **24/24** 검출 · 미검출 0 |
| `npm run test:bundle -w apps/hub` | **9/9** · 금지 구문 0건 |
| `npm run build:dry -w apps/hub` | 605.97 KiB (gzip 94.47) — 기록만 |
| `npm run test:ui -w apps/hub` | 화면 14장 + 흐름 1 · 콘솔 오류 0 |
| `npm test -w apps/showroom` | **29/29** · 콘텐츠 문제 0건 |
| `npm run test:ui -w apps/showroom` | **27/27** · 캡처 7장 · **외부 요청 0건** · 콘솔 오류 0 |
| `npm ci` (새 사본) | 통과 |

**전부 통과하는 상태다.** 그러니 "시험이 통과한다"는 것은 리뷰 결과가 아니다.
찾아 달라는 것은 **시험이 통과하는데도 틀리는 것**이다.

---

## 9. 리뷰 결과 제출 형식

발견 건마다 아래 6칸을 채워 달라. 칸을 못 채우면 그 건은 **빼 달라**(추측은 받지 않는다).

| 칸 | 내용 |
|---|---|
| 위치 | `파일:줄` |
| 심각도 | 🔴 실제로 깨진다 / 🟡 조건이 맞으면 깨진다 / ⚪ 지금은 안 깨지지만 곧 깨진다 |
| 무엇이 틀렸나 | 한 문장 |
| **어떤 입력·상태에서** | 구체적으로. "동시 실행 시" 말고 "실행 A 가 ④를 쓴 직후 실행 B 가 ②를 읽으면" |
| **그래서 무슨 결과가** | 구체적으로. "문제가 된다" 말고 "정상 토큰이 차단되어 관리자 재인증이 필요해진다" |
| 고치는 방법 | 가능하면 패치 형태로. 없으면 방향만 |

정렬은 **심각도 높은 순**. 같은 심각도면 §4 의 ①→⑧ 순서.
§4 의 ①–⑧ 각각에 대해서는 **"확인함 / 실제 결함 / 과한 걱정 / 판단 불가(근거 문서 없음)"** 중 하나로 반드시 답해 달라.

---

## 10. 리뷰할 때 하면 안 되는 것

> 이 저장소는 **공개**다. 그리고 리뷰어는 FIRMMIT 계정에 접근할 수 없다.

- **계정 접속·배포 금지** — `wrangler login` · `wrangler deploy`(`--dry-run` 제외) · `wrangler d1 … --remote` · `wrangler secret put` · `wrangler dev --remote`
- **실제 외부 API 호출 금지** — Cloudflare · cafe24 · 네이버 · Google · Slack · Telegram · 카카오. 전부 가짜 서버로만
- **비밀값·실제 식별자를 새로 적어 넣지 말 것** — 실제 계정 ID · `database_id` · AUD · API 토큰 · 암호화 키 · **직원 실명과 이메일**. 자리표시자 `<...>` 를 유지하고, 예시 이메일은 `@example.invalid` 만
- **확인 안 된 주소를 추정해 넣지 말 것** — `show.firmmit.com` 은 개설·승인된 사실이 **없다**
- **시험을 지우거나 완화하는 제안 금지** — 시험 수·검출 수가 줄면 그 자체가 실패다
- **범위 밖 재설계 제안 금지** — Phase 2 이후 기능 · 알림 발송 · 하위 앱 쓰기

---

## 11. 파일 해시 (SHA-256 앞 12자리)

| 파일 | 해시 |
|---|---|
| `apps/hub/migrations/0004_groupsync.sql` | `c844c1ee96b0` |
| `apps/hub/migrations/0005_kpi.sql` | `99f3d313cba3` |
| `apps/hub/migrations/0006_tokens.sql` | `617a61105d0b` |
| `packages/contracts/schema/kpi-summary-v1.2.json` | `8ed9ab2ece1f` (바뀌지 않음) |
| `packages/contracts/src/generated/schema-validator.mjs` | `9ea7420e6f2f` |
| `packages/contracts/src/generated/schema-meta.mjs` | `8fa98dd8a1ec` |
| `packages/contracts/src/ids.mjs` | `bb0c8674d86e` |
| `apps/hub/docs/kpi-response.schema.json` | `33585bc588b2` |
| `apps/showroom/content/manifest.schema.json` | `854b9f83cf51` |
| `apps/showroom/content/manifest.json` | `bb8fac7f0cdc` |

스키마 해시는 사전 컴파일 검사기 안에도 들어 있다 — 스키마를 고치고 `build:validator` 를 다시 돌리지 않으면 시험이 실패한다.

---

전체 변경 내역은 `docs/FIRMMIT_ONE_변경표_v2.3_2026-09-17.md` (Z01–Z34) 를 본다.
