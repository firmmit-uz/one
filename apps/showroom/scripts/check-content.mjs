// TV 쇼룸 콘텐츠 검사 — 하나라도 걸리면 빌드가 실패한다(exitCode 1).
//
// 막는 것
//  · 승인 정보 없음 (release.status=approved 인데 직책·승인일이 없음)
//  · 기간 역전 (publish_from > expires_at)
//  · 파일 없음 (media 가 가리키는 파일이 실제로 없음)
//  · 내부 정보 형태 (이메일 · 전화번호 · 시트 ID 같은 긴 토큰 · workers.dev · vercel.app · pages.dev · IP)
//  · 허용 밖 링크 (공개 주소 3개 외)
//  · 언어 빠짐 (manifest.languages 의 언어가 하나라도 없음)
//  · 실명으로 보이는 승인자 (직책만 적는다)
//
// 실행: npm run check -w @firmmit-one/showroom
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONTENT_DIR = join(ROOT, 'content');

/** 화면에 내보내도 되는 공개 주소. 직원 인증이 필요한 주소는 절대 넣지 않는다. */
export const ALLOWED_URLS = ['https://firmmitmall.com', 'https://www.firmmit.kr', 'https://t.me/firmmit_global'];

/** 안전 화면(저장본이 없을 때)에 쓰는 주소 — 이메일·전화번호는 넣지 않는다 */
export const SAFE_SCREEN_URLS = ['https://www.firmmit.kr', 'https://t.me/firmmit_global'];

export const BANNED = [
  { name: '이메일', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: '전화번호', re: /(?:\+\d{1,3}[ -]?)?(?:0\d{1,2}|\d{2,3})[ -]\d{3,4}[ -]\d{4}/ },
  { name: '내부 배포 주소', re: /workers\.dev|\.vercel\.app|pages\.dev|cloudflareaccess\.com|clients\.ahost/i },
  { name: '구글 문서·시트 주소', re: /docs\.google\.com|drive\.google\.com|script\.google\.com/i },
  { name: '시트 ID·비밀값 형태', re: /\b[A-Za-z0-9_-]{25,}\b/ },
  { name: 'IP 주소', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: '암호화되지 않은 주소', re: /http:\/\//i },
  { name: '스크립트 태그', re: /<\s*script/i },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID_RE = /^S\d{2}$/;
const STATUSES = ['draft', 'approved', 'published', 'expired', 'withdrawn'];
const TYPES = ['cover', 'section', 'links'];
/** 한글 이름처럼 보이는 값(2~4자)은 직책이 아니라 실명일 가능성이 높다 */
const LOOKS_LIKE_NAME_RE = /^[가-힣]{2,4}$/;

export function loadManifest(dir = CONTENT_DIR) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

function walkStrings(value, path, out) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}.${k}`, out);
}

/**
 * @returns {string[]} 문제 목록 (빈 배열이면 통과)
 */
export function checkManifest(manifest, dir = CONTENT_DIR) {
  const problems = [];
  const bad = (msg) => problems.push(msg);

  if (manifest?.manifest_version !== '1.0') bad(`manifest_version 이 "1.0" 이 아님: ${manifest?.manifest_version}`);
  const release = manifest?.release;
  if (!release || !['sample', 'approved'].includes(release.status)) bad('release.status 는 sample 또는 approved 여야 함');
  const langs = Array.isArray(manifest?.languages) ? manifest.languages : [];
  if (langs.length === 0) bad('languages 가 비어 있음');
  if (!langs.includes(manifest?.default_language)) bad('default_language 가 languages 안에 없음');
  if (!Number.isInteger(manifest?.autoplay_seconds) || manifest.autoplay_seconds < 5) bad('autoplay_seconds 가 없거나 너무 짧음');
  if (!Number.isInteger(manifest?.idle_resume_seconds) || manifest.idle_resume_seconds < 10) bad('idle_resume_seconds 가 없거나 너무 짧음');

  // 언어 빠짐
  const needLangs = (obj, where) => {
    if (obj === undefined) return;
    for (const l of langs) if (obj[l] === undefined) bad(`${where}: 언어 ${l} 이(가) 없음`);
    for (const l of Object.keys(obj)) if (!langs.includes(l)) bad(`${where}: 목록에 없는 언어 ${l}`);
  };
  needLangs(release?.note, 'release.note');

  // 링크 허용 목록
  const linkIds = new Set();
  for (const link of manifest?.links ?? []) {
    if (linkIds.has(link.id)) bad(`링크 id 중복: ${link.id}`);
    linkIds.add(link.id);
    if (!ALLOWED_URLS.includes(link.url)) bad(`허용 밖 링크: ${link.id} → ${link.url}`);
    needLangs(link.label, `links.${link.id}.label`);
  }

  // 항목
  const ids = new Set();
  for (const item of manifest?.items ?? []) {
    const where = `items.${item?.id ?? '?'}`;
    if (!ITEM_ID_RE.test(item?.id ?? '')) bad(`${where}: id 형식이 S00 형태가 아님`);
    if (ids.has(item.id)) bad(`${where}: id 중복`);
    ids.add(item.id);
    if (!TYPES.includes(item?.type)) bad(`${where}: 모르는 type ${item?.type}`);
    if (!STATUSES.includes(item?.status)) bad(`${where}: 모르는 status ${item?.status}`);

    // 승인 정보
    if (release?.status === 'sample') {
      if (item?.approved_by !== 'SAMPLE') bad(`${where}: 샘플 묶음에서는 approved_by 가 반드시 "SAMPLE"`);
      if (item?.approved_at !== null) bad(`${where}: 샘플 묶음에서는 approved_at 이 null`);
    } else {
      if (typeof item?.approved_by !== 'string' || item.approved_by.trim() === '' || item.approved_by === 'SAMPLE') {
        bad(`${where}: 승인자(직책)가 없음`);
      } else if (LOOKS_LIKE_NAME_RE.test(item.approved_by.trim())) {
        bad(`${where}: 승인자는 직책만 적는다(실명으로 보임)`);
      }
      if (!DATE_RE.test(item?.approved_at ?? '')) bad(`${where}: 승인일이 없음`);
    }

    // 기간
    if (!DATE_RE.test(item?.publish_from ?? '')) bad(`${where}: publish_from 날짜 형식 오류`);
    if (!DATE_RE.test(item?.expires_at ?? '')) bad(`${where}: expires_at 날짜 형식 오류`);
    if (DATE_RE.test(item?.publish_from ?? '') && DATE_RE.test(item?.expires_at ?? '') && item.publish_from > item.expires_at) {
      bad(`${where}: 기간 역전 (${item.publish_from} > ${item.expires_at})`);
    }

    needLangs(item?.title, `${where}.title`);
    needLangs(item?.subtitle, `${where}.subtitle`);
    needLangs(item?.body, `${where}.body`);

    // 파일 존재
    if (item?.media !== undefined && !existsSync(join(dir, item.media))) bad(`${where}: 파일 없음 ${item.media}`);

    // 링크 참조
    for (const id of item?.links ?? []) if (!linkIds.has(id)) bad(`${where}: 모르는 링크 ${id}`);
    if (item?.type === 'links' && (item?.links ?? []).length === 0) bad(`${where}: links 화면인데 링크가 없음`);
  }

  // 금지 패턴 (링크 허용 목록은 예외)
  const strings = [];
  walkStrings(manifest, '', strings);
  for (const [path, value] of strings) {
    if (ALLOWED_URLS.includes(value)) continue;
    for (const b of BANNED) if (b.re.test(value)) bad(`${path || '(root)'}: ${b.name} 형태가 들어 있음 — ${JSON.stringify(value.slice(0, 60))}`);
  }

  return problems;
}

// 직접 실행했을 때만 보고한다 (시험에서는 함수만 가져다 쓴다)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = loadManifest();
  const problems = checkManifest(manifest);
  const shown = (manifest.items ?? []).filter((i) => i.status === 'published').length;
  for (const p of problems) console.error(`FAIL\t${p}`);
  console.log(`# 항목 ${manifest.items?.length ?? 0}개 (게시 상태 ${shown}개) · 링크 ${manifest.links?.length ?? 0}개 · 언어 ${(manifest.languages ?? []).join(',')}`);
  console.log(`# 승인 상태: ${manifest.release?.status}`);
  console.log(`# 문제 ${problems.length}건`);
  process.exitCode = problems.length ? 1 : 0;
  console.log(`# check-content 종료코드 ${process.exitCode}`);
}
