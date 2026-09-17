import type { Env } from './env';

export type ConfigCheck = { ok: true; mode: 'production' | 'development' } | { ok: false; reason: string };

// 시작 설정 점검: 운영에서 개발용 우회 변수가 있으면 전부 거부
export function checkConfig(env: Env): ConfigCheck {
  const mode = env.ENVIRONMENT;
  if (mode !== 'production' && mode !== 'development') {
    return { ok: false, reason: 'invalid_environment' };
  }
  if (mode !== 'development' && env.DEV_FAKE_IDENTITY !== undefined) {
    return { ok: false, reason: 'dev_identity_in_production' };
  }
  return { ok: true, mode };
}
