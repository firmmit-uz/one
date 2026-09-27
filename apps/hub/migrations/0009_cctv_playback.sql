-- R3 CCTV 3단계: 녹화 다시보기 (FIRMMIT 지시 2026-09-27, #13)
--
-- 허브는 녹화를 저장하지 않는다. 중계 PC 의 녹화기(Frigate 등)가 가진 구간 클립을
-- 실시간과 같은 방법(같은 출처 전달·열람 토큰·감사기록)으로 내보낼 뿐이다.
--
-- playback_path : 중계 서버 안의 구간 클립 경로 **틀**. `{from}` `{to}` 자리에 허브가
--                 유닉스 초(정수)를 넣는다. 예) /api/akis-gh1/start/{from}/end/{to}/clip.mp4
--                 NULL 이면 이 카메라는 다시보기가 없다 (실시간과 따로 켠다).
-- clip_from/to  : 열람 토큰이 실시간용인지(둘 다 NULL) 구간용인지(둘 다 있음) 구분한다.
--                 구간용 토큰은 그 구간에만 통하고, 실시간 /play 에는 통하지 않는다.

ALTER TABLE cctv_cameras ADD COLUMN playback_path TEXT
  CHECK (playback_path IS NULL
         OR (substr(playback_path, 1, 1) = '/'
             AND substr(playback_path, 1, 2) <> '//'
             AND length(playback_path) <= 200
             AND playback_path NOT LIKE '%..%'
             AND instr(playback_path, '{from}') > 0
             AND instr(playback_path, '{to}') > 0));

-- 시각은 YYYY-MM-DDTHH:MM:SS.sssZ 한 형식만 (문자열 비교가 곧 시간 비교)
ALTER TABLE cctv_view_sessions ADD COLUMN clip_from TEXT
  CHECK (clip_from IS NULL OR length(clip_from) = 24);
ALTER TABLE cctv_view_sessions ADD COLUMN clip_to TEXT
  CHECK (clip_to IS NULL OR (clip_from IS NOT NULL AND length(clip_to) = 24 AND clip_to > clip_from));
