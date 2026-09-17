// 번들 검사: 배포 모의 산출물(dist)에 Worker 에서 쓸 수 없는 구문이 없는지 확인한다.
//
// 왜: 로컬 vitest 는 environment 'node' 라서, Node 에서만 되는 코드(new Function · node:fs)가
// 시험을 통과할 수 있다. 실제 Worker 번들을 직접 읽어 막는다.
//
// 실행: npm run test:bundle -w apps/hub  (build:dry 를 먼저 돌린다)
// 산출물이 없으면 건너뛰지 않고 실패한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(HUB, 'dist');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}${detail ? '\t' + detail : ''}`);
};

console.log('# wrangler deploy --dry-run (로그인 불필요, 실제 배포 아님)');
try {
  execFileSync('npm', ['run', 'build:dry'], {
    cwd: HUB,
    stdio: 'pipe',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' },
  });
} catch (e) {
  check('build:dry 실행', false, String(e.message).slice(0, 200));
}

check('dist 디렉터리가 생성됨 (없으면 건너뛰지 않고 실패)', existsSync(DIST));

let files = [];
if (existsSync(DIST)) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|cjs)$/.test(name)) files.push(p);
    }
  };
  walk(DIST);
}
check('번들 파일을 찾음', files.length > 0, `${files.length}개`);

// 주석은 빼고 코드만 본다
const strip = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

const BANNED = {
  'new Function': /\bnew Function\s*\(/,
  'eval(': /(^|[^.\w$])eval\s*\(/,
  'node:fs': /["']node:fs["']/,
  'node: 내장 모듈': /["']node:[a-z_]+["']/,
  'require(': /(^|[^.\w$])require\s*\(["']/,
};

let total = 0;
for (const [name, re] of Object.entries(BANNED)) {
  const hits = [];
  for (const f of files) {
    const code = strip(readFileSync(f, 'utf8'));
    const m = re.exec(code);
    if (m) hits.push(`${f.slice(HUB.length)}:${code.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\n/g, ' ')}`);
  }
  total += hits.length;
  check(`번들에 ${name} 없음`, hits.length === 0, hits.slice(0, 2).join(' | '));
}

// 사전 컴파일 검사기가 실제로 번들에 들어갔는지 (Ajv 런타임이 아니라)
const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
check('사전 컴파일 검사기가 번들에 들어감', all.includes('kpi-summary/1.2.json'));
check('Ajv 런타임 컴파일러가 번들에 없음', !/ajv\/dist\/compile\/codegen/.test(all) && !all.includes('_ajvErrors'));

const size = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`# 번들 ${files.length}개 · ${(size / 1024).toFixed(1)} KiB · 금지 구문 ${total}건`);

const failed = results.filter((r) => !r.ok).length;
console.log(`# bundle-check ${results.length - failed}/${results.length} 통과`);
process.exitCode = failed ? 1 : 0;
console.log(`# bundle-check 종료코드 ${process.exitCode}`);
