-- WP1: Access 그룹 사본 자동 동기화 상태
-- sync_state 는 "마지막 성공"만 담는다(기존 쓰기 제한 규칙이 그 값을 본다).
-- 이 표는 시도·실패 사유를 따로 담아, 실패해도 사본과 sync_state 를 건드리지 않게 한다.

CREATE TABLE group_sync_state (
  key                  TEXT    NOT NULL PRIMARY KEY CHECK (key = 'access_groups'),
  -- 시각은 전부 YYYY-MM-DDTHH:MM:SS.sssZ (24자) 한 형식만
  last_attempt_at      TEXT    NOT NULL CHECK (typeof(last_attempt_at) = 'text' AND length(last_attempt_at) = 24
                                               AND substr(last_attempt_at, 24, 1) = 'Z'),
  last_outcome         TEXT    NOT NULL CHECK (last_outcome IN ('success','failure')),
  last_failure_code    TEXT    CHECK (last_failure_code IS NULL
                                      OR (typeof(last_failure_code) = 'text' AND length(last_failure_code) BETWEEN 1 AND 64)),
  last_failure_at      TEXT    CHECK (last_failure_at IS NULL
                                      OR (typeof(last_failure_at) = 'text' AND length(last_failure_at) = 24
                                          AND substr(last_failure_at, 24, 1) = 'Z')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (typeof(consecutive_failures) = 'integer' AND consecutive_failures >= 0),
  -- group_sync_stale 감사기록을 남긴 시각. 성공하면 NULL 로 되돌려 다음 지연 때 다시 1건만 남긴다.
  stale_audited_at     TEXT    CHECK (stale_audited_at IS NULL
                                      OR (typeof(stale_audited_at) = 'text' AND length(stale_audited_at) = 24
                                          AND substr(stale_audited_at, 24, 1) = 'Z')),
  -- 성공 = 실패 사유 없음 (NULL 함정을 피하려고 양쪽을 NOT NULL 값으로 비교)
  CHECK ((last_outcome = 'success') = (last_failure_code IS NULL)),
  CHECK ((last_failure_code IS NULL) = (last_failure_at IS NULL)),
  CHECK ((last_outcome = 'success') = (consecutive_failures = 0))
);
