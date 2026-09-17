// 콘텐츠 검사·화면 코드의 규칙 시험. 실패가 하나라도 있으면 exitCode=1.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_URLS, BANNED, checkManifest, CONTENT_DIR, loadManifest, ROOT, SAFE_SCREEN_URLS } from '../scripts/check-content.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}${detail ? '\t' + detail : ''}`);
};
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const clone = () => JSON.parse(JSON.stringify(base));
const base = loadManifest();

// ---------- 1. 지금 콘텐츠는 통과한다 ----------
check('현재 manifest 가 검사를 통과', checkManifest(base).length === 0, checkManifest(base).slice(0, 2).join(' | '));
check('샘플 묶음이라 승인 전 표시가 필요', base.release.status === 'sample');
check('모든 항목의 승인자가 SAMPLE (가짜 승인 정보 없음)', base.items.every((i) => i.approved_by === 'SAMPLE' && i.approved_at === null));

// ---------- 2. 막아야 하는 것이 실제로 막힌다 ----------
const mustFail = [
  ['승인 정보 없음', (m) => { m.release.status = 'approved'; m.items[0].approved_by = ''; }],
  ['승인일 없음', (m) => { m.release.status = 'approved'; for (const i of m.items) { i.approved_by = '해외사업부장'; i.approved_at = null; } }],
  ['승인자가 실명으로 보임', (m) => { m.release.status = 'approved'; for (const i of m.items) { i.approved_by = '박선기'; i.approved_at = '2026-09-17'; } }],
  ['기간 역전', (m) => { m.items[0].publish_from = '2027-01-01'; m.items[0].expires_at = '2026-01-01'; }],
  ['파일 없음', (m) => { m.items[0].media = 'media/없는파일.svg'; }],
  ['이메일', (m) => { m.items[0].subtitle.ko = '문의 staff@example.invalid 로 주세요'; }],
  ['전화번호', (m) => { m.items[0].subtitle.ko = '전화 010-1234-5678'; }],
  ['내부 배포 주소(workers.dev)', (m) => { m.items[0].subtitle.ko = 'firmmit-nongjajae.global-630.workers.dev'; }],
  ['내부 배포 주소(vercel.app)', (m) => { m.items[0].subtitle.ko = 'firmmit-amim.vercel.app 참고'; }],
  ['구글 시트 주소', (m) => { m.items[0].subtitle.ko = 'docs.google.com 문서'; }],
  ['시트 ID 형태', (m) => { m.items[0].subtitle.ko = '1PxQjaBcDeFgHiJkLmNoPqRsTuVwXyZ0123'; }],
  ['IP 주소', (m) => { m.items[0].subtitle.ko = '92.5.30.63 서버'; }],
  ['http 주소', (m) => { m.items[0].subtitle.ko = 'http://example.invalid'; }],
  ['스크립트 태그', (m) => { m.items[0].subtitle.ko = '<script>alert(1)</script>'; }],
  ['허용 밖 링크', (m) => { m.links[0].url = 'https://one.firmmit.com'; }],
  ['모르는 링크 참조', (m) => { m.items[3].links = ['nope']; }],
  ['언어 빠짐', (m) => { delete m.items[0].title.en; }],
  ['목록에 없는 언어', (m) => { m.items[0].title.ru = 'Тест'; }],
  ['id 중복', (m) => { m.items[1].id = m.items[0].id; }],
  ['모르는 status', (m) => { m.items[0].status = 'live'; }],
  ['links 화면에 링크 없음', (m) => { m.items[3].links = []; }],
  ['자동재생 간격이 너무 짧음', (m) => { m.autoplay_seconds = 1; }],
];
const survived = [];
for (const [name, mutate] of mustFail) {
  const m = clone();
  mutate(m);
  if (checkManifest(m).length === 0) survived.push(name);
}
check(`막아야 하는 ${mustFail.length}가지가 모두 빌드 실패`, survived.length === 0, survived.join(', '));

// 대조군: 정상 승인 묶음은 통과해야 한다 (검사기가 무조건 실패하는 것이 아님을 보인다)
const approved = clone();
approved.release.status = 'approved';
for (const i of approved.items) {
  i.approved_by = '해외사업부장';
  i.approved_at = '2026-09-17';
}
check('정상 승인 묶음은 통과 (검사기가 무조건 막는 것이 아님)', checkManifest(approved).length === 0, checkManifest(approved).slice(0, 2).join(' | '));

// ---------- 3. 화면 코드 규칙 ----------
const appJs = read('public/app.js');
const swJs = read('public/sw.js');
const html = read('public/index.html');
const css = read('public/styles.css');

// 주석에서 규칙을 설명하는 것은 허용 — 실제 코드만 본다
const stripComments = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
const appCode = stripComments(appJs);
const swCode = stripComments(swJs);

check('브라우저 저장소를 쓰지 않는다 (localStorage·sessionStorage·IndexedDB·쿠키)',
  !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(appCode + swCode));
check('HTML 문자열을 넣지 않는다', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(appCode + swCode));
// 코드에 박힌 주소는 공개 허용 목록의 것만 허용한다.
// (안전 화면은 content.json 이 없을 때도 떠야 하므로 공개 홈페이지 주소를 코드에 둔다)
let codeNoAllowed = appCode + swCode;
for (const u of ALLOWED_URLS) codeNoAllowed = codeNoAllowed.split(u).join('');
check('코드에 박힌 주소는 공개 허용 목록의 것만', !/['"`]https?:\/\//.test(codeNoAllowed));
check('안전 화면 주소가 공개 허용 목록 안에 있다', ALLOWED_URLS.some((u) => appCode.includes(u)));
check('외부 스크립트·스타일·글꼴이 없다', !/(src|href)="https?:\/\//.test(html) && !/@import|fonts\.googleapis/.test(css));
check('iframe 이 없다', !/<iframe/i.test(html) && !/iframe/i.test(appCode));
check('폼·입력칸이 없다 (방문객 입력이 남지 않는다)', !/<form|<input|<textarea/i.test(html) && !/createElement\('(form|input|textarea)'/.test(appCode));
check('허브 API 를 부르지 않는다 (완전 분리)', !/\/api\/|fm-one-hub|cloudflareaccess/.test(appCode + swCode + html));
const headers = read('public/_headers');
check('CSP 가 같은 주소만 허용', html.includes("default-src 'self'") && headers.includes("frame-ancestors 'none'"));
check('frame-ancestors 는 헤더로 준다 (meta 로는 무시된다)', !html.includes('frame-ancestors') && headers.includes('X-Frame-Options: DENY'));
check('숨긴 요소가 실제로 숨겨진다', css.includes('.index-overlay[hidden]') && css.includes('display: none'));
check('#9898A0 를 글자색으로 쓰지 않는다', !/color:\s*#9898a0/i.test(css));
check('EBU R 95 안전 여백 5% 를 쓴다', css.includes('--safe: 5%') && css.includes('tech.ebu.ch/publications/r095'));
// 시계 조작(?now=)은 로컬에서만. 배포본에서 받으면 주소창으로 승인 기간을 우회할 수 있다.
check('?now= 를 읽는 곳이 forcedDate() 한 군데뿐이다', (appCode.match(/get\('now'\)/g) ?? []).length === 1);
check('?now= 가 호스트 검사 없이 쓰이지 않는다', !/location\.search\)\.get\('now'\)/.test(appCode));

// wrangler 설정: D1·비밀값·Access 없음
const wrangler = read('wrangler.jsonc');
const cfg = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ''));
check('쇼룸 Worker 이름이 허브와 다르다', cfg.name === 'fm-one-showroom');
check('쇼룸에 D1·변수·비밀값이 없다', cfg.d1_databases === undefined && cfg.vars === undefined && cfg.kv_namespaces === undefined);
check('쇼룸에 Cron 이 없다', cfg.triggers === undefined);

// ---------- 4. 빌드 산출물 ----------
const built = existsSync(join(ROOT, 'public', 'content.json'));
check('content.json 이 만들어져 있다 (npm run build)', built);
if (built) {
  const out = JSON.parse(read('public/content.json'));
  check('QR 이 모든 링크에 붙어 있다', out.links.every((l) => typeof l.qr === 'string' && existsSync(join(ROOT, 'public', l.qr))));
  check('안전 화면 QR 이 있다', out.safe_screen.length === SAFE_SCREEN_URLS.length && out.safe_screen.every((s) => existsSync(join(ROOT, 'public', s.qr))));
  check('공개 주소만 들어 있다', out.links.every((l) => ALLOWED_URLS.includes(l.url)));
  const text = JSON.stringify(out);
  const hits = BANNED.filter((b) => {
    // 허용 주소는 빼고 본다
    let stripped = text;
    for (const u of ALLOWED_URLS) stripped = stripped.split(u).join('');
    return b.re.test(stripped);
  });
  check('산출물에 금지 패턴이 없다', hits.length === 0, hits.map((h) => h.name).join(','));
}

// ---------- 5. 표시 조건 ----------
const mod = await import('../public/app.js').catch(() => null);
if (mod?.visibleItems) {
  const content = JSON.parse(read('public/content.json'));
  const today = new Date('2026-09-17T00:00:00Z');
  const shown = mod.visibleItems(content, today).map((i) => i.id);
  check('게시 상태 + 기간 안인 항목만 나온다', shown.join(',') === 'S01,S02,S03,S04', shown.join(','));
  const future = mod.visibleItems(content, new Date('2099-01-01T00:00:00Z')).map((i) => i.id);
  check('먼 미래에도 만료 항목은 안 나온다', !future.includes('S06'));
  const past = mod.visibleItems(content, new Date('2020-01-01T00:00:00Z')).map((i) => i.id);
  check('게시 시작 전에는 아무것도 안 나온다', past.length === 0, past.join(','));
} else {
  check('app.js 의 표시 조건 함수를 불러올 수 있다', false);
}

// ---------- 6. 시계 조작(?now=)은 로컬에서만 ----------
if (mod?.forcedDate) {
  const f = mod.forcedDate;
  check('로컬에서는 ?now= 를 받는다', f('127.0.0.1', '?now=2020-01-01')?.toISOString() === '2020-01-01T12:00:00.000Z');
  check('localhost 도 받는다', f('localhost', '?now=2099-01-01') instanceof Date);
  check('배포 주소에서는 ?now= 를 무시한다 (workers.dev)', f('fm-one-showroom.workers.dev', '?now=2020-01-01') === null);
  check('배포 주소에서는 ?now= 를 무시한다 (사내 주소)', f('show.example.invalid', '?now=2099-01-01') === null);
  check('로컬이어도 형식이 틀리면 무시한다', f('127.0.0.1', '?now=2020-1-1') === null && f('127.0.0.1', '?now=abc') === null);
  check('없는 날짜는 무시한다', f('127.0.0.1', '?now=2026-02-31') === null || f('127.0.0.1', '?now=2026-13-01') === null);
  check('?now= 가 없으면 null (실제 시각을 쓴다)', f('127.0.0.1', '') === null);
} else {
  check('app.js 의 forcedDate() 를 불러올 수 있다', false);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`# content.test ${results.length - failed}/${results.length} 통과`);
process.exitCode = failed ? 1 : 0;
console.log(`# content.test 종료코드 ${process.exitCode}`);
