// Worker 진입점: /api/* 는 Hono, 나머지는 Static Assets
import { createApp } from './app';
import { checkConfig } from './config';
import type { Env } from './env';
import { GROUP_SYNC_CRON, runGroupSync } from './groupsync';
import { runUptimeChecks } from './uptime';

const app = createApp();

export const UPTIME_CRON = '*/5 * * * *';

/** Cron 값으로 작업을 나눈다. 모르는 값은 경고만 남기고 아무것도 하지 않는다. */
export function cronJob(cron: string): 'uptime' | 'group_sync' | null {
  if (cron === UPTIME_CRON) return 'uptime';
  if (cron === GROUP_SYNC_CRON) return 'group_sync';
  return null;
}

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),

  async scheduled(controller, env, ctx) {
    const cfg = checkConfig(env);
    if (!cfg.ok) {
      console.error('config_error', cfg.reason);
      return;
    }
    const job = cronJob(controller.cron);
    if (job === null) {
      console.warn('unknown_cron', controller.cron);
      return;
    }
    const deps = { fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => new Date() };
    if (job === 'uptime') {
      ctx.waitUntil(
        runUptimeChecks(env.DB, deps).then(
          (r) => console.log('uptime_done', JSON.stringify(r)),
          (e: unknown) => console.error('uptime_failed', e instanceof Error ? e.name : 'unknown'),
        ),
      );
      return;
    }
    ctx.waitUntil(
      runGroupSync(env.DB, env, deps).then(
        (r) => console.log('group_sync_done', JSON.stringify(r)),
        (e: unknown) => console.error('group_sync_failed', e instanceof Error ? e.name : 'unknown'),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
