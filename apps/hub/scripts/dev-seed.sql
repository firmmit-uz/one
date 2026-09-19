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

-- R3 CCTV 화면 확인용 (로컬 전용). 실제 카메라가 아니며 중계 서버도 없다.
-- 켜려면 wrangler.jsonc env.development 에 CCTV_ENABLED / CCTV_RELAY_ORIGIN 을 넣는다.
INSERT INTO cctv_cameras (camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at)
VALUES
 ('cheonan-gate', '천안 정문',   '천안', 'mp4',      '/live/cheonan-gate.mp4', 'active',        10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('icheon-vfarm', '이천 재배동', '이천', 'snapshot', '/snapshot/icheon.jpg',   'active',        20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('nonsan-apc',   '논산 APC',    '논산', 'mp4',      NULL,                      'not_connected', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
