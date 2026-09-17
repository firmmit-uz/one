// WP1: Cloudflare Access 그룹 사본 자동 동기화 (읽기 전용 API, 15분 Cron)
//
// 공식 문서 확인 2026-09-17
//  - GET /accounts/{account_id}/access/groups
//    https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/groups/methods/list/
//    그룹 객체: id · name(선택) · include/exclude/require(선택, 규칙 배열) · is_default
//    이메일 규칙 {"email":{"email":"user@example.com"}} · 그 밖 everyone / email_domain /
//    email_list / login_method / auth_method / device_posture 등
//    질의 변수 page · per_page(최대 1000) · name · search
//    필요 권한 "Access: Organizations, Identity Providers, and Groups Read"
//  - 응답 봉투 success / result / errors / messages, 페이지형은 result_info
//    { page, per_page, count, total_count, total_pages }
//    https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/
//    [재확인 필요] 그룹 목록 스키마 문서에는 result_info 가 명시돼 있지 않다 →
//    있으면 쓰고, 없으면 "마지막 쪽이 per_page 미만" 으로 판정한다(양쪽 모두 시험).
import { runAudited } from './audit';
import { isSnapshotStale } from './authz';
import type { Env } from './env';
import { GROUP_SYNC_KEY } from './env';
import { isEmail } from './validate';

export const GROUP_SYNC_CRON = '*/15 * * * *';
export const GROUP_SYNC_ACTOR = 'system:groupsync';
export const DIFF_LIMIT = 500;

/** 동기화 대상 (허용 목록). 목록 밖 그룹은 무시한다. */
export const SYNC_GROUPS = [
  'ALL',
  'ADMIN',
  'BREAKGLASS',
  'NONGJAJAE',
  'CONSTRUCTION',
  'RND',
  'UZ',
  'FINANCE',
] as const;

/** FINANCE 는 Phase 2 예정이라 선택 그룹. 나머지는 없으면 전체 실패. */
export const OPTIONAL_GROUPS = new Set<string>(['FINANCE']);
export const REQUIRED_GROUPS = SYNC_GROUPS.filter((g) => !OPTIONAL_GROUPS.has(g));
/** 이 그룹이 0명이 되면 관리자가 잠기므로 전체 실패로 본다. */
export const LOCKOUT_GROUPS = ['ADMIN', 'BREAKGLASS'] as const;

const SYNC_GROUP_SET = new Set<string>(SYNC_GROUPS);
const SYNC_GROUP_ORDER: readonly string[] = SYNC_GROUPS;
const API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const API_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{8,256}$/;
const PLACEHOLDER_RE = /^<.*>$/;
/** require 에서 허용하는 규칙(로그인 방식 조건). 구성원 계산에는 쓰지 않는다. */
const REQUIRE_ALLOWED = new Set(['login_method', 'auth_method']);

export interface GroupMembers {
  group_name: string;
  emails: string[];
}

export interface GroupSyncConfig {
  accountId: string;
  apiToken: string;
}

export interface GroupSyncDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  timeoutMs?: number;
  perPage?: number;
  maxPages?: number;
  requestId?: string;
}

export type SyncFailureCode =
  | 'api_timeout'
  | 'api_network'
  | 'invalid_json'
  | 'invalid_response'
  | 'api_not_ok'
  | 'unknown_rule'
  | 'invalid_email'
  | 'duplicate_group'
  | 'missing_group'
  | 'admin_group_empty'
  | 'too_many_pages'
  | 'store_failed'
  | `api_http_${number}`;

export type GroupSyncResult =
  | { ok: true; changed: boolean; groups: number; members: number; added: number; removed: number }
  | { ok: false; code: SyncFailureCode | 'config_error' };

// ---------- 설정 ----------

function isPlaceholder(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  return t.length === 0 || PLACEHOLDER_RE.test(t);
}

/**
 * 자동 동기화 설정. 계정 ID·토큰 중 하나라도 없거나 자리표시자면 null(자동 모드 아님).
 * null 이면 동기화를 실행하지 않고, 수동 입력 API 가 계속 열려 있다.
 */
export function groupSyncConfig(env: Env): GroupSyncConfig | null {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  if (isPlaceholder(accountId) || isPlaceholder(apiToken)) return null;
  const id = (accountId as string).trim();
  const token = (apiToken as string).trim();
  // 경로·헤더에 그대로 들어가므로 형식을 먼저 막는다
  if (!ACCOUNT_ID_RE.test(id) || !API_TOKEN_RE.test(token)) return null;
  return { accountId: id, apiToken: token };
}

export function isAutoSyncEnabled(env: Env): boolean {
  return groupSyncConfig(env) !== null;
}

/** 다음 예정 시각 (15분 경계, UTC) */
export function nextGroupSyncAt(now: Date): string {
  const step = 15 * 60 * 1000;
  return new Date(Math.floor(now.getTime() / step) * step + step).toISOString();
}

// ---------- 응답 해석 ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 이메일 규칙인지 (키가 정확히 하나씩인 경우만 인정) */
function isEmailRule(r: unknown): boolean {
  if (!isPlainObject(r)) return false;
  const keys = Object.keys(r);
  if (keys.length !== 1 || keys[0] !== 'email') return false;
  const body = r.email;
  if (!isPlainObject(body)) return false;
  const bodyKeys = Object.keys(body);
  return bodyKeys.length === 1 && bodyKeys[0] === 'email';
}

/** 규칙에서 이메일 값만 꺼냄 (없으면 null) */
function readRuleEmail(r: unknown): string | null {
  const body = isPlainObject(r) ? r.email : null;
  const v = isPlainObject(body) ? body.email : null;
  return typeof v === 'string' ? v : null;
}

function collectEmails(rules: unknown[], out: Set<string>): SyncFailureCode | null {
  for (const rule of rules) {
    if (!isEmailRule(rule)) return 'unknown_rule'; // MUTATION:UNKNOWN-RULE
    const raw = readRuleEmail(rule);
    if (raw === null) return 'invalid_email';
    const e = raw.trim().toLowerCase();
    if (!isEmail(e)) return 'invalid_email';
    out.add(e);
  }
  return null;
}

/** require 는 로그인 방식 조건만 허용, 구성원 계산에는 쓰지 않는다. */
function checkRequire(rules: unknown[]): SyncFailureCode | null {
  for (const rule of rules) {
    if (!isPlainObject(rule)) return 'unknown_rule';
    const keys = Object.keys(rule);
    if (keys.length !== 1 || !REQUIRE_ALLOWED.has(keys[0] as string)) return 'unknown_rule';
  }
  return null;
}

function ruleArray(v: unknown): unknown[] | null {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : null;
}

/**
 * 그룹 객체 목록 → 그룹별 구성원.
 * 구성원 = include 의 이메일 − exclude 의 이메일. 허용 목록 밖 그룹은 무시.
 */
export function parseGroups(result: unknown[]): { ok: true; groups: GroupMembers[] } | { ok: false; code: SyncFailureCode } {
  const found = new Map<string, string[]>();
  for (const g of result) {
    if (!isPlainObject(g)) return { ok: false, code: 'invalid_response' };
    const name = g.name;
    // 이름 없는 그룹은 허용 목록에 있을 수 없으므로 건너뜀
    if (typeof name !== 'string') continue;
    // 허용 목록 밖 그룹은 규칙 검사도 하지 않고 무시한다.
    // (Access 에는 everyone·도메인 규칙을 쓰는 다른 그룹이 있어, 검사하면 동기화가 늘 실패한다)
    if (!SYNC_GROUP_SET.has(name)) continue; // MUTATION:ALLOWLIST
    if (found.has(name)) return { ok: false, code: 'duplicate_group' };

    const include = ruleArray(g.include);
    const exclude = ruleArray(g.exclude);
    const require = ruleArray(g.require);
    if (include === null || exclude === null || require === null) return { ok: false, code: 'invalid_response' };

    const reqErr = checkRequire(require);
    if (reqErr) return { ok: false, code: reqErr };

    const inc = new Set<string>();
    const exc = new Set<string>();
    const incErr = collectEmails(include, inc);
    if (incErr) return { ok: false, code: incErr };
    const excErr = collectEmails(exclude, exc);
    if (excErr) return { ok: false, code: excErr };

    found.set(name, [...inc].filter((e) => !exc.has(e)).sort());
  }

  for (const g of REQUIRED_GROUPS) {
    if (!found.has(g)) return { ok: false, code: 'missing_group' };
  }
  // 관리자 잠김 방지: 계산 결과가 0명이면 전체 실패
  for (const g of LOCKOUT_GROUPS) {
    if ((found.get(g) ?? []).length === 0) return { ok: false, code: 'admin_group_empty' };
  }

  // 선택 그룹이 응답에 없으면 구성원 0명 (권한이 생기지 않는 쪽)
  for (const name of SYNC_GROUPS) if (!found.has(name)) found.set(name, []);
  const order = (n: string) => SYNC_GROUP_ORDER.indexOf(n);
  return {
    ok: true,
    groups: [...found.entries()]
      .map(([group_name, emails]) => ({ group_name, emails }))
      .sort((a, b) => order(a.group_name) - order(b.group_name)),
  };
}

// ---------- 호출 ----------

async function fetchAllGroups(
  cfg: GroupSyncConfig,
  deps: GroupSyncDeps,
): Promise<{ ok: true; result: unknown[] } | { ok: false; code: SyncFailureCode }> {
  const perPage = deps.perPage ?? 100;
  const maxPages = deps.maxPages ?? 20;
  const timeout = deps.timeoutMs ?? 10_000;
  const all: unknown[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${API_BASE}/accounts/${cfg.accountId}/access/groups?page=${page}&per_page=${perPage}`;
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.apiToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'api_timeout' : 'api_network' };
    }
    if (res.status !== 200) {
      const code = res.status >= 100 && res.status <= 599 ? res.status : 0;
      return { ok: false, code: `api_http_${code}` as SyncFailureCode };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, code: 'invalid_json' };
    }
    if (!isPlainObject(body)) return { ok: false, code: 'invalid_response' };
    if (body.success !== true) return { ok: false, code: 'api_not_ok' };
    const result = body.result;
    if (!Array.isArray(result)) return { ok: false, code: 'invalid_response' };
    all.push(...result);

    const info = body.result_info;
    const totalPages = isPlainObject(info) ? info.total_pages : undefined;
    if (typeof totalPages === 'number' && Number.isInteger(totalPages)) {
      if (page >= totalPages) return { ok: true, result: all };
    } else if (result.length < perPage) {
      return { ok: true, result: all };
    }
  }
  return { ok: false, code: 'too_many_pages' };
}

// ---------- 사본 교체 (수동 입력과 공용) ----------

export function snapshotReplaceStmts(db: D1Database, groups: GroupMembers[], nowIso: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM access_group_snapshot'),
    ...groups.flatMap((g) =>
      g.emails.map((e) =>
        db.prepare('INSERT INTO access_group_snapshot (group_name, email, synced_at) VALUES (?, ?, ?)').bind(g.group_name, e, nowIso),
      ),
    ),
    db
      .prepare(
        'INSERT INTO sync_state (key, last_success_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_success_at = excluded.last_success_at',
      )
      .bind(GROUP_SYNC_KEY, nowIso),
  ];
}

export interface SnapshotDiff {
  added: string[][];
  removed: string[][];
  addedCount: number;
  removedCount: number;
  truncated: boolean;
}

export function snapshotDiff(current: { group_name: string; email: string }[], next: GroupMembers[]): SnapshotDiff {
  const nextPairs = new Set(next.flatMap((g) => g.emails.map((e) => `${g.group_name}\t${e}`)));
  const curPairs = new Set(current.map((r) => `${r.group_name}\t${r.email}`));
  const added = [...nextPairs].filter((p) => !curPairs.has(p)).sort();
  const removed = [...curPairs].filter((p) => !nextPairs.has(p)).sort();
  const split = (p: string) => p.split('\t');
  return {
    added: added.slice(0, DIFF_LIMIT).map(split),
    removed: removed.slice(0, DIFF_LIMIT).map(split),
    addedCount: added.length,
    removedCount: removed.length,
    truncated: added.length > DIFF_LIMIT || removed.length > DIFF_LIMIT,
  };
}

export async function loadSnapshotRows(db: D1Database): Promise<{ group_name: string; email: string }[]> {
  const res = await db.prepare('SELECT group_name, email FROM access_group_snapshot').all<{ group_name: string; email: string }>();
  return res.results ?? [];
}

// ---------- 상태 기록 ----------

export interface GroupSyncStateRow {
  key: string;
  last_attempt_at: string;
  last_outcome: 'success' | 'failure';
  last_failure_code: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  stale_audited_at: string | null;
}

export async function loadSyncState(db: D1Database): Promise<GroupSyncStateRow | null> {
  return db.prepare('SELECT * FROM group_sync_state WHERE key = ?').bind(GROUP_SYNC_KEY).first<GroupSyncStateRow>();
}

const STATE_UPSERT = `INSERT INTO group_sync_state
  (key, last_attempt_at, last_outcome, last_failure_code, last_failure_at, consecutive_failures, stale_audited_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  last_attempt_at = excluded.last_attempt_at,
  last_outcome = excluded.last_outcome,
  last_failure_code = excluded.last_failure_code,
  last_failure_at = excluded.last_failure_at,
  consecutive_failures = excluded.consecutive_failures,
  stale_audited_at = excluded.stale_audited_at`;

function stateStmt(
  db: D1Database,
  row: Omit<GroupSyncStateRow, 'key'>,
): D1PreparedStatement {
  return db
    .prepare(STATE_UPSERT)
    .bind(
      GROUP_SYNC_KEY,
      row.last_attempt_at,
      row.last_outcome,
      row.last_failure_code,
      row.last_failure_at,
      row.consecutive_failures,
      row.stale_audited_at,
    );
}

// ---------- 실행 ----------

/**
 * 15분 Cron 본체.
 * 실패하면 기존 사본과 sync_state 를 그대로 둔다(그 뒤 30분 규칙이 쓰기를 막는다).
 */
export async function runGroupSync(db: D1Database, env: Env, deps: GroupSyncDeps): Promise<GroupSyncResult> {
  const cfg = groupSyncConfig(env);
  if (cfg === null) {
    // 설정이 없으면 외부 호출 0건. 수동 입력으로 계속 운영한다.
    console.error('config_error', 'group_sync_not_configured');
    return { ok: false, code: 'config_error' };
  }
  const requestId = deps.requestId ?? `cron-${crypto.randomUUID()}`;
  const fetched = await fetchAllGroups(cfg, deps);
  const parsed = fetched.ok ? parseGroups(fetched.result) : fetched;

  if (!parsed.ok) {
    await recordFailure(db, parsed.code, deps.now(), requestId);
    return { ok: false, code: parsed.code };
  }

  const nowIso = deps.now().toISOString();
  const groups = parsed.groups;
  try {
    const current = await loadSnapshotRows(db);
    const diff = snapshotDiff(current, groups);
    const changed = diff.addedCount > 0 || diff.removedCount > 0;
    const stmts = [
      ...snapshotReplaceStmts(db, groups, nowIso),
      stateStmt(db, {
        last_attempt_at: nowIso,
        last_outcome: 'success',
        last_failure_code: null,
        last_failure_at: null,
        consecutive_failures: 0,
        stale_audited_at: null,
      }),
    ];
    if (changed) {
      // 내용이 바뀐 경우에만 감사기록 1건
      await runAudited(db, async () => ({
        stmts,
        entry: {
          ts: nowIso,
          actor_email: GROUP_SYNC_ACTOR,
          action: 'group_snapshot_sync',
          target: 'access_group_snapshot',
          detail: {
            source: 'auto',
            groups: groups.map((g) => ({ group_name: g.group_name, count: g.emails.length })),
            added: diff.added,
            removed: diff.removed,
            added_count: diff.addedCount,
            removed_count: diff.removedCount,
            truncated: diff.truncated,
          },
          request_id: requestId,
        },
      }));
    } else {
      await db.batch(stmts);
    }
    return {
      ok: true,
      changed,
      groups: groups.length,
      members: groups.reduce((n, g) => n + g.emails.length, 0),
      added: diff.addedCount,
      removed: diff.removedCount,
    };
  } catch (err) {
    console.error('group_sync_store_failed', err instanceof Error ? err.name : 'unknown');
    await recordFailure(db, 'store_failed', deps.now(), requestId);
    return { ok: false, code: 'store_failed' };
  }
}

/**
 * 실패 기록. 사본·sync_state 는 건드리지 않는다.
 * 감사기록은 (1) 사유가 바뀐 첫 실패, (2) 사본이 30분을 넘긴 첫 시점에만 남긴다.
 */
async function recordFailure(db: D1Database, code: SyncFailureCode, now: Date, requestId: string): Promise<void> {
  const nowIso = now.toISOString();
  try {
    const prev = await loadSyncState(db);
    const sameReason = prev?.last_outcome === 'failure' && prev.last_failure_code === code;
    const failures = (prev?.last_outcome === 'failure' ? prev.consecutive_failures : 0) + 1;

    const syncRow = await db
      .prepare('SELECT last_success_at FROM sync_state WHERE key = ?')
      .bind(GROUP_SYNC_KEY)
      .first<{ last_success_at: string }>();
    const stale = isSnapshotStale(syncRow?.last_success_at ?? null, now);
    const staleAudit = stale && (prev?.stale_audited_at ?? null) === null;

    const next: Omit<GroupSyncStateRow, 'key'> = {
      last_attempt_at: nowIso,
      last_outcome: 'failure',
      last_failure_code: code,
      last_failure_at: nowIso,
      consecutive_failures: failures,
      stale_audited_at: staleAudit ? nowIso : (prev?.stale_audited_at ?? null),
    };

    if (sameReason && !staleAudit) {
      await db.batch([stateStmt(db, next)]);
      return;
    }
    // 감사기록이 필요한 경우: 상태 갱신 + 감사 1건을 한 batch 로
    if (!sameReason) {
      await runAudited(db, async () => ({
        stmts: [stateStmt(db, next)],
        entry: {
          ts: nowIso,
          actor_email: GROUP_SYNC_ACTOR,
          action: 'group_sync_failed',
          target: 'access_group_snapshot',
          detail: { code, consecutive_failures: failures, snapshot_stale: stale },
          request_id: requestId,
        },
      }));
    } else {
      await db.batch([stateStmt(db, next)]);
    }
    if (staleAudit) {
      await runAudited(db, async () => ({
        stmts: [],
        entry: {
          ts: nowIso,
          actor_email: GROUP_SYNC_ACTOR,
          action: 'group_sync_stale',
          target: 'access_group_snapshot',
          detail: { code, last_success_at: syncRow?.last_success_at ?? null },
          request_id: requestId,
        },
      }));
    }
  } catch (err) {
    console.error('group_sync_state_failed', err instanceof Error ? err.name : 'unknown');
  }
}
