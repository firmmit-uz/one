-- 로컬 개발 전용 시드 (운영 D1 에 적용 금지)
-- 사용: npx wrangler d1 execute fm-one-hub-dev --local --env development --file scripts/dev-seed.sql
-- 가짜 신원 dev-admin@example.invalid 은 wrangler.jsonc env.development.DEV_FAKE_IDENTITY 와 같아야 함
INSERT INTO users (email, emp_id, display_name, status, created_at)
VALUES ('dev-admin@example.invalid', NULL, '개발 관리자', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO access_group_snapshot (group_name, email, synced_at)
VALUES ('ADMIN', 'dev-admin@example.invalid', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO role_grants (email, app_id, role, scope, expires_at, granted_by, granted_at)
VALUES ('dev-admin@example.invalid', 'hub', 'ADMIN', '*', NULL, 'dev-seed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 30분이 지나면 '오래됨' 표시 (ADMIN 은 계속 쓰기 가능). 다시 실행하거나 관리 화면에서 사본 저장.
INSERT INTO sync_state (key, last_success_at)
VALUES ('access_groups', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET last_success_at = excluded.last_success_at;
