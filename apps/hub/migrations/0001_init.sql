-- FIRMMIT ONE 허브 v1 초기 스키마 (D1 / SQLite)
-- 원칙: NOT NULL + CHECK 로 NULL 함정 차단, 감사기록은 추가만 허용.

-- 앱 목록 (런처)
CREATE TABLE app_registry (
  app_id         TEXT    NOT NULL PRIMARY KEY
                 CHECK (length(app_id) BETWEEN 2 AND 64
                        AND app_id NOT GLOB '*[^a-z0-9-]*'
                        AND app_id NOT IN ('hub')),
  name_ko        TEXT    NOT NULL CHECK (length(trim(name_ko)) > 0),
  name_uz        TEXT    NOT NULL CHECK (length(trim(name_uz)) > 0),
  name_ru        TEXT    NOT NULL CHECK (length(trim(name_ru)) > 0),
  url            TEXT    CHECK (url IS NULL OR substr(url, 1, 8) = 'https://'),
  kind           TEXT    NOT NULL CHECK (kind IN ('staff_app','public_site','admin_console','channel')),
  required_group TEXT    CHECK (required_group IS NULL OR length(trim(required_group)) > 0),
  status         TEXT    NOT NULL CHECK (status IN ('active','legacy','not_connected')),
  sort           INTEGER NOT NULL DEFAULT 0,
  health_url     TEXT    CHECK (health_url IS NULL OR substr(health_url, 1, 8) = 'https://'),
  -- 미연결 항목은 주소·점검주소 없음, 연결 항목은 주소 필수
  CHECK ((status = 'not_connected' AND url IS NULL AND health_url IS NULL)
      OR (status IN ('active','legacy') AND url IS NOT NULL))
);

-- 직원
CREATE TABLE users (
  email        TEXT NOT NULL PRIMARY KEY
               CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1),
  emp_id       TEXT CHECK (emp_id IS NULL OR length(trim(emp_id)) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  status       TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX users_emp_id_uq ON users(emp_id) WHERE emp_id IS NOT NULL;

-- 직원 기록은 삭제하지 않음 (상태만 변경)
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'users_no_delete'); END;
CREATE TRIGGER users_email_immutable BEFORE UPDATE OF email ON users
WHEN NEW.email IS NOT OLD.email
BEGIN SELECT RAISE(ABORT, 'users_email_immutable'); END;

-- 역할 부여 (app_id = 'hub' 는 허브 자체 권한)
CREATE TABLE role_grants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL REFERENCES users(email) ON UPDATE RESTRICT ON DELETE RESTRICT,
  app_id     TEXT NOT NULL CHECK (length(app_id) BETWEEN 2 AND 64 AND app_id <> '*'),
  role       TEXT NOT NULL CHECK (role IN ('VIEWER','OPERATOR','MANAGER','ADMIN')),
  scope      TEXT NOT NULL DEFAULT '*' CHECK (length(scope) BETWEEN 1 AND 64),
  expires_at TEXT,
  granted_by TEXT NOT NULL CHECK (length(granted_by) > 0),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE INDEX role_grants_email_idx ON role_grants(email);

-- 부여 기록은 삭제 금지, 변경은 '회수 1회'만 허용
CREATE TRIGGER role_grants_no_delete BEFORE DELETE ON role_grants
BEGIN SELECT RAISE(ABORT, 'role_grants_append_only'); END;
CREATE TRIGGER role_grants_revoke_only BEFORE UPDATE ON role_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.email IS NOT OLD.email
  OR NEW.app_id IS NOT OLD.app_id
  OR NEW.role IS NOT OLD.role
  OR NEW.scope IS NOT OLD.scope
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.granted_at IS NOT OLD.granted_at
BEGIN SELECT RAISE(ABORT, 'role_grants_revoke_only'); END;

-- Cloudflare Access 그룹 사본
CREATE TABLE access_group_snapshot (
  group_name TEXT NOT NULL CHECK (length(trim(group_name)) > 0),
  email      TEXT NOT NULL CHECK (email = lower(email) AND instr(email, '@') > 1),
  synced_at  TEXT NOT NULL,
  PRIMARY KEY (group_name, email)
);
CREATE INDEX access_group_snapshot_email_idx ON access_group_snapshot(email);

CREATE TABLE sync_state (
  key             TEXT NOT NULL PRIMARY KEY,
  last_success_at TEXT NOT NULL
);

-- 그룹별 역할 상한 (app_id = '*' 는 전체, 'hub' 는 허브)
CREATE TABLE group_ceiling (
  group_name TEXT NOT NULL CHECK (length(trim(group_name)) > 0),
  app_id     TEXT NOT NULL CHECK (length(app_id) >= 1),
  max_role   TEXT NOT NULL CHECK (max_role IN ('VIEWER','OPERATOR','MANAGER','ADMIN')),
  PRIMARY KEY (group_name, app_id)
);

-- 감사기록 (추가 전용 + 해시 체인; 해시는 앱에서 계산)
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  actor_email TEXT NOT NULL CHECK (length(actor_email) > 0),
  action      TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  target      TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  request_id  TEXT NOT NULL,
  prev_hash   TEXT NOT NULL CHECK (length(prev_hash) = 64),
  row_hash    TEXT NOT NULL UNIQUE CHECK (length(row_hash) = 64)
);
CREATE INDEX audit_log_action_actor_idx ON audit_log(action, actor_email, target);

-- MUTATION:TRIGGER-BEGIN
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log_append_only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log_append_only'); END;

-- INSERT OR REPLACE 는 DELETE 트리거를 부르지 않으므로 충돌 자체를 먼저 차단
CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM audit_log WHERE row_hash = NEW.row_hash)
BEGIN SELECT RAISE(ABORT, 'audit_log_append_only'); END;
-- MUTATION:TRIGGER-END

-- 체인 머리 확인: prev_hash 는 반드시 마지막 행의 row_hash (동시 쓰기 충돌 감지)
CREATE TRIGGER audit_log_chain_head BEFORE INSERT ON audit_log
WHEN NEW.prev_hash IS NOT COALESCE(
  (SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1),
  '0000000000000000000000000000000000000000000000000000000000000000')
BEGIN SELECT RAISE(ABORT, 'audit_chain_conflict'); END;

-- 가용성 상태
CREATE TABLE uptime_state (
  app_id               TEXT    NOT NULL PRIMARY KEY REFERENCES app_registry(app_id),
  state                TEXT    NOT NULL CHECK (state IN ('UP','DOWN','UNKNOWN')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_checked_at      TEXT,
  last_change_at       TEXT,
  last_status_code     INTEGER CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599)
);

-- ===== 향후용 (Phase 1 에서는 비어 있음) =====
CREATE TABLE kpi_def (
  system             TEXT NOT NULL CHECK (length(system) > 0),
  kpi_id             TEXT NOT NULL CHECK (length(kpi_id) > 0),
  definition_version TEXT NOT NULL CHECK (definition_version GLOB '[0-9]*.[0-9]*'),
  name_ko            TEXT NOT NULL,
  unit               TEXT NOT NULL,
  tier               TEXT NOT NULL CHECK (tier IN ('T-RT','T-OPS','T-DAY','T-BANK','T-WEEK','T-MONTH','T-REF','T-SYS')),
  clock_basis        TEXT NOT NULL CHECK (clock_basis IN ('updated_at','data_as_of')),
  verdict_source     TEXT NOT NULL CHECK (verdict_source IN ('one','freshness_build')),
  definition_note    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (system, kpi_id, definition_version)
);

-- 키: system + kpi_id + definition_version + scope_key (R4 §2.3 규칙 6)
CREATE TABLE kpi_cache (
  system             TEXT NOT NULL,
  kpi_id             TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  scope_key          TEXT NOT NULL CHECK (length(scope_key) > 0),
  value_json         TEXT NOT NULL CHECK (json_valid(value_json)),
  status             TEXT NOT NULL CHECK (status IN ('ok','stale','partial','error','unavailable')),
  data_as_of         TEXT,
  updated_at         TEXT NOT NULL,
  fetched_at         TEXT NOT NULL,
  last_success_at    TEXT,
  PRIMARY KEY (system, kpi_id, definition_version, scope_key),
  FOREIGN KEY (system, kpi_id, definition_version) REFERENCES kpi_def(system, kpi_id, definition_version)
);

CREATE TABLE notify_dedup (
  dedup_key     TEXT    NOT NULL PRIMARY KEY,
  channel       TEXT    NOT NULL,
  first_sent_at TEXT    NOT NULL,
  last_sent_at  TEXT    NOT NULL,
  send_count    INTEGER NOT NULL DEFAULT 1 CHECK (send_count >= 1)
);

-- 외부 토큰: 암호문만 저장 (평문 금지). version = 동시 갱신 충돌 검사용(R2 §1.4 ④), key_version = 암호화 키 세대
CREATE TABLE tokens (
  token_id    TEXT    NOT NULL PRIMARY KEY,
  provider    TEXT    NOT NULL,
  account_ref TEXT    NOT NULL,
  ciphertext  BLOB    NOT NULL,
  iv          BLOB    NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  expires_at  TEXT,
  updated_at  TEXT    NOT NULL
);

-- 갱신 실행권 (R2 §1.4 ①②⑥)
CREATE TABLE token_lease (
  token_id    TEXT NOT NULL PRIMARY KEY REFERENCES tokens(token_id),
  holder      TEXT NOT NULL,
  lease_until TEXT NOT NULL
);

-- 갱신 선기록 (R2 §1.4 ③⑤): 응답을 받자마자 암호문으로 먼저 기록
CREATE TABLE token_refresh_journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id    TEXT NOT NULL REFERENCES tokens(token_id),
  holder      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('in_progress','applied','conflict','failed','unknown')),
  ciphertext  BLOB,
  iv          BLOB,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  CHECK ((ciphertext IS NULL) = (iv IS NULL))
);
