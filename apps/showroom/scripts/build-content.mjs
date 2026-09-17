// content/ → public/ 로 내보낸다. 검사를 통과하지 못하면 아무것도 쓰지 않는다.
//
//  1) 콘텐츠 검사 (scripts/check-content.mjs)
//  2) media 파일 복사
//  3) 링크 QR 을 **빌드 시점에** SVG 로 만든다 (화면에서 만들지 않는다 → 실행 중 외부 요청·계산 0)
//  4) public/content.json 작성
//
// 실행: npm run build -w @firmmit-one/showroom
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import { checkManifest, CONTENT_DIR, loadManifest, ROOT, SAFE_SCREEN_URLS } from './check-content.mjs';

const PUBLIC_DIR = join(ROOT, 'public');
const MEDIA_OUT = join(PUBLIC_DIR, 'media');

const manifest = loadManifest();
const problems = checkManifest(manifest);
if (problems.length) {
  for (const p of problems) console.error(`FAIL\t${p}`);
  console.error(`# 콘텐츠 검사 실패 ${problems.length}건 — 아무것도 내보내지 않음`);
  process.exit(1);
}

// media 복사 (내보내는 폴더는 매번 새로 만든다)
rmSync(MEDIA_OUT, { recursive: true, force: true });
mkdirSync(MEDIA_OUT, { recursive: true });
const mediaSrc = join(CONTENT_DIR, 'media');
let copied = 0;
for (const name of readdirSync(mediaSrc)) {
  cpSync(join(mediaSrc, name), join(MEDIA_OUT, name));
  copied++;
}

// QR (오류 정정 M, 여백 2셀). 주소가 짧아 버전은 자동으로 잡힌다.
function qrSvg(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

const qrLinks = [...manifest.links];
// 안전 화면용 QR 도 함께 만든다 (저장본이 없을 때 쓰는 화면)
for (const url of SAFE_SCREEN_URLS) {
  if (!qrLinks.some((l) => l.url === url)) qrLinks.push({ id: `safe-${qrLinks.length}`, url, label: {} });
}
const qrFiles = {};
for (const link of qrLinks) {
  const file = `media/qr-${link.id}.svg`;
  writeFileSync(join(PUBLIC_DIR, file), qrSvg(link.url));
  qrFiles[link.url] = file;
}

// 화면이 읽는 파일. 표시 여부(게시 기간)는 화면이 그때의 시각으로 판단한다.
const out = {
  manifest_version: manifest.manifest_version,
  built_at: new Date().toISOString().slice(0, 10),
  release: manifest.release,
  languages: manifest.languages,
  default_language: manifest.default_language,
  autoplay_seconds: manifest.autoplay_seconds,
  idle_resume_seconds: manifest.idle_resume_seconds,
  links: manifest.links.map((l) => ({ ...l, qr: qrFiles[l.url] })),
  safe_screen: SAFE_SCREEN_URLS.map((url) => ({ url, qr: qrFiles[url] })),
  items: manifest.items,
};
writeFileSync(join(PUBLIC_DIR, 'content.json'), `${JSON.stringify(out, null, 2)}\n`);

console.log(`# media ${copied}개 복사 · QR ${Object.keys(qrFiles).length}개 생성`);
console.log(`# content.json 작성 (항목 ${out.items.length}개 · 승인 상태 ${out.release.status})`);
console.log('# build-content 종료코드 0');
