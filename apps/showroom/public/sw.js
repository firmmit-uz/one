// TV 쇼룸 서비스 워커 — 마지막 승인본을 미리 저장해 네트워크가 끊겨도 화면이 돌게 한다.
//
//  · 저장하는 것은 **승인된 정적 파일만**이다. 방문객 입력·개인정보는 저장하지 않는다.
//  · localStorage · sessionStorage · IndexedDB · 쿠키는 쓰지 않는다 (Cache Storage 하나만).
//  · 게시 기간 판단은 화면(app.js)이 그때의 시각으로 한다 →
//    오프라인이라 예전 파일을 쓰더라도 만료된 항목은 나오지 않는다.
const CACHE = 'showroom-v1';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'logo.svg', 'content.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // 콘텐츠가 가리키는 그림·QR 도 함께 저장한다 (실패해도 설치는 진행)
      try {
        const res = await fetch('content.json', { cache: 'no-cache' });
        const data = await res.json();
        const media = new Set();
        for (const item of data.items ?? []) if (item.media) media.add(item.media);
        for (const link of data.links ?? []) if (link.qr) media.add(link.qr);
        for (const s of data.safe_screen ?? []) if (s.qr) media.add(s.qr);
        await cache.addAll([...media]);
      } catch {
        /* 콘텐츠를 못 읽어도 껍데기는 저장한다 → 안전 화면이 뜬다 */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 같은 주소의 파일만 다룬다 (외부 요청은 애초에 없다)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          // content.json 과 정적 파일은 최신본으로 저장해 둔다
          await cache.put(req, fresh.clone());
          return fresh;
        }
      } catch {
        /* 네트워크 없음 → 저장본으로 */
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // 화면 이동(SPA)은 저장해 둔 index.html 로
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504 });
    })(),
  );
});
