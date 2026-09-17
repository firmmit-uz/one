import { describe, expect, it } from 'vitest';
import { ADMIN, count, harness, json, seedOrg, seedUser, STAFF } from './helpers';

type Item = { app_id: string; kind: string; status: string; url: string | null; role: string | null; name: Record<string, string> };

async function appsFor(email: string, setup?: (h: Awaited<ReturnType<typeof harness>>) => void) {
  const h = await harness();
  seedOrg(h.sqlite);
  setup?.(h);
  const res = await h.call('/api/apps', { token: await h.token(email) });
  expect(res.status).toBe(200);
  const items = (await json(res)).apps as Item[];
  return { h, items, ids: items.map((i) => i.app_id) };
}

const PUBLIC = ['quote', 'academy-apply', 'fino', 'firmmit-mall', 'homepage-kr', 'homepage-uz', 'smartstore', 'firmmit-fresh'];
const CHANNELS = ['telegram', 'kakao-bot'];

describe('런처 목록', () => {
  it('시드: 17개 앱, 모든 URL https, 미연결은 URL 없음', async () => {
    const h = await harness();
    expect(count(h.sqlite, 'SELECT COUNT(*) FROM app_registry')).toBe(17);
    expect(count(h.sqlite, "SELECT COUNT(*) FROM app_registry WHERE url IS NOT NULL AND url NOT LIKE 'https://%'")).toBe(0);
    expect(count(h.sqlite, "SELECT COUNT(*) FROM app_registry WHERE status = 'not_connected' AND url IS NOT NULL")).toBe(0);
    // 이름: uz·ru 에 한글 없음
    const rows = h.sqlite.prepare('SELECT name_uz, name_ru FROM app_registry').all() as { name_uz: string; name_ru: string }[];
    for (const r of rows) {
      expect(r.name_uz).not.toMatch(/[가-힣]/);
      expect(r.name_ru).not.toMatch(/[가-힣]/);
    }
  });

  it('DB 제약: http 주소·미연결에 주소·잘못된 kind 거부', async () => {
    const h = await harness();
    const ins = (url: string | null, kind: string, status: string) =>
      h.sqlite
        .prepare("INSERT INTO app_registry (app_id, name_ko, name_uz, name_ru, url, kind, status) VALUES ('zz-test', 'a', 'b', 'c', ?, ?, ?)")
        .run(url, kind, status);
    expect(() => ins('http://x.example', 'public_site', 'active')).toThrow(/CHECK/);
    expect(() => ins('https://x.example', 'public_site', 'not_connected')).toThrow(/CHECK/);
    expect(() => ins(null, 'public_site', 'active')).toThrow(/CHECK/);
    expect(() => ins('https://x.example', 'iframe', 'active')).toThrow(/CHECK/);
    expect(() => ins('https://x.example', 'public_site', null as unknown as string)).toThrow();
  });

  it('농자재 직원: 자기 업무 앱 + 공개 사이트·채널 전부, 다른 업무 앱·관리 콘솔 없음', async () => {
    const { items, ids } = await appsFor(STAFF);
    expect(ids).toContain('nongjajae');
    for (const id of [...PUBLIC, ...CHANNELS]) expect(ids).toContain(id);
    for (const id of ['icheon-vfarm', 'amim', 'quote-backoffice', 'ahost', 'band-slack-bridge', 'tapo-cctv']) expect(ids).not.toContain(id);
    expect(items.find((i) => i.app_id === 'nongjajae')).toMatchObject({
      role: 'OPERATOR',
      url: 'https://firmmit-nongjajae.global-630.workers.dev',
      kind: 'staff_app',
    });
    expect(items.find((i) => i.app_id === 'quote')!.role).toBeNull();
  });

  it('그룹에는 있지만 역할 없음 → 업무 앱 안 보임', async () => {
    const { ids } = await appsFor('rnd@example.test', (h) => seedUser(h.sqlite, { email: 'rnd@example.test', groups: ['RND'] }));
    expect(ids).not.toContain('icheon-vfarm');
    expect(ids.filter((i) => PUBLIC.includes(i))).toHaveLength(PUBLIC.length);
  });

  it('역할은 있지만 required_group 에 없음 → 안 보임', async () => {
    const { ids } = await appsFor('x@example.test', (h) => {
      h.sqlite.prepare("INSERT INTO group_ceiling (group_name, app_id, max_role) VALUES ('KR', '*', 'VIEWER')").run();
      seedUser(h.sqlite, { email: 'x@example.test', groups: ['KR'], grants: [{ app_id: 'amim', role: 'VIEWER' }] });
    });
    expect(ids).not.toContain('amim');
  });

  it('미연결 항목: url 없이 status 만', async () => {
    const { items } = await appsFor(STAFF);
    for (const id of ['smartstore', 'firmmit-fresh', 'kakao-bot']) {
      const it = items.find((i) => i.app_id === id)!;
      expect(it.status).toBe('not_connected');
      expect(it.url).toBeNull();
    }
    for (const it of items.filter((i) => i.status !== 'not_connected')) expect(it.url).toMatch(/^https:\/\//);
  });

  it('ADMIN: 관리 콘솔 보임 (미연결 콘솔은 url 없음), 다른 업무 앱은 역할 없으면 안 보임', async () => {
    const { items, ids } = await appsFor(ADMIN);
    for (const id of ['ahost', 'band-slack-bridge', 'tapo-cctv']) expect(ids).toContain(id);
    expect(items.find((i) => i.app_id === 'ahost')!.url).toBe('https://clients.ahost.uz');
    expect(items.find((i) => i.app_id === 'band-slack-bridge')).toMatchObject({ status: 'not_connected', url: null });
    expect(ids).not.toContain('nongjajae');
  });

  it('관리 콘솔: 허브 ADMIN 이라도 required_group(ADMIN) 밖이면 안 보임', async () => {
    const { ids } = await appsFor('bg@example.test', (h) =>
      seedUser(h.sqlite, { email: 'bg@example.test', groups: ['BREAKGLASS'], grants: [{ app_id: 'hub', role: 'ADMIN' }] }),
    );
    expect(ids).not.toContain('ahost');
  });

  it('DB 에 http 주소가 들어가도 응답에서 제거 (방어)', async () => {
    const { items } = await appsFor(STAFF, (h) => {
      h.sqlite.exec('PRAGMA ignore_check_constraints = ON');
      h.sqlite.prepare("UPDATE app_registry SET url = 'javascript:alert(1)' WHERE app_id = 'fino'").run();
      h.sqlite.exec('PRAGMA ignore_check_constraints = OFF');
    });
    expect(items.find((i) => i.app_id === 'fino')!.url).toBeNull();
  });

  it('정렬: sort 순', async () => {
    const { ids } = await appsFor(STAFF);
    expect(ids.indexOf('nongjajae')).toBeLessThan(ids.indexOf('quote'));
    expect(ids.indexOf('quote')).toBeLessThan(ids.indexOf('telegram'));
  });
});
