# FIRMMIT ONE (허브 v1 · Phase 1)

FIRMMIT 사내 앱을 한곳에서 여는 직원 허브와, 앞으로 쓸 KPI 계약 검사 모듈입니다.

| 경로 | 내용 |
|---|---|
| `apps/hub` | Cloudflare Worker(Hono) + 정적 화면. Access 로그인 검증, D1 권한, 새 탭 앱 런처, 시스템 상태, 감사기록(추가 전용·해시 체인), 관리 화면 |
| `packages/contracts` | KPI 요약 봉투 스키마 v1.2 + 원문·의미 검사기, 시험 85개·변이 60개 |

## 시험

```bash
npm install
npm test --workspaces
node apps/hub/test/mutation.mjs
```

## 배포

**런북 v2.2의 게이트 G1(V0–V13) 전부 통과 + 박선기 대표 승인 후에만** 진행합니다.
절차는 `apps/hub/README.md` 4장(배포 안내서)을 따르며, 로그인·배포는 FIRMMIT 담당자가 직접 합니다.
저장소에는 실제 계정 ID·비밀값을 넣지 않습니다(`wrangler.jsonc`는 자리표시자).

## 범위 밖(Phase 1)

데이터 연동(KPI), 알림 발송, Access 그룹 자동 동기화(Phase 1.5), TV 쇼룸(별도 산출물).
