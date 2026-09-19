# FIRMMIT ONE 허브 v1 (`fm-one-hub`)

직원용 **앱 런처 + 로그인 확인 + 권한 + 시스템 상태 + 감사기록 + 관리** (Phase 1, 데이터 연동 없음).
Cloudflare Worker 1개 + Static Assets + D1 1개. 앱은 **새 탭**으로만 열고(iframe 없음), 허브는 업무 데이터를 저장하지 않는다.

> 이 저장소 작업에서는 Cloudflare 계정에 로그인·배포하지 않았다. `wrangler deploy --dry-run` 번들 확인만 했다.
> `<...>` 로 된 값은 모두 자리표시자다. 비밀값·실제 계정 ID·실제 직원 명단은 코드에 없다.

---

## 1. 구조

```
apps/hub/
├─ wrangler.jsonc            Worker 설정 (자산·D1·크론·관측, env.development)
├─ package.json / tsconfig.json / tsconfig.test.json / vitest.config.ts
├─ migrations/
│  ├─ 0001_init.sql          전체 스키마 + 추가 전용 트리거 + 해시 체인 머리 확인
│  ├─ 0002_seed_apps.sql     런처 앱 17개 (공개 정보만, 미연결은 주소 없음)
│  └─ 0003_seed_group_ceiling.sql  그룹별 역할 상한 (사용자·관리자는 만들지 않음)
├─ scripts/dev-seed.sql      로컬 개발 전용 가짜 관리자 (운영 적용 금지)
├─ src/
│  ├─ index.ts               진입점 (fetch → Hono, scheduled → 가용성 점검)
│  ├─ app.ts                 미들웨어 순서: 보안헤더 → 설정점검 → /api/health → 인증 → CSRF → 권한주체 → 라우트
│  ├─ auth.ts                Cf-Access-Jwt-Assertion 검증 (jose, RS256, iss/aud/exp/nbf/email)
│  ├─ authz.ts               D1 권한 판정 (캐시 없음, 상한, 사본 신선도)
│  ├─ admin.ts               관리 API (모든 변경 = 변경 + 감사 1건을 한 배치로)
│  ├─ audit.ts               해시 체인 기록·점검
│  ├─ apps.ts                런처 보기 권한
│  ├─ uptime.ts              5분 가용성 점검 (알림 발송 코드 없음)
│  ├─ validate.ts            수동 입력 검증 (fail-closed)
│  ├─ config.ts / env.ts / http.ts
├─ public/                   SPA (index.html, app.js, i18n.js, styles.css, logo.svg, favicon.svg, _headers)
└─ test/
   ├─ d1-adapter.ts          node:sqlite 기반 D1 대체 (실제 마이그레이션 SQL 실행)
   ├─ helpers.ts             로컬 RSA 키로 JWT 발급, 시험 조직 준비
   ├─ *.test.ts              vitest 시험 8개 파일
   ├─ mutation.mjs           변이 시험
   ├─ ui-server.ts           UI 시험용 로컬 서버 (정적 파일 + 실제 API + 메모리 DB)
   ├─ ui_screens.py          Playwright(Chromium) 스크린샷·검사
   └─ screens/               스크린샷·ui-report.json
```

### 1.1 API

| 경로 | 인증 | 권한 | 설명 |
|---|---|---|---|
| `GET /api/health` | 없음 | — | `{"ok":true}` 만 반환 |
| `GET /api/me` | Access | 등록·활성·그룹 소속 | 이메일·이름·그룹·유효 역할·사본 신선도 |
| `GET /api/apps` | Access | 〃 | 권한별 런처 목록. 미연결은 `url:null` + `status:"not_connected"` |
| `GET /api/status` | Access | 〃 | 전체 요약 숫자 + 볼 수 있는 앱 상태. 허브 ADMIN 은 상세 |
| `GET /api/kpi` | Access | 볼 수 있는 KPI만 | KPI 목록 + 요약. 권한 없는 KPI는 **응답에 아예 없음**. 응답 형식: `docs/kpi-response.schema.json` |
| `GET /api/kpi/:kpi_id` | Access | 〃 | KPI 1건. 권한 없음·미수집은 **똑같이 404**(존재 여부 비노출) |
| `GET /api/admin/users` | Access | 허브 ADMIN | 직원·부여(상태 포함)·앱·상한·그룹 사본·동기화 상태 |
| `POST /api/admin/users` | Access | 허브 ADMIN | 직원 등록 `{email, display_name, emp_id?, reason?}` |
| `POST /api/admin/users/:email/status` | Access | 허브 ADMIN | `{status: active\|suspended\|revoked, reason?}` (자기 정지 금지) |
| `POST /api/admin/grants` | Access | 허브 ADMIN | `{email, app_id, role, scope?, expires_at?, reason?}` |
| `POST /api/admin/grants/:id/revoke` | Access | 허브 ADMIN | `{reason?}` (자기 허브 ADMIN 회수 금지) |
| `POST /api/admin/group-snapshot` | Access | 허브 ADMIN | 그룹 사본 **전체 교체** `{groups:[{group_name, emails[]}], reason?}`. **자동 동기화가 설정돼 있으면 409 `auto_sync_enabled`** |
| `GET /api/admin/tokens` | Access | 허브 ADMIN | 연동 토큰 **상태만**(값·암호문 미포함) + 자동 갱신 켜짐 여부 |
| `GET /api/admin/phase0` | Access | 허브 ADMIN | 게이트 G1 체크리스트 14개 + 통과 수 |
| `POST /api/admin/phase0/:item_id` | Access | 허브 ADMIN | `{state: pending\|passed\|failed\|na, evidence_ref?, reason?}`. `passed`는 증적 참조 필수, 증적에 주소·이메일·비밀값 형태 금지 |
| `GET /api/cctv` | Access | 허브 ADMIN | 카메라 목록. **중계 서버 주소·경로는 응답에 없음** |
| `POST /api/cctv/:camera_id/open` | Access | 허브 ADMIN | 열람 시작 `{reason?}` → 감사기록 1건 + `play_path` |
| `GET /api/cctv/:camera_id/play` | Access | 허브 ADMIN | 영상을 **같은 출처로 전달**. 형식이 `video/mp4`·`image/jpeg` 가 아니면 502 |
| `GET /api/admin/cctv` | Access | 허브 ADMIN | 카메라 목록(관리용, 정렬·갱신 시각 포함) |
| `POST /api/admin/cctv` | Access | 허브 ADMIN | 카메라 등록·수정 `{camera_id, name_ko, site, stream_kind, stream_path\|null, sort?, reason?}` |
| `GET /api/admin/audit?limit=&before=` | Access | 허브 ADMIN | 감사기록 (최대 500) |
| `GET /api/admin/audit/verify` | Access | 허브 ADMIN | 해시 체인 점검 `{ok, checked, broken_at_id?, reason?}` |

- 모든 `/api` 응답: `Cache-Control: no-store` + 보안 헤더 + `X-Request-Id`. 오류는 `{"error":{"code","message"}}`, 스택·SQL 미노출.
- 쓰기(POST): `Origin == ALLOWED_ORIGIN` 이고 `Content-Type: application/json` 일 때만. `Sec-Fetch-Site` 가 있으면 `same-origin` 이어야 함.
- 입력: 모르는 필드·잘못된 타입·빈 값·null 거부, boolean 은 `true/false` 만, 본문 64KB 제한.

### 1.2 인증·권한 규칙

- **입장 = Access(필요조건)**: 매 `/api/*` 요청마다 `Cf-Access-Jwt-Assertion` 헤더 JWT 를 검증한다. 발급자 `https://<TEAM>.cloudflareaccess.com`, JWKS `…/cdn-cgi/access/certs`, audience `ACCESS_AUD`, RS256, `exp` 필수, `email` 필수. `CF_Authorization` 쿠키는 쓰지 않는다. 헤더 없음·검증 실패·설정 누락(자리표시자 포함) → 401.
- **행동 = D1**: 매 요청 캐시 없이 `users`·`role_grants`·`access_group_snapshot`·`group_ceiling`·`sync_state` 를 읽는다.
  - `users.status != 'active'` → 403, 사본의 어느 그룹에도 없음 → 403, 미등록 → 403.
  - 회수·만료(또는 날짜 해석 실패)된 부여는 무시.
  - 부여 역할이 사용자가 속한 그룹 상한(`app_id` 또는 `*`) 중 최고값을 넘거나 상한 행이 없으면 **그 부여는 무시**.
  - `app_id = 'hub'` 의 ADMIN = 허브 관리자.
  - 사본 동기화가 30분을 넘거나 기록이 없으면 **허브 ADMIN 외 쓰기(POST) 거부** (`group_snapshot_stale`). 읽기는 허용하고 화면에 경고.
  - `BREAKGLASS` 그룹 사용자는 Access 세션(`iat`)마다 `breakglass_login` 감사 1건. 기록 실패 시 요청 거부(500).
- 런처 보기: 공개 사이트·채널 = 모두, 업무 앱 = `required_group` 소속 + 해당 앱 역할 VIEWER 이상, 관리 콘솔 = `required_group` 소속 + (해당 앱 역할 또는 허브 ADMIN).
- 기본값: 사용자 0명, 부여 0건, 자동 관리자 없음.
- 운영(`ENVIRONMENT=production`)에서 `DEV_FAKE_IDENTITY` 가 있으면(빈 값 포함) Worker 가 처리하는 모든 요청 500 + `config_error` 로그. `ENVIRONMENT` 가 `production/development` 가 아니어도 500.

### 1.3 감사기록

- `audit_log` 는 추가 전용: UPDATE·DELETE 트리거 차단, `INSERT OR REPLACE`/`REPLACE` 는 **BEFORE INSERT 트리거가 같은 id 또는 같은 row_hash 존재 시 ABORT** (REPLACE 는 DELETE 트리거를 부르지 않기 때문), UPSERT 는 UPDATE 트리거로 차단.
- `row_hash = sha256(prev_hash | JSON[ts, actor, action, target, detail_json, request_id])` (앱에서 계산). 첫 행 `prev_hash` = 0×64.
- 삽입 트리거가 `prev_hash == 마지막 row_hash` 를 강제 → 동시 쓰기 충돌 시 배치 전체 롤백 후 재시도(최대 5회).
- 관리 변경은 **변경 문장 + 감사 행을 한 D1 batch(트랜잭션)** 로 실행 → 감사 실패 시 변경도 롤백.
- `role_grants` 는 삭제 금지·회수 1회만 허용, `users` 는 삭제·이메일 변경 금지 (트리거).

---

## 2. 로컬 실행 (선택)

```bash
cd firmmit-one && npm install
cd apps/hub
# 로컬 D1 준비 (로컬 파일만 사용, 계정 불필요)
npx wrangler d1 migrations apply fm-one-hub-dev --local --env development
npx wrangler d1 execute fm-one-hub-dev --local --env development --file scripts/dev-seed.sql
npm run dev          # = wrangler dev --env development → http://localhost:8787
```

- development 에서는 `DEV_FAKE_IDENTITY`(`dev-admin@example.invalid`) 로 JWT 없이 동작한다. 이 값은 운영 설정에 넣지 않는다.
- 이번 작업에서는 `wrangler dev` 를 실행하지 않았다. UI 는 `test/ui-server.ts`(Node) 로 확인했다.

## 3. 시험

```bash
cd apps/hub
npm test                 # vitest (node:sqlite 로 실제 마이그레이션 실행)
npm run typecheck        # tsc --noEmit (src) + tsconfig.test.json (src+test)
npm run test:mutation    # 변이 24개 — 미검출 시 exit 1
npm run test:bundle      # build:dry 실행 후 번들에 eval·new Function·node: 없음 확인
npm run test:ui          # Playwright(Chromium) 스크린샷 → test/screens/, 실패 시 exit 1
npm run build:dry        # wrangler deploy --dry-run --outdir dist (로그인 불필요)
```

| 영역 | 확인 내용 |
|---|---|
| 인증 | 헤더 없음·쿠키만·서명 불일치·변조·aud·iss·만료·exp 없음·nbf 미래·email 없음/형식 오류·HS256·alg=none·모르는 kid·과대 토큰 → 401 / 정상 200 / 설정 누락·자리표시자 → 401 / production+DEV 변수 → 500 |
| 권한 | 기본 0명, 미등록·suspended·revoked 403, 만료·회수 무시, **회수·정지·사본 제외 직후 같은 JWT 거부**, 사본 없음 403, 30분 초과 비ADMIN 쓰기 거부(30분 정각은 허용), 상한 초과 무시, 다중 그룹 최고 상한 |
| 감사 | UPDATE·DELETE·INSERT OR REPLACE(id/row_hash)·REPLACE·UPSERT 실패, 체인 verify 통과, 복제 DB(`VACUUM INTO`)에서 트리거 제거 후 내용 변조·중간 삭제·해시 재계산 변조 → verify 실패, 동시 쓰기 재시도, 감사 실패 시 변경 롤백 |
| CSRF·입력 | Origin 없음/다름/끝 슬래시/`null`, Content-Type 다름(415), cross-site, ALLOWED_ORIGIN 자리표시자, 모르는 필드·잘못된 역할·빈 이메일·과거 만료·없는 날짜·`__proto__` 등 |
| 런처 | 권한별 필터, 미연결 = url 없음, 공개 사이트 전원, `javascript:` 주소 방어 |
| 가용성 | 1회 실패 UP 유지 → 2회 DOWN → 계속 DOWN → 복구 UP, 변화 때만 감사, HEAD 405→GET, 리다이렉트 미추적, 시간 초과, scheduled 설정 오류 시 미실행 |
| KPI | 내부 KPI 봉투가 계약 v1.2 통과, ONE 이 `kpi_def` 기준으로 stale 재계산(기준 시각 해석 실패 = stale), 상태 우선순위, 권한 없는 KPI는 응답에서 제거·개별 조회 404, 그룹에서 빠지면 다음 조회에 사라짐, 요약/상세 breakdown 구분, 깨지거나 모양이 다른 캐시는 내보내지 않음, 마지막 정상 시각 보존, 조회는 감사 체인 대신 구조화 로그, 가짜 소스 왕복(정상·스키마 위반·제한시간·소스 다운·통화 혼합·personal·null≠0), 응답이 `docs/kpi-response.schema.json` 통과 |
| 토큰 갱신 | 기본 꺼짐(`"true"` 외 전부 꺼짐)·키 없음·토큰 없음·실행권 행 없음 → 외부 호출 0건, ① 동시 실행 2개 중 하나만, ② 남은 시간 부족 시 요청 없이 해제, ②-1 시작 기록 실패 시 요청 없음, ③ 파싱 전 선기록(깨진 응답에서도 남음), ④ 버전 조건·⑤ 충돌 보존(남의 값 덮어쓰지 않음), ⑥ 남의 실행권 해제 불가, 응답 유실 → `unknown` + 재시도 없음 + 다음 실행 차단, 죽은 `in_progress` 차단, 평문 토큰이 D1·로그·감사 어디에도 없음, 시각 형식 한 가지 |
| Phase 0 | 14개 항목 시작 상태, 통과에는 증적 필수, 증적에 주소·이메일·비밀값 거부, 변경+감사 한 batch, 같은 값 409, 비ADMIN 403 |
| 그룹 동기화 | 1쪽·여러 쪽(`result_info` 있음/없음)·최대 쪽수, 허용 목록 밖 무시, 필수 그룹 누락·ADMIN 0명·알 수 없는 규칙·이메일 형식 → 실패하고 **사본 유지**, HTTP 401/403/429/500·시간 초과·네트워크·깨진 JSON·`success:false`, 대소문자·공백 정규화·중복 제거·exclude 적용, 빈 그룹·FINANCE 없음 = 정상, 같은 사유 연속 실패 = 감사 1건, 30분 초과 = `group_sync_stale` 1건, 설정 누락 시 외부 호출 0건, 변경 없으면 감사 0건, 자동 모드에서 수동 입력 409 |
| 헤더 | 모든 응답 보안 헤더·no-store, `/api/health` = `{"ok":true}`, 500 응답에 내부 정보 없음, `_headers` 와 코드 값 일치, wrangler 자리표시자 |

---

## 4. 배포 안내서 (FIRMMIT 담당자 직접 수행)

> **착수 조건**: Phase 0 게이트 **G1 전 항목 통과 + 박선기 대표 승인** 후에만.
> 게이트 G1 = 런북 **v2.2의 V0–V13(14개)**: V0 도메인 만료 2027년 이후 · V1 OTP 메일 수신 · V2 로그인 안 한 창에서 이천의 모든 주소 차단 · V3 개인 @firmmit.kr OTP 로그인 · V4 로그아웃 30초 후 재차단 · V5 명단 밖 이메일 주소 차단 · V6 Google 로그인 성공+같은 주소 OTP 거부 · V7 S-4의 모든 시트 제한됨·웹 게시 없음 · V8 구 GAS 토큰 없이 거부 · V9 신규 GAS 정상·비노출 · V10 자격증명 8건 교체 · V11 구버전·preview·해시 주소·FINO 문서 차단 · V12 복구 중 경계 유지 · V13 파생 노출 교체(별첨 S-6 7행 + B1 교차확인).
> 운영 개방 대장 G01(Access·JWT 실측)·G02(원격 D1 재시험)도 함께 확인.

1. **로그인** — 담당자 PC 에서 `npx wrangler login` (2단계 인증된 회사 소유 계정).
2. **D1 생성** — `npx wrangler d1 create fm-one-hub` → 출력된 `database_id` 를 `wrangler.jsonc` 의 `<D1_DATABASE_ID>` 에 넣는다 (저장소에는 올리지 않거나 별첨 S 에 기록).
3. **마이그레이션** — `npx wrangler d1 migrations apply fm-one-hub --remote --env=""` → `SELECT COUNT(*) FROM app_registry` = 17, `users` = 0 확인.
   - 먼저 **staging D1** 을 따로 만들어 같은 순서로 적용하고 트리거·batch 동작을 확인하는 것을 권장(G02).
4. **Access 앱 (Worker 단위)** — Workers & Pages → `fm-one-hub` → Access(또는 Settings → Domains & Routes) → *Protect this Worker behind Access* → **All traffic** → 정책은 허브 전용 **FIRMMIT-ALL 그룹**(Include = 직원 이메일 명단, Require = Login Methods: One-time PIN) + **FIRMMIT-BREAKGLASS** 로 새로 만들어 선택 (**Email domain 옵션·Emails ending in 규칙 사용 금지**, 이천 시범 그룹 ICHEON-PILOT 재사용 금지). Phase 1 시범은 직원 1명부터 → Session duration → Apply. [화면 문구는 적용 시점에 공식 문서로 재확인]
   - Worker 가 아직 없으면 Access 탭이 없으므로, 첫 배포는 API 가 자리표시자 설정 때문에 전부 401(fail-closed)인 상태로 올라간다. 정적 SPA 껍데기(데이터 없음)가 잠시 공개될 수 있으므로 첫 배포 직후 곧바로 Access 를 적용하거나, 첫 배포에 `"workers_dev": false` 를 넣고 Access 적용 후 켠다.
   - workers.dev·Preview·Custom Domain **모든 주소**에서 로그인 화면이 뜨는지 실측.
5. **설정값** — Zero Trust 의 팀 도메인 `<team>.cloudflareaccess.com` 에서 `<team>` → `ACCESS_TEAM`, Access 앱 Overview 의 *Application Audience (AUD) Tag* → `ACCESS_AUD`, 허브 최종 주소(`https://…`, 끝 슬래시 없음) → `ALLOWED_ORIGIN`. `DEV_FAKE_IDENTITY` 는 **절대 넣지 않는다**.
6. **배포** — `npx wrangler deploy --env=""` → `GET /api/health` = `{"ok":true}`, 로그인 후 `/api/me` 403 `not_registered`(아직 사용자 0명) 확인.
7. **첫 ADMIN 2인 등록 (SQL, 자리표시자)** — 두 사람 모두 허브 정책 그룹(FIRMMIT-ALL)과 Access 그룹 사본의 ADMIN 그룹에 있어야 한다.

   ```sql
   -- npx wrangler d1 execute fm-one-hub --remote --env="" --file bootstrap-admins.sql   (파일은 저장소에 올리지 않음)
   INSERT INTO users (email, emp_id, display_name, status, created_at) VALUES
     ('<ADMIN1_EMAIL>', '<ADMIN1_EMP_ID 또는 NULL>', '<ADMIN1_이름>', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     ('<ADMIN2_EMAIL>', '<ADMIN2_EMP_ID 또는 NULL>', '<ADMIN2_이름>', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
   INSERT INTO access_group_snapshot (group_name, email, synced_at) VALUES
     ('ADMIN', '<ADMIN1_EMAIL>', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     ('ADMIN', '<ADMIN2_EMAIL>', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
   INSERT INTO role_grants (email, app_id, role, scope, expires_at, granted_by, granted_at) VALUES
     ('<ADMIN1_EMAIL>', 'hub', 'ADMIN', '*', NULL, 'bootstrap:<실행자>', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     ('<ADMIN2_EMAIL>', 'hub', 'ADMIN', '*', NULL, 'bootstrap:<실행자>', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
   INSERT INTO sync_state (key, last_success_at) VALUES ('access_groups', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET last_success_at = excluded.last_success_at;
   ```
   - 이메일은 반드시 **소문자**. 이 SQL 은 감사 체인 밖이므로 실행자·시각을 별첨 S 에 기록한다.
   - 대안(권장): ADMIN 1명만 SQL 로 만들고 두 번째 ADMIN 은 관리 화면(직원 등록 → 그룹 사본 → 권한 부여)으로 등록하면 감사기록에 남는다.
8. **그룹 사본 동기화 (자동 — 설정이 없으면 수동)** — 아래 대응표의 8개 그룹만 대상이다.

   **8-a. 자동 동기화 (권장, 15분 Cron)**
   1. Cloudflare 대시보드 → My Profile → API Tokens → *Create Token* → Custom token.
      권한은 **Account → Access: Organizations, Identity Providers, and Groups → Read** **하나만** 준다 (쓰기 권한 금지).
      Account Resources 는 해당 계정 1개로 좁히고, 가능하면 IP 필터·만료일을 건다.
      [화면 문구는 적용 시점에 공식 문서로 재확인]
   2. 계정 ID (대시보드 우측 또는 URL `dash.cloudflare.com/<account_id>`) → `wrangler.jsonc` 의 `"CF_ACCOUNT_ID": "<CF_ACCOUNT_ID>"` 를 실제 값으로 바꾼다.
   3. 토큰은 **설정 파일에 넣지 않는다** — `npx wrangler secret put CF_API_TOKEN --env=""` 로 Worker Secret 에만 넣는다. 토큰 값은 별첨 S 에 보관한다.
   4. 배포 후 15분 안에 관리 화면 *그룹 동기화* 영역에서 **마지막 성공** 시각이 갱신되는지 확인한다.
      실패하면 같은 영역에 사유 코드(`api_http_403` = 토큰 권한 부족, `missing_group` = Access 에 그룹이 없음, `unknown_rule` = 이메일 외 규칙 사용 등)가 뜬다.
   - **Access 에 FIRMMIT-FINANCE 그룹이 아직 없어도 동기화는 성공한다** (선택 그룹 → 구성원 0명). 나머지 7개 그룹은 하나라도 없으면 전체 실패로 보고 기존 사본을 유지한다.
   - 각 그룹의 Include/Exclude 는 **이메일 규칙만** 써야 한다. `Everyone`·`Emails ending in`(도메인)·`Email list`·IP·국가 규칙이 하나라도 있으면 그 동기화 전체가 실패한다(fail-closed). Require 는 로그인 방식 조건(Login Methods / Authentication Method)만 허용하며 구성원 계산에 쓰지 않는다.
   - 계산 결과 ADMIN 또는 BREAKGLASS 가 0명이면 관리자 잠김을 막기 위해 실패로 처리하고 기존 사본을 유지한다.
   - 실패해도 사본과 마지막 성공 시각은 그대로다 → 30분이 지나면 기존 규칙대로 허브 ADMIN 외 쓰기가 막힌다.

   **8-b. 수동 입력 (자동 설정이 없을 때만)**
   - `CF_ACCOUNT_ID`·`CF_API_TOKEN` 중 하나라도 비어 있거나 자리표시자면 자동 동기화는 실행되지 않고(`config_error` 로그, 외부 호출 0건) 관리 화면의 *그룹 사본 입력*(한 줄에 `그룹,이메일`)을 그대로 쓴다. 저장 시 전체 교체 + 동기화 시각 갱신 + 추가/삭제 내역 감사.
   - 자동 동기화가 켜진 상태에서는 수동 입력이 **409 `auto_sync_enabled`** 로 거부된다(수동 입력이 동기화 시각을 갱신해 자동 동기화 실패를 가리는 것을 막기 위함). 화면에서도 입력란이 닫힌다.

   | 허브 D1 그룹명(`group_name`) | Cloudflare Access 규칙 그룹 | 비고 |
   |---|---|---|
   | ALL | FIRMMIT-ALL | 허브 입장 정책 그룹(직원 전체, OTP) |
   | ADMIN | FIRMMIT-ADMIN | 허브 관리자(개인 계정 2인 이상) |
   | BREAKGLASS | FIRMMIT-BREAKGLASS | firmmitinfo@gmail.com, Google 로그인만 |
   | NONGJAJAE | FIRMMIT-NONGJAJAE | 농자재 유통 |
   | CONSTRUCTION | FIRMMIT-CONSTRUCTION | 견적 백오피스 |
   | RND | FIRMMIT-RND | 이천 수직농장 |
   | UZ | FIRMMIT-UZ | AMIM 등 우즈벡 앱 |
   | FINANCE | FIRMMIT-FINANCE | 재무 KPI(Phase 2) |

   Phase 0용 FIRMMIT-ICHEON-PILOT·FIRMMIT-IT는 허브 그룹 사본에 넣지 않는다.
9. **시험 체크리스트 (직원 1명·앱 1개 end-to-end)**
   - [ ] 비로그인 상태로 허브 모든 주소 접속 → Access 로그인 화면 (앱 화면·API 응답 없음)
   - [ ] ADMIN 로그인 → 관리 화면에서 시험 직원 등록 → 사본에 그룹(예: `NONGJAJAE`) 추가 → `nongjajae` VIEWER 부여
   - [ ] 시험 직원 로그인 → 홈에 *농자재 유통 시스템* + 공개 사이트·채널 표시, 미연결 항목은 회색 "미연결"·링크 없음, 관리 탭 없음
   - [ ] 카드 클릭 → **새 탭**으로 앱 진입 (앱 자체 Access 로그인 확인)
   - [ ] ADMIN 이 해당 부여 **회수** → 직원이 새로고침하면 즉시 카드 사라짐 (재로그인 없이)
   - [ ] ADMIN 이 직원 **정지** → 직원 화면 403 "계정이 정지…"
   - [ ] 관리 화면 감사기록에 `user_create`·`group_snapshot_replace`·`grant_create`·`grant_revoke`·`user_status_change` 순서로 남음 → **무결성 점검 = 정상**
   - [ ] `/api/admin/users` 를 직원 계정으로 호출 → 403, 다른 Origin 에서 POST → 403
   - [ ] 시스템 상태: 5~10분 뒤 점검 시각 갱신(가용성 Cron */5), 요약 숫자 = 목록 상태
   - [ ] 로그아웃(`/cdn-cgi/access/logout`) 후 재접속 → 로그인 화면
   - [ ] (BREAKGLASS 계정 보유 시) 로그인 1회 → 감사 `breakglass_login` 1건

### 4.1 Cron 계획과 계정 한도

현재 `wrangler.jsonc` 의 `triggers.crons` = `["*/5 * * * *", "*/15 * * * *"]`.

| 상태 | 주기 | 내용 |
|---|---|---|
| 적용됨 | `*/5 * * * *` | 앱 가용성 점검 (`uptime_state`) → 이어서 내부 KPI 갱신 (`kpi_cache`) |
| 적용됨 | `*/15 * * * *` | Cloudflare API 로 Access 그룹 사본 자동 동기화 (`sync_state`·`group_sync_state` 갱신) |
| 적용됨(기본 꺼짐) | `0 * * * *` | 외부 토큰 갱신 (`tokens`·`token_lease`·`token_refresh_journal`, 응답 유실 = REFRESH_UNKNOWN) |
| Phase 2 | KPI별 | `kpi_def` 기준 수집 → `kpi_cache` |
| Phase 2 | 매일 | 감사 체인 머리 해시를 외부(별도 저장소)에 고정 기록 |
| Phase 3 | KST 08:30 / UZT 09:00 | P2 요약 알림 (`notify_dedup`), 가용성 DOWN 즉시 알림 |

**계정 Cron 합계** — Workers Free 한도는 계정당 5개다(R1 §5 기준). 현재 사용: 허브 3개(`*/5`, `*/15`, `0 * * * *`) + 기존 BAND→Slack 브리지 1개 = **4개**. 남은 여유 1개. R1 계획의 `25 23 * * *`(T-DAY)는 아직 넣지 않았다. Cron 을 늘릴 때 이 표를 함께 갱신한다.

---

### 4.2 외부 토큰 갱신을 켜기 전 조건 (WP3)

`TOKEN_REFRESH_ENABLED` 기본값은 `"false"` 다. **아래가 모두 끝나기 전에는 켜지 않는다.**

1. cafe24 개발자센터 **앱 등록**과 몰 ID 확인 (지금은 `<MALL_ID>` 자리표시자)
2. 쇼핑몰 관리자 브라우저로 **최초 인증(동의)** — 로그인 없이 코드를 받을 방법은 없다(R2 §1.1)
3. `src/tokens/providers.ts` 의 cafe24 어댑터에 실제 주소를 넣는다 (지금은 호출하면 `provider_not_configured` 로 끝난다)
4. 암호화 키: `openssl rand -base64 32` → `npx wrangler secret put TOKEN_KEY_V1 --env=""` (설정 파일에 넣지 않는다). 키 값은 별첨 S 에 보관
5. 토큰 첫 행을 넣을 때 **`tokens` 와 `token_lease` 를 같은 batch 로** 만든다(`createTokenStmts`). 실행권 행이 없으면 갱신이 영원히 돌지 않는다
6. **G02**(원격 D1 의 batch·조건부 UPDATE 동작)와 **박선기 대표 승인**
7. `wrangler.jsonc` 의 `TOKEN_REFRESH_ENABLED` 를 `"true"` 로 바꾸고 배포 → 관리 화면 *연동 토큰* 에서 상태 확인

**충돌·확인 불가 상태는 자동으로 풀리지 않는다.** 마지막 선기록이 `conflict`·`unknown` 이거나 실행권이 끝난 `in_progress` 면
다음 실행이 아예 시작하지 않는다(새 토큰을 덮어쓰지 않기 위해서다). 해제는 **관리자 재인증**(최초 인증과 같은 동의 절차) 뒤에만 가능하며,
**재인증 기능은 이번 범위 밖**이다 — 그 상태가 되면 선기록의 암호문을 근거로 사람이 복구 절차를 밟는다.

### 4.3 CCTV 보기를 켜기 전 조건 (R3 1단계)

`CCTV_ENABLED` 기본값은 `"false"` 다. **아래가 모두 끝나기 전에는 켜지 않는다.**

허브는 카메라에 직접 붙지 않는다. 구조는 이렇다:

```
[카메라] --RTSP(같은 사내망)--> [중계 PC] --Cloudflare Tunnel--> [허브 Worker] --같은 출처--> [브라우저]
                                   └ 카메라 계정·비밀번호는 여기에만 있다
```

**중계 PC 는 카메라와 같은 사내망(같은 공유기) 안에 있어야 한다.** Tapo 의 RTSP 는 같은 망에서만 열린다.
보는 사람은 어디에 있어도 된다 — 허브를 거치기 때문이다. 시설이 여러 곳이면 **시설마다 중계 PC 1대씩** 필요하다.

#### 4.3.1 중계 PC 에 할 일 (카메라가 있는 시설에서)

1. **Tapo 앱에서 카메라 계정 만들기**
   Tapo 앱 → 카메라 → 설정 → 고급 설정 → 카메라 계정. **Tapo 로그인과 별개의 아이디·비밀번호**다.
   만들고 나면 RTSP 주소는 `rtsp://아이디:비밀번호@카메라IP:554/stream1` (고화질) · `/stream2` (저화질).
   카메라 IP 는 공유기 관리 화면이나 Tapo 앱에서 확인한다. **공유기에서 IP 를 고정**해 두는 것이 좋다(재부팅 때 바뀌면 끊긴다).

2. **중계 프로그램 설치 — go2rtc** (무료·공개)
   내려받기: <https://github.com/AlexxIT/go2rtc/releases> 의 `go2rtc_win64.zip` (Windows 10 이상 64비트).
   압축을 풀고 같은 폴더에 `go2rtc.yaml` 을 만든다:

   ```yaml
   api:
     listen: "127.0.0.1:1984"   # 바깥에 직접 열지 않는다. 터널만 통과시킨다.

   streams:
     cheonan-gate:  # 허브에 등록할 이름과 같게 맞추면 헷갈리지 않는다
       - rtsp://<카메라아이디>:<카메라비밀번호>@192.168.0.101:554/stream1
     icheon-vfarm:
       - rtsp://<카메라아이디>:<카메라비밀번호>@192.168.0.102:554/stream2
   ```

   `go2rtc.exe` 를 실행하고 <http://127.0.0.1:1984/> 에서 영상이 보이는지 먼저 확인한다.
   여기서 안 보이면 그 다음 단계는 의미가 없다 — 카메라 계정·IP·같은 망인지부터 다시 본다.

   go2rtc 가 내보내는 주소가 곧 허브에 넣을 **경로**다:

   | 재생 방식 | 경로 | 형식 |
   |---|---|---|
   | `mp4` (실시간 영상) | `/api/stream.mp4?src=cheonan-gate` | `video/mp4` |
   | `snapshot` (사진) | `/api/frame.jpeg?src=cheonan-gate` | `image/jpeg` |

   허브는 이 두 형식만 받는다. 다른 형식이 오면 502 로 막는다.

3. **PC 가 꺼지지 않게 한다**
   제어판 → 전원 옵션 → 절전 **안 함**, 하드디스크 끄기 **안 함**. 화면만 꺼지는 것은 괜찮다.
   PC 를 끄면 경영진 화면도 같이 꺼진다.

4. **Cloudflare Tunnel 로 내보내기**
   `cloudflared` 를 설치하고(<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>)
   Cloudflare Zero Trust 에서 터널을 만든 뒤, 공개 호스트 이름을 `http://127.0.0.1:1984` 로 연결한다.
   **공유기 포트포워딩은 하지 않는다** — 터널은 밖에서 들어오는 문을 열지 않는다.

5. **아무나 못 보게 잠그기** — 둘 중 하나를 고른다

   | 방법 | 설정 | 허브 쪽 |
   |---|---|---|
   | **Cloudflare Access 서비스 토큰** (권장) | Zero Trust → Access → 그 호스트에 정책을 걸고 서비스 토큰 발급 | `CCTV_RELAY_AUTH="cf-access"` + Secret `CCTV_RELAY_CF_ID`·`CCTV_RELAY_CF_SECRET` |
   | go2rtc 자체 인증 | `go2rtc.yaml` 의 `api:` 에 `username`·`password` 추가 | `CCTV_RELAY_AUTH="basic"` + Secret `CCTV_RELAY_USER`·`CCTV_RELAY_PASS` |

   권장 쪽이 나은 이유: Cloudflare 가 **가장자리에서 먼저 막아** 중계 PC 까지 요청이 오지 않는다.

   **`CCTV_RELAY_AUTH` 를 정해 놓고 짝이 되는 값이 없으면 허브는 재생을 거부한다** —
   조용히 아무 것도 안 밝히고 부르면, 중계 서버가 열려 있을 때 그대로 통과해 버리기 때문이다.

#### 4.3.2 허브 쪽에 할 일

1. Secret 등록 (설정 파일에 넣지 않는다):
   ```bash
   npx wrangler secret put CCTV_RELAY_CF_ID --env=""
   npx wrangler secret put CCTV_RELAY_CF_SECRET --env=""
   ```
2. `wrangler.jsonc` 에서
   - `CCTV_RELAY_ORIGIN` → 4.3.1-4 에서 만든 **터널 호스트 주소**(`https://...`)
   - `CCTV_RELAY_AUTH` → `"cf-access"` 또는 `"basic"`
   **자리표시자 `<CCTV_RELAY_ORIGIN>` 그대로면 꺼진 것과 같게 동작한다.**
3. 배포 후 관리 화면(또는 `POST /api/admin/cctv`)에서 카메라를 등록한다. **경로만 넣는다**:
   ```json
   { "camera_id": "tashkent-akis-1", "name_ko": "타슈켄트 AKIS 1번", "site": "타슈켄트",
     "stream_kind": "mp4", "stream_path": "/api/stream.mp4?src=tashkent-akis-1" }
   ```
4. `CCTV_ENABLED` 를 `"true"` 로 바꾸고 배포 → *CCTV* 화면에서 확인

#### 4.3.3 해외 구간(우즈베키스탄↔한국)에서 주의할 것

| 항목 | 내용 |
|---|---|
| **업로드 속도** | 영상은 현지 회선의 **업로드**로 나간다. 1080p 실시간은 카메라 1대당 대략 2~4 Mbps 가 필요하다. 회선이 좁으면 `stream2`(저화질) 를 쓰거나 `snapshot` 방식으로 바꾼다 `[재확인 필요]` |
| **동시 시청** | 허브가 사람마다 따로 중계 서버에 요청한다. 여러 명이 동시에 보면 업로드도 그만큼 늘어난다 |
| **지연** | 진행형 MP4 는 보통 수 초 지연된다. 실시간 관제용이 아니라 **상황 확인용**으로 보아야 한다 `[재확인 필요]` |
| **정전·회선 단절** | 중계 PC 나 현지 회선이 끊기면 화면은 `502` 로 뜬다. 허브가 끊긴 것을 "정상" 으로 표시하지는 않는다 |

#### 4.3.4 그 밖에 남은 것

- **노무·법무 검토**: 직원이 찍히는 화면을 상시 열람하는 형태가 되면 근로자 감시 문제가 생길 수 있다.
  기술적으로는 열람 기록(`cctv_view_open` 감사기록)과 ADMIN 제한이 들어가 있으나, 한국·우즈베키스탄 법령 판단은 이 문서 범위 밖이다. `[재확인 필요]`
- **G11**(실제 중계 서버·카메라 연결, 영상 재생, 대역폭·CPU)과 **박선기 대표 승인**

**안 켜면 아무 일도 없다.** 꺼져 있거나 주소가 자리표시자면 카메라는 전부 "볼 수 없음" 으로 표시되고,
영상 요청은 `409` 로 끝난다(중계 서버를 부르지도 않는다).

> 위 프로그램 이름·주소는 2026-09-19 웹 검색으로 확인했다. **내려받기 전에 공식 저장소 주소가 맞는지 다시 확인한다.** `[재확인 필요]`

---

## 5. 알려진 한계

- **외부 데이터 연동 없음**: 실제 값이 나오는 KPI는 ONE 내부 3개(`SYS.UPTIME` · `SYS.KPI_STALE_COUNT` · `SYS.PHASE0`)뿐이다. 농자재·견적·cafe24 등 외부 소스는 어댑터 인터페이스와 **가짜 소스 왕복 시험**까지만 있고, `wrangler.jsonc`에 서비스 바인딩을 넣지 않았다(G03 이후).
- **`SYS.UPTIME`은 "현재 상태"만**: R4 §1.6의 24시간 가용률은 `uptime_state`에 이력이 없어 만들지 않았다(이력 표도 만들지 않음). 화면에는 현재 DOWN 앱 수만 나온다.
- **`SYS.P1_UNACKED` · `SYS.TOKEN_EXPIRY` · `SYS.TLS_EXPIRY`는 "준비 중"** 카드다(값 null + `NOT_IMPLEMENTED`). `SYS.TOKEN_EXPIRY`는 WP3에서 값과 연결된다.
- **KPI 조회는 감사 체인에 남기지 않는다**: 조회마다 해시 체인에 쓰면 경합·용량이 커지고 감사 보존 기간이 아직 결정되지 않았다. 대신 `kpi_read` 구조화 로그(`actor_email`·`request_id`·KPI ID)만 남긴다 — R4 §2.1 ⑥과 다른 점이며 **보류** 항목이다.
- **영업일 달력 없음**: `T-OPS`·`T-DAY`·`T-BANK` 등급은 R4에서 영업일 달력을 함께 보지만 지금은 경과 시간만 본다. 이번에 쓰는 KPI는 전부 `T-SYS`라 영향이 없다.
- **토큰 갱신은 가짜 서버로만 시험했다**: 실제 cafe24 호출은 하지 않는다(몰 ID 미확인·앱 등록 전). 어댑터의 `call()` 은 지금 `provider_not_configured` 로 끝난다.
- **④ 저장과 journal `applied` 를 한 batch 로 묶는 조건부 SQL** 은 로컬 `node:sqlite` 에서만 확인했다. 원격 D1 batch 에서 앞 문장의 결과를 뒤 문장이 보는지는 **G02 운영 검증 대기**다.
- **토큰 등록 API 는 만들지 않았다**: 평문 토큰을 HTTP 로 받는 경로를 열지 않기 위해서다. 첫 행은 배포 담당자가 SQL·스크립트로 넣는다.
- **번들 크기**: 사전 컴파일 검사기(약 259 KiB) 때문에 137 KiB → 590 KiB(gzip 90 KiB)로 늘었다. Workers 한도는 비압축 64 MiB(양 플랜 동일, 공식 문서 2026-09-17 확인)라 여유가 크다. Free 플랜 CPU 10 ms/요청은 조회 경로(캐시 읽기)만 타므로 문제되지 않으나, Cron의 봉투 검증 6건에 대한 실제 CPU 사용량은 **운영 검증 대기**다.
- **CCTV 는 중계 서버가 있어야 동작한다**: 허브는 RTSP 를 다루지 않는다. 중계 서버가 없으면 카메라는 전부 "볼 수 없음" 이다. 실제 중계 서버·카메라 연결은 **G11 운영 검증 대기**.
- **CCTV 재생 방식은 `mp4`·`snapshot` 둘뿐이다**: HLS·WebRTC 는 넣지 않았다. HLS 는 조각 파일마다 전달 경로가 필요하고, WebRTC 는 Worker 가 중계할 수 없다. 모르는 방식은 저장도 재생도 거부한다.
- **영상 화면은 한국어만 있다**: FIRMMIT 요청(경영진 전용). 우즈베크어·러시아어로 보아도 이 화면만 한국어로 나온다.
- **브라우저 재생은 실제 H.264 영상으로 확인하지 못했다**: 시험 환경에서 H.264 로 인코딩할 수 없어, 사진(JPEG) 방식만 브라우저에서 실제로 띄워 확인했다. 영상 방식은 **G11 운영 검증 대기**. `[재확인 필요]`
- **알림 OFF**: 가용성 변화는 감사기록에만 남고 발송 코드는 없다(Phase 3).
- **그룹 자동 동기화는 로컬 시험까지만 확인**: 실제 Cloudflare Access API 응답 모양(특히 `result_info` 유무, `require` 규칙의 실제 형태)은 **운영 검증 대기(G01)**. 공식 문서(2026-09-17 확인)에 맞춘 가짜 서버로만 왕복 시험했다. `email_list` 규칙은 목록 조회 API 를 확인하지 않아 **지원하지 않고 실패 처리**한다 `[재확인 필요]`.
- 자동 동기화는 **이메일 규칙만** 해석한다. Access 쪽에서 그룹 규칙을 도메인·Everyone 등으로 바꾸면 그 시점부터 동기화가 계속 실패하고(사본은 유지) 30분 뒤 비ADMIN 쓰기가 막힌다 — 관리 화면의 실패 사유를 보고 되돌려야 한다.
- **운영 검증 대기**: 실제 Access JWT·JWKS(G01), 원격 D1 의 트리거·batch·`json_valid` 동작(G02) 은 로컬(node:sqlite, 로컬 RSA 키)에서만 확인했다.
- 감사 체인은 **꼬리 삭제**(마지막 행들 제거)를 체인만으로는 감지하지 못한다 → 외부 앵커 필요. D1 관리 권한자는 트리거를 DROP 할 수 있다(그 뒤의 변조는 verify 가 감지).
- 부트스트랩 SQL(첫 ADMIN) 은 감사 체인 밖이다.
- 직원 상태 변경이 동시에 두 번 일어나면 감사의 `from` 값이 실제와 다를 수 있다(드묾).
- 가용성 판정은 2xx·3xx·401·403 을 정상으로 본다(Access 보호 앱은 로그인 화면만 살아 있어도 UP). 점검 대상은 앱 주소 자체 9개.
- `run_worker_first` 밖(정적 자산)의 보안 헤더는 `public/_headers` 에 의존한다. UI 시험은 Node 로컬 서버에서 `_headers` 를 흉내 내 확인했고, `wrangler dev`·실제 Workers 에서의 적용은 재확인 필요.
- 운영에서 `DEV_FAKE_IDENTITY` 오설정 시 Worker 요청(API)은 500 이지만, 정적 SPA 파일은 Worker 를 거치지 않아 계속 제공된다(데이터 없음).
- 스마트스토어·퍼밋프레시 주소, 카카오 봇·Tapo CCTV·BAND→Slack 브리지 연결은 미확인이므로 "미연결"로만 표시한다(추정 주소 금지).
