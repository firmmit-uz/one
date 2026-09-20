// 간단 변이 시험: 보안 검사를 일부러 끈 복사본에서 시험이 실패하는지 확인
// 실행: node test/mutation.mjs  (미검출 변이가 있으면 exitCode = 1)
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = fileURLToPath(new URL('..', import.meta.url));
const WORK = join(HUB, '.mutants');
const require = createRequire(import.meta.url);
const VITEST = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

// [이름, 파일, 찾을 문자열/정규식, 바꿀 문자열]
const MUTANTS = [
  ['auth: aud 확인 끔', 'src/auth.ts', /^.*\/\/ MUTATION:AUD\n/m, ''],
  ['auth: iss 확인 끔', 'src/auth.ts', /^\s+issuer,\n/m, ''],
  ['audit: UPDATE/DELETE/REPLACE 트리거 제거', 'migrations/0001_init.sql', /-- MUTATION:TRIGGER-BEGIN[\s\S]*?-- MUTATION:TRIGGER-END/, ''],
  ['audit: REPLACE 방어 트리거만 제거', 'migrations/0001_init.sql', /CREATE TRIGGER audit_log_no_replace[\s\S]*?END;/, ''],
  ['authz: 계정 상태 확인 끔', 'src/authz.ts', "if (user.status !== 'active')", 'if (false)'],
  ['authz: 그룹 상한 무시 끔', 'src/authz.ts', "if (rank > ceiling) return 'over_ceiling';", ''],
  ['authz: 사본 30분 쓰기 제한 끔', 'src/app.ts', '!canWrite(p)', 'false'],
  ['csrf: Origin 확인 끔', 'src/app.ts', "if (c.req.header('Origin') !== allowed)", 'if (false)'],
  ['admin·cctv 공용 관문: ADMIN 확인 끔', 'src/guard.ts', "if (!c.get('principal').isHubAdmin)", 'if (false)'],
  // WP1
  ['groupsync: 허용 목록 검사 끔', 'src/groupsync.ts', /^.*\/\/ MUTATION:ALLOWLIST\n/m, ''],
  ['groupsync: 알 수 없는 규칙 검사 끔', 'src/groupsync.ts', /^.*\/\/ MUTATION:UNKNOWN-RULE\n/m, ''],
  ['groupsync: ADMIN 0명 거부 끔', 'src/groupsync.ts', "if ((found.get(g) ?? []).length === 0) return { ok: false, code: 'admin_group_empty' };", ''],
  ['groupsync: 실패해도 사본 교체', 'src/groupsync.ts', 'const parsed = fetched.ok ? parseGroups(fetched.result) : fetched;', 'const parsed = parseGroups(fetched.ok ? fetched.result : []);'],
  ['admin: 자동 모드에서 수동 입력 허용', 'src/admin.ts', 'if (isAutoSyncEnabled(c.env)) {', 'if (false) {'],
  // WP2
  ['kpi: stale 재계산 결과 무시', 'src/kpi/gateway.ts', "return stale.is_stale ? worstStatus(base, 'stale') : base;", 'return base;'],
  [
    'kpi: 권한 필터 끔',
    'src/kpi/gateway.ts',
    '    const level = viewLevelFor(def.kpi_id, visibility, groups);\n    if (level === null) continue; // 권한 없음 → 응답에서 제거',
    "    const level = viewLevelFor(def.kpi_id, visibility, groups) ?? 'summary';",
  ],
  [
    'kpi: 소스 봉투 검증 끔 (통화 합산·개인정보 검사 포함)',
    'src/kpi/source.ts',
    /  if \(!r\.ok\) \{\n    return \{ ok: false, code: 'SOURCE_SCHEMA'[\s\S]*?\n  \}\n/,
    '',
  ],
  ['kpi: 증적 형식 검사 끔', 'src/kpi/phase0.ts', 'for (const b of EVIDENCE_BANNED) if (b.re.test(value)) return { ok: false, reason: b.reason };', ''],
  ['kpi: 깨진 캐시도 내보냄', 'src/kpi/gateway.ts', "if (typeof kpi.measure !== 'object' || kpi.measure === null) return null;", ''],
  // WP3
  [
    'tokens: 버전 조건 제거 (④)',
    'src/tokens/refresh.ts',
    "'UPDATE tokens SET ciphertext = ?, iv = ?, key_version = ?, version = version + 1, expires_at = ?, updated_at = ?, last_refresh_journal_id = ? WHERE token_id = ? AND version = ?',",
    "'UPDATE tokens SET ciphertext = ?, iv = ?, key_version = ?, version = version + 1, expires_at = ?, updated_at = ?, last_refresh_journal_id = ? WHERE token_id = ? AND ? IS NOT NULL',",
  ],
  [
    'tokens: 실행권 해제에서 holder 조건 제거 (⑥)',
    'src/tokens/refresh.ts',
    "'UPDATE token_lease SET lease_until = ?1 WHERE token_id = ?2 AND holder = ?3'",
    "'UPDATE token_lease SET lease_until = ?1 WHERE token_id = ?2 AND ?3 IS NOT NULL'",
  ],
  [
    'tokens: 남은 시간 검사 제거 (②)',
    'src/tokens/refresh.ts',
    'if (Date.parse(leaseUntil) - now.getTime() < timeoutMs + marginMs) {',
    'if (false) {',
  ],
  [
    'tokens: ④ 판정을 토큰이 아니라 journal 쪽 결과로 한다',
    'src/tokens/refresh.ts',
    'const tokenChanged = (batch[1]?.meta?.changes ?? 0) > 0;',
    'const tokenChanged = (batch[0]?.meta?.changes ?? 0) > 0;',
  ],
  [
    'tokens: ④ 어긋난 기록 맞추기 제거 (멀쩡한 토큰이 차단된다)',
    'src/tokens/refresh.ts',
    '  if (!journalApplied) {',
    '  if (false && !journalApplied) {',
  ],
  [
    'tokens: ⑤ 어긋난 기록 되돌리기 제거',
    'src/tokens/refresh.ts',
    "{ reason: 'version_conflict', expected_version: token.version }, 'any');",
    "{ reason: 'version_conflict', expected_version: token.version });",
  ],
  ['tokens: 차단 규칙 제거', 'src/tokens/refresh.ts', '  if (block !== null) {', '  if (false && block !== null) {'],
  ['tokens: 기본 꺼짐 무시', 'src/tokens/refresh.ts', "return env.TOKEN_REFRESH_ENABLED === 'true';", "return env.TOKEN_REFRESH_ENABLED !== 'true';"],
  // R3 CCTV
  ['cctv: 기본 꺼짐 무시', 'src/cctv.ts', "return env.CCTV_ENABLED === 'true';", "return env.CCTV_ENABLED !== 'true';"],
  ['cctv: 경로 되감기 검사 끔 (조각·인코딩 우회)', 'src/cctv.ts', "return u.origin === 'https://relay.invalid' && `${u.pathname}${u.search}` === v;", 'return true;'],
  ["cctv: 경로 '..' 검사 끔", 'src/cctv.ts', "if (v.includes('..')) return false;", ''],
  ['cctv: 볼 수 있음 판정 끔', 'src/cctv.ts', /const playable =\n[\s\S]*?\/\/ MUTATION:CCTV-PLAYABLE/, 'const playable = true;'],
  ['cctv: 모르는 인증 방식 허용', 'src/cctv.ts', /^.*\/\/ MUTATION:CCTV-AUTH-UNKNOWN\n/m, "  if (scheme === 'none' || !['basic','cf-access'].includes(scheme)) return { ok: true, headers: [] };\n"],
  ['cctv: 인증 값이 없어도 그냥 부름', 'src/cctv.ts', "  const auth = relayAuth(env);\n  if (!auth.ok) return { ok: false, code: 'relay_auth_misconfigured' };", '  const auth = { ok: true, headers: [] };'],
  ['cctv: 인증 방법이 비어도 익명으로 부름', 'src/cctv.ts', "if (typeof raw !== 'string' || raw.trim() === '') return { ok: false };", "if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, headers: [] };"],
  ['cctv: 중계 서버로 자동 따라가기 허용(workerd 거부값)', 'src/cctv.ts', "redirect: 'manual'", "redirect: 'follow'"],
  ['cctv: 중계 서버 요청에서 no-cache 제거', 'src/cctv.ts', "  headers.set('Cache-Control', 'no-cache');\n", ''],
  ['cctv: https 외 주소 허용', 'src/cctv.ts', "if (u.protocol !== 'https:') return null;", ''],
  ['cctv: 주소에 사용자정보 허용', 'src/cctv.ts', "if (u.username !== '' || u.password !== '') return null;", ''],
  ['cctv: 주소에 경로·질의·조각 허용', 'src/cctv.ts', "if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return null;", ''],
  ['cctv: Range 목록 검사 끔', 'src/cctv.ts', "if (range !== null && RANGE_RE.test(range)) headers.set('Range', range);", "if (range !== null) headers.set('Range', range);"],
  ["cctv: basic 아이디에 ':' 허용", 'src/cctv.ts', "!CRED_RE.test(user) || user.includes(':')", "!CRED_RE.test(user)"],
  ['cctv: 준비 판정에서 인증 설정 무시', 'src/cctv.ts', "return isEnabled(env) && relayOrigin(env) !== null && relayAuth(env).ok;", "return isEnabled(env) && relayOrigin(env) !== null;"],
  ['cctv: 열람 토큰 없이 재생 허용', 'src/cctv.ts', /^.*\/\/ MUTATION:CCTV-VIEW-SESSION\n.*\n.*\n/m, ''],
  ['cctv: HEAD 로 영상 연결 열기 허용', 'src/cctv.ts', "if (c.req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET');", ''],
  ['cctv: 거부할 때 중계 연결을 끊지 않음', 'src/cctv.ts', "    await upstream.body?.cancel().catch(() => undefined);\n", ''],
  ['cctv: 가장자리 캐시 허용', 'src/cctv.ts', "cf: { cacheEverything: false }", "cf: { cacheEverything: true }"],
  ['cctv: 카메라 이름 규칙 검사 끔', 'src/cctv.ts', "if (!CAMERA_ID_RE.test(v)) throw new ValidationError('invalid_format', 'camera_id');", ''],
  ['admin: 카메라 정렬값 검사 끔', 'src/admin.ts', "if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 9999) {", 'if (false) {'],
  ['cctv: 중계 서버 응답 형식 확인 끔', 'src/cctv.ts', 'if (ct !== ALLOWED_UPSTREAM_TYPES[target.kind]) {', 'if (false) {'],
  ['cctv: 중계 서버 응답 코드 확인 끔', 'src/cctv.ts', 'if (upstream.status !== 200 && upstream.status !== 206) {', 'if (false) {'],
  [
    'cctv: 중계 서버 머리말을 그대로 내보냄',
    'src/cctv.ts',
    /  for \(const k of PASS_RESPONSE_HEADERS\) \{\n[\s\S]*?\n  \}\n/,
    '  upstream.headers.forEach((v, k) => out.set(k, v));\n',
  ],
  ['cctv: 표 제약(미연결↔경로 짝) 제거', 'migrations/0007_cctv.sql', /  CHECK \(\(status = 'not_connected'[\s\S]*?stream_path IS NOT NULL\)\)/, '  CHECK (1 = 1)'],
];

function prepare(name, mutate) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const part of ['src', 'test', 'migrations', 'public', 'scripts', 'docs', 'vitest.config.ts', 'package.json', 'tsconfig.json', 'wrangler.jsonc']) {
    cpSync(join(HUB, part), join(dir, part), {
      recursive: true,
      filter: (p) => !p.includes(`${'/'}screens`) && !p.endsWith('.ui-server.mjs'),
    });
  }
  if (mutate) {
    const [, file, find, repl] = mutate;
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(find, repl);
    if (after === before) throw new Error(`변이 적용 실패: ${mutate[0]}`);
    writeFileSync(path, after);
  }
  return dir;
}

function runVitest(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, 'run', '--reporter=dot'], {
      cwd: dir,
      env: { ...process.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
      const m = /^\s*Tests\s+(\d.*)$/m.exec(clean);
      resolve({ code, summary: m ? m[1].trim() : clean.slice(-300) });
    });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        results[k] = await fn(items[k], k);
      }
    }),
  );
  return results;
}

const baselineDir = prepare('baseline', null);
const baseline = await runVitest(baselineDir);
console.log(`기준(변이 없음): ${baseline.code === 0 ? '통과' : '실패'} — ${baseline.summary}`);
if (baseline.code !== 0) {
  console.error('기준 시험이 실패하여 변이 결과를 신뢰할 수 없음');
  process.exitCode = 1;
}

const results = await pool(MUTANTS, 3, async (m, k) => {
  const dir = prepare(`m${k + 1}`, m);
  const r = await runVitest(dir);
  return { name: m[0], killed: r.code !== 0, summary: r.summary };
});

let survived = 0;
for (const r of results) {
  if (!r.killed) survived++;
  console.log(`${r.killed ? '검출' : '미검출'}  ${r.name} — ${r.summary}`);
}
console.log(`\n변이 ${results.length}개 중 검출 ${results.length - survived}, 미검출 ${survived}`);
if (survived > 0) process.exitCode = 1;
if (existsSync(WORK) && process.exitCode !== 1) rmSync(WORK, { recursive: true, force: true });
