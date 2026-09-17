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
  ['admin: ADMIN 확인 끔', 'src/admin.ts', "if (!c.get('principal').isHubAdmin)", 'if (false)'],
  // WP1
  ['groupsync: 허용 목록 검사 끔', 'src/groupsync.ts', /^.*\/\/ MUTATION:ALLOWLIST\n/m, ''],
  ['groupsync: 알 수 없는 규칙 검사 끔', 'src/groupsync.ts', /^.*\/\/ MUTATION:UNKNOWN-RULE\n/m, ''],
  ['groupsync: ADMIN 0명 거부 끔', 'src/groupsync.ts', "if ((found.get(g) ?? []).length === 0) return { ok: false, code: 'admin_group_empty' };", ''],
  ['groupsync: 실패해도 사본 교체', 'src/groupsync.ts', 'const parsed = fetched.ok ? parseGroups(fetched.result) : fetched;', 'const parsed = parseGroups(fetched.ok ? fetched.result : []);'],
  ['admin: 자동 모드에서 수동 입력 허용', 'src/admin.ts', 'if (isAutoSyncEnabled(c.env)) {', 'if (false) {'],
];

function prepare(name, mutate) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const part of ['src', 'test', 'migrations', 'public', 'scripts', 'vitest.config.ts', 'package.json', 'tsconfig.json', 'wrangler.jsonc']) {
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
