// 허브 ADMIN 관문 — 관리 API 와 CCTV API 가 **같은 판정**을 쓴다 (서버가 최종 판정).
// 화면이 탭을 숨기는 것과 별개로 여기서 막는다.
import type { MiddlewareHandler } from 'hono';
import type { HubEnv } from './app';
import { jsonError } from './http';

export const requireHubAdmin: MiddlewareHandler<HubEnv> = async (c, next) => {
  if (!c.get('principal').isHubAdmin) return jsonError(c, 403, 'forbidden', 'Administrator role required');
  await next();
};
