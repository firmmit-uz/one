-- R3 CCTV 1단계: 허브 화면에서 사내 CCTV 영상 보기 (ADMIN 전용)
--
-- 구조상 중요한 점 — 허브는 카메라에 직접 붙지 않는다.
--   [카메라] --RTSP(사내망)--> [중계 서버] --HTTP--> [허브 Worker] --같은 출처--> [브라우저]
--   RTSP 주소·카메라 계정·비밀번호는 **중계 서버에만** 있고 이 표·허브·브라우저에 들어오지 않는다.
--
-- 이 표에는 중계 서버 **안에서의 경로만** 둔다. 서버 주소(origin)는 설정값 CCTV_RELAY_ORIGIN 에 있다.
--   → 관리자가 임의의 주소를 넣어 허브가 엉뚱한 곳으로 요청하게 만들 수 없다.
--
-- 이번 단계는 실제 중계 서버 없이 만들고 시험한다(가짜 서버 전용). 켜기 전 조건은 README 에 있다.

CREATE TABLE cctv_cameras (
  camera_id   TEXT    NOT NULL PRIMARY KEY
              CHECK (length(camera_id) BETWEEN 2 AND 64
                     AND camera_id NOT GLOB '*[^a-z0-9-]*'),
  -- 화면 이름은 한국어만 둔다 (이 화면은 ADMIN 전용이고 한국어로만 본다).
  name_ko     TEXT    NOT NULL CHECK (length(trim(name_ko)) BETWEEN 1 AND 100),
  -- 시설 이름 (서울·천안·이천·논산·보성·양평·타슈켄트 등). 자유 입력.
  site        TEXT    NOT NULL CHECK (length(trim(site)) BETWEEN 1 AND 64),
  -- 재생 방식
  --   mp4      : 중계 서버가 내보내는 진행형 MP4 — 브라우저가 라이브러리 없이 바로 재생
  --   snapshot : 사진 1장을 주기적으로 다시 받음 — 대역폭이 좁거나 재생이 안 될 때
  -- 목록에 없는 값은 앱에서도 거부한다(이중 방어가 아니라, 표 제약은 저장을 막고 앱은 출력을 막는다).
  stream_kind TEXT    NOT NULL CHECK (stream_kind IN ('mp4', 'snapshot')),
  -- 중계 서버 안에서의 경로. 반드시 '/' 로 시작한다. 주소·계정은 넣지 않는다.
  stream_path TEXT    CHECK (stream_path IS NULL
                             OR (substr(stream_path, 1, 1) = '/'
                                 AND substr(stream_path, 1, 2) <> '//'
                                 AND length(stream_path) <= 200
                                 AND stream_path NOT LIKE '%..%')),
  status      TEXT    NOT NULL CHECK (status IN ('active', 'not_connected')),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  -- 미연결이면 경로가 없어야 하고, 연결이면 경로가 있어야 한다 (null ≠ 0 과 같은 원칙)
  CHECK ((status = 'not_connected' AND stream_path IS NULL)
      OR (status = 'active'        AND stream_path IS NOT NULL))
);

CREATE INDEX cctv_cameras_sort_idx ON cctv_cameras(sort, camera_id);

-- 시드 행을 넣지 않는다.
--   실제 카메라 이름·경로를 확인하지 못했고, 확인 안 된 값을 추정해서 넣지 않는다.
--   카메라는 관리 화면에서 ADMIN 이 등록한다 (변경 + 감사기록 한 batch).
