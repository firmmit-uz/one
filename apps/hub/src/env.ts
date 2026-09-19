// 환경 변수·바인딩 정의
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  ALLOWED_ORIGIN?: string;
  DEV_FAKE_IDENTITY?: string;
  // WP1 그룹 동기화: 계정 ID 는 vars(자리표시자), API 토큰은 Worker Secret(읽기 전용 권한만)
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  // WP3 토큰 갱신: 기본 꺼짐("true" 외의 값은 모두 꺼짐). 암호화 키는 Worker Secret.
  TOKEN_REFRESH_ENABLED?: string;
  TOKEN_KEY_V1?: string;
  // R3 CCTV: 기본 꺼짐("true" 외의 값은 모두 꺼짐).
  // 중계 서버 주소는 vars(자리표시자), 접속표는 Worker Secret. 카메라 계정은 허브에 두지 않는다.
  CCTV_ENABLED?: string;
  CCTV_RELAY_ORIGIN?: string;
  // 중계 서버에 자신을 밝히는 방법: none | basic | cf-access (vars)
  CCTV_RELAY_AUTH?: string;
  // 아래 4개는 전부 Worker Secret — 설정 파일에 넣지 않는다
  CCTV_RELAY_USER?: string;
  CCTV_RELAY_PASS?: string;
  CCTV_RELAY_CF_ID?: string;
  CCTV_RELAY_CF_SECRET?: string;
}

export const ROLES = ['VIEWER', 'OPERATOR', 'MANAGER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

// 역할 순위 (모르는 값은 -1)
export function roleRank(role: unknown): number {
  return typeof role === 'string' ? (ROLES as readonly string[]).indexOf(role) : -1;
}

export function isRole(v: unknown): v is Role {
  return roleRank(v) >= 0;
}

export const HUB_APP_ID = 'hub';
export const BREAKGLASS_GROUP = 'BREAKGLASS';
export const GROUP_SYNC_KEY = 'access_groups';
export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
