// 권한 판정: 매 요청 D1 에서 캐시 없이 조회
import {
  BREAKGLASS_GROUP,
  GROUP_SYNC_KEY,
  HUB_APP_ID,
  SNAPSHOT_MAX_AGE_MS,
  roleRank,
  ROLES,
  type Role,
} from './env';

export interface GrantRow {
  id: number;
  email: string;
  app_id: string;
  role: string;
  scope: string;
  expires_at: string | null;
  granted_by: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface CeilingRow {
  group_name: string;
  app_id: string;
  max_role: string;
}

export interface EffectiveRole {
  app_id: string;
  role: Role;
  scopes: string[];
}

export interface Principal {
  email: string;
  displayName: string;
  empId: string | null;
  groups: string[];
  snapshotSyncedAt: string | null;
  snapshotStale: boolean;
  roles: Map<string, EffectiveRole>;
  isHubAdmin: boolean;
  isBreakglass: boolean;
}

export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; code: 'not_registered' | 'account_inactive' | 'no_access_group' };

export type GrantState = 'active' | 'revoked' | 'expired' | 'over_ceiling';

// 부여 1건의 현재 상태 (fail-closed: 날짜 해석 실패 = 만료)
export function grantState(g: GrantRow, ceilings: CeilingRow[], userGroups: Set<string>, now: Date): GrantState {
  if (g.revoked_at !== null) return 'revoked';
  if (g.expires_at !== null) {
    const exp = Date.parse(g.expires_at);
    if (!Number.isFinite(exp) || exp <= now.getTime()) return 'expired';
  }
  const rank = roleRank(g.role);
  if (rank < 0) return 'over_ceiling';
  let ceiling = -1;
  for (const c of ceilings) {
    if (!userGroups.has(c.group_name)) continue;
    if (c.app_id !== g.app_id && c.app_id !== '*') continue;
    ceiling = Math.max(ceiling, roleRank(c.max_role));
  }
  // 상한 초과(또는 상한 없음) 역할은 무시
  if (rank > ceiling) return 'over_ceiling';
  return 'active';
}

export function computeRoles(
  grants: GrantRow[],
  ceilings: CeilingRow[],
  userGroups: Set<string>,
  now: Date,
): Map<string, EffectiveRole> {
  const roles = new Map<string, EffectiveRole>();
  for (const g of grants) {
    if (grantState(g, ceilings, userGroups, now) !== 'active') continue;
    const role = g.role as Role;
    const cur = roles.get(g.app_id);
    if (!cur || roleRank(role) > roleRank(cur.role)) {
      roles.set(g.app_id, { app_id: g.app_id, role, scopes: [g.scope] });
    } else if (cur.role === role && !cur.scopes.includes(g.scope)) {
      cur.scopes.push(g.scope);
    }
  }
  return roles;
}

export function isSnapshotStale(lastSuccessAt: string | null, now: Date): boolean {
  if (lastSuccessAt === null) return true;
  const t = Date.parse(lastSuccessAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > SNAPSHOT_MAX_AGE_MS;
}

export async function loadPrincipal(db: D1Database, email: string, now: Date): Promise<PrincipalResult> {
  const [userRes, groupRes, syncRes, grantRes, ceilRes] = await db.batch([
    db.prepare('SELECT email, emp_id, display_name, status FROM users WHERE email = ?').bind(email),
    db.prepare('SELECT group_name FROM access_group_snapshot WHERE email = ? ORDER BY group_name').bind(email),
    db.prepare('SELECT last_success_at FROM sync_state WHERE key = ?').bind(GROUP_SYNC_KEY),
    db
      .prepare(
        'SELECT id, email, app_id, role, scope, expires_at, granted_by, granted_at, revoked_at, revoked_by FROM role_grants WHERE email = ? AND revoked_at IS NULL',
      )
      .bind(email),
    db
      .prepare(
        'SELECT gc.group_name, gc.app_id, gc.max_role FROM group_ceiling gc JOIN access_group_snapshot s ON s.group_name = gc.group_name WHERE s.email = ?',
      )
      .bind(email),
  ]);

  const user = (userRes?.results?.[0] ?? null) as
    | { email: string; emp_id: string | null; display_name: string; status: string }
    | null;
  if (!user) return { ok: false, code: 'not_registered' };
  if (user.status !== 'active') return { ok: false, code: 'account_inactive' };

  const groups = ((groupRes?.results ?? []) as { group_name: string }[]).map((r) => r.group_name);
  if (groups.length === 0) return { ok: false, code: 'no_access_group' };

  const sync = (syncRes?.results?.[0] ?? null) as { last_success_at: string } | null;
  const snapshotSyncedAt = sync?.last_success_at ?? null;
  const groupSet = new Set(groups);
  const roles = computeRoles(
    (grantRes?.results ?? []) as unknown as GrantRow[],
    (ceilRes?.results ?? []) as unknown as CeilingRow[],
    groupSet,
    now,
  );

  return {
    ok: true,
    principal: {
      email: user.email,
      displayName: user.display_name,
      empId: user.emp_id,
      groups,
      snapshotSyncedAt,
      snapshotStale: isSnapshotStale(snapshotSyncedAt, now),
      roles,
      isHubAdmin: roles.get(HUB_APP_ID)?.role === 'ADMIN',
      isBreakglass: groupSet.has(BREAKGLASS_GROUP),
    },
  };
}

// 쓰기 허용: 그룹 사본이 신선하거나, 허브 ADMIN
export function canWrite(p: Principal): boolean {
  return !p.snapshotStale || p.isHubAdmin;
}

export function hasRole(p: Principal, appId: string, min: Role): boolean {
  const r = p.roles.get(appId);
  return !!r && roleRank(r.role) >= roleRank(min);
}

export { ROLES };
