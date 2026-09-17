import { describe, expect, it } from 'vitest';
import { ADMIN, ADMIN2, count, harness, json, NOW, seedOrg, seedUser, STAFF } from './helpers';

async function ready() {
  const h = await harness();
  seedOrg(h.sqlite);
  return { h, t: await h.token(ADMIN) };
}

describe('관리: 조회', () => {
  it('사용자·부여 상태·앱·사본 반환', async () => {
    const { h, t } = await ready();
    seedUser(h.sqlite, { email: 'over@example.test', groups: ['UZ'], grants: [{ app_id: 'amim', role: 'ADMIN' }] });
    const body = await json(await h.call('/api/admin/users', { token: t }));
    const over = body.users.find((u: { email: string }) => u.email === 'over@example.test');
    expect(over.grants[0].state).toBe('over_ceiling');
    const staff = body.users.find((u: { email: string }) => u.email === STAFF);
    expect(staff.groups).toEqual(['NONGJAJAE']);
    expect(staff.grants[0]).toMatchObject({ app_id: 'nongjajae', role: 'OPERATOR', state: 'active' });
    expect(body.apps[0].app_id).toBe('hub');
    expect(body.apps.length).toBe(18);
    expect(body.snapshot.stale).toBe(false);
    expect(body.snapshot.groups.find((g: { group_name: string }) => g.group_name === 'ADMIN').emails).toEqual([ADMIN, ADMIN2]);
  });
});

describe('관리: 직원 등록·상태', () => {
  it('등록 → 201 + 감사, 중복 → 409', async () => {
    const { h, t } = await ready();
    const res = await h.call('/api/admin/users', {
      token: t,
      body: { email: 'New.Person@Example.test', display_name: ' 신규 직원 ', emp_id: 'E-100', reason: '입사' },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).user).toMatchObject({ email: 'new.person@example.test', display_name: '신규 직원', status: 'active' });
    expect(count(h.sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'user_create' AND target = 'user:new.person@example.test'")).toBe(1);
    const dup = await h.call('/api/admin/users', { token: t, body: { email: 'new.person@example.test', display_name: 'x' } });
    expect(dup.status).toBe(409);
    const dupEmp = await h.call('/api/admin/users', { token: t, body: { email: 'other@example.test', display_name: 'x', emp_id: 'E-100' } });
    expect(dupEmp.status).toBe(409);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(1);
  });

  it('상태 변경 + 감사, 같은 상태 409, 없는 사용자 404, 자기 정지 409', async () => {
    const { h, t } = await ready();
    const path = `/api/admin/users/${encodeURIComponent(STAFF)}/status`;
    expect((await h.call(path, { token: t, body: { status: 'suspended', reason: '휴직' } })).status).toBe(200);
    expect(count(h.sqlite, "SELECT COUNT(*) FROM users WHERE email = ? AND status = 'suspended'", STAFF)).toBe(1);
    const a = h.sqlite.prepare("SELECT detail_json FROM audit_log WHERE action = 'user_status_change'").get() as { detail_json: string };
    expect(JSON.parse(a.detail_json)).toEqual({ from: 'active', to: 'suspended', reason: '휴직' });
    expect((await h.call(path, { token: t, body: { status: 'suspended' } })).status).toBe(409);
    expect((await h.call('/api/admin/users/ghost%40example.test/status', { token: t, body: { status: 'revoked' } })).status).toBe(404);
    const self = await h.call(`/api/admin/users/${encodeURIComponent(ADMIN)}/status`, { token: t, body: { status: 'revoked' } });
    expect(self.status).toBe(409);
    expect((await json(self)).error.code).toBe('self_lockout');
    expect((await h.call(path, { token: t, body: { status: 'active' } })).status).toBe(200);
  });

  it('직원 기록 삭제·이메일 변경은 DB 가 거부', async () => {
    const { h } = await ready();
    expect(() => h.sqlite.prepare('DELETE FROM users WHERE email = ?').run(STAFF)).toThrow(/users_no_delete/);
    expect(() => h.sqlite.prepare("UPDATE users SET email = 'x@example.test' WHERE email = ?").run(STAFF)).toThrow();
  });
});

describe('관리: 부여·회수', () => {
  it('부여 → 201, 감사 target 에 부여 id, 즉시 유효', async () => {
    const { h, t } = await ready();
    seedUser(h.sqlite, { email: 'rnd@example.test', groups: ['RND'] });
    const rt = await h.token('rnd@example.test');
    const ids = async () => (await json(await h.call('/api/apps', { token: rt }))).apps.map((a: { app_id: string }) => a.app_id);
    expect(await ids()).not.toContain('icheon-vfarm');
    const res = await h.call('/api/admin/grants', {
      token: t,
      body: { email: 'rnd@example.test', app_id: 'icheon-vfarm', role: 'VIEWER', scope: 'KR', expires_at: '2027-01-01T00:00:00Z' },
    });
    expect(res.status).toBe(201);
    const g = (await json(res)).grant;
    expect(g).toMatchObject({
      app_id: 'icheon-vfarm',
      role: 'VIEWER',
      scope: 'KR',
      expires_at: '2027-01-01T00:00:00.000Z',
      state: 'active',
      granted_by: ADMIN,
    });
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log WHERE action = ? AND target = ?', 'grant_create', `grant:${g.id}`)).toBe(1);
    expect(await ids()).toContain('icheon-vfarm');
  });

  it('상한 초과 부여는 저장하되 over_ceiling 으로 알림', async () => {
    const { h, t } = await ready();
    const res = await h.call('/api/admin/grants', { token: t, body: { email: STAFF, app_id: 'nongjajae', role: 'ADMIN' } });
    expect(res.status).toBe(201);
    expect((await json(res)).grant.state).toBe('over_ceiling');
  });

  it('없는 사용자 404, 없는 앱 400, hub 는 허용', async () => {
    const { h, t } = await ready();
    expect((await h.call('/api/admin/grants', { token: t, body: { email: 'ghost@example.test', app_id: 'amim', role: 'VIEWER' } })).status).toBe(404);
    expect((await h.call('/api/admin/grants', { token: t, body: { email: STAFF, app_id: 'no-such-app', role: 'VIEWER' } })).status).toBe(400);
    expect((await h.call('/api/admin/grants', { token: t, body: { email: STAFF, app_id: 'hub', role: 'VIEWER' } })).status).toBe(201);
  });

  it('회수 → 200 + 감사, 재회수 409, 없는 id 404, 자기 ADMIN 회수 409', async () => {
    const { h, t } = await ready();
    const staffGrant = count(h.sqlite, 'SELECT id FROM role_grants WHERE email = ?', STAFF);
    const res = await h.call(`/api/admin/grants/${staffGrant}/revoke`, { token: t, body: {} });
    expect(res.status).toBe(200);
    expect((await json(res)).revoked_by).toBe(ADMIN);
    expect(count(h.sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'grant_revoke'")).toBe(1);
    const again = await h.call(`/api/admin/grants/${staffGrant}/revoke`, { token: t, body: {} });
    expect(again.status).toBe(409);
    expect((await h.call('/api/admin/grants/9999/revoke', { token: t, body: {} })).status).toBe(404);
    const own = count(h.sqlite, "SELECT id FROM role_grants WHERE email = ? AND app_id = 'hub'", ADMIN);
    const self = await h.call(`/api/admin/grants/${own}/revoke`, { token: t, body: {} });
    expect(self.status).toBe(409);
    expect((await json(self)).error.code).toBe('self_lockout');
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(1);
  });

  it('부여 기록은 회수 외 변경·삭제·재활성화 불가 (DB 트리거)', async () => {
    const { h } = await ready();
    const id = count(h.sqlite, 'SELECT id FROM role_grants WHERE email = ?', STAFF);
    expect(() => h.sqlite.prepare("UPDATE role_grants SET role = 'ADMIN' WHERE id = ?").run(id)).toThrow(/role_grants_revoke_only/);
    expect(() => h.sqlite.prepare('DELETE FROM role_grants WHERE id = ?').run(id)).toThrow(/role_grants_append_only/);
    h.sqlite.prepare("UPDATE role_grants SET revoked_at = 'x', revoked_by = 'y' WHERE id = ?").run(id);
    expect(() => h.sqlite.prepare('UPDATE role_grants SET revoked_at = NULL, revoked_by = NULL WHERE id = ?').run(id)).toThrow(
      /role_grants_revoke_only/,
    );
  });
});

describe('관리: 그룹 사본 수동 입력', () => {
  it('전체 교체 + sync_state 갱신 + 추가/삭제 내역 감사', async () => {
    const { h, t } = await ready();
    h.sqlite.prepare('UPDATE sync_state SET last_success_at = ?').run(new Date(NOW.getTime() - 3600_000).toISOString());
    const res = await h.call('/api/admin/group-snapshot', {
      token: t,
      body: {
        groups: [
          { group_name: 'ADMIN', emails: [ADMIN, ADMIN2] },
          { group_name: 'UZ', emails: [STAFF, 'uz1@example.test'] },
        ],
        reason: '수동 동기화',
      },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ synced_at: NOW.toISOString(), groups: 2, members: 4 });
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM access_group_snapshot')).toBe(4);
    expect(count(h.sqlite, "SELECT COUNT(*) FROM access_group_snapshot WHERE group_name = 'NONGJAJAE'")).toBe(0);
    const row = h.sqlite.prepare("SELECT detail_json FROM audit_log WHERE action = 'group_snapshot_replace'").get() as { detail_json: string };
    const d = JSON.parse(row.detail_json);
    expect(d.added).toEqual([
      ['UZ', STAFF],
      ['UZ', 'uz1@example.test'],
    ]);
    expect(d.removed).toEqual([['NONGJAJAE', STAFF]]);
    const me = await json(await h.call('/api/me', { token: await h.token(STAFF) }));
    expect(me.groups).toEqual(['UZ']);
    expect(me.snapshot.stale).toBe(false);
  });

  it('자기 자신이 ADMIN/BREAKGLASS 에서 빠지면 409', async () => {
    const { h, t } = await ready();
    const res = await h.call('/api/admin/group-snapshot', { token: t, body: { groups: [{ group_name: 'ADMIN', emails: [ADMIN2] }] } });
    expect(res.status).toBe(409);
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM access_group_snapshot')).toBe(3);
  });

  it('중복 그룹·중복 이메일·잘못된 그룹명·빈 목록 400', async () => {
    const { h, t } = await ready();
    const bad = [
      { groups: [{ group_name: 'ADMIN', emails: [ADMIN] }, { group_name: 'ADMIN', emails: [ADMIN2] }] },
      { groups: [{ group_name: 'ADMIN', emails: [ADMIN, ADMIN] }] },
      { groups: [{ group_name: 'AD MIN', emails: [ADMIN] }] },
      { groups: [] },
      { groups: [{ group_name: 'ADMIN', emails: [] }] },
    ];
    for (const body of bad) {
      expect((await h.call('/api/admin/group-snapshot', { token: t, body })).status).toBe(400);
    }
  });
});
