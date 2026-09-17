// 런처 앱 목록과 보기 권한
import type { Principal } from './authz';
import { hasRole } from './authz';
import type { Role } from './env';

export type AppKind = 'staff_app' | 'public_site' | 'admin_console' | 'channel';
export type AppStatus = 'active' | 'legacy' | 'not_connected';

export interface AppRow {
  app_id: string;
  name_ko: string;
  name_uz: string;
  name_ru: string;
  url: string | null;
  kind: AppKind;
  required_group: string | null;
  status: AppStatus;
  sort: number;
  health_url: string | null;
}

export interface LauncherItem {
  app_id: string;
  kind: AppKind;
  status: AppStatus;
  name: { ko: string; uz: string; ru: string };
  url: string | null;
  role: Role | null;
}

export async function listApps(db: D1Database): Promise<AppRow[]> {
  const res = await db
    .prepare(
      'SELECT app_id, name_ko, name_uz, name_ru, url, kind, required_group, status, sort, health_url FROM app_registry ORDER BY sort ASC, app_id ASC',
    )
    .all<AppRow>();
  return res.results ?? [];
}

// 보기 권한: 공개 사이트·채널은 모두, 업무 앱은 그룹+역할, 관리 콘솔은 그룹+(역할 또는 허브 ADMIN)
export function canSeeApp(app: AppRow, p: Principal): boolean {
  switch (app.kind) {
    case 'public_site':
    case 'channel':
      return true;
    case 'staff_app':
      return inRequiredGroup(app, p) && hasRole(p, app.app_id, 'VIEWER');
    case 'admin_console':
      return inRequiredGroup(app, p) && (hasRole(p, app.app_id, 'VIEWER') || p.isHubAdmin);
    default:
      return false;
  }
}

function inRequiredGroup(app: AppRow, p: Principal): boolean {
  return app.required_group === null || p.groups.includes(app.required_group);
}

export function safeUrl(app: AppRow): string | null {
  if (app.status === 'not_connected' || app.url === null) return null;
  return app.url.startsWith('https://') ? app.url : null;
}

export function toLauncherItem(app: AppRow, p: Principal): LauncherItem {
  return {
    app_id: app.app_id,
    kind: app.kind,
    status: app.status,
    name: { ko: app.name_ko, uz: app.name_uz, ru: app.name_ru },
    url: safeUrl(app),
    role: p.roles.get(app.app_id)?.role ?? null,
  };
}
