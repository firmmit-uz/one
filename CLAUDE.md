# CLAUDE.md — FIRMMIT ONE 저장소 규칙

전체 인수인계는 저장소 바깥의 `../HANDOFF.md`에 있다. **작업 전에 반드시 끝까지 읽는다.**
설계 근거는 `../참고자료/`에 있다 (저장소에 복사·커밋 금지).

## 이번 작업 범위
Phase 1.5 (WP1 그룹 동기화 · WP2 KPI 게이트웨이 + 공통 ID 검사기 · WP3 토큰 갱신 모듈) + WP4 TV 쇼룸(`apps/showroom`).
**로컬 제작·시험까지만.** Phase 2 이후 기능과 알림 발송은 만들지 않는다.
하위 앱(농자재·견적 등)에 값을 쓰는 기능은 금지. 허브 자체의 ADMIN 관리 입력은 기존 관리 API 규칙(ADMIN 확인·CSRF·입력 검증·변경+감사 한 batch)을 따르면 허용.

## 절대 금지
- 계정 로그인·배포·원격 변경: `wrangler login` · `wrangler deploy`(`--dry-run` 제외) · `wrangler d1 … --remote` · `wrangler secret put` · `wrangler dev --remote`
- 실제 외부 API 호출 (cafe24 · 네이버 · Cloudflare API · Google · Slack · Telegram · 카카오) — 가짜 서버·fixture만
- 비밀값·실제 계정 ID·직원 실명과 이메일을 코드·로그·커밋·캡처에 넣기 (`<...>` 자리표시자, 시험 이메일은 `@example.invalid`)
- 기존 마이그레이션 `0001`–`0003` 수정. 새 번호는 고정: `0004` WP1 · `0005` WP2 · `0006` WP3
- 인증·권한·CSRF·감사 트리거·보안 헤더 약화, 기존 시험 삭제·완화
- 확인 안 된 주소를 추정해서 넣기, 미연결을 "연결됨"으로 표시
- 직원 허브와 TV 쇼룸 사이에 코드·데이터·세션·D1 공유
- 허브에서 `@firmmit-one/contracts` 기존 진입점(`src/index.mjs`) import — `node:fs`와 Ajv 런타임 컴파일(`new Function`) 때문에 Worker에서 실패. Worker용 진입점 + 사전 컴파일본만 사용. `nodejs_compat`으로 우회 금지
- 커밋·푸시 (FIRMMIT가 요청할 때만)

## 배포 조건 (이 저장소 작업자는 배포하지 않음)
런북 v2.2 게이트 G1 V0–V13 **14개 전부 통과 + 박선기 대표 승인** 뒤 FIRMMIT 직원이 직접 배포.

## 기준 시험 (작업 뒤 시험 수·검출 수가 줄면 실패)
아래 숫자는 **2026-09-20 에 직접 돌려 나온 값**이다 (R3 CCTV 반영분 포함).
괄호 안은 인수인계서 §5 기준선. **둘 중 어느 쪽보다도 줄면 실패**로 본다.

```bash
export WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false
npm ci                                # Node 22.13 이상
npm test -w packages/contracts        # 85건(정상20·거부65) 불일치 0 · 변이 60/60 · 의미 17/17 · Worker 17/17 · ID 21/21
npm test -w apps/hub                  # 12파일 · 294/294        (기준선 11파일 · 247/247)
npm run typecheck -w apps/hub         # 오류 0
npm run test:mutation -w apps/hub     # 38/38 검출 · 미검출 0    (기준선 27/27)
npm run test:bundle -w apps/hub       # 9/9 · 금지 구문 0건
npm run build:dry -w apps/hub         # 약 617.9 KiB            (기준선 약 605.9 KiB — 배포 아님, 크기는 기록만)
npm run test:ui -w apps/hub           # 화면 17장 + 흐름 2 · 콘솔 오류 0  (기준선 14장 + 흐름 1) (Python Playwright 필요)
npm test -w apps/showroom             # 38/38
npm run test:ui -w apps/showroom      # 27/27 · 캡처 7장 · 외부 요청 0건
```
- `test/headers.test.ts`의 `wrangler.jsonc` 정확 비교(vars·crons)는 Cron·변수를 추가할 때 **새 값으로 정확히** 갱신 (부분 비교로 완화 금지, 변경표에 기록).
- 작업공간·의존성 추가 시에만 `npm install` 1회 → 잠금 파일 함께 전달. 마지막엔 새 사본에서 `npm ci` 통과.
- 변이 시험은 `apps/hub` 안 파일만 복사해 돌린다 → 새 시험은 hub 밖 상대경로·`dist` 의존 금지. 변이가 찾는 문자열을 지우면 `mutation.mjs`도 함께 수정.

## 코드 원칙
- fail-closed: 설정 누락·자리표시자·알 수 없는 값 → 거부. null ≠ 0.
- D1 변경 + 감사기록은 한 batch. 감사기록은 추가 전용. KPI 조회는 감사 체인에 넣지 않고 구조화 로그만.
- 문자열로 비교하는 시각은 `YYYY-MM-DDTHH:MM:SS.sssZ` 한 형식만.
- 새 방어 코드마다 시험 + 변이 시험 추가.
- 확인 못 한 외부 사실은 `[재확인 필요]` 표시, 확인한 사실은 공식 문서 주소·날짜 기록.

## 화면 규칙
- 로고 `logo.svg` 우측 상단. 색: `#3365FF` `#2A7FFA` `#F25555` `#292C34` `#9898A0`
- `#F25555`·`#2A7FFA` 위에 흰 글자 금지, `#F25555`는 흰 배경에서 아이콘 전용, `#9898A0` 글자 금지(보조 글자 `#6B6F7A`)
- 허브 언어 `ko` · `uz-Latn` · `ru`. `Firmmit`/`FIRMMIT`은 번역·음역 금지
  - 예외: **CCTV 화면(R3)과 그 오류 문구는 한국어만** — FIRMMIT 지시(2026-09-19 "언어는 한국어로만, 우리 경영진만 볼꺼야"). `t()`·`errorText()`가 `ko`로 되돌린다
- 상태 표시는 아이콘 + 글자 + 색. WCAG 2.2 AA 목표

## 완료 보고
한국어 · 핵심만 · 표 우선. 변경표 v2.3(상태 4종: 수정함 / 재시험 통과 / 운영 검증 대기 / 보류) + 시험 결과 전후 비교 + 해시 + 남은 운영 검증(G01–G10) + `[재확인 필요]` 목록 → ZIP 1개.
