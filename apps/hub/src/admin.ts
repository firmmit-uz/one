// 관리 API (허브 ADMIN 전용, 모든 변경은 감사기록과 같은 트랜잭션)
import { Hono } from 'hono';
import type { HubEnv } from './app';
import { runAudited, verifyAuditChain, type AuditRow } from './audit';
import { grantState, isSnapshotStale, type CeilingRow, type GrantRow } from './authz';
import { GROUP_SYNC_KEY, HUB_APP_ID } from './env';
import {
  isAutoSyncEnabled,
  loadSnapshotRows,
  loadSyncState,
  LOCKOUT_GROUPS,
  nextGroupSyncAt,
  snapshotDiff,
  snapshotReplaceStmts,
} from './groupsync';
import { CAMERA_ID_RE, cameraList, getCamera, relayReady, STREAM_KINDS, streamPathValidator, toView } from './cctv';
import { requireHubAdmin } from './guard';
import { ApiError, errorIncludes } from './http';
import { applyPhase0Update, listPhase0, parsePhase0Body } from './kpi/phase0';
import { isEnabled as isTokenRefreshEnabled, tokenStatuses } from './tokens/refresh';
import { arrayOf, email, futureIsoUtc, int, objectOf, oneOf, readJsonBody, role, str, ValidationError } from './validate';

const GROUP_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SCOPE_RE = /^[A-Za-z0-9_.:*-]{1,64}$/;
const EMP_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;

const reason = { v: str({ max: 500 }), optional: true } as const;

// 정렬 순서: 0 이상 9999 이하의 정수만 (실수·NaN·범위 밖 거부)
export function adminRoutes() {
  const r = new Hono<HubEnv>();

  // ADMIN 확인 (서버가 최종 판정) — CCTV API 와 같은 관문
  r.use('*', requireHubAdmin);

  r.get('/users', async (c) => {
    const db = c.env.DB;
    const now = c.get('now');
    const [users, grants, snap, ceilings, apps, sync] = await db.batch([
      db.prepare('SELECT email, emp_id, display_name, status, created_at FROM users ORDER BY email LIMIT 2000'),
      db.prepare('SELECT * FROM role_grants ORDER BY id'),
      db.prepare('SELECT group_name, email FROM access_group_snapshot ORDER BY group_name, email'),
      db.prepare('SELECT group_name, app_id, max_role FROM group_ceiling ORDER BY group_name, app_id'),
      db.prepare('SELECT app_id, name_ko, name_uz, name_ru, kind, status FROM app_registry ORDER BY sort, app_id'),
      db.prepare('SELECT last_success_at FROM sync_state WHERE key = ?').bind(GROUP_SYNC_KEY),
    ]);
    const syncState = await loadSyncState(db);
    const auto = isAutoSyncEnabled(c.env);
    const snapRows = (snap?.results ?? []) as { group_name: string; email: string }[];
    const ceilingRows = (ceilings?.results ?? []) as unknown as CeilingRow[];
    const groupsByEmail = new Map<string, string[]>();
    const membersByGroup = new Map<string, string[]>();
    for (const s of snapRows) {
      groupsByEmail.set(s.email, [...(groupsByEmail.get(s.email) ?? []), s.group_name]);
      membersByGroup.set(s.group_name, [...(membersByGroup.get(s.group_name) ?? []), s.email]);
    }
    const grantsByEmail = new Map<string, GrantRow[]>();
    for (const g of (grants?.results ?? []) as unknown as GrantRow[]) {
      grantsByEmail.set(g.email, [...(grantsByEmail.get(g.email) ?? []), g]);
    }
    const syncedAt = ((sync?.results?.[0] ?? null) as { last_success_at: string } | null)?.last_success_at ?? null;
    return c.json({
      users: ((users?.results ?? []) as { email: string }[]).map((u) => {
        const groups = groupsByEmail.get(u.email) ?? [];
        const gs = new Set(groups);
        return {
          ...u,
          groups,
          grants: (grantsByEmail.get(u.email) ?? []).map((g) => ({ ...g, state: grantState(g, ceilingRows, gs, now) })),
        };
      }),
      apps: [
        { app_id: HUB_APP_ID, name_ko: 'FIRMMIT ONE 허브', name_uz: 'FIRMMIT ONE hub', name_ru: 'Хаб FIRMMIT ONE', kind: 'hub', status: 'active' },
        ...((apps?.results ?? []) as object[]),
      ],
      ceilings: ceilingRows,
      snapshot: {
        synced_at: syncedAt,
        stale: isSnapshotStale(syncedAt, now),
        groups: [...membersByGroup.entries()].map(([group_name, emails]) => ({ group_name, emails })),
        // WP1: 자동 동기화 상태 (자동 모드가 아니면 수동 입력만 쓴다)
        sync: {
          auto,
          next_run_at: auto ? nextGroupSyncAt(now) : null,
          last_attempt_at: syncState?.last_attempt_at ?? null,
          last_outcome: syncState?.last_outcome ?? null,
          last_failure_code: syncState?.last_failure_code ?? null,
          last_failure_at: syncState?.last_failure_at ?? null,
          consecutive_failures: syncState?.consecutive_failures ?? 0,
        },
      },
    });
  });

  // 직원 등록
  r.post('/users', async (c) => {
    const body = objectOf({
      email: { v: email },
      display_name: { v: str({ max: 100 }) },
      emp_id: { v: str({ max: 32, pattern: EMP_RE }), optional: true, nullable: true },
      reason,
    })(await readJsonBody(c.req.raw), '');
    const db = c.env.DB;
    const exists = await db.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(body.email).first();
    if (exists) throw new ApiError(409, 'already_exists', 'User already exists');
    const now = c.get('now').toISOString();
    const actor = c.get('principal').email;
    try {
      await runAudited(db, async () => ({
        stmts: [
          db
            .prepare("INSERT INTO users (email, emp_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)")
            .bind(body.email, body.emp_id ?? null, body.display_name, now),
        ],
        entry: {
          ts: now,
          actor_email: actor,
          action: 'user_create',
          target: `user:${body.email}`,
          detail: { emp_id: body.emp_id ?? null, display_name: body.display_name, reason: body.reason ?? null },
          request_id: c.get('requestId'),
        },
      }));
    } catch (err) {
      if (errorIncludes(err, 'UNIQUE constraint failed')) throw new ApiError(409, 'already_exists', 'User or employee ID already exists');
      throw err;
    }
    return c.json({ user: { email: body.email, emp_id: body.emp_id ?? null, display_name: body.display_name, status: 'active', created_at: now } }, 201);
  });

  // 직원 상태 변경
  r.post('/users/:email/status', async (c) => {
    const target = email(c.req.param('email'), 'email');
    const body = objectOf({ status: { v: oneOf(['active', 'suspended', 'revoked'] as const) }, reason })(
      await readJsonBody(c.req.raw),
      '',
    );
    const actor = c.get('principal').email;
    if (target === actor && body.status !== 'active') throw new ApiError(409, 'self_lockout', 'Cannot deactivate your own account');
    const db = c.env.DB;
    const cur = await db.prepare('SELECT status FROM users WHERE email = ?').bind(target).first<{ status: string }>();
    if (!cur) throw new ApiError(404, 'not_found', 'User not found');
    if (cur.status === body.status) throw new ApiError(409, 'no_change', 'Status unchanged');
    const now = c.get('now').toISOString();
    await runAudited(db, async () => ({
      stmts: [db.prepare('UPDATE users SET status = ? WHERE email = ?').bind(body.status, target)],
      entry: {
        ts: now,
        actor_email: actor,
        action: 'user_status_change',
        target: `user:${target}`,
        detail: { from: cur.status, to: body.status, reason: body.reason ?? null },
        request_id: c.get('requestId'),
      },
    }));
    return c.json({ email: target, status: body.status });
  });

  // 역할 부여
  r.post('/grants', async (c) => {
    const body = objectOf({
      email: { v: email },
      app_id: { v: str({ min: 2, max: 64, pattern: /^[a-z0-9-]+$/ }) },
      role: { v: role },
      scope: { v: str({ max: 64, pattern: SCOPE_RE }), optional: true },
      expires_at: { v: futureIsoUtc(() => c.get('now')), optional: true, nullable: true },
      reason,
    })(await readJsonBody(c.req.raw), '');
    const db = c.env.DB;
    const [u, a] = await db.batch([
      db.prepare('SELECT email, status FROM users WHERE email = ?').bind(body.email),
      db.prepare('SELECT app_id FROM app_registry WHERE app_id = ?').bind(body.app_id),
    ]);
    if (!u?.results?.[0]) throw new ApiError(404, 'user_not_found', 'User not found');
    if (body.app_id !== HUB_APP_ID && !a?.results?.[0]) throw new ValidationError('unknown_app', 'app_id');

    const now = c.get('now').toISOString();
    const actor = c.get('principal').email;
    const scope = body.scope ?? '*';
    const expires = body.expires_at ?? null;
    let grantId = 0;
    await runAudited(
      db,
      async () => {
        const row = await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM role_grants').first<{ next: number }>();
        grantId = row?.next ?? 1;
        return {
          stmts: [
            db
              .prepare(
                'INSERT INTO role_grants (id, email, app_id, role, scope, expires_at, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .bind(grantId, body.email, body.app_id, body.role, scope, expires, actor, now),
          ],
          entry: {
            ts: now,
            actor_email: actor,
            action: 'grant_create',
            target: `grant:${grantId}`,
            detail: { email: body.email, app_id: body.app_id, role: body.role, scope, expires_at: expires, reason: body.reason ?? null },
            request_id: c.get('requestId'),
          },
        };
      },
      { retryOn: ['role_grants.id'] },
    );

    // 상한 초과 여부를 바로 알려줌
    const [grp, ceil] = await db.batch([
      db.prepare('SELECT group_name FROM access_group_snapshot WHERE email = ?').bind(body.email),
      db.prepare('SELECT group_name, app_id, max_role FROM group_ceiling'),
    ]);
    const groups = new Set(((grp?.results ?? []) as { group_name: string }[]).map((g) => g.group_name));
    const grant: GrantRow = {
      id: grantId,
      email: body.email,
      app_id: body.app_id,
      role: body.role,
      scope,
      expires_at: expires,
      granted_by: actor,
      granted_at: now,
      revoked_at: null,
      revoked_by: null,
    };
    const state = grantState(grant, (ceil?.results ?? []) as unknown as CeilingRow[], groups, c.get('now'));
    return c.json({ grant: { ...grant, state } }, 201);
  });

  // 역할 회수
  r.post('/grants/:id/revoke', async (c) => {
    const idText = c.req.param('id');
    if (!ID_RE.test(idText)) throw new ValidationError('invalid_id', 'id');
    const id = Number(idText);
    const body = objectOf({ reason })(await readJsonBody(c.req.raw), '');
    const db = c.env.DB;
    const g = await db.prepare('SELECT * FROM role_grants WHERE id = ?').bind(id).first<GrantRow>();
    if (!g) throw new ApiError(404, 'not_found', 'Grant not found');
    if (g.revoked_at !== null) throw new ApiError(409, 'already_revoked', 'Grant already revoked');
    const actor = c.get('principal').email;
    if (g.email === actor && g.app_id === HUB_APP_ID && g.role === 'ADMIN') {
      throw new ApiError(409, 'self_lockout', 'Cannot revoke your own administrator grant');
    }
    const now = c.get('now').toISOString();
    try {
      await runAudited(db, async () => ({
        stmts: [db.prepare('UPDATE role_grants SET revoked_at = ?, revoked_by = ? WHERE id = ?').bind(now, actor, id)],
        entry: {
          ts: now,
          actor_email: actor,
          action: 'grant_revoke',
          target: `grant:${id}`,
          detail: { email: g.email, app_id: g.app_id, role: g.role, scope: g.scope, reason: body.reason ?? null },
          request_id: c.get('requestId'),
        },
      }));
    } catch (err) {
      // 동시 회수 경합: 트리거가 두 번째 회수를 막음
      if (errorIncludes(err, 'role_grants_revoke_only')) throw new ApiError(409, 'already_revoked', 'Grant already revoked');
      throw err;
    }
    return c.json({ id, revoked_at: now, revoked_by: actor });
  });

  // 그룹 사본 수동 입력: 전체 교체.
  // 자동 동기화가 설정돼 있으면 거부한다 — 수동 입력이 sync_state 를 갱신해
  // 자동 동기화 실패를 가리는 것을 막기 위해서다 (WP1).
  r.post('/group-snapshot', async (c) => {
    if (isAutoSyncEnabled(c.env)) {
      throw new ApiError(409, 'auto_sync_enabled', 'Automatic group sync is enabled; manual replacement is disabled');
    }
    const body = objectOf({
      groups: {
        v: arrayOf(
          objectOf({
            group_name: { v: str({ max: 64, pattern: GROUP_RE }) },
            emails: { v: arrayOf(email, { min: 1, max: 2000, unique: true }) },
          }),
          { min: 1, max: 100 },
        ),
      },
      reason,
    })(await readJsonBody(c.req.raw), '');
    const names = body.groups.map((g) => g.group_name);
    if (new Set(names).size !== names.length) throw new ValidationError('duplicate_value', 'groups.group_name');
    const actor = c.get('principal').email;
    // 자기 자신이 관리 그룹에서 빠지면 잠김 → 거부
    const keepsAccess = body.groups.some(
      (g) => (LOCKOUT_GROUPS as readonly string[]).includes(g.group_name) && g.emails.includes(actor),
    );
    if (!keepsAccess) throw new ApiError(409, 'self_lockout', 'You must remain in ADMIN or BREAKGLASS group');

    const db = c.env.DB;
    const now = c.get('now').toISOString();
    const members = new Set(body.groups.flatMap((g) => g.emails.map((e) => `${g.group_name}\t${e}`))).size;
    // 사본 교체 SQL 은 자동 동기화와 공용 (검사 규칙은 서로 다르다)
    await runAudited(db, async () => {
      const diff = snapshotDiff(await loadSnapshotRows(db), body.groups);
      return {
        stmts: snapshotReplaceStmts(db, body.groups, now),
        entry: {
          ts: now,
          actor_email: actor,
          action: 'group_snapshot_replace',
          target: 'access_group_snapshot',
          detail: {
            source: 'manual',
            groups: body.groups.map((g) => ({ group_name: g.group_name, count: g.emails.length })),
            added: diff.added,
            removed: diff.removed,
            truncated: diff.truncated,
            reason: body.reason ?? null,
          },
          request_id: c.get('requestId'),
        },
      };
    });
    return c.json({ synced_at: now, groups: body.groups.length, members });
  });

  // Phase 0 게이트 G1 체크리스트 (허브 자체 관리 입력 — 하위 앱에 쓰지 않는다)
  r.get('/phase0', async (c) => c.json(await listPhase0(c.env.DB)));

  r.post('/phase0/:item_id', async (c) => {
    const update = await parsePhase0Body(c.req.raw);
    const item = await applyPhase0Update(
      c.env.DB,
      c.req.param('item_id'),
      update,
      c.get('principal').email,
      c.get('now'),
      c.get('requestId'),
    );
    return c.json({ item });
  });

  // 연동 토큰 상태 (WP3). **토큰 값·암호문은 절대 내려보내지 않는다.**
  r.get('/tokens', async (c) =>
    c.json({
      enabled: isTokenRefreshEnabled(c.env),
      tokens: await tokenStatuses(c.env.DB, c.get('now')),
    }),
  );

  // R3 CCTV 카메라 등록 (허브 자체 관리 입력 — 하위 앱·카메라에 쓰지 않는다).
  // 중계 서버 **안에서의 경로만** 받는다. 서버 주소·카메라 계정은 설정값·중계 서버 쪽에 있다.
  r.get('/cctv', async (c) => {
    // 뷰어(/api/cctv)와 같은 판정·같은 모양. 관리 화면은 정렬·수정 시각만 더 본다.
    const l = await cameraList(c.env, c.env.DB);
    return c.json({
      enabled: l.enabled,
      relay_configured: l.relay_configured,
      cameras: l.views.map((v, i) => ({ ...v, sort: l.rows[i]!.sort, updated_at: l.rows[i]!.updated_at })),
    });
  });

  r.post('/cctv', async (c) => {
    const body = objectOf({
      camera_id: { v: str({ min: 2, max: 64, pattern: CAMERA_ID_RE }) },
      name_ko: { v: str({ max: 100 }) },
      site: { v: str({ max: 64 }) },
      stream_kind: { v: oneOf(STREAM_KINDS) },
      // 연결하려면 '/' 로 시작하는 경로. 미연결로 두려면 null. **빼면 이전 경로 유지** (새 등록에서 빼면 미연결).
      // 목록은 경로를 돌려주지 않으므로, 이름·순서만 고치는 저장이 경로를 지우지 않게 하려면 이 규칙이 필요하다.
      stream_path: { v: streamPathValidator, nullable: true, optional: true },
      sort: { v: int({ min: 0, max: 9999 }), optional: true },
      reason,
    })(await readJsonBody(c.req.raw), '');

    const db = c.env.DB;
    const now = c.get('now').toISOString();
    const actor = c.get('principal').email;
    // 이전 상태는 batch 를 준비할 때마다 읽는다 — runAudited 가 재시도하면 다시 읽으므로 감사기록이 묵은 값을 담지 않는다
    // 닫힌 함수 안의 대입은 TS 흐름 분석이 따라오지 못하므로 객체 속성으로 들고 있는다
    const seen: { before: Awaited<ReturnType<typeof getCamera>>; sort: number; stream_path: string | null; status: 'active' | 'not_connected' } = { before: null, sort: 0, stream_path: null, status: 'not_connected' };

    await runAudited(db, async () => {
      const before = await getCamera(db, body.camera_id);
      const sort = body.sort ?? before?.sort ?? 0;
      // 경로: 보낸 값 > 이전 값 > 없음. 상태는 경로에서만 정한다 — 따로 받지 않아 어긋날 수 없다
      const stream_path: string | null = body.stream_path === undefined ? (before?.stream_path ?? null) : body.stream_path;
      const status = stream_path === null ? 'not_connected' : 'active';
      seen.before = before;
      seen.sort = sort;
      seen.stream_path = stream_path;
      seen.status = status;
      return {
      stmts: [
        db
          .prepare(
            `INSERT INTO cctv_cameras (camera_id, name_ko, site, stream_kind, stream_path, status, sort, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(camera_id) DO UPDATE SET
               name_ko = excluded.name_ko, site = excluded.site, stream_kind = excluded.stream_kind,
               stream_path = excluded.stream_path, status = excluded.status, sort = excluded.sort,
               updated_at = excluded.updated_at`,
          )
          .bind(body.camera_id, body.name_ko, body.site, body.stream_kind, stream_path, status, sort, before?.created_at ?? now, now),
      ],
      entry: {
        ts: now,
        actor_email: actor,
        action: before === null ? 'cctv_camera_create' : 'cctv_camera_update',
        target: `camera:${body.camera_id}`,
        // 경로는 감사기록에 넣지 않는다. 바뀌었는지 여부만 남긴다.
        detail: {
          name_ko: body.name_ko,
          site: body.site,
          stream_kind: body.stream_kind,
          status,
          path_changed: (before?.stream_path ?? null) !== stream_path,
          from_status: before?.status ?? null,
          reason: body.reason ?? null,
        },
        request_id: c.get('requestId'),
      },
      };
    });

    // 응답은 방금 저장한 값으로 만든다 — 다시 읽으면 왕복이 하나 늘고, 그 사이 다른 저장이 끼면 남의 결과를 돌려준다
    const saved = {
      camera_id: body.camera_id,
      name_ko: body.name_ko,
      site: body.site,
      stream_kind: body.stream_kind,
      stream_path: seen.stream_path,
      status: seen.status,
      sort: seen.sort,
      created_at: seen.before?.created_at ?? now,
      updated_at: now,
    };
    return c.json({ camera: toView(saved, relayReady(c.env)) }, seen.before === null ? 201 : 200);
  });

  r.get('/audit', async (c) => {
    const q = c.req.query();
    for (const k of Object.keys(q)) if (k !== 'limit' && k !== 'before') throw new ValidationError('unknown_field', k);
    let limit = 100;
    if (q.limit !== undefined) {
      if (!/^[1-9][0-9]{0,2}$/.test(q.limit) || Number(q.limit) > 500) throw new ValidationError('invalid_value', 'limit');
      limit = Number(q.limit);
    }
    let before = Number.MAX_SAFE_INTEGER;
    if (q.before !== undefined) {
      if (!ID_RE.test(q.before)) throw new ValidationError('invalid_value', 'before');
      before = Number(q.before);
    }
    const res = await c.env.DB.prepare(
      'SELECT id, ts, actor_email, action, target, detail_json, request_id, prev_hash, row_hash FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?',
    )
      .bind(before, limit)
      .all<AuditRow>();
    return c.json({
      entries: (res.results ?? []).map(({ detail_json, ...rest }) => ({ ...rest, detail: JSON.parse(detail_json) as unknown })),
    });
  });

  r.get('/audit/verify', async (c) => c.json(await verifyAuditChain(c.env.DB)));

  return r;
}
