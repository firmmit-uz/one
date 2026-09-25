# FIRMMIT ONE 허브 배포 체크리스트

- 대상: `fm-one-hub` (Cloudflare Workers + D1 + Cloudflare Access)
- 작성일: 2026-09-25
- 수행: **FIRMMIT 담당자 본인** (외부·자동 도구는 로그인·배포·원격 D1 변경을 하지 않는다)
- 근거: `apps/hub/README.md` §4 / 인수인계서 / 런북 v2.2

> 이 문서는 **위에서 아래로 순서대로** 진행한다. 앞 단계가 ❌면 다음 단계로 넘어가지 않는다.

---

## §0 착수 조건 — 이것이 전부 ✅ 가 아니면 배포하지 않는다

### 0-1. 게이트 G1 (런북 v2.2 · V0–V13 · 14개)

| # | 항목 | 통과 | 증적 |
|---|---|---|---|
| V0 | 도메인 만료 2027년 이후 | ☐ | |
| V1 | OTP 메일 수신 | ☐ | |
| V2 | 로그인 안 한 창에서 이천의 모든 주소 차단 | ☐ | |
| V3 | 개인 `@firmmit.kr` OTP 로그인 | ☐ | |
| V4 | 로그아웃 30초 후 재차단 | ☐ | |
| V5 | 명단 밖 이메일 주소 차단 | ☐ | |
| V6 | Google 로그인 성공 + 같은 주소 OTP 거부 | ☐ | |
| V7 | S-4의 모든 시트 제한됨 · 웹 게시 없음 | ☐ | |
| V8 | 구 GAS 토큰 없이 거부 | ☐ | |
| V9 | 신규 GAS 정상 · 비노출 | ☐ | |
| V10 | 자격증명 8건 교체 | ☐ | |
| V11 | 구버전 · preview · 해시 주소 · FINO 문서 차단 | ☐ | |
| V12 | 복구 중 경계 유지 | ☐ | |
| V13 | 파생 노출 교체 (별첨 S-6 7행 + B1 교차확인) | ☐ | |

### 0-2. 승인·부대 조건

| 항목 | 상태 |
|---|---|
| **박선기 대표 승인** (서면) | ☐ |
| G01 Access·JWT 실측 | ☐ |
| G02 원격 D1 재시험 (staging D1 권장) | ☐ |

---

## §1 사전 확인 (코드 쪽 — 배포 전날까지)

| # | 항목 | 확인 |
|---|---|---|
| 1-1 | PR `firmmit-uz/one#1` 초안 해제 → 검토 → **base 브랜치에 병합** | ☐ |
| 1-2 | 병합본으로 새 폴더에 `git clone` → `npm ci` 통과 (Node 22.13 이상) | ☐ |
| 1-3 | CLAUDE.md 「기준 시험」 9개 전부 통과 (수·검출 수가 줄면 배포 중단) | ☐ |
| 1-4 | 저장소 `firmmit-uz/one` **공개/비공개** 결정 — 현재 **public** | ☐ |
| 1-5 | 별첨 S(비밀값 보관처) 준비 — 값은 저장소·대화에 남기지 않는다 | ☐ |

```bash
export WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false
npm ci
npm test -w packages/contracts
npm test -w apps/hub
npm run typecheck -w apps/hub
npm run test:mutation -w apps/hub
npm run test:bundle -w apps/hub
npm run build:dry -w apps/hub
npm run test:ui -w apps/hub          # Python Playwright 필요
npm test -w apps/showroom
npm run test:ui -w apps/showroom
```

---

## §2 준비물 (시작 전에 손에 있어야 하는 것)

| 준비물 | 어디서 | 비고 |
|---|---|---|
| 2단계 인증된 **회사 소유** Cloudflare 계정 | — | 개인 계정 금지 |
| 허브 최종 주소 (`https://…`) | 결정 사항 | 끝 슬래시 없음 |
| ADMIN 2인의 이메일 (소문자) | — | 개인 계정, 공용 계정 금지 |
| 직원 이메일 명단 | 인사 | FIRMMIT-ALL Include 에 넣을 값 |
| BREAKGLASS 계정 | — | Google 로그인만 |
| 별첨 S 보관처 | — | `database_id` · API 토큰 · 실행 기록 |

**Cron 여유 확인**: Workers Free 한도 계정당 5개. 허브 3개 + 기존 BAND→Slack 1개 = **4개**, 여유 1개.

---

## §3 배포 절차 (8단계)

### 3-1. 로그인
```bash
npx wrangler login
```
☐ 로그인한 계정이 **회사 소유 계정**인지 화면에서 확인

### 3-2. D1 생성
```bash
npx wrangler d1 create fm-one-hub
```
☐ 출력된 `database_id` → `wrangler.jsonc` 의 `<D1_DATABASE_ID>` 에 기입
☐ 같은 값을 별첨 S 에 기록

### 3-3. 마이그레이션
```bash
npx wrangler d1 migrations apply fm-one-hub --remote --env=""
```
☐ `SELECT COUNT(*) FROM app_registry` = **17**
☐ `SELECT COUNT(*) FROM users` = **0**
☐ (권장) staging D1 을 먼저 만들어 같은 순서로 적용 — G02

### 3-4. 설정값 채우기 (`wrangler.jsonc` · vars)

| 자리표시자 | 넣을 값 | 어디서 | 완료 |
|---|---|---|---|
| `<D1_DATABASE_ID>` | D1 ID | 3-2 출력 | ☐ |
| `<TEAM>` | Zero Trust 팀 이름 | `<team>.cloudflareaccess.com` | ☐ |
| `<AUD>` | Application Audience Tag | Access 앱 Overview (3-5 이후) | ☐ |
| `ALLOWED_ORIGIN` | `https://허브주소` | 결정 사항 (끝 슬래시 없음) | ☐ |
| `<CF_ACCOUNT_ID>` | 계정 ID | `dash.cloudflare.com/<여기>` | ☐ |

☐ **`DEV_FAKE_IDENTITY` 는 절대 넣지 않는다**
☐ 비밀값(`CF_API_TOKEN` 등)은 파일이 아니라 Worker Secret 에만 넣는다

### 3-5. Access 앱 (Worker 단위)

Workers & Pages → `fm-one-hub` → Access → *Protect this Worker behind Access* → **All traffic**

☐ 정책 = 허브 전용 **FIRMMIT-ALL** (Include = 직원 이메일 명단, Require = Login Methods: One-time PIN)
☐ **FIRMMIT-BREAKGLASS** 추가
☐ **Email domain / Emails ending in 규칙 사용 금지**
☐ 이천 시범 그룹 **FIRMMIT-ICHEON-PILOT 재사용 금지**
☐ Session duration 설정 → Apply
☐ workers.dev · Preview · Custom Domain **모든 주소**에서 로그인 화면이 뜨는지 실측

> ⚠️ **첫 배포 순서 주의** — Worker 가 없으면 Access 탭도 없다. 그대로 올리면 API 는 전부 401(fail-closed)이지만 **정적 SPA 껍데기가 잠시 공개**된다.
> → 첫 배포에 **`"workers_dev": false`** 를 넣고, Access 적용 후에 켠다.

### 3-6. 배포
```bash
npx wrangler deploy --env=""
```
☐ `GET /api/health` → `{"ok":true}`
☐ 로그인 후 `GET /api/me` → 403 `not_registered` (아직 사용자 0명 — **정상**)

### 3-7. 첫 ADMIN 2인 등록

권장: **ADMIN 1명만 SQL 로**, 두 번째는 관리 화면으로 등록 → 감사기록에 남는다.

```bash
npx wrangler d1 execute fm-one-hub --remote --env="" --file bootstrap-admins.sql
```
☐ 이메일은 반드시 **소문자**
☐ 두 사람 모두 FIRMMIT-ALL + ADMIN 그룹에 있어야 한다
☐ `bootstrap-admins.sql` 은 **저장소에 올리지 않는다**
☐ 이 SQL 은 감사 체인 밖 → 실행자·시각을 별첨 S 에 기록

### 3-8. 그룹 사본 동기화 (자동, 15분 Cron)

☐ API 토큰 생성 — 권한은 **Account → Access: Organizations, Identity Providers, and Groups → Read 하나만** (쓰기 금지)
☐ Account Resources 를 해당 계정 1개로 좁힘, 가능하면 IP 필터·만료일
☐ `CF_ACCOUNT_ID` 기입 (3-4)
☐ `npx wrangler secret put CF_API_TOKEN --env=""` — **설정 파일에 넣지 않는다**
☐ 배포 후 15분 안에 관리 화면 *그룹 동기화* 의 **마지막 성공** 시각 갱신 확인

**대상 그룹 8개**

| 허브 `group_name` | Cloudflare Access 그룹 | 용도 |
|---|---|---|
| ALL | FIRMMIT-ALL | 허브 입장 정책 (직원 전체, OTP) |
| ADMIN | FIRMMIT-ADMIN | 허브 관리자 (개인 계정 2인 이상) |
| BREAKGLASS | FIRMMIT-BREAKGLASS | Google 로그인만 |
| NONGJAJAE | FIRMMIT-NONGJAJAE | 농자재 유통 |
| CONSTRUCTION | FIRMMIT-CONSTRUCTION | 견적 백오피스 |
| RND | FIRMMIT-RND | 이천 수직농장 |
| UZ | FIRMMIT-UZ | AMIM 등 우즈벡 앱 |
| FINANCE | FIRMMIT-FINANCE | 재무 KPI (Phase 2, 선택) |

**실패 사유 코드**: `api_http_403` 토큰 권한 부족 · `missing_group` Access 에 그룹 없음 · `unknown_rule` 이메일 외 규칙 사용

☐ 각 그룹 Include/Exclude 는 **이메일 규칙만** (`Everyone` · `Emails ending in` · `Email list` · IP · 국가 규칙이 하나라도 있으면 전체 실패)
☐ FINANCE 는 없어도 성공, **나머지 7개는 하나라도 없으면 전체 실패**
☐ ADMIN 또는 BREAKGLASS 가 0명이면 실패 처리 (관리자 잠김 방지)

---

## §4 end-to-end 시험 (직원 1명 · 앱 1개)

| # | 시험 | 기대 | 통과 |
|---|---|---|---|
| 1 | 비로그인으로 허브 모든 주소 접속 | Access 로그인 화면 (앱 화면·API 응답 없음) | ☐ |
| 2 | ADMIN 로그인 → 시험 직원 등록 → 사본에 `NONGJAJAE` 추가 → `nongjajae` VIEWER 부여 | 정상 | ☐ |
| 3 | 시험 직원 로그인 | 홈에 「농자재 유통 시스템」 + 공개 사이트·채널, 미연결은 회색·링크 없음, 관리 탭 없음 | ☐ |
| 4 | 카드 클릭 | **새 탭**으로 앱 진입, 앱 자체 Access 로그인 | ☐ |
| 5 | ADMIN 이 부여 **회수** | 직원 새로고침 시 즉시 카드 사라짐 (재로그인 없이) | ☐ |
| 6 | ADMIN 이 직원 **정지** | 직원 화면 403 「계정이 정지…」 | ☐ |
| 7 | 감사기록 | `user_create` → `group_snapshot_replace` → `grant_create` → `grant_revoke` → `user_status_change` 순, **무결성 점검 = 정상** | ☐ |
| 8 | `/api/admin/users` 를 직원 계정으로 호출 / 다른 Origin 에서 POST | 둘 다 403 | ☐ |
| 9 | 시스템 상태 | 5~10분 뒤 점검 시각 갱신 (Cron `*/5`), 요약 숫자 = 목록 상태 | ☐ |
| 10 | 로그아웃 `/cdn-cgi/access/logout` 후 재접속 | 로그인 화면 | ☐ |
| 11 | (BREAKGLASS 보유 시) 로그인 1회 | 감사 `breakglass_login` 1건 | ☐ |

---

## §5 이번에 **켜지 않는 것**

| 기능 | 설정 | 상태 |
|---|---|---|
| CCTV 보기 (R3) | `CCTV_ENABLED="false"` · `CCTV_RELAY_ORIGIN`·`CCTV_RELAY_AUTH` 자리표시자 | **끔** |
| 외부 토큰 갱신 (WP3) | `TOKEN_REFRESH_ENABLED="false"` | **끔** |

### CCTV 를 켜려면 (README §4.3) — 아직 전부 미완

☐ AKIS 온실 **안**에 중계 PC (카메라와 같은 공유기) — 천안 사무실 PC 불가
☐ 카메라 대수 · 내부 IP (공유기에서 IP 고정)
☐ 온실 회선 **업로드** 속도 실측 — 1080p 카메라 1대당 약 2~4 Mbps `[재확인 필요]`
☐ go2rtc + Cloudflare Tunnel 구축 (`apps/hub/docs/cctv-relay/go2rtc.example.yaml`)
☐ `CCTV_RELAY_AUTH` 를 `cf-access` / `basic` / `none` 중 **명시적으로 기입** (자리표시자면 거부)
☐ Secret 등록 (`CCTV_RELAY_CF_ID`·`CCTV_RELAY_CF_SECRET` 또는 `CCTV_RELAY_USER`·`CCTV_RELAY_PASS`)
☐ **노무·법무 검토** (근로자 감시) `[재확인 필요]`
☐ **G11 운영 검증** + 박선기 대표 승인

> 안 켜면 아무 일도 없다 — 카메라는 전부 "볼 수 없음", 영상 요청은 `409` 로 끝나고 중계 서버를 부르지도 않는다.

### 토큰 갱신을 켜려면 (README §4.2) — 아직 전부 미완

☐ cafe24 앱 등록 + 몰 ID (`<MALL_ID>` 자리표시자)
☐ 쇼핑몰 관리자 브라우저로 최초 동의
☐ `src/tokens/providers.ts` 어댑터에 실제 주소 기입
☐ `openssl rand -base64 32` → `npx wrangler secret put TOKEN_KEY_V1 --env=""`
☐ 첫 토큰 행은 `tokens` + `token_lease` 를 **같은 batch** 로 (실행권 행이 없으면 영원히 안 돈다)
☐ **G02** + 박선기 대표 승인

---

## §6 중단·되돌리기 기준

| 상황 | 조치 |
|---|---|
| §0 항목이 하나라도 ❌ | **배포하지 않는다** |
| 3-3 에서 `app_registry` ≠ 17 | 중단, 마이그레이션 이력 확인 |
| 3-6 이후 Access 로그인 화면이 안 뜨는 주소가 있음 | 즉시 `workers_dev: false` 로 재배포, 원인 해결 전 공개 금지 |
| 3-8 동기화 실패가 30분 이상 지속 | 허브 ADMIN 외 쓰기가 막힌다 — 사유 코드 확인, 수동 입력(8-b) 으로 전환 판단 |
| §4 시험 1·8 실패 (권한 경계) | **즉시 중단**, 사용자 안내 전 원인 해결 |
| ADMIN 전원 로그인 불가 | BREAKGLASS 계정 (Google 로그인) 으로 진입 |

---

## §7 실행 기록 (별첨 S 에 보관)

| 항목 | 값 |
|---|---|
| 배포 일시 (KST) | |
| 수행자 | |
| 승인자 (박선기 대표) 서명 | |
| 배포 커밋 해시 | |
| D1 `database_id` | 별첨 S |
| 허브 주소 | |
| ADMIN 2인 | |
| bootstrap SQL 실행자·시각 | |
| §4 시험 전부 통과 여부 | |

---

### `[재확인 필요]` 목록

- 우즈베키스탄 현지 회선 업로드 속도 · 필요 대역폭 (1080p당 2~4 Mbps)
- Cloudflare 대시보드 화면 문구 (Access 앱 · API 토큰 생성) — 적용 시점에 공식 문서로 재확인
- go2rtc 공식 저장소 주소 — 내려받기 전 재확인
- 근로자 감시 관련 한국·우즈베키스탄 법령 판단
