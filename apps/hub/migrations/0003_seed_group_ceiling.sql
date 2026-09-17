-- 그룹별 역할 상한 기본값 (정책). 사용자·관리자는 만들지 않음 (기본 0명).
-- 상한 행이 없는 (그룹, 앱) 조합의 부여 역할은 무시됨 (fail-closed).
INSERT INTO group_ceiling (group_name, app_id, max_role) VALUES
 ('ADMIN',        '*',                'ADMIN'),
 ('BREAKGLASS',   '*',                'ADMIN'),
 ('NONGJAJAE',    'nongjajae',        'MANAGER'),
 ('CONSTRUCTION', 'quote-backoffice', 'MANAGER'),
 ('RND',          'icheon-vfarm',     'MANAGER'),
 ('UZ',           'amim',             'MANAGER');
