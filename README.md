# FIRMMIT ONE (허브 v1 · Phase 1.5 + TV 쇼룸)

FIRMMIT 사내 앱을 한곳에서 여는 **직원 허브**, KPI 계약 검사 모듈, 그리고 사내 TV 에 띄우는 **방문객용 쇼룸**입니다.

| 경로 | 내용 |
|---|---|
| `apps/hub` | Cloudflare Worker(Hono) + 정적 화면. Access 로그인 검증, D1 권한, 새 탭 앱 런처, 시스템 상태, 감사기록(추가 전용·해시 체인), 관리 화면, **Access 그룹 자동 동기화**, **KPI 게이트웨이**, **외부 토큰 갱신(기본 꺼짐)** |
| `packages/contracts` | KPI 요약 봉투 스키마 v1.2 + 원문·의미 검사기(Node·Workers 두 진입점), 공통 ID 검사기 |
| `apps/showroom` | TV 쇼룸(`fm-one-showroom`). **허브와 배포·데이터·세션 완전 분리.** 지금 콘텐츠는 승인 전 샘플 |

## 시험

```bash
npm install
export WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false

npm test -w packages/contracts      # 사례 85건 · 변이 60개 · 의미 17 · Worker 진입점 17 · 공통 ID 21
npm test -w apps/hub                # vitest
npm run typecheck -w apps/hub
npm run test:mutation -w apps/hub   # 변이 시험
npm run test:bundle -w apps/hub     # 번들에 eval·new Function·node: 없음
npm run test:ui -w apps/hub         # 화면 캡처 (Python Playwright 필요)

npm test -w apps/showroom           # 콘텐츠 검사 + 규칙 시험
npm run test:ui -w apps/showroom    # 화면·조작·오프라인·QR (Playwright + opencv-python-headless)
```

## 문서

| 문서 | 내용 |
|---|---|
| `docs/FIRMMIT_ONE_인수인계_클로드코드_2026-09-18.md` | **작업을 이어받는 사람이 먼저 읽는다** — 첫 30분·금지 사항·기준 시험 숫자·함정 모음 |
| `docs/FIRMMIT_ONE_변경표_v2.3_2026-09-17.md` | Z01–Z36 변경 내역 · 시험 결과 · 해시 · 남은 운영 검증 · FIRMMIT 에 물을 것 |
| `docs/FIRMMIT_ONE_GPT리뷰_핸드오프_2026-09-17.md` | 외부 코드 리뷰 요청서 — 의심 지점 8건 · 제출 형식 |

## 배포

**런북 v2.2의 게이트 G1(V0–V13) 전부 통과 + 박선기 대표 승인 후에만** 진행합니다.
절차는 `apps/hub/README.md` 4장(배포 안내서), 쇼룸은 `apps/showroom/README.md` 4장을 따르며,
로그인·배포는 FIRMMIT 담당자가 직접 합니다.
저장소에는 실제 계정 ID·비밀값을 넣지 않습니다(`wrangler.jsonc`는 자리표시자, 비밀값은 Worker Secret).

## 범위 밖

- 외부 데이터 연동(농자재·견적·cafe24 등 실제 소스) — 어댑터 인터페이스와 가짜 소스 왕복 시험까지만 (G03 이후)
- 알림 발송(Slack·Telegram·메일) — Phase 3
- 하위 앱에 값을 쓰는 기능 — Phase 4
- 실제 cafe24 토큰 갱신 — 몰 ID 미확인·앱 등록 전 (가짜 서버로만 시험)
- CCTV(R3) · DNS 이전 · 대시보드 확장
