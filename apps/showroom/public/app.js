// FIRMMIT ONE TV 쇼룸 (방문객용).
//
// 지키는 것
//  · 외부 요청 0건 — 같은 주소의 파일만 읽는다
//  · 저장소를 쓰지 않는다 — localStorage · sessionStorage · IndexedDB · 쿠키 없음
//    (서비스 워커의 Cache Storage 에 승인된 정적 파일만 둔다)
//  · 방문객 입력이 화면에 남지 않는다 — 폼·로그인 없음
//  · 게시 기간이 지난 항목은 오프라인이어도 보여주지 않는다
//  · 저장본이 없거나 깨지면 안전 화면(로고 + 공개 홈페이지 + 공개 채널 QR)으로 간다
//  · HTML 문자열을 넣지 않는다 (textContent · DOM API 만)

const CONTENT_URL = 'content.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const KEYHINT_MS = 8000;
const RETRY_MS = 30_000;

const state = {
  content: null,
  lang: 'ko',
  order: [], // 보여줄 항목 (게시 기간 안)
  index: 0,
  playing: true,
  timer: null,
  idleTimer: null,
  startedAt: Date.now(),
  safe: false,
};

const $ = (id) => document.getElementById(id);

// ---------- DOM 만들기 (HTML 문자열 없음) ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function put(node, ...children) {
  node.replaceChildren();
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const T = {
  ko: { index: '목차', hint: '← → 이동 · Enter 선택 · Home 목차 · Space 재생/정지 · ↑↓ 언어', close: '다시 Home 을 누르면 닫힙니다' },
  en: { index: 'Contents', hint: '← → move · Enter select · Home contents · Space play/pause · ↑↓ language', close: 'Press Home again to close' },
  'uz-Latn': { index: 'Mundarija', hint: '← → · Enter · Home · Space · ↑↓', close: 'Yopish uchun Home' },
  ru: { index: 'Содержание', hint: '← → · Enter · Home · Space · ↑↓', close: 'Home — закрыть' },
};
const t = (k) => (T[state.lang] ?? T.ko)[k] ?? T.ko[k];

function text(obj) {
  if (!obj) return '';
  return obj[state.lang] ?? obj[state.content?.default_language] ?? obj.ko ?? '';
}

function lines(obj) {
  if (!obj) return [];
  const v = obj[state.lang] ?? obj[state.content?.default_language] ?? obj.ko;
  return Array.isArray(v) ? v : [];
}

// ---------- 표시 조건 ----------
/** 게시 상태이고 오늘이 게시 기간 안일 때만 보여준다. 오프라인이어도 만료는 만료다. */
export function visibleItems(content, today) {
  const day = today.toISOString().slice(0, 10);
  return (content?.items ?? []).filter((i) => i.status === 'published' && i.publish_from <= day && day <= i.expires_at);
}

// ---------- 화면 ----------
function slideCover(item) {
  return el(
    'div',
    { class: 'slide-inner cover' },
    el(
      'div',
      { class: 'cover-text' },
      el('p', { class: 'brand', text: text(item.title) }),
      item.subtitle ? el('p', { class: 'sub', text: text(item.subtitle) }) : null,
    ),
    item.media ? el('img', { class: 'media', src: item.media, alt: '' }) : null,
  );
}

function slideSection(item) {
  const col = el(
    'div',
    { class: 'col' },
    el('h2', { text: text(item.title) }),
    item.subtitle ? el('p', { class: 'sub', text: text(item.subtitle) }) : null,
    lines(item.body).length ? el('ul', {}, lines(item.body).map((line) => el('li', { text: line }))) : null,
  );
  return item.media
    ? el('div', { class: 'slide-inner split' }, col, el('img', { class: 'media', src: item.media, alt: '' }))
    : el('div', { class: 'slide-inner' }, col);
}

function slideLinks(item) {
  const byId = new Map((state.content?.links ?? []).map((l) => [l.id, l]));
  const cards = (item.links ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((link) =>
      el(
        'div',
        { class: 'link-card' },
        link.qr ? el('img', { src: link.qr, alt: '' }) : null,
        el('p', { class: 'label', text: text(link.label) }),
        el('p', { class: 'url', text: link.url.replace(/^https:\/\//, '') }),
      ),
    );
  return el(
    'div',
    { class: 'slide-inner links' },
    el('h2', { text: text(item.title) }),
    item.subtitle ? el('p', { class: 'sub', text: text(item.subtitle) }) : null,
    el('div', { class: 'link-grid' }, cards),
  );
}

/** 저장본이 없거나 깨졌을 때. 이메일·전화번호는 넣지 않는다. */
function safeScreen(links) {
  const qr = (links ?? []).find((l) => l.url.includes('t.me'));
  const site = (links ?? []).find((l) => l.url.includes('firmmit.kr'));
  return el(
    'div',
    { class: 'slide-inner safe-screen' },
    el('p', { class: 'brand', text: 'FIRMMIT' }),
    el('p', { class: 'site', text: (site?.url ?? 'https://www.firmmit.kr').replace(/^https:\/\//, '') }),
    qr?.qr ? el('img', { src: qr.qr, alt: '' }) : null,
  );
}

function render() {
  const slide = $('slide');
  if (state.safe || state.order.length === 0) {
    put(slide, safeScreen(state.content?.safe_screen ?? []));
    $('pager').textContent = '';
    $('progress-bar').style.width = '0%';
    return;
  }
  const item = state.order[state.index];
  const build = { cover: slideCover, section: slideSection, links: slideLinks }[item.type] ?? slideSection;
  put(slide, build(item));
  $('pager').textContent = `${state.index + 1} / ${state.order.length}`;
  document.documentElement.lang = state.lang;
  renderIndex();
}

function renderIndex() {
  const list = $('index-list');
  put(
    list,
    state.order.map((item, i) =>
      el('li', { 'aria-current': i === state.index ? 'true' : 'false', text: `${i + 1}. ${text(item.title)}` }),
    ),
  );
  $('index-title').textContent = t('index');
  $('index-hint').textContent = t('close');
}

// ---------- 자동재생 ----------
function clearTimer() {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function startAutoplay() {
  clearTimer();
  if (!state.playing || state.order.length < 2) return;
  const total = (state.content?.autoplay_seconds ?? 15) * 1000;
  let elapsed = 0;
  const step = 100;
  state.timer = setInterval(() => {
    elapsed += step;
    $('progress-bar').style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
    if (elapsed >= total) {
      elapsed = 0;
      go(1);
    }
  }, step);
}

function setPlaying(on) {
  state.playing = on;
  if (on) startAutoplay();
  else {
    clearTimer();
    $('progress-bar').style.width = '0%';
  }
}

/** 입력이 들어오면 자동재생을 멈추고, 한동안 입력이 없으면 되돌아간다. */
function onInput() {
  setPlaying(false);
  if (state.idleTimer !== null) clearTimeout(state.idleTimer);
  const wait = (state.content?.idle_resume_seconds ?? 60) * 1000;
  state.idleTimer = setTimeout(() => setPlaying(true), wait);
}

function go(delta) {
  if (state.order.length === 0) return;
  state.index = (state.index + delta + state.order.length) % state.order.length;
  render();
}

function toggleIndex(force) {
  const overlay = $('index-overlay');
  const open = force === undefined ? overlay.hidden : force;
  overlay.hidden = !open;
  if (open) renderIndex();
}

function cycleLanguage(delta) {
  const langs = state.content?.languages ?? ['ko'];
  const i = langs.indexOf(state.lang);
  state.lang = langs[(i + delta + langs.length) % langs.length] ?? langs[0];
  render();
}

// TV 리모컨: 표준 키 이름 + 기기별 keyCode 를 함께 본다
const REMOTE = { 415: 'play', 19: 'pause', 10009: 'back', 461: 'back', 10252: 'playpause' };

function handleKey(ev) {
  const k = ev.key;
  const remote = REMOTE[ev.keyCode];
  const overlayOpen = !$('index-overlay').hidden;
  let used = true;
  if (k === 'ArrowRight' || k === 'PageDown' || remote === 'next') go(1);
  else if (k === 'ArrowLeft' || k === 'PageUp') go(-1);
  else if (k === 'ArrowUp') cycleLanguage(-1);
  else if (k === 'ArrowDown') cycleLanguage(1);
  else if (k === 'Home' || k === 'ContextMenu' || k === 'GoBack' || remote === 'back') toggleIndex();
  else if (k === 'Enter' || k === ' ' || k === 'Spacebar' || remote === 'playpause') {
    if (k === 'Enter' && overlayOpen) toggleIndex(false);
    else if (k === 'Enter') go(1);
    else setPlayingToggle();
  } else if (k === 'Escape') toggleIndex(false);
  else if (k === 'End') {
    state.index = state.order.length - 1;
    render();
  } else used = false;

  if (used) {
    ev.preventDefault();
    onInput();
  }
}

function setPlayingToggle() {
  // Space 는 재생/정지를 직접 뒤집는다 (onInput 이 멈춘 뒤 다시 켠다)
  const next = !state.playing;
  setTimeout(() => setPlaying(next), 0);
}

// ---------- 상시 전시 ----------
async function keepScreenAwake() {
  try {
    if ('wakeLock' in navigator) {
      let lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try {
            lock = await navigator.wakeLock.request('screen');
          } catch {
            /* 기기가 지원하지 않으면 그냥 넘어간다 */
          }
        }
      });
    }
  } catch {
    /* 지원하지 않는 기기 */
  }
}

function scheduleDailyReload() {
  setTimeout(() => location.reload(), DAY_MS);
}

// ---------- 시작 ----------
async function loadContent() {
  const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`content_${res.status}`);
  const data = await res.json();
  if (data?.manifest_version !== '1.0' || !Array.isArray(data.items)) throw new Error('content_shape');
  return data;
}

function applyContent(data, now) {
  state.content = data;
  state.lang = data.default_language ?? 'ko';
  state.order = visibleItems(data, now);
  state.index = 0;
  state.safe = state.order.length === 0;
  const badge = $('sample-badge');
  if (data.release?.status !== 'approved') {
    badge.hidden = false;
    badge.textContent = text(data.release?.note) || '샘플 — 승인 전';
  } else {
    badge.hidden = true;
  }
  render();
  startAutoplay();
}

/**
 * 시험용 시계. **로컬에서만** `?now=YYYY-MM-DD` 를 받는다.
 *
 * 배포본에서 받아 주면 주소창만 고쳐서 승인 기간 밖 항목(만료된 것·게시 전인 것)을
 * TV 에 띄울 수 있다. 회수 방어가 게시 기간뿐이므로 그 구멍을 열어 두면 안 된다.
 * 로컬이 아니거나 형식이 맞지 않으면 null → 실제 시각을 쓴다.
 */
function forcedDate(hostname, search) {
  const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '']);
  if (!LOCAL.has(hostname)) return null;
  const forced = new URLSearchParams(search).get('now');
  if (!forced || !/^\d{4}-\d{2}-\d{2}$/.test(forced)) return null;
  const d = new Date(`${forced}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function boot() {
  const now = forcedDate(location.hostname, location.search) ?? new Date();

  try {
    applyContent(await loadContent(), now);
  } catch {
    // 저장본이 없거나 깨졌다 → 안전 화면. 일정 시간 뒤 다시 시도한다.
    state.safe = true;
    render();
    setTimeout(() => boot(), RETRY_MS);
    return;
  }

  const hint = $('keyhint');
  hint.textContent = t('hint');
  hint.hidden = false;
  setTimeout(() => {
    hint.hidden = true;
  }, KEYHINT_MS);

  window.addEventListener('keydown', handleKey);
  // 마우스·터치도 자동재생을 멈춘다 (발표 중 갑자기 넘어가지 않게)
  for (const ev of ['pointerdown', 'wheel']) window.addEventListener(ev, onInput, { passive: true });

  await keepScreenAwake();
  scheduleDailyReload();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch {
      /* 서비스 워커가 없어도 화면은 돈다 */
    }
  }
}

// 브라우저에서만 시작한다 (시험은 표시 조건 함수만 가져다 쓴다)
if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();

export { state, applyContent, handleKey, forcedDate };
