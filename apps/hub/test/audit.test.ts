import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appendAudit, computeRowHash, canonicalContent, GENESIS_HASH, runAudited, verifyAuditChain } from '../src/audit';
import { FakeD1 } from './d1-adapter';
import { ADMIN, count, createDb, harness, json, NOW, openDb, seedOrg } from './helpers';

const tmp = mkdtempSync(join(tmpdir(), 'fm-hub-audit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function withRows(n = 5) {
  const { sqlite, d1 } = createDb();
  for (let i = 0; i < n; i++) {
    await appendAudit(d1 as unknown as D1Database, {
      ts: new Date(NOW.getTime() + i * 1000).toISOString(),
      actor_email: 'admin@example.test',
      action: 'test_event',
      target: `t:${i}`,
      detail: { i, note: '감사 기록' },
      request_id: `req-${i}`,
    });
  }
  return { sqlite, d1 };
}

const db = (d1: FakeD1) => d1 as unknown as D1Database;

describe('감사기록: 추가 전용 트리거', () => {
  it('UPDATE 실패', async () => {
    const { sqlite } = await withRows();
    expect(() => sqlite.prepare("UPDATE audit_log SET action = 'x' WHERE id = 2").run()).toThrow(/audit_log_append_only/);
    expect(() => sqlite.prepare('UPDATE audit_log SET detail_json = detail_json').run()).toThrow(/audit_log_append_only/);
  });

  it('DELETE 실패', async () => {
    const { sqlite } = await withRows();
    expect(() => sqlite.prepare('DELETE FROM audit_log WHERE id = 3').run()).toThrow(/audit_log_append_only/);
    expect(() => sqlite.prepare('DELETE FROM audit_log').run()).toThrow(/audit_log_append_only/);
    expect(count(sqlite, 'SELECT COUNT(*) FROM audit_log')).toBe(5);
  });

  it('INSERT OR REPLACE (같은 id, 올바른 prev_hash) 실패, 원본 유지', async () => {
    const { sqlite, d1 } = await withRows();
    const before = sqlite.prepare('SELECT * FROM audit_log WHERE id = 2').get();
    const head = (sqlite.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { row_hash: string }).row_hash;
    const fake = await computeRowHash(head, 'forged');
    expect(() =>
      sqlite
        .prepare(
          "INSERT OR REPLACE INTO audit_log (id, ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES (2, 'x', 'evil@example.test', 'forged', 't', '{}', 'r', ?, ?)",
        )
        .run(head, fake),
    ).toThrow(/audit_log_append_only/);
    expect(sqlite.prepare('SELECT * FROM audit_log WHERE id = 2').get()).toEqual(before);
    expect((await verifyAuditChain(db(d1))).ok).toBe(true);
  });

  it('REPLACE INTO / INSERT OR REPLACE (같은 row_hash, id 없음) 실패', async () => {
    const { sqlite } = await withRows();
    const r1 = sqlite.prepare('SELECT row_hash FROM audit_log WHERE id = 1').get() as { row_hash: string };
    const head = (sqlite.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { row_hash: string }).row_hash;
    for (const verb of ['INSERT OR REPLACE', 'REPLACE']) {
      expect(() =>
        sqlite
          .prepare(
            `${verb} INTO audit_log (ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES ('x', 'evil@example.test', 'forged', 't', '{}', 'r', ?, ?)`,
          )
          .run(head, r1.row_hash),
      ).toThrow(/audit_log_append_only/);
    }
    expect(count(sqlite, 'SELECT COUNT(*) FROM audit_log WHERE id = 1')).toBe(1);
  });

  it('UPSERT (ON CONFLICT DO UPDATE) 실패', async () => {
    const { sqlite } = await withRows();
    const head = (sqlite.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { row_hash: string }).row_hash;
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO audit_log (id, ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES (1, 'x', 'e', 'a', 't', '{}', 'r', ?, ?) ON CONFLICT(id) DO UPDATE SET action = 'forged'",
        )
        .run(head, 'f'.repeat(64)),
    ).toThrow(/audit_log_append_only/);
  });

  it('prev_hash 가 체인 머리가 아니면 삽입 거부', async () => {
    const { sqlite } = await withRows(2);
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO audit_log (ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES ('x', 'e', 'a', 't', '{}', 'r', ?, ?)",
        )
        .run(GENESIS_HASH, 'e'.repeat(64)),
    ).toThrow(/audit_chain_conflict/);
  });

  it('detail_json 은 JSON 이어야 함', async () => {
    const { sqlite } = await withRows(0);
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO audit_log (ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES ('x', 'e', 'a', 't', 'not json', 'r', ?, ?)",
        )
        .run(GENESIS_HASH, 'e'.repeat(64)),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('감사기록: 해시 체인', () => {
  it('빈 체인·정상 체인 verify 통과', async () => {
    const empty = createDb();
    expect(await verifyAuditChain(db(empty.d1))).toEqual({ ok: true, checked: 0, head_hash: GENESIS_HASH });
    const { d1, sqlite } = await withRows(7);
    const r = await verifyAuditChain(db(d1), 3); // 페이지 경계 포함
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(7);
    const rows = sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all() as Record<string, string>[];
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.row_hash);
    const r0 = rows[0]!;
    expect(r0.row_hash).toBe(await computeRowHash(GENESIS_HASH, canonicalContent(r0 as never)));
  });

  it('복제 DB 에서 트리거 제거 후 내용 변조 → verify 실패 (원본은 정상)', async () => {
    const { sqlite, d1 } = await withRows(5);
    const copyPath = join(tmp, 'tamper-content.db');
    sqlite.exec(`VACUUM INTO '${copyPath}'`);
    const copy = openDb(copyPath);
    copy.exec('DROP TRIGGER audit_log_no_update');
    copy.prepare(`UPDATE audit_log SET detail_json = '{"i":2,"note":"변조"}' WHERE id = 3`).run();
    const r = await verifyAuditChain(db(new FakeD1(copy)));
    expect(r.ok).toBe(false);
    expect(r.broken_at_id).toBe(3);
    expect(r.reason).toBe('row_hash_mismatch');
    copy.close();
    expect((await verifyAuditChain(db(d1))).ok).toBe(true);
  });

  it('복제 DB 에서 중간 행 삭제 → verify 실패', async () => {
    const { sqlite } = await withRows(5);
    const copyPath = join(tmp, 'tamper-delete.db');
    sqlite.exec(`VACUUM INTO '${copyPath}'`);
    const copy = openDb(copyPath);
    copy.exec('DROP TRIGGER audit_log_no_delete');
    copy.prepare('DELETE FROM audit_log WHERE id = 2').run();
    const r = await verifyAuditChain(db(new FakeD1(copy)));
    expect(r).toMatchObject({ ok: false, broken_at_id: 3, reason: 'prev_hash_mismatch', checked: 1 });
    copy.close();
  });

  it('복제 DB 에서 해시까지 다시 계산한 변조 → 다음 행에서 실패', async () => {
    const { sqlite } = await withRows(5);
    const copyPath = join(tmp, 'tamper-rehash.db');
    sqlite.exec(`VACUUM INTO '${copyPath}'`);
    const copy = openDb(copyPath);
    copy.exec('DROP TRIGGER audit_log_no_update');
    const row = copy.prepare('SELECT * FROM audit_log WHERE id = 2').get() as Record<string, string>;
    const forged = { ...row, actor_email: 'someone-else@example.test' };
    const h = await computeRowHash(row.prev_hash!, canonicalContent(forged as never));
    copy.prepare('UPDATE audit_log SET actor_email = ?, row_hash = ? WHERE id = 2').run(forged.actor_email, h);
    const r = await verifyAuditChain(db(new FakeD1(copy)));
    expect(r).toMatchObject({ ok: false, broken_at_id: 3, reason: 'prev_hash_mismatch' });
    copy.close();
  });

  it('동시 쓰기로 체인 머리가 바뀌면 재시도 후 성공', async () => {
    const { sqlite, d1 } = await withRows(1);
    let injected = false;
    d1.beforeBatch = () => {
      // 첫 배치 직전에 다른 요청이 기록한 것처럼 끼워넣기
      injected = true;
      const head = (sqlite.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { row_hash: string }).row_hash;
      sqlite
        .prepare(
          "INSERT INTO audit_log (ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash) VALUES ('t', 'other', 'other', 'x', '{}', 'r', ?, ?)",
        )
        .run(head, 'c'.repeat(64));
    };
    await runAudited(db(d1), async () => ({
      stmts: [],
      entry: { ts: NOW.toISOString(), actor_email: 'a@example.test', action: 'retry_test', target: 'x', detail: {}, request_id: 'r2' },
    }));
    expect(injected).toBe(true);
    expect(count(sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'retry_test'")).toBe(1);
    // 끼워넣은 행은 해시가 가짜라 verify 는 그 행에서 실패해야 함
    expect((await verifyAuditChain(db(d1))).broken_at_id).toBe(2);
  });

  it('감사 기록 실패 시 변경도 함께 롤백 (원자성)', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    h.sqlite.exec("CREATE TRIGGER test_block_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'blocked_for_test'); END;");
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await h.call('/api/admin/users', {
      token: await h.token(ADMIN),
      body: { email: 'atomic@example.test', display_name: '원자성' },
    });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body).toEqual({ error: { code: 'internal_error', message: 'Internal error' } });
    expect(JSON.stringify(body)).not.toContain('blocked_for_test');
    expect(count(h.sqlite, "SELECT COUNT(*) FROM users WHERE email = 'atomic@example.test'")).toBe(0);
    errSpy.mockRestore();
  });
});

describe('감사기록 API', () => {
  it('ADMIN: 목록·verify, 비ADMIN: 403', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const t = await h.token(ADMIN);
    await h.call('/api/admin/users', { token: t, body: { email: 'a1@example.test', display_name: 'A1' } });
    await h.call('/api/admin/users', { token: t, body: { email: 'a2@example.test', display_name: 'A2' } });
    const list = await json(await h.call('/api/admin/audit?limit=1', { token: t }));
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({ action: 'user_create', target: 'user:a2@example.test', actor_email: ADMIN });
    expect(list.entries[0].detail).toMatchObject({ display_name: 'A2' });
    const older = await json(await h.call(`/api/admin/audit?before=${list.entries[0].id}`, { token: t }));
    expect(older.entries[0].target).toBe('user:a1@example.test');
    const v = await json(await h.call('/api/admin/audit/verify', { token: t }));
    expect(v).toMatchObject({ ok: true, checked: 2 });
    const staff = await h.token('staff1@example.test');
    expect((await h.call('/api/admin/audit', { token: staff })).status).toBe(403);
    expect((await h.call('/api/admin/audit/verify', { token: staff })).status).toBe(403);
  });
});

describe('BREAKGLASS 로그인 기록', () => {
  it('세션(iat)당 1건 기록', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const { seedUser } = await import('./helpers');
    seedUser(h.sqlite, { email: 'bg@example.test', groups: ['BREAKGLASS'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
    const t1 = await h.token('bg@example.test', {}, { iat: 1_700_000_000 + 1 });
    expect((await h.call('/api/me', { token: t1 })).status).toBe(200);
    expect((await h.call('/api/apps', { token: t1 })).status).toBe(200);
    expect(count(h.sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'breakglass_login'")).toBe(1);
    const t2 = await h.token('bg@example.test', {}, { iat: 1_700_000_000 + 2 });
    await h.call('/api/me', { token: t2 });
    expect(count(h.sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'breakglass_login' AND actor_email = 'bg@example.test'")).toBe(2);
    // 일반 사용자는 기록 없음
    await h.call('/api/me', { token: await h.token(ADMIN) });
    expect(count(h.sqlite, "SELECT COUNT(*) FROM audit_log WHERE action = 'breakglass_login'")).toBe(2);
  });

  it('BREAKGLASS 기록 실패 시 요청 거부 (500)', async () => {
    const h = await harness();
    seedOrg(h.sqlite);
    const { seedUser } = await import('./helpers');
    seedUser(h.sqlite, { email: 'bg@example.test', groups: ['BREAKGLASS'], grants: [{ app_id: 'hub', role: 'ADMIN' }] });
    h.sqlite.exec("CREATE TRIGGER test_block_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const res = await h.call('/api/me', { token: await h.token('bg@example.test') });
    expect(res.status).toBe(500);
    expect((await json(res)).error.code).toBe('audit_unavailable');
  });
});
