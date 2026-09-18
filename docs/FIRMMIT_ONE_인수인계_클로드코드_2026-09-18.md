<p align="right"><img src="../logo.svg" alt="FIRMMIT" width="120"></p>

# FIRMMIT ONE — 클로드 코드 인수인계서

| 항목 | 값 |
|---|---|
| 작성 | 2026-09-18 |
| 인계 시점 커밋 | `4ab8f1a` (브랜치 `firmmit/brave-bardeen-0nolbj` = 저장소 기본 브랜치). **코드의 마지막 변경은 `362e3da`** — 그 뒤는 문서만 |
| 저장소 | <https://github.com/firmmit-uz/one> — **공개(public)** |
| 이번까지 끝난 것 | Phase 1.5 **WP1–WP4** 제작 + 자체 점검 수정 2건(Z35·Z36) |
| 다음 사람이 할 것 | **§8** — GPT 리뷰 결과 반영 · 보류 3건 해제 · 배포 지원 |
| 배포 상태 | **안 됨.** 로컬 제작·시험까지만 |

> **이 문서 하나로 이어받을 수 있게 썼다.** 저장소 안의 `CLAUDE.md`·`README.md`·`docs/` 와 겹치는 내용이 있지만,
> 다른 계정에서 처음 여는 사람을 기준으로 필요한 것을 전부 적었다.

---

## 1. 첫 30분 — 이 순서대로 한다

```bash
# 1) 받기
git clone https://github.com/firmmit-uz/one
cd one
git log --oneline -1          # 4ab8f1a 이상이어야 한다
git status                    # 깨끗해야 한다

# 2) 환경 (Node 22.13 이상. 확인 시점 v22.22.2)
node -v
npm ci                        # install 이 아니라 ci
export WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false

# 3) 기준 시험 — §5 의 숫자와 **정확히** 같아야 한다
npm test -w packages/contracts
npm test -w apps/hub
npm run typecheck -w apps/hub
npm run test:mutation -w apps/hub
npm run test:bundle -w apps/hub
npm run build:dry -w apps/hub
npm test -w apps/showroom
```

**숫자가 하나라도 다르면 거기서 멈추고 FIRMMIT 에 알린다.** 코드를 고치기 전에 기준선부터 맞춘다.

화면 시험은 Python 이 필요하다 (없으면 건너뛰되, 화면을 고쳤으면 반드시 돌린다):

```bash
pip install playwright opencv-python-headless && playwright install chromium
npm run test:ui -w apps/hub        # 화면 14장 + 흐름 1
npm run test:ui -w apps/showroom   # 27건 · 캡처 7장 (opencv 로 QR 재해독)
```

### 저장소 밖에 있던 것들 — **새 세션에는 없다**

| 파일 | 상태 | 어떻게 하나 |
|---|---|---|
| `../HANDOFF.md` (원본 인수인계서 v2.2) | 저장소에 없음 | **FIRMMIT 에 요청한다.** 없이도 이 문서로 진행 가능 |
| `../참고자료/` (R1·R2·R4, 런북 v2.2) | 저장소에 넣지 않음(금지) | 설계 근거가 필요할 때만 FIRMMIT 에 요청 |

`CLAUDE.md` 가 그 두 경로를 가리키지만 새 환경에는 없다. **없다고 해서 추측으로 채우지 않는다** — 필요하면 물어본다.

---

## 2. 이게 뭔가

FIRMMIT(스마트팜 기기 제조 · 딸기 신선 수출)의 사내 시스템 두 개다.

| 경로 | 무엇 | 배포 단위 |
|---|---|---|
| `apps/hub` | **직원 허브** — 사내 앱 런처, Access 로그인 검증, D1 권한, 시스템 상태, 감사기록(추가 전용·해시 체인), 관리 화면, 그룹 자동 동기화, KPI 게이트웨이, 토큰 갱신 | Worker `fm-one-hub` |
| `apps/showroom` | **TV 쇼룸** — 사내 TV 에 상시 띄우는 방문객용 화면. 리모컨으로 넘긴다 | Worker `fm-one-showroom` |
| `packages/contracts` | KPI 요약 봉투 스키마 v1.2 + 검사기(Node·Workers 두 진입점) + 공통 ID 검사기 | (라이브러리) |

> **허브와 쇼룸은 완전히 분리된다.** 배포 단위·데이터·세션·쿠키·D1 을 공유하지 않고,
> 쇼룸 코드는 허브 API 를 부르지 않는다. 브랜드 색과 로고 파일만 같다. **이 경계를 무너뜨리면 안 된다.**

---

## 3. 절대 금지 — 이걸 어기면 작업 자체가 무효다

### 3-1. 계정·배포

- `wrangler login` · `wrangler deploy`(`--dry-run` 제외) · `wrangler d1 … --remote` · `wrangler secret put` · `wrangler dev --remote`
- Cloudflare · Vercel · Google · cafe24 · 네이버 · Slack · Telegram 등 **어떤 계정에도 로그인하지 않는다**
- 배포는 **게이트 G1(V0–V13) 14개 전부 통과 + 박선기 대표 승인** 뒤 FIRMMIT 직원이 직접 한다

### 3-2. 외부 호출

- **실제 외부 API 호출 0건.** 모든 연동은 가짜 서버(mock `fetch`)와 고정 응답(fixture)으로만 시험한다
- 시험 중 외부 네트워크 요청이 0건인지 검사하는 시험이 이미 있다 (쇼룸 UI 시험)

### 3-3. 비밀값·개인정보

- 실제 Cloudflare 계정 ID · `database_id` · AUD · API 토큰 · 비밀번호 · GAS 웹앱 주소 · 암호화 키 ·
  **직원 실명과 이메일**을 코드·문서·커밋·로그·캡처에 넣지 않는다
- `<...>` 자리표시자를 유지하고, 시험용 이메일은 **`@example.invalid` 만** 쓴다
- 비상 계정 주소는 배포 안내 문서에만 둔다 — 코드·시드·시험에 넣지 않는다
- **저장소가 공개라 더 엄격하다.** FIRMMIT 이 공개 유지를 선택했다(2026-09-17)

### 3-4. 코드 경계

- 마이그레이션 `0001`–`0003` 수정 금지. 새 번호는 고정: `0004` WP1 · `0005` WP2 · `0006` WP3. 다음은 `0007` 부터
- 인증(`auth.ts`) · 권한(`authz.ts`) · CSRF · 감사 트리거 · 보안 헤더를 약하게 만들지 않는다
- **기존 시험 삭제·완화 금지.** 시험 수·검출 수가 줄면 그 자체가 실패다
- 허브에서 `@firmmit-one/contracts` 의 **기존 진입점 `src/index.mjs` 를 import 하지 않는다** —
  `node:fs` 와 Ajv 런타임 컴파일(`new Function`) 때문에 Worker 에서 실패한다.
  **Worker 용 진입점(`@firmmit-one/contracts/worker`) + 사전 컴파일본만** 쓴다. `nodejs_compat` 으로 우회 금지
- 확인 안 된 주소를 추정해서 넣지 않는다. 미연결을 "연결됨/정상"으로 표시하지 않는다
- 하위 앱(농자재·견적 등)에 **값을 쓰는 기능 금지**(Phase 4). 허브 자체의 ADMIN 관리 입력은 기존 규칙을 따르면 허용
- **알림 발송 금지**(Phase 3). P1 상황은 감사기록 1건 + KPI 상태로만 남긴다
- **커밋·푸시는 FIRMMIT 이 요청할 때만**

---

## 4. 설계 원칙 — 새 코드도 여기 맞춘다

1. **fail-closed** — 설정 누락 · 자리표시자 · 알 수 없는 값 · 검증 실패는 **거부**한다. 오류를 0으로 바꾸지 않는다. **`null ≠ 0`**
2. **D1 변경 + 감사기록은 한 batch.** 감사기록은 추가 전용(해시 체인). KPI 조회는 체인에 넣지 않고 구조화 로그만
3. **문자열로 비교하는 시각은 `YYYY-MM-DDTHH:MM:SS.sssZ` 한 형식만.** 형식이 섞이면 문자열 비교가 틀어진다
4. **새 방어 코드마다 시험 + 변이 시험을 추가**한다
5. 확인 못 한 외부 사실은 `[재확인 필요]` 로 표시하고, 확인한 사실은 **공식 문서 주소 + 확인 날짜**를 남긴다
6. 토큰 값·암호문은 서버 밖으로 나가지 않는다. 화면에는 상태만

### 화면 규칙

- 로고 `logo.svg` 우측 상단. 색 `#3365FF` `#2A7FFA` `#F25555` `#292C34` `#9898A0`
- `#F25555`·`#2A7FFA` 위에 흰 글자 금지 · `#F25555` 는 흰 배경에서 아이콘 전용 · `#9898A0` 글자 금지(보조 글자 `#6B6F7A`)
- 허브 언어 `ko` · `uz-Latn` · `ru`. **`Firmmit`/`FIRMMIT` 은 번역·음역 금지**
- 상태 표시는 **아이콘 + 글자 + 색** 셋 다. WCAG 2.2 AA 목표

---

## 5. 기준 시험 — 인수 직후 이 숫자가 나와야 한다

| # | 명령 | 기대값 |
|---|---|---|
| 1 | `npm test -w packages/contracts` | 사례 **85건 · 불일치 0** / 변이 **60/60** / 의미 **17/17** / Worker **17/17** / ID **21/21** |
| 2 | `npm test -w apps/hub` | **11파일 · 247/247** |
| 3 | `npm run typecheck -w apps/hub` | 오류 **0** |
| 4 | `npm run test:mutation -w apps/hub` | **27/27** 검출 · 미검출 **0** |
| 5 | `npm run test:bundle -w apps/hub` | **9/9** · 금지 구문 **0건** |
| 6 | `npm run build:dry -w apps/hub` | 약 **605.9 KiB** (배포 아님 — 크기는 기록만) |
| 7 | `npm run test:ui -w apps/hub` | 화면 **14장 + 흐름 1** · 콘솔 오류 0 |
| 8 | `npm test -w apps/showroom` | **38/38** · 콘텐츠 문제 0건 |
| 9 | `npm run test:ui -w apps/showroom` | **27/27** · 캡처 7장 · **외부 요청 0건** |
| 10 | 새 사본에서 `npm ci` | 통과 |

**작업 뒤 이 숫자가 줄면 실패다.** 늘리는 것은 좋다.

### 시험 관련 함정 (미리 알아 둘 것)

- `apps/hub/test/headers.test.ts` 는 `wrangler.jsonc` 의 `vars`·`crons` 를 **정확 비교**(`toEqual`)한다.
  Cron·변수를 추가하면 **새 값으로 정확히 갱신**해야 한다. 부분 비교로 완화하지 말고, 변경표에 기록한다.
- 변이 시험(`apps/hub/test/mutation.mjs`)은 **`apps/hub` 안 파일만 복사**해서 돌린다.
  → 새 시험은 hub 밖 상대경로·`dist` 에 의존하면 안 된다.
  → 변이가 찾는 문자열을 지우면 `mutation.mjs` 도 함께 고쳐야 한다.
- 작업공간·의존성을 추가할 때만 `npm install` 1회 → 잠금 파일을 함께 전달. 마지막엔 새 사본에서 `npm ci` 통과 확인.

---

## 6. 저장소 지도

```text
one/
├─ CLAUDE.md                      저장소 규칙 (짧은 판)
├─ README.md                      전체 개요
├─ logo.svg
├─ docs/
│  ├─ FIRMMIT_ONE_변경표_v2.3_2026-09-17.md      ★ Z01–Z36 전체 변경 내역 · 시험 결과 · 해시 · 남은 검증 · 9개 질문
│  ├─ FIRMMIT_ONE_GPT리뷰_핸드오프_2026-09-17.md  ★ GPT 리뷰 요청서(2판) — 의심 지점 8건
│  └─ FIRMMIT_ONE_인수인계_클로드코드_2026-09-18.md  (이 문서)
├─ apps/hub/                      직원 허브 Worker
│  ├─ wrangler.jsonc              자리표시자만. Cron 3개(*/5 uptime · */15 그룹동기화 · 매시 토큰)
│  ├─ migrations/0001–0006        0001–0003 수정 금지
│  ├─ src/
│  │  ├─ auth.ts authz.ts audit.ts   기존 보안 경계 — 약화 금지
│  │  ├─ index.ts                    scheduled() 를 cron 값으로 분기 (cronJob)
│  │  ├─ admin.ts                    관리 API. 자동 동기화 중 수동 입력은 409
│  │  ├─ groupsync.ts       (WP1)    Access 그룹 사본 자동 교체 · 510줄
│  │  ├─ kpi/               (WP2)    봉투→검증→stale→캐시→권한필터→표시 · 886줄
│  │  └─ tokens/            (WP3)    회전 토큰 갱신 ①–⑥ · 약 620줄 · 기본 꺼짐
│  ├─ public/                        화면 (app.js · i18n.js · styles.css)
│  ├─ docs/kpi-response.schema.json  /api/kpi 응답 형식 (실제 응답으로 검증함)
│  └─ test/                          11파일 247건 + mutation.mjs + bundle-check.mjs + ui_screens.py
├─ apps/showroom/                 TV 쇼룸 (완전 분리)
│  ├─ content/manifest.json          콘텐츠 정본 — 승인·게시 기간·언어별 문구. 지금은 전부 샘플
│  ├─ scripts/check-content.mjs      내보내기 전 검사 (22가지가 빌드 실패)
│  ├─ scripts/build-content.mjs      검사 → media 복사 → QR 생성 → public/content.json
│  ├─ public/                        배포되는 것 (app.js · sw.js · _headers · content.json)
│  └─ test/                          content.test.mjs 38건 + ui_showroom.py 27건
└─ packages/contracts/
   ├─ schema/kpi-summary-v1.2.json   봉투 스키마 (고치면 build:validator 재실행 필수)
   ├─ src/core.mjs                   원문·의미 검사 공용 (Node 전용 API 없음)
   ├─ src/index.mjs                  Node 진입점 — **허브에서 import 금지**
   ├─ src/worker.mjs                 Workers 진입점 — 허브는 이것만 쓴다
   ├─ src/ids.mjs                    공통 ID 검사기 (확정 6종 + 초안 5종)
   ├─ src/generated/                 사전 컴파일 검사기 (빌드 산출물, 커밋됨)
   └─ scripts/build-validator.mjs    Ajv standalone 사전 컴파일
```

---

## 7. 지금까지 한 것 (요약)

| WP | 무엇 | 상태 |
|---|---|---|
| **WP1** | Access 그룹 목록을 15분마다 읽어 D1 사본 자동 교체. 허용 목록 8개 그룹, 이메일 규칙만 해석, 하나라도 이상하면 전체 실패(fail-closed) | 재시험 통과 · **G01 운영 검증 대기** |
| **WP2-A** | KPI 계약 검사기를 Workers 에서 돌게 — 빌드 시점 Ajv standalone 사전 컴파일. Node·Worker 두 진입점이 85 사례에서 **판정·거부 계층·규칙 완전 일치** | 재시험 통과 |
| **WP2-B** | KPI 게이트웨이 + `GET /api/kpi`·`/api/kpi/:id` + 홈 화면 고정 줄 · 시스템 카드 + Phase0 체크리스트(V0–V13) 관리 입력 | 재시험 통과 · **G02·G03 대기** |
| **WP2-C** | 공통 ID 검사기 — 확정 6종(CUS·PRD·SKU·ORD·PRJ·EMP) R4 정규식 그대로, 초안 5종은 `status:'draft'` | 초안 5종 **보류** |
| **WP3** | 회전 토큰 갱신 ①–⑥. AES-GCM(WebCrypto) · 실행권(lease) · 선기록(journal) · 응답 유실은 `unknown`(차단) · **기본 꺼짐** | 재시험 통과 · **G02 대기** |
| **WP4** | TV 쇼룸. 저장소·비밀값·Cron 없음, 외부 요청 0건, 브라우저 저장소 미사용, QR 은 빌드 시점 생성 + OpenCV 재해독 확인 | 콘텐츠 **보류(G10)** · **G09 대기** |
| **Z35** | (자체 점검 수정) ④ batch 가 원격 D1 의 read-your-write 에 기대던 것을 없앰 | 수정함 · G02 |
| **Z36** | (자체 점검 수정) 쇼룸 `?now=` 시계 조작을 로컬 전용으로 | 수정함 |

자세한 것은 **`docs/FIRMMIT_ONE_변경표_v2.3_2026-09-17.md`** 의 Z01–Z36 표를 본다.

---

## 8. 다음 사람이 할 일 — 우선순위

### 8-1. GPT 리뷰 결과 반영 ← **지금 대기 중인 일**

FIRMMIT 이 `docs/FIRMMIT_ONE_GPT리뷰_핸드오프_2026-09-17.md` 와 전달물 ZIP 으로 GPT 리뷰를 받는 중이다.
결과가 오면:

1. 요청서 §9 의 6칸(위치·심각도·무엇이 틀렸나·어떤 입력에서·무슨 결과·고치는 법)이 채워졌는지 본다. **안 채워진 건은 근거 부족으로 되돌린다**
2. 🔴 부터 순서대로 **재현 시험을 먼저 쓰고**(실패하는 것을 확인) 고친다
3. 요청서 §6 "이미 닫힌 것" 에 해당하는 지적은 걸러낸다
4. 고칠 때마다 **시험 + 변이 시험 추가**. §5 숫자가 줄지 않는지 확인
5. 변경표에 `Z37` 부터 이어서 적는다

리뷰어에게 특별히 물어 둔 것 — 답이 오면 그대로 반영한다:

| # | 질문 | 왜 중요한가 |
|---|---|---|
| ① | **D1 batch 가 트랜잭션인지** 공식 문서 근거 | Z35 수정 뒤 남은 **유일한 가정**이다 |
| ② | 쇼룸 `?now=` 를 호스트 검사로 막는 것으로 충분한지 | 빌드 시점 제거가 나은지 |
| ③ | 그룹 동기화의 **전체 실패 vs 그룹 단위 실패** | 한 그룹 설정 변경이 8개 전부를 멈춘다 |
| ④ | `listKpis` 가 `scope_key = GLOBAL_SCOPE` 만 읽는 것 | 부서·사이트 범위 KPI 가 오면 **조용히** 빠진다 |
| ⑤ | Ajv 출력의 `require` 문자열 치환 방어가 충분한지 | Ajv 버전이 오르면 조용히 안 먹을 수 있다 |
| ⑥ | ID 정규식 11종의 오탐·누락 | 발급 시작하면 되돌리기 어렵다 |
| ⑦ | 통과하는데 버그를 못 잡는 시험 | 변이 27개가 다 검출된다고 안심하면 안 된다 |
| ⑧ | 시각 형식이 섞이는 경로가 남았는지 | 문자열 비교가 틀어진다 |

### 8-2. FIRMMIT 답변이 오면 푸는 것 (보류 3건)

| 보류 | 무엇을 기다리나 | 오면 할 일 |
|---|---|---|
| **Z14** | 감사기록 보존 기간 | 짧으면 KPI 조회를 `audit_log` 해시 체인에 넣는다. 길면 지금(구조화 로그만) 유지 |
| **Z19** | 초안 ID 5종(QUO·DOC·SITE·PL·CC) 승인 | 승인된 정규식으로 바꾸고 `status` 를 `'confirmed'` 로. 시험도 함께 |
| **Z31** | 쇼룸 승인 콘텐츠·승인자(직책)·언어 | `manifest.json` 교체, `release.status` 를 `"approved"` 로, 자리표시자 SVG 를 승인 사진으로 |

그 밖의 질문 9개는 변경표 §6 에 있다.

### 8-3. 배포 지원 (직접 배포하지 않는다)

- 게이트 G1 **V0–V13 14개** 통과 기록은 허브 관리 화면의 Phase0 체크리스트에 넣는다. **통과 표시에는 증적 참조가 필수**다
- 배포 절차는 `apps/hub/README.md` 4장, 쇼룸은 `apps/showroom/README.md` 4장
- 읽기 전용 Cloudflare API 토큰이 생기면 WP1 자동 동기화를 켤 수 있다 (`apps/hub/README.md` 4장 **8-a**)

### 8-4. 운영 검증에서 문제가 나오면

| ID | 무엇을 확인 | 틀리면 고칠 곳 |
|---|---|---|
| **G01** | Access 그룹 API 실제 응답(`result_info` 유무, `require` 규칙 형태), 읽기 전용 토큰 권한 | `src/groupsync.ts` |
| **G02** | 원격 D1 의 batch · 조건부 UPDATE · 트리거 · `json_valid` | `src/tokens/refresh.ts` · `src/kpi/*` · `src/groupsync.ts` |
| **G03** | 농자재·견적 등 실제 소스의 필드·금액 | `src/kpi/source.ts` (어댑터) |
| **G09** | 실제 TV·리모컨·24시간 연속·재부팅·절전·네트워크 단절 | `apps/showroom/public/app.js` |
| **G10** | 승인 콘텐츠 | `apps/showroom/content/manifest.json` |

### 8-5. 범위 밖 — 요청받기 전엔 만들지 않는다

Phase 2 이후 기능 · 알림 발송(Slack·Telegram·메일) · 하위 앱 쓰기 · 실제 cafe24 연동 ·
CCTV(R3) · DNS 이전 · 대시보드 확장 · 기존 앱(농자재·견적·이천·FINO·AMIM·카카오 봇) 수정.

---

## 9. 함정 모음 — **여기서 시간을 잃었다. 미리 읽어라**

### 9-1. Workers 런타임

| 함정 | 증상 | 해법 |
|---|---|---|
| Ajv 런타임 컴파일 | Worker 에서 `new Function` 금지 → 실패 | **빌드 시점 standalone 사전 컴파일.** `scripts/build-validator.mjs` |
| Ajv 가 박아 넣는 `require("ajv/dist/runtime/ucs2length")` | 번들에 `require` 가 남음 | 같은 구현을 인라인하고 **호출부를 문자열 치환**. 빌드 뒤 금지 구문 자체 검사 |
| 자체 검사가 **내 주석**에 걸림 | 설명 주석에 "new Function" 이 들어가 검사 실패 | 검사 전에 **주석 줄을 걷어낸다**(`stripComments`) |
| `$ref` 하위 스키마의 규칙 ID 불일치 | `schemaPath` 가 상대경로(`#/allOf/0/then/required`)로 나옴 | Ajv `verbose: true` + `embeddedSchemas` 내보내기 + WeakMap 색인 → 85/85 완전 일치 |

### 9-2. D1 · SQLite

| 함정 | 증상 | 해법 |
|---|---|---|
| batch 안에서 앞 문장 결과에 기댐 | 로컬은 통과, 원격에서 **모든 성공이 conflict** 로 뒤집힐 수 있음 | **Z35** — 두 문장이 같은 pre-state 만 조건으로 보게 한다 |
| 경합 판정을 `version` 이나 시각으로 | 그 사이 다른 실행이 쓴 것과 구분 안 됨 | 판정은 조건부 UPDATE 의 **`meta.changes` 하나로만** |
| `json_valid` CHECK | 깨진 JSON 을 시험에 넣을 수 없음 | `'[]'` 같은 유효 JSON + "필드가 빠진 객체" 로 시험하고, 읽는 쪽(`toView`)을 강화 |
| `ALTER TABLE` 로 CHECK 추가 불가 | SQLite 제약 | 앱에서 지키고 **시험으로 막는다** |
| 시험에서 표 이름을 바꿔 실패를 흉내 | 엉뚱한 곳(차단 규칙의 읽기)이 먼저 터짐 | `BEFORE INSERT … RAISE(ABORT)` 트리거를 쓰고, 읽기는 try/catch 로 fail-closed |

### 9-3. 시험 자체

| 함정 | 증상 | 해법 |
|---|---|---|
| 변이가 **살아남음**(이중 방어) | 같은 규칙을 두 군데서 강제해 하나를 꺼도 통과 | 관문을 **한 군데로** 모으고 출력이 그 결과에서만 나오게 한다 |
| 경계값을 **정확히** 씀 | `> 임계값` 인데 시험이 `== 임계값` | 여유를 두고(예: 1시간 → 2시간) 쓴다 |
| 고정 시계 + `exp` 충돌 | 시계를 정확히 +60분 옮기니 JWT 가 만료 | +30분처럼 겹치지 않게 |
| 설명 주석이 금지 패턴 검사에 걸림 | 규칙을 설명하는 문장이 `localStorage` 검사에 걸림 | 검사 전에 주석 제거 |
| 시드 행 수를 잘못 셈 | `toBe(4)` 인데 실제 3 (`seedOrg` 가 3개 만듦) | 헬퍼가 무엇을 만드는지 먼저 확인 |

### 9-4. 화면 · CSS

| 함정 | 증상 | 해법 |
|---|---|---|
| `[hidden]` 이 클래스에 짐 | `.index-overlay { display: grid }` 가 이김 | `.index-overlay[hidden] { display: none }` 을 명시 |
| `frame-ancestors` 를 `<meta>` 에 | 무시됨 | **`public/_headers`** 로 준다 |
| 모듈 최상위 `window` | Node 에서 import 하면 터짐 | `typeof window !== 'undefined'` 가드 |
| `.slide-inner` 에 `display: grid` 누락 | 표지 화면이 넘침 | 명시적으로 준다 |
| 흰 배경에 밝은 글자 | 아래쪽 고정 줄이 안 보임 | `--slide-w/--slide-h` 로 다시 짜고 어두운 글자 |
| UI 시험의 Tab 범위 | 패널을 추가하니 포커스 흐름 범위가 모자람 | 시험의 Tab 횟수도 함께 늘린다 |

### 9-5. 그 밖

- JSDoc 안의 `*/` — `(*/15 경계)` 라고 쓰면 **주석이 거기서 닫힌다**. 말로 풀어 쓴다("15분 경계")
- Ajv `$id` 중복 — "schema with key or id … already exists" → `$id` 를 빼면 된다
- TS `Env` 색인 서명 오류 — `env[name]` 대신 `env.TOKEN_KEY_V1` 처럼 직접 쓴다

---

## 10. 아직 확인 못 한 것 `[재확인 필요]`

| # | 항목 | 지금 어떻게 해 두었나 |
|---|---|---|
| 1 | 원격 D1 batch 가 **트랜잭션**인지 | 그렇다고 보고 구현(Z35). 가시성에는 기대지 않는다 |
| 2 | Access 그룹 목록 응답에 `result_info` 가 있는지 | 있으면 쓰고, 없으면 "마지막 쪽이 `per_page` 미만" 으로 판정 (양쪽 시험) |
| 3 | `require` 규칙의 실제 모양 | 로그인 방식 조건만 허용, 구성원 계산에 쓰지 않음. 그 밖은 동기화 전체 실패 |
| 4 | `email_list` 규칙 지원 | **지원 안 함 → 실패 처리.** 목록 조회 API 를 공식 문서로 확인 못 했다 |
| 5 | cafe24 몰 ID · 앱 등록 · 실제 갱신 주소 | 자리표시자. 호출하면 `provider_not_configured` 로 끝난다 |
| 6 | Cron 실행의 CPU 사용량 (Free 10 ms/요청) | 번들 크기만 기록. 배포 후 실측 |
| 7 | 쇼룸 최종 주소 | 미정. **`show.firmmit.com` 은 개설·승인된 사실이 없다** |
| 8 | 사내 TV 해상도 · 리모컨 키 코드 | 1920/3840 + 표준 키 + 기기별 keyCode 몇 가지 |

**이 목록에 있는 것을 "확인된 사실"처럼 쓰지 않는다.** 새로 확인하면 공식 문서 주소와 날짜를 남긴다.

---

## 11. 완료 보고 형식 (FIRMMIT 이 기대하는 것)

한국어 · 핵심만 · **표 우선**.

1. **변경표** — ID · 위치 · 근거 · 내용 · 확인 방법 · 결과 · 상태 · 남은 운영 시험
   상태는 네 가지만: **수정함 / 재시험 통과 / 운영 검증 대기 / 보류**
2. **시험 결과표** — 인수 시점(기준값) vs 작업 뒤 vs 종료코드 vs 판정. **줄어든 것이 없음을 명시**
3. **파일 해시** (SHA-256 앞 12자리)
4. **남은 운영 검증** (G01–G10 중 건드린 것)
5. **`[재확인 필요]` 목록**
6. **FIRMMIT 에 물을 것**
7. 전부 **ZIP 1개**로

기존 변경표(`docs/FIRMMIT_ONE_변경표_v2.3_2026-09-17.md`)를 그대로 이어서 쓰면 된다 — `Z37` 부터.

---

## 12. 인계 시점 체크섬

```
커밋      4ab8f1a  (코드는 362e3da 가 마지막. 그 뒤는 문서만)
브랜치    firmmit/brave-bardeen-0nolbj  (= 저장소 기본 브랜치, PR 대상 없음)
추적 파일  150개
```

| 파일 | SHA-256 앞 12자리 |
|---|---|
| `apps/hub/migrations/0004_groupsync.sql` | `c844c1ee96b0` |
| `apps/hub/migrations/0005_kpi.sql` | `99f3d313cba3` |
| `apps/hub/migrations/0006_tokens.sql` | `8a37dd079ffa` |
| `apps/hub/src/tokens/refresh.ts` | `5655a374fc72` |
| `packages/contracts/schema/kpi-summary-v1.2.json` | `8ed9ab2ece1f` |
| `packages/contracts/src/generated/schema-validator.mjs` | `9ea7420e6f2f` |
| `packages/contracts/src/generated/schema-meta.mjs` | `8fa98dd8a1ec` |
| `packages/contracts/src/ids.mjs` | `bb0c8674d86e` |
| `apps/hub/docs/kpi-response.schema.json` | `33585bc588b2` |
| `apps/showroom/public/app.js` | `db141430dea5` |
| `apps/showroom/content/manifest.schema.json` | `854b9f83cf51` |
| `apps/showroom/content/manifest.json` | `bb8fac7f0cdc` |

확인:

```bash
sha256sum packages/contracts/src/generated/schema-validator.mjs | cut -c1-12
```

> 스키마 해시는 **사전 컴파일 검사기 안에도** 들어 있다 —
> 스키마를 고치고 `npm run build:validator -w packages/contracts` 를 다시 돌리지 않으면 시험이 실패한다.

---

## 13. 새 세션에 그대로 붙여 넣을 첫 지시문

```text
FIRMMIT ONE 저장소를 이어받는다.
저장소 https://github.com/firmmit-uz/one · 브랜치 firmmit/brave-bardeen-0nolbj · 커밋 4ab8f1a.

1. docs/FIRMMIT_ONE_인수인계_클로드코드_2026-09-18.md 를 끝까지 읽는다.
2. CLAUDE.md 의 금지 사항을 그대로 지킨다. 특히:
   - 계정 로그인·배포·원격 D1·Secret 등록 금지 (wrangler deploy --dry-run 만 허용)
   - 실제 외부 API 호출 금지 (가짜 서버·fixture 만)
   - 비밀값·실제 계정 ID·직원 실명/이메일을 코드·문서·커밋에 넣지 않는다 (시험 이메일은 @example.invalid)
   - 마이그레이션 0001–0003 수정 금지, 기존 시험 삭제·완화 금지
   - 커밋·푸시는 내가 요청할 때만
3. 그 문서 §1 의 기준 시험을 돌려 §5 의 숫자와 같은지 먼저 확인하고 결과를 표로 보고한다.
4. 숫자가 다르면 거기서 멈추고 나에게 알린다.

그 다음 작업은 내가 따로 지시한다.
```

---

**막히면 물어본다.** 확인 안 된 것을 추측으로 채우는 것이 이 프로젝트에서 가장 큰 실패다.
