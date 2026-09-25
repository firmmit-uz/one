-- R3 CCTV 2단계: 열람 세션
--
-- 왜 필요한가
--   "영상을 열면 열람 기록이 남는다" 는 약속이 지금까지는 **화면의 호출 순서**(먼저 /open, 그다음 /play)에만
--   기대고 있었다. 주소를 직접 치거나 <img> 에 걸면 /play 만 불려 감사기록 없이 영상이 나갔다.
--   이제 /open 이 감사기록과 **같은 batch** 로 열람 토큰을 남기고, /play 는 그 토큰이 있어야만 연다.
--
-- 토큰은 서버가 만든 무작위 UUID 이고, 카메라·사람·만료 시각에 묶인다. 주소·경로·접속표는 넣지 않는다.
-- 만료된 행은 다음 /open 때 같은 batch 에서 지운다.

CREATE TABLE cctv_view_sessions (
  token       TEXT NOT NULL PRIMARY KEY CHECK (length(token) = 36),
  camera_id   TEXT NOT NULL REFERENCES cctv_cameras(camera_id) ON DELETE CASCADE,
  actor_email TEXT NOT NULL CHECK (length(actor_email) BETWEEN 3 AND 254),
  -- 시각은 YYYY-MM-DDTHH:MM:SS.sssZ 한 형식만 쓴다 (문자열 비교가 곧 시간 비교)
  opened_at   TEXT NOT NULL CHECK (length(opened_at) = 24),
  expires_at  TEXT NOT NULL CHECK (length(expires_at) = 24 AND expires_at > opened_at)
);

CREATE INDEX cctv_view_sessions_expires_idx ON cctv_view_sessions(expires_at);
