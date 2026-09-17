-- WP2: KPI 게이트웨이 (수직 슬라이스)
-- 기존 표 kpi_def · kpi_cache 는 0001 에서 만들어 두었고 여기서 처음 쓴다.
-- 이번에 실제 값을 내는 것은 ONE 내부 KPI 3개뿐이다. 외부 소스 연결은 G03 이후.

-- KPI 열람 권한: (KPI, Access 그룹) → 볼 수 있는 수준
--   summary = 요약값만, detail = 세부(breakdown) 포함
-- 행이 없는 조합은 "볼 수 없음" 이고, 응답에서 그 KPI 를 아예 뺀다(권한 없음 카드도 만들지 않음).
CREATE TABLE kpi_visibility (
  kpi_id     TEXT NOT NULL CHECK (length(kpi_id) BETWEEN 3 AND 45),
  group_name TEXT NOT NULL CHECK (length(trim(group_name)) > 0),
  level      TEXT NOT NULL CHECK (level IN ('summary','detail')),
  PRIMARY KEY (kpi_id, group_name)
);

-- Phase 0 게이트 G1 체크리스트 (런북 v2.2 V0–V13, 14개). ADMIN 이 손으로 입력한다.
-- 증적 칸에는 주소·비밀값을 넣지 않는다("별첨 S-6 7행" 같은 참조만) — 앱에서 입력 검증한다.
CREATE TABLE phase0_checklist (
  item_id      TEXT    NOT NULL PRIMARY KEY CHECK (item_id GLOB 'V[0-9]' OR item_id GLOB 'V[0-9][0-9]'),
  sort         INTEGER NOT NULL CHECK (typeof(sort) = 'integer' AND sort >= 0),
  title_ko     TEXT    NOT NULL CHECK (length(trim(title_ko)) > 0),
  state        TEXT    NOT NULL CHECK (state IN ('pending','passed','failed','na')),
  evidence_ref TEXT    CHECK (evidence_ref IS NULL
                              OR (typeof(evidence_ref) = 'text' AND length(trim(evidence_ref)) BETWEEN 1 AND 200)),
  updated_at   TEXT    CHECK (updated_at IS NULL
                              OR (typeof(updated_at) = 'text' AND length(updated_at) = 24 AND substr(updated_at, 24, 1) = 'Z')),
  updated_by   TEXT    CHECK (updated_by IS NULL OR length(trim(updated_by)) > 0),
  CHECK ((updated_at IS NULL) = (updated_by IS NULL))
);

-- 항목 이름은 apps/hub/README.md §4 "게이트 G1" 과 같은 문구를 쓴다.
INSERT INTO phase0_checklist (item_id, sort, title_ko, state) VALUES
 ('V0',  0,  '도메인 만료 2027년 이후',                          'pending'),
 ('V1',  1,  'OTP 메일 수신',                                    'pending'),
 ('V2',  2,  '로그인 안 한 창에서 이천의 모든 주소 차단',        'pending'),
 ('V3',  3,  '개인 회사 계정 OTP 로그인',                        'pending'),
 ('V4',  4,  '로그아웃 30초 후 재차단',                          'pending'),
 ('V5',  5,  '명단 밖 이메일 주소 차단',                         'pending'),
 ('V6',  6,  'Google 로그인 성공 + 같은 주소 OTP 거부',          'pending'),
 ('V7',  7,  '대상 시트 제한됨 · 웹 게시 없음',                  'pending'),
 ('V8',  8,  '구 GAS 토큰 없이 거부',                            'pending'),
 ('V9',  9,  '신규 GAS 정상 · 공개 코드 비노출',                 'pending'),
 ('V10', 10, '공개됐던 자격증명 8건 교체',                       'pending'),
 ('V11', 11, '구버전 · preview · 해시 주소 · FINO 문서 차단',    'pending'),
 ('V12', 12, '복구 중에도 경계 유지',                            'pending'),
 ('V13', 13, '파생 노출 교체 (별첨 S-6 7행 + B1 교차확인)',      'pending');

-- ONE 내부 KPI 정의 (전부 등급 T-SYS · 판정 주체 one)
-- 신선도 기준은 등급에서 계산한다(R4 §1.0). T-SYS = 15분.
INSERT INTO kpi_def (system, kpi_id, definition_version, name_ko, unit, tier, clock_basis, verdict_source, definition_note, created_at) VALUES
 ('one', 'SYS.UPTIME',          '1.0', '앱 가용성',        'count', 'T-SYS', 'updated_at', 'one',
  '현재 DOWN 상태인 점검 대상 앱 수. 점검 대상 = app_registry 에 health_url 이 있고 미연결이 아닌 앱. R4 §1.6의 "24시간 가용률"은 이력 표가 없어 이번 범위 밖(준비 중).',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('one', 'SYS.KPI_STALE_COUNT', '1.0', '지연 KPI 수',      'count', 'T-SYS', 'updated_at', 'one',
  'kpi_cache 에서 display_status 가 stale 또는 error 인 KPI 수. breakdown 은 열람 그룹별 수.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('one', 'SYS.PHASE0',          '1.0', 'Phase 0 게이트',   'count', 'T-SYS', 'updated_at', 'one',
  '런북 v2.2 게이트 G1 V0–V13(14개) 중 통과 수. ADMIN 수기 입력이며 미시험 항목은 통과로 세지 않는다.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('one', 'SYS.P1_UNACKED',      '1.0', '미확인 P1 알림',   'count', 'T-SYS', 'updated_at', 'one',
  '준비 중 — 알림센터(Phase 3)가 생긴 뒤에 값이 나온다.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('one', 'SYS.TOKEN_EXPIRY',    '1.0', '연동 토큰 만료',   'count', 'T-SYS', 'updated_at', 'one',
  '준비 중 — WP3 토큰 갱신 모듈이 켜진 뒤에 값이 나온다.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('one', 'SYS.TLS_EXPIRY',      '1.0', '인증서 만료',      'count', 'T-SYS', 'updated_at', 'one',
  '준비 중 — TLS 점검은 이번 범위 밖.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 열람 권한 (R4 §1.6). ALL = 직원 전체 그룹, ADMIN = 허브 관리자 그룹.
INSERT INTO kpi_visibility (kpi_id, group_name, level) VALUES
 ('SYS.UPTIME',          'ALL',        'summary'),
 ('SYS.UPTIME',          'ADMIN',      'detail'),
 ('SYS.UPTIME',          'BREAKGLASS', 'detail'),
 ('SYS.KPI_STALE_COUNT', 'ALL',        'summary'),
 ('SYS.KPI_STALE_COUNT', 'ADMIN',      'detail'),
 ('SYS.KPI_STALE_COUNT', 'BREAKGLASS', 'detail'),
 ('SYS.PHASE0',          'ADMIN',      'detail'),
 ('SYS.PHASE0',          'BREAKGLASS', 'detail'),
 ('SYS.P1_UNACKED',      'ADMIN',      'detail'),
 ('SYS.TOKEN_EXPIRY',    'ADMIN',      'detail'),
 ('SYS.TLS_EXPIRY',      'ADMIN',      'detail');
