-- WP3: 외부 토큰 갱신 모듈 (R2 §1.4)
-- 표 tokens · token_lease · token_refresh_journal 은 0001 에서 만들어 두었고 여기서 처음 쓴다.
-- 이번에는 실제 외부 연결을 하지 않는다(가짜 서버 전용). 켜기 전 조건은 README 에 있다.

-- 선기록(journal)에 필요한 열 두 개를 더한다.
--   key_version : 어느 키 세대로 암호화했는지 (키를 바꿔도 예전 선기록을 풀 수 있어야 한다)
--   lease_until : 그 시도가 쥐고 있던 실행권의 만료 시각
--                 → "실행권이 끝났는데도 in_progress" = 실행이 중간에 죽은 것 → 다음 실행 차단
ALTER TABLE token_refresh_journal ADD COLUMN key_version INTEGER;
ALTER TABLE token_refresh_journal ADD COLUMN lease_until TEXT;

-- 토큰을 마지막으로 바꾼 선기록 id.
--   ④ 저장과 journal applied 를 한 batch 로 묶을 때 "우리가 쓴 그 행" 인지 가리는 데 쓴다.
--   version 이나 시각만으로는 그 사이 다른 실행이 쓴 것과 구분할 수 없다.
ALTER TABLE tokens ADD COLUMN last_refresh_journal_id INTEGER;

-- 토큰별 마지막 선기록을 빨리 찾기 위한 색인 (차단 규칙이 매번 본다)
CREATE INDEX token_refresh_journal_token_idx ON token_refresh_journal(token_id, id);

-- 참고: SQLite 는 ALTER TABLE 로 CHECK 를 더할 수 없다.
--   key_version >= 1, lease_until 은 YYYY-MM-DDTHH:MM:SS.sssZ(24자) — 앱에서 지키고 시험으로 막는다.
