import { describe, expect, it } from 'vitest';
import { computeRoles, grantState, isSnapshotStale, type CeilingRow, type GrantRow } from '../src/authz';
import { ADMIN, ADMIN2, count, harness, json, NOW, NOW_SEC, ORIGIN, seedOrg, seedUser, setSynced, STAFF } from './helpers';

const newUser = { email: 'new.person@example.test', display_name: '신규' };

describe('권한: 기본값', () => {
  it('마이그레이션 직후 사용자 0명·부여 0건·관리자 없음 → 누구든 403', async () => {
    const h = await harness();
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM users')).toBe(0);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM role_grants')).toBe(0);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM access_group_snapshot')).toBe(0);
    const res = await h.call('/api/admin/users', { token: await h.token('anyone@example.test') });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('not_registered');
    expect((await h.call('/api/me', { token: await h.token('anyone@example.test') })).status).toBe(403);
  });

  it('등록되지 않은 사용자 → 403 not_registered', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const res = await h.call('/api/apps', { token: await h.token('stranger@example.test') });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('not_registered');
  });
});

describe('권한: 계정 상태', () => {
  for (const status of ['suspended', 'revoked']) {
    it(`${status} → 403 (관리자 권한이 있어도)`, async () => {
      const h = await harness();
      seedOrg(h.sqlite);
      seedUser(h.sqlite, { email: 'x@example.test', status, groups: ['ADMIN'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
      for (const p of ['/api/me', '/api/apps', '/api/status', '/api/admin/users']) {
        const res = await h.call(p, { token: await h.token('x@example.test') });
        expect(res.status).toBe(403);
        expect((await json(res)).error.code).toBe('account_inactive');
      }
    });
  }
});

describe('권한: 부여 만료·회수', () => {
  it('만료된 부여는 무시', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, {
      email: 'exp@example.test',
      groups: ['ADMIN'],
      grants: [
        { app_id: 'hub', role: 'ADMIN', expires_at: new Date(NOW.getTime() - 1000).toISOString() },
        { app_id: 'nongjajae', role: 'VIEWER', expires_at: new Date(NOW.getTime() + 3600_000).toISOString() },
      ],
    });
    const t = await h.token('exp@example.test');
    expect((await h.call('/api/admin/users', { token: t })).status).toBe(403);
    const me = await json(await h.call('/api/me', { token: t }));
    expect(me.is_admin).toBe(false);
    expect(me.roles).toEqual([{ app_id: 'nongjajae', role: 'VIEWER', scopes: ['*'] }]);
    // 시계를 넘기면 두 번째 부여도 만료
    h.clock.now = new Date(NOW.getTime() + 3600_000);
    setSynced(h.sqlite, h.clock.now);
    const t2 = await h.token('exp@example.test', {}, { iat: NOW_SEC + 3500, exp: NOW_SEC + 7200 });
    expect((await json(await h.call('/api/me', { token: t2 }))).roles).toEqual([]);
  });

  it('회수된 부여는 무시', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'rv@example.test', groups: ['ADMIN'], grants: [{ app_id: 'hub', role: 'ADMIN', revoked: true }] });
    expect((await h.call('/api/admin/users', { token: await h.token('rv@example.test') })).status).toBe(403);
  });

  it('회수 직후 같은 JWT 로 즉시 거부 (캐시 없음)', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const victimToken = await h.token(ADMIN2);
    expect((await h.call('/api/admin/users', { token: victimToken })).status).toBe(200);
    const grantId = count(h.sqlite, "SELECT id FROM role_grants WHERE email = ? AND app_id = 'hub'", ADMIN2);
    const rv = await h.call(`/api/admin/grants/${grantId}/revoke`, { token: await h.token(ADMIN), body: { reason: 'test' } });
    expect(rv.status).toBe(200);
    const after = await h.call('/api/admin/users', { token: victimToken });
    expect(after.status).toBe(403);
    expect((await json(after)).error.code).toBe('forbidden');
  });

  it('계정 정지 직후 같은 JWT 로 즉시 거부', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const staffToken = await h.token(STAFF);
    expect((await h.call('/api/apps', { token: staffToken })).status).toBe(200);
    const res = await h.call(`/api/admin/users/${encodeURIComponent(STAFF)}/status`, {
      token: await h.token(ADMIN),
      body: { status: 'suspended' },
    });
    expect(res.status).toBe(200);
    expect((await h.call('/api/apps', { token: staffToken })).status).toBe(403);
  });
});

describe('권한: Access 그룹 사본', () => {
  it('사본의 어느 그룹에도 없음 → 403 no_access_group', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'nogroup@example.test', groups: [], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
    const res = await h.call('/api/me', { token: await h.token('nogroup@example.test') });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('no_access_group');
  });

  it('사본에서 빠지면 같은 JWT 로 즉시 거부', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const t = await h.token(STAFF);
    expect((await h.call('/api/me', { token: t })).status).toBe(200);
    h.sqlite.prepare('DELETE FROM access_group_snapshot WHERE email = ?').run(STAFF);
    expect((await h.call('/api/me', { token: t })).status).toBe(403);
  });

  it('사본 30분 초과 → 비ADMIN 쓰기 거부, ADMIN 쓰기 허용, 읽기는 허용', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    // 비ADMIN 이지만 허브 MANAGER 인 사용자 (상한 표에 hub MANAGER 추가)
    h.sqlite.prepare("INSERT INTO group_ceiling (group_name, app_id, max_role) VALUES ('OPS', 'hub', 'MANAGER')").run();
    seedUser(h.sqlite, { email: 'mgr@example.test', groups: ['OPS'], grants: [{ app_id: 'hub', role: 'MANAGER' }] });
    const mgr = await h.token('mgr@example.test');
    const adm = await h.token(ADMIN);

    // 신선: 비ADMIN 쓰기는 역할 부족으로 forbidden
    let res = await h.call('/api/admin/users', { token: mgr, body: newUser });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('forbidden');

    // 31분 경과
    setSynced(h.sqlite, new Date(NOW.getTime() - 31 * 60_000));
    res = await h.call('/api/admin/users', { token: mgr, body: newUser });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('group_snapshot_stale');
    expect((await h.call('/api/me', { token: mgr })).status).toBe(200);
    const me = await json(await h.call('/api/me', { token: mgr }));
    expect(me.snapshot.stale).toBe(true);

    res = await h.call('/api/admin/users', { token: adm, body: newUser });
    expect(res.status).toBe(201);

    // 정확히 30분은 아직 신선
    setSynced(h.sqlite, new Date(NOW.getTime() - 30 * 60_000));
    res = await h.call('/api/admin/users', { token: mgr, body: { ...newUser, email: 'n2@example.test' } });
    expect((await json(res)).error.code).toBe('forbidden');
  });

  it('동기화 기록 자체가 없음 → 오래된 것으로 간주', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    setSynced(h.sqlite, null);
    h.sqlite.prepare("INSERT INTO group_ceiling (group_name, app_id, max_role) VALUES ('OPS', 'hub', 'OPERATOR')").run();
    seedUser(h.sqlite, { email: 'op@example.test', groups: ['OPS'], grants: [{ app_id: 'hub', role: 'OPERATOR' }] });
    const res = await h.call('/api/admin/users', { token: await h.token('op@example.test'), body: newUser });
    expect((await json(res)).error.code).toBe('group_snapshot_stale');
  });
});

describe('권한: 그룹 상한', () => {
  it('상한 초과 역할은 무시 (NONGJAJAE 상한 MANAGER 에 ADMIN 부여)', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'over@example.test', groups: ['NONGJAJAE'], grants: [{ app_id: 'nongjajae', role: 'ADMIN' }] });
    const me = await json(await h.call('/api/me', { token: await h.token('over@example.test') }));
    expect(me.roles).toEqual([]);
    const apps = await json(await h.call('/api/apps', { token: await h.token('over@example.test') }));
    expect(apps.apps.map((a: { app_id: string }) => a.app_id)).not.toContain('nongjajae');
  });

  it('상한 이내 역할은 유효, 무시된 높은 역할이 낮은 역할을 가리지 않음', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, {
      email: 'mix@example.test',
      groups: ['NONGJAJAE'],
      grants: [
        { app_id: 'nongjajae', role: 'ADMIN' },
        { app_id: 'nongjajae', role: 'MANAGER', scope: 'KR' },
      ],
    });
    const me = await json(await h.call('/api/me', { token: await h.token('mix@example.test') }));
    expect(me.roles).toEqual([{ app_id: 'nongjajae', role: 'MANAGER', scopes: ['KR'] }]);
  });

  it('상한 행이 없는 앱의 역할은 무시 (허브 ADMIN 부여 + 일반 그룹)', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'uzhub@example.test', groups: ['UZ'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
    const t = await h.token('uzhub@example.test');
    expect((await h.call('/api/admin/users', { token: t })).status).toBe(403);
    expect((await json(await h.call('/api/me', { token: t }))).is_admin).toBe(false);
  });

  it('여러 그룹 중 최고 상한 적용', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    seedUser(h.sqlite, { email: 'multi@example.test', groups: ['UZ', 'ADMIN'], grants: [{ app_id: 'amim', role: 'ADMIN' }] });
    const me = await json(await h.call('/api/me', { token: await h.token('multi@example.test') }));
    expect(me.roles).toEqual([{ app_id: 'amim', role: 'ADMIN', scopes: ['*'] }]);
  });
});

describe('권한 함수 단위', () => {
  const base: GrantRow = {
    id: 1,
    email: 'a@example.test',
    app_id: 'amim',
    role: 'VIEWER',
    scope: '*',
    expires_at: null,
    granted_by: 'x',
    granted_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    revoked_by: null,
  };
  const ceil: CeilingRow[] = [{ group_name: 'UZ', app_id: 'amim', max_role: 'OPERATOR' }];
  const groups = new Set(['UZ']);

  it('grantState 경우들', () => {
    expect(grantState(base, ceil, groups, NOW)).toBe('active');
    expect(grantState({ ...base, revoked_at: 'x' }, ceil, groups, NOW)).toBe('revoked');
    expect(grantState({ ...base, expires_at: 'garbage' }, ceil, groups, NOW)).toBe('expired');
    expect(grantState({ ...base, expires_at: NOW.toISOString() }, ceil, groups, NOW)).toBe('expired');
    expect(grantState({ ...base, role: 'MANAGER' }, ceil, groups, NOW)).toBe('over_ceiling');
    expect(grantState({ ...base, role: 'ROOT' }, ceil, groups, NOW)).toBe('over_ceiling');
    expect(grantState(base, ceil, new Set(['OTHER']), NOW)).toBe('over_ceiling');
    expect(grantState(base, [], groups, NOW)).toBe('over_ceiling');
  });

  it('computeRoles 최고 역할 선택', () => {
    const roles = computeRoles(
      [base, { ...base, id: 2, role: 'OPERATOR', scope: 'UZ' }, { ...base, id: 3, role: 'OPERATOR', scope: 'KR' }],
      ceil,
      groups,
      NOW,
    );
    expect(roles.get('amim')).toEqual({ app_id: 'amim', role: 'OPERATOR', scopes: ['UZ', 'KR'] });
  });

  it('isSnapshotStale', () => {
    expect(isSnapshotStale(null, NOW)).toBe(true);
    expect(isSnapshotStale('bad', NOW)).toBe(true);
    expect(isSnapshotStale(NOW.toISOString(), NOW)).toBe(false);
    expect(isSnapshotStale(new Date(NOW.getTime() - 30 * 60_000 - 1).toISOString(), NOW)).toBe(true);
  });

  it('ORIGIN 상수 형식', () => {
    expect(ORIGIN.startsWith('https://')).toBe(true);
  });
});
