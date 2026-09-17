// FIRMMIT ONE 허브 SPA (vanilla JS). 서버 데이터는 textContent/DOM API 로만 넣음.
import { DICT, LANGS } from './i18n.js';

const LANG_KEY = 'fm-one-hub.lang';
const KIND_ORDER = ['staff_app', 'public_site', 'admin_console', 'channel'];
const ROLES = ['VIEWER', 'OPERATOR', 'MANAGER', 'ADMIN'];
const STATE_ICON = { UP: '✓', DOWN: '✕', UNKNOWN: '?' };

const state = {
  lang: loadLang(),
  me: null,
  meError: null,
  route: 'home',
};

// ---------- 공통 도구 ----------
function loadLang() {
  try {
    const v = window.localStorage.getItem(LANG_KEY);
    if (v && LANGS.includes(v)) return v;
  } catch {
    /* 저장소 없음 */
  }
  return 'ko';
}

function saveLang(v) {
  try {
    window.localStorage.setItem(LANG_KEY, v);
  } catch {
    /* 무시 */
  }
}

function t(key, vars) {
  const dict = DICT[state.lang] || DICT.ko;
  let s = dict[key] ?? DICT.ko[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// DOM 생성 (HTML 문자열 삽입 없음)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

// null/false 는 건너뛰고 자식 교체 (replaceChildren 은 null 을 "null" 글자로 넣음)
function put(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

function append(node, children) {
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function appName(app) {
  const n = app.name || {};
  if (state.lang === 'uz-Latn') return n.uz || n.ko || app.app_id;
  if (state.lang === 'ru') return n.ru || n.ko || app.app_id;
  return n.ko || app.app_id;
}

function fmtTime(iso) {
  if (!iso) return t('none');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

function safeHttpsUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network_error');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const code = data && data.error && typeof data.error.code === 'string' ? data.error.code : `http_${res.status}`;
    const err = new ApiError(res.status, code);
    err.detail = data && data.error && typeof data.error.message === 'string' ? data.error.message : '';
    throw err;
  }
  if (data === null || typeof data !== 'object') throw new ApiError(res.status, 'invalid_response');
  return data;
}

function errorText(err) {
  const code = err instanceof ApiError ? err.code : 'generic';
  const key = `err_${code}`;
  const dict = DICT[state.lang] || DICT.ko;
  if (key in dict) return dict[key];
  if (err instanceof ApiError && err.status >= 500) return t('err_internal_error');
  return t('err_generic');
}

// 오류 상태 표시 (0·빈 목록으로 바꾸지 않음)
function errorBox(err, onRetry) {
  const code = err instanceof ApiError ? err.code : 'generic';
  const box = el(
    'div',
    { class: 'alert alert-error', role: 'alert' },
    el('span', { class: 'alert-icon', 'aria-hidden': 'true', text: '!' }),
    el(
      'div',
      { class: 'alert-body' },
      el('strong', { text: t('err_title') }),
      el('p', { text: errorText(err) }),
      el('p', { class: 'alert-code' }, `${t('err_code')}: `, el('code', { text: code })),
      err instanceof ApiError && err.detail && code === 'invalid_input' ? el('p', { class: 'alert-code' }, el('code', { text: err.detail })) : null,
    ),
  );
  if (onRetry) box.append(el('button', { type: 'button', class: 'btn btn-secondary', onclick: onRetry, text: t('retry') }));
  return box;
}

function inlineError(err) {
  const code = err instanceof ApiError ? err.code : 'generic';
  const detail = err instanceof ApiError && err.detail && code === 'invalid_input' ? ` (${err.detail})` : '';
  return el('p', { class: 'form-error', role: 'alert' }, el('span', { 'aria-hidden': 'true', text: '! ' }), `${errorText(err)} [${code}]${detail}`);
}

function toast(message) {
  const region = document.getElementById('toast');
  put(region, el('p', { class: 'toast', text: message }));
  window.setTimeout(() => {
    if (region.firstChild && region.firstChild.textContent === message) region.replaceChildren();
  }, 4000);
}

function loading() {
  return el('p', { class: 'loading', text: t('loading') });
}

function badge(kind, text, icon) {
  return el('span', { class: `badge badge-${kind}` }, icon ? el('span', { class: 'badge-icon', 'aria-hidden': 'true', text: icon }) : null, text);
}

function stateBadge(s) {
  const known = s === 'UP' || s === 'DOWN' ? s : 'UNKNOWN';
  return badge(`state-${known.toLowerCase()}`, t(`state_${known}`), STATE_ICON[known]);
}

function sectionHead(title, ...extra) {
  return el('div', { class: 'section-head' }, el('h2', { text: title }), ...extra);
}

function table(headers, rows, opts = {}) {
  // 모바일 카드형 표시용 라벨
  for (const tr of rows) {
    [...tr.children].forEach((td, i) => {
      if (headers[i]) td.setAttribute('data-label', headers[i]);
    });
  }
  return el(
    'div',
    { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': opts.label || headers.join(', ') },
    el(
      'table',
      { class: opts.stack ? 'table table-stack' : 'table' },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, rows),
    ),
  );
}

// ---------- 화면 틀 ----------
function applyStaticText() {
  document.documentElement.lang = state.lang;
  document.title = t('page_title');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.getAttribute('data-i18n'));
  const sel = document.getElementById('lang-select');
  sel.value = state.lang;
  const who = document.getElementById('who');
  who.textContent = state.me ? state.me.email : '';
  const adminTab = document.querySelector('[data-route="admin"]');
  adminTab.hidden = !(state.me && state.me.is_admin === true);
  for (const tab of document.querySelectorAll('[data-route]')) {
    if (tab.getAttribute('data-route') === state.route) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

function currentRoute() {
  const m = /^#\/(home|status|me|admin)$/.exec(window.location.hash);
  return m ? m[1] : 'home';
}

async function render(focus = false) {
  state.route = currentRoute();
  applyStaticText();
  const main = document.getElementById('main');
  if (state.meError) {
    put(main, errorBox(state.meError, () => boot()));
    return;
  }
  if (!state.me) {
    put(main, loading());
    return;
  }
  const view = { home: viewHome, status: viewStatus, me: viewMe, admin: viewAdmin }[state.route];
  // 화면마다 새 컨테이너: 늦게 끝난 이전 렌더는 떼어진 노드에만 씀
  const container = el('div', { class: 'view' }, loading());
  put(main, container);
  if (focus) main.focus({ preventScroll: true });
  await view(container);
}

function staleBanner() {
  if (!state.me || !state.me.snapshot || state.me.snapshot.stale !== true) return null;
  return el(
    'div',
    { class: 'alert alert-warn', role: 'status' },
    el('span', { class: 'alert-icon', 'aria-hidden': 'true', text: '!' }),
    el('div', { class: 'alert-body' }, el('p', { text: t('snapshot_stale') })),
  );
}

// ---------- KPI (WP2) ----------
const KPI_ICON = { ok: '✓', stale: '⏱', partial: '◐', error: '!', unavailable: '·' };
// 새로 stale/error 가 된 KPI 는 한 번만 알린다 (WCAG 2.2 SC 4.1.3)
const kpiSeen = new Map();

function kpiName(k) {
  const key = `kpi_${k.kpi_id.replace('.', '_')}`;
  const dict = DICT[state.lang] || DICT.ko;
  return dict[key] ?? DICT.ko[key] ?? k.name_ko ?? k.kpi_id;
}

function kpiStatusBadge(status) {
  const kind = { ok: 'state-up', stale: 'warn', partial: 'warn', error: 'state-down', unavailable: 'muted' }[status] || 'muted';
  return badge(kind, t(`kpi_status_${status}`), KPI_ICON[status] || '?');
}

// 값 표시 규칙 (R4 §2.4). null 과 0 을 구분하고, 오류는 0 으로 바꾸지 않는다.
function kpiValueText(k) {
  const m = k.measure || {};
  if (k.display_status === 'unavailable') return t('kpi_preparing');
  if (m.value === null || m.value === undefined) {
    // 건수 KPI 는 마지막 정상값을 쓸 수 있으면 쓰고, 아니면 "—"
    return k.last_success_at ? t('kpi_last_good') : '—';
  }
  if (m.kind === 'count') return String(m.value);
  if (m.kind === 'state') return t(`state_${m.value}`) || String(m.value);
  return String(m.value);
}

function kpiCard(k) {
  const head = el('div', { class: 'kpi-head' }, el('h3', { text: kpiName(k) }), kpiStatusBadge(k.display_status));
  const value = el('p', { class: 'kpi-value', text: kpiValueText(k) });
  const meta = el('p', { class: 'meta' });
  if (k.display_status === 'stale') {
    append(meta, [t('kpi_stale_hint', { time: fmtTime(k.stale.basis_at), n: Math.round((k.stale.threshold_seconds || 0) / 60) })]);
  } else if (k.display_status === 'unavailable') {
    append(meta, [t('kpi_unavailable_hint')]);
  } else {
    append(meta, [t('kpi_updated', { time: fmtTime(k.updated_at) })]);
  }
  const card = el('article', { class: `kpi-card kpi-${k.display_status}` }, head, value, meta);
  if (Array.isArray(k.breakdown) && k.breakdown.length) card.append(breakdownToggle(k));
  return card;
}

// 차트는 없지만 세부값은 반드시 표로도 볼 수 있어야 한다
function breakdownToggle(k) {
  const rows = k.breakdown.map((b) =>
    el('tr', {}, el('td', {}, el('code', { text: b.key })), el('td', { text: kpiValueText({ measure: b.measure, display_status: 'ok' }) })),
  );
  const box = el('div', { hidden: true }, table([t('col_item'), t('col_value')], rows, { label: kpiName(k), stack: true }));
  const btn = el('button', {
    type: 'button',
    class: 'btn btn-secondary btn-sm',
    text: t('show_table'),
    'aria-expanded': 'false',
    onclick: () => {
      const open = box.hidden;
      box.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? t('hide_table') : t('show_table');
    },
  });
  return el('div', { class: 'kpi-detail' }, btn, box);
}

/** 홈 상단 고정 줄: 데이터 기준 · 지연 KPI 수 · 다운 수 */
function kpiStatusLine(data) {
  const down = data.kpis.find((k) => k.kpi_id === 'SYS.UPTIME');
  const downText = down && down.measure && down.measure.value !== null ? String(down.measure.value) : '—';
  const line = el(
    'a',
    { class: 'status-line', href: '#/status' },
    el('span', { text: t('kpi_as_of', { time: fmtTime(data.as_of) }) }),
    el('span', { class: 'sep', 'aria-hidden': 'true', text: '·' }),
    el('span', { text: t('kpi_stale_n', { n: data.summary.stale }) }),
    el('span', { class: 'sep', 'aria-hidden': 'true', text: '·' }),
    el('span', { text: t('kpi_down_n', { n: downText }) }),
  );
  return line;
}

// 새로 나빠진 KPI 만 한 번 알린다
function announceKpiChanges(data) {
  const region = document.getElementById('kpi-live');
  if (!region) return;
  const newly = [];
  for (const k of data.kpis) {
    const before = kpiSeen.get(k.kpi_id);
    if (before !== k.display_status && (k.display_status === 'stale' || k.display_status === 'error')) newly.push(kpiName(k));
    kpiSeen.set(k.kpi_id, k.display_status);
  }
  put(region, newly.length ? el('p', { text: t('kpi_changed', { list: newly.join(', ') }) }) : null);
}

async function kpiSection() {
  const box = el('section', { class: 'panel kpi-panel' }, sectionHead(t('kpi_system')), loading());
  try {
    const data = await api('/api/kpi');
    if (!Array.isArray(data.kpis)) throw new ApiError(200, 'invalid_response');
    announceKpiChanges(data);
    put(box,
      kpiStatusLine(data),
      sectionHead(t('kpi_system')),
      data.kpis.length
        ? el('div', { class: 'kpi-grid' }, data.kpis.map(kpiCard))
        : el('p', { class: 'empty', text: t('group_empty') }),
    );
  } catch (err) {
    put(box, sectionHead(t('kpi_system')), errorBox(err, () => render()));
  }
  return box;
}

// ---------- 홈: 런처 ----------
async function viewHome(main) {
  let data;
  try {
    data = await api('/api/apps');
  } catch (err) {
    put(main, el('h1', { class: 'page-title', text: t('nav_home') }), errorBox(err, () => render()));
    return;
  }
  const apps = Array.isArray(data.apps) ? data.apps : null;
  if (!apps) {
    put(main, errorBox(new ApiError(200, 'invalid_response'), () => render()));
    return;
  }
  const sections = KIND_ORDER.map((kind) => {
    const items = apps.filter((a) => a.kind === kind);
    if (kind === 'admin_console' && items.length === 0) return null;
    return el(
      'section',
      { class: 'launcher-group', 'aria-labelledby': `grp-${kind}` },
      el('h2', { id: `grp-${kind}`, text: t(`group_${kind}`) }),
      items.length === 0 ? el('p', { class: 'empty', text: t('group_empty') }) : el('ul', { class: 'card-grid' }, items.map(appCard)),
    );
  });
  const kpis = el('div');
  put(main,
    el('h1', { class: 'page-title', text: t('greeting', { name: state.me.display_name }) }),
    kpis,
    el('p', { class: 'lead', text: t('home_intro') }),
    staleBanner(),
    ...sections,
  );
  put(kpis, await kpiSection());
}

function appCard(app) {
  const name = appName(app);
  const url = app.status === 'not_connected' ? null : safeHttpsUrl(app.url);
  const badges = el('span', { class: 'card-badges' });
  if (app.status === 'not_connected') badges.append(badge('muted', t('badge_not_connected'), '○'));
  if (app.status === 'legacy') badges.append(badge('warn', t('badge_legacy'), '!'));
  if (app.role && ROLES.includes(app.role)) badges.append(badge('role', t(`role_${app.role}`)));

  if (!url) {
    return el(
      'li',
      {},
      el(
        'div',
        { class: 'card card-disabled', 'aria-disabled': 'true' },
        el('span', { class: 'card-title', text: name }),
        badges,
        el('span', { class: 'card-foot', text: t('not_connected_hint') }),
      ),
    );
  }
  const host = new URL(url).host + (new URL(url).pathname !== '/' ? new URL(url).pathname : '');
  return el(
    'li',
    {},
    el(
      'a',
      { class: 'card', href: url, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'card-title', text: name }),
      el('span', { class: 'card-host', text: host }),
      badges,
      el('span', { class: 'card-foot' }, t('open_new_tab'), el('span', { class: 'ext', 'aria-hidden': 'true', text: ' ↗' })),
    ),
  );
}

// ---------- 시스템 상태 ----------
async function viewStatus(main) {
  let data;
  try {
    data = await api('/api/status');
  } catch (err) {
    put(main, el('h1', { class: 'page-title', text: t('nav_status') }), errorBox(err, () => render()));
    return;
  }
  const s = data.summary;
  if (!s || typeof s.up !== 'number' || !Array.isArray(data.items)) {
    put(main, errorBox(new ApiError(200, 'invalid_response'), () => render()));
    return;
  }
  const tiles = el(
    'div',
    { class: 'tiles' },
    [
      ['UP', s.up],
      ['DOWN', s.down],
      ['UNKNOWN', s.unknown],
    ].map(([k, n]) =>
      el(
        'div',
        { class: `tile tile-${k.toLowerCase()}` },
        el('span', { class: 'tile-icon', 'aria-hidden': 'true', text: STATE_ICON[k] }),
        el('span', { class: 'tile-num', text: String(n) }),
        el('span', { class: 'tile-label', text: t(`state_${k}`) }),
      ),
    ),
  );
  const detail = data.detail === true;
  const headers = detail
    ? [t('col_app'), t('col_state'), t('col_failures'), t('col_checked'), t('col_changed'), t('col_code')]
    : [t('col_app'), t('col_state')];
  const rows = data.items.map((it) =>
    el(
      'tr',
      {},
      el('td', { text: appName(it) }),
      el('td', {}, stateBadge(it.state)),
      detail ? el('td', { class: 'num', text: String(it.consecutive_failures ?? 0) }) : null,
      detail ? el('td', { text: fmtTime(it.last_checked_at) }) : null,
      detail ? el('td', { text: fmtTime(it.last_change_at) }) : null,
      detail ? el('td', { class: 'num', text: it.last_status_code == null ? '—' : String(it.last_status_code) }) : null,
    ),
  );
  put(main,
    sectionHead(t('nav_status'), el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => render(), text: t('refresh') })),
    el(
      'p',
      { class: 'meta' },
      t('status_monitored', { n: s.monitored }),
      ' · ',
      data.last_checked_at ? t('status_last_checked', { time: fmtTime(data.last_checked_at) }) : t('status_never'),
    ),
    tiles,
    el('p', { class: 'meta', text: detail ? t('status_scope_admin') : t('status_scope_staff') }),
    rows.length ? table(headers, rows, { label: t('nav_status') }) : el('p', { class: 'empty', text: t('status_items_empty') }),
  );
}

// ---------- 내 정보 ----------
async function viewMe(main) {
  let me;
  try {
    me = await api('/api/me');
    state.me = me;
    applyStaticText();
  } catch (err) {
    put(main, el('h1', { class: 'page-title', text: t('nav_me') }), errorBox(err, () => render()));
    return;
  }
  const row = (k, v) => el('div', { class: 'kv' }, el('dt', { text: k }), el('dd', {}, v));
  const groups = me.groups.length ? el('span', { class: 'chips' }, me.groups.map((g) => el('span', { class: 'chip', text: g }))) : t('none');
  const snap = me.snapshot || {};
  const snapBadge = snap.stale ? badge('warn', t('snapshot_old'), '!') : badge('state-up', t('snapshot_fresh'), '✓');
  const roleRows = me.roles.map((r) =>
    el(
      'tr',
      {},
      el('td', { text: r.app_id }),
      el('td', {}, badge('role', t(`role_${r.role}`))),
      el('td', { text: (r.scopes || []).join(', ') }),
    ),
  );
  put(main,
    el('h1', { class: 'page-title', text: t('nav_me') }),
    staleBanner(),
    el(
      'dl',
      { class: 'kv-list panel' },
      row(t('me_email'), me.email),
      row(t('me_name'), me.display_name),
      row(t('me_emp_id'), me.emp_id || t('none')),
      row(t('me_groups'), groups),
      row(t('me_snapshot'), el('span', {}, snapBadge, ' ', fmtTime(snap.synced_at))),
      row(t('me_auth'), me.auth_source === 'dev' ? t('auth_dev') : t('auth_access')),
    ),
    el('h2', { text: t('me_roles') }),
    roleRows.length ? table([t('col_app'), t('field_role'), t('col_scope')], roleRows, { label: t('me_roles') }) : el('p', { class: 'empty', text: t('me_no_roles') }),
  );
}

// ---------- 관리 ----------
async function viewAdmin(main) {
  if (!state.me.is_admin) {
    put(main, el('h1', { class: 'page-title', text: t('nav_admin') }), errorBox(new ApiError(403, 'forbidden')));
    return;
  }
  const usersBox = el('section', { class: 'panel' });
  const tokenBox = el('section', { class: 'panel' });
  const auditBox = el('section', { class: 'panel' });
  put(main, el('h1', { class: 'page-title', text: t('nav_admin') }), staleBanner(), usersBox, tokenBox, auditBox);
  await Promise.all([renderUsers(usersBox), renderTokens(tokenBox), renderAudit(auditBox)]);
}

// WP3: 연동 토큰 상태. 토큰 값·암호문은 서버가 내려보내지 않는다.
const TOKEN_BADGE = {
  ok: ['state-up', '✓'],
  expiring: ['warn', '!'],
  conflict: ['state-down', '✕'],
  unknown: ['state-down', '?'],
  running: ['muted', '⟳'],
  no_data: ['muted', '·'],
};

async function renderTokens(box) {
  put(box, sectionHead(t('tokens_title')), loading());
  let data;
  try {
    data = await api('/api/admin/tokens');
  } catch (err) {
    put(box, sectionHead(t('tokens_title')), errorBox(err, () => renderTokens(box)));
    return;
  }
  const mode = data.enabled ? badge('role', t('tokens_on'), '⟳') : badge('muted', t('tokens_off'), 'i');
  const rows = (data.tokens || []).map((tk) => {
    const [kind, icon] = TOKEN_BADGE[tk.state] || ['muted', '?'];
    return el(
      'tr',
      {},
      el('td', {}, el('code', { text: tk.token_id })),
      el('td', { text: tk.provider }),
      el('td', {}, badge(kind, t(`token_state_${tk.state}`), icon)),
      el('td', { text: fmtTime(tk.expires_at) }),
      el('td', { text: tk.last_outcome ? t(`token_outcome_${tk.last_outcome}`) : t('none') }),
      el('td', { text: fmtTime(tk.last_attempt_at) }),
    );
  });
  put(box,
    sectionHead(t('tokens_title'), mode),
    rows.length
      ? table([t('col_token'), t('col_provider'), t('col_state'), t('col_expires'), t('col_last_outcome'), t('col_last_attempt')], rows, {
          label: t('tokens_title'),
          stack: true,
        })
      : el('p', { class: 'empty', text: t('tokens_empty') }),
    el('p', { class: 'meta', text: t('tokens_note') }),
  );
}

async function renderUsers(box) {
  put(box, sectionHead(t('admin_users')), loading());
  let data;
  try {
    data = await api('/api/admin/users');
  } catch (err) {
    put(box, sectionHead(t('admin_users')), errorBox(err, () => renderUsers(box)));
    return;
  }
  const reload = () => renderUsers(box);
  const rows = data.users.map((u) => userRow(u, reload));
  put(box,
    sectionHead(t('admin_users'), el('button', { type: 'button', class: 'btn btn-secondary', onclick: reload, text: t('refresh') })),
    rows.length
      ? table([t('col_user'), t('col_status'), t('col_groups'), t('col_grants'), t('change_status')], rows, { label: t('admin_users'), stack: true })
      : el('p', { class: 'empty', text: t('group_empty') }),
    el('div', { class: 'form-grid' }, addUserForm(reload), grantForm(data, reload)),
    syncPanel(data),
    snapshotForm(data, reload),
  );
}

// WP1: 그룹 동기화 상태 (마지막 성공 · 마지막 실패 사유 · 다음 예정)
function syncPanel(data) {
  const snap = data.snapshot || {};
  const s = snap.sync || {};
  const kv = (k, v) => el('div', { class: 'kv' }, el('dt', { text: k }), el('dd', {}, v));
  const failed = s.last_outcome === 'failure';
  const rows = [
    kv(t('sync_mode'), s.auto ? badge('role', t('sync_auto_on'), '⟳') : badge('muted', t('sync_auto_off'), 'i')),
    kv(
      t('sync_last_success'),
      el('span', {}, snap.stale ? badge('warn', t('snapshot_old'), '!') : badge('state-up', t('snapshot_fresh'), '✓'), ' ', fmtTime(snap.synced_at)),
    ),
  ];
  if (s.last_attempt_at) {
    rows.push(
      kv(
        t('sync_last_attempt'),
        el('span', {}, failed ? badge('state-down', t('sync_failed'), '✕') : badge('state-up', t('sync_ok'), '✓'), ' ', fmtTime(s.last_attempt_at)),
      ),
    );
  } else {
    rows.push(kv(t('sync_last_attempt'), t('sync_never')));
  }
  if (failed && s.last_failure_code) {
    rows.push(
      kv(
        t('sync_last_failure'),
        el(
          'span',
          {},
          el('code', { text: s.last_failure_code }),
          ' ',
          t('sync_consecutive', { n: s.consecutive_failures || 1 }),
          ' · ',
          fmtTime(s.last_failure_at),
        ),
      ),
    );
  }
  rows.push(kv(t('sync_next_run'), s.auto ? fmtTime(s.next_run_at) : t('none')));
  return el('section', { class: 'panel' }, sectionHead(t('sync_title')), el('dl', { class: 'kv-list' }, rows));
}

function userRow(u, reload) {
  const statusSel = el(
    'select',
    { 'aria-label': `${t('change_status')} ${u.email}` },
    ['active', 'suspended', 'revoked'].map((s) => el('option', { value: s, text: t(`user_status_${s}`) })),
  );
  statusSel.value = u.status;
  const msg = el('div', { class: 'row-msg' });
  const applyBtn = el('button', {
    type: 'button',
    class: 'btn btn-secondary btn-sm',
    text: t('apply'),
    onclick: async () => {
      if (statusSel.value === u.status) return;
      applyBtn.disabled = true;
      try {
        await api(`/api/admin/users/${encodeURIComponent(u.email)}/status`, { method: 'POST', body: { status: statusSel.value } });
        toast(t('saved'));
        reload();
      } catch (err) {
        put(msg, inlineError(err));
        applyBtn.disabled = false;
      }
    },
  });
  const statusKind = u.status === 'active' ? 'state-up' : u.status === 'suspended' ? 'warn' : 'state-down';
  const statusIcon = u.status === 'active' ? '✓' : u.status === 'suspended' ? '‖' : '✕';
  return el(
    'tr',
    {},
    el('td', {}, el('div', { class: 'strong', text: u.display_name }), el('div', { class: 'sub', text: u.email }), u.emp_id ? el('div', { class: 'sub', text: u.emp_id }) : null),
    el('td', {}, badge(statusKind, t(`user_status_${u.status}`), statusIcon)),
    el('td', {}, u.groups.length ? el('span', { class: 'chips' }, u.groups.map((g) => el('span', { class: 'chip', text: g }))) : t('none')),
    el('td', {}, u.grants.length ? el('ul', { class: 'grant-list' }, u.grants.map((g) => grantItem(g, reload))) : t('none')),
    el('td', {}, el('div', { class: 'inline' }, statusSel, applyBtn), msg),
  );
}

function grantItem(g, reload) {
  const stateKind = { active: 'state-up', revoked: 'muted', expired: 'muted', over_ceiling: 'warn' }[g.state] || 'muted';
  const stateIcon = { active: '✓', revoked: '✕', expired: '⌛', over_ceiling: '!' }[g.state] || '?';
  const li = el(
    'li',
    { class: 'grant' },
    el('span', { class: 'grant-main' }, el('code', { text: g.app_id }), ' ', badge('role', t(`role_${g.role}`)), g.scope !== '*' ? ` [${g.scope}]` : ''),
    badge(stateKind, t(`grant_state_${g.state}`), stateIcon),
    g.expires_at ? el('span', { class: 'sub', text: t('grant_expires', { time: fmtTime(g.expires_at) }) }) : null,
  );
  const ownAdmin = state.me && g.email === state.me.email && g.app_id === 'hub' && g.role === 'ADMIN';
  if (g.state !== 'revoked' && !ownAdmin) {
    const actions = el('span', { class: 'grant-actions' });
    const msg = el('span', { class: 'row-msg' });
    const start = el('button', {
      type: 'button',
      class: 'btn btn-danger-outline btn-sm',
      text: t('revoke'),
      onclick: () => {
        const confirmBtn = el('button', {
          type: 'button',
          class: 'btn btn-danger btn-sm',
          text: t('confirm_revoke'),
          onclick: async () => {
            confirmBtn.disabled = true;
            try {
              await api(`/api/admin/grants/${encodeURIComponent(String(g.id))}/revoke`, { method: 'POST', body: {} });
              toast(t('saved'));
              reload();
            } catch (err) {
              put(msg, inlineError(err));
              confirmBtn.disabled = false;
            }
          },
        });
        const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: t('cancel'), onclick: () => put(actions, start) });
        put(actions, confirmBtn, cancelBtn);
        confirmBtn.focus();
      },
    });
    actions.append(start);
    li.append(actions, msg);
  }
  return li;
}

function field(label, input, hint) {
  const id = `f-${Math.random().toString(36).slice(2, 10)}`;
  input.id = id;
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), input, hint ? el('p', { class: 'hint', text: hint }) : null);
}

function formShell(title, fields, submitText, onSubmit) {
  const msg = el('div', { class: 'form-msg' });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary', text: submitText });
  const form = el('form', { class: 'form panel-inner', novalidate: true }, el('h3', { text: title }), fields, btn, msg);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    btn.disabled = true;
    msg.replaceChildren();
    try {
      await onSubmit();
    } catch (err) {
      put(msg, err instanceof ApiError ? inlineError(err) : el('p', { class: 'form-error', role: 'alert', text: err.message }));
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

function optionalText(v) {
  const s = v.trim();
  return s === '' ? undefined : s;
}

function addUserForm(reload) {
  const email = el('input', { type: 'email', required: true, autocomplete: 'off', maxlength: '254' });
  const name = el('input', { type: 'text', required: true, maxlength: '100' });
  const emp = el('input', { type: 'text', maxlength: '32' });
  return formShell(t('form_add_user'), [field(t('field_email'), email), field(t('field_name'), name), field(t('field_emp_id'), emp)], t('submit_add_user'), async () => {
    const body = { email: email.value.trim(), display_name: name.value };
    const e = optionalText(emp.value);
    if (e) body.emp_id = e;
    await api('/api/admin/users', { method: 'POST', body });
    toast(t('saved'));
    reload();
  });
}

function grantForm(data, reload) {
  const user = el(
    'select',
    { required: true },
    data.users.filter((u) => u.status === 'active').map((u) => el('option', { value: u.email, text: `${u.display_name} <${u.email}>` })),
  );
  const app = el('select', { required: true }, data.apps.map((a) => el('option', { value: a.app_id, text: `${appName({ app_id: a.app_id, name: { ko: a.name_ko, uz: a.name_uz, ru: a.name_ru } })} (${a.app_id})` })));
  const role = el('select', { required: true }, ROLES.map((r) => el('option', { value: r, text: `${t(`role_${r}`)} (${r})` })));
  const scope = el('input', { type: 'text', value: '*', maxlength: '64' });
  const expires = el('input', { type: 'datetime-local' });
  const reason = el('input', { type: 'text', maxlength: '500' });
  return formShell(
    t('form_grant'),
    [field(t('field_user'), user), field(t('field_app'), app), field(t('field_role'), role), field(t('field_scope'), scope), field(t('field_expires'), expires), field(t('field_reason'), reason)],
    t('submit_grant'),
    async () => {
      const body = { email: user.value, app_id: app.value, role: role.value };
      const sc = optionalText(scope.value);
      if (sc) body.scope = sc;
      if (expires.value) {
        const d = new Date(expires.value);
        if (Number.isNaN(d.getTime())) throw new ApiError(400, 'invalid_input');
        body.expires_at = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      const r = optionalText(reason.value);
      if (r) body.reason = r;
      const res = await api('/api/admin/grants', { method: 'POST', body });
      toast(`${t('saved')} — ${t(`grant_state_${res.grant.state}`)}`);
      reload();
    },
  );
}

function snapshotForm(data, reload) {
  // 자동 동기화가 켜져 있으면 서버가 409 로 거부하므로 입력란을 열지 않는다
  if (data.snapshot.sync && data.snapshot.sync.auto === true) {
    return el(
      'section',
      { class: 'panel' },
      sectionHead(t('form_snapshot')),
      el('p', { class: 'empty', text: t('sync_manual_disabled') }),
    );
  }
  const lines = data.snapshot.groups.flatMap((g) => g.emails.map((e) => `${g.group_name},${e}`));
  const area = el('textarea', { rows: '8', spellcheck: 'false', class: 'mono' });
  area.value = lines.join('\n');
  const synced = el(
    'p',
    { class: 'meta' },
    data.snapshot.stale ? badge('warn', t('snapshot_old'), '!') : badge('state-up', t('snapshot_fresh'), '✓'),
    ' ',
    t('snapshot_synced_at', { time: fmtTime(data.snapshot.synced_at) }),
  );
  const reason = el('input', { type: 'text', maxlength: '500' });
  const form = formShell(t('form_snapshot'), [synced, field(t('form_snapshot'), area, t('snapshot_help')), field(t('field_reason'), reason)], t('submit_snapshot'), async () => {
    const groups = new Map();
    const raw = area.value.split('\n');
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i].trim();
      if (line === '') continue;
      const m = /^([A-Za-z0-9_.-]{1,64})\s*,\s*(\S+@\S+)$/.exec(line);
      if (!m) throw new Error(t('snapshot_parse_error', { line: i + 1 }));
      const list = groups.get(m[1]) || [];
      if (!list.includes(m[2].toLowerCase())) list.push(m[2].toLowerCase());
      groups.set(m[1], list);
    }
    const body = { groups: [...groups.entries()].map(([group_name, emails]) => ({ group_name, emails })) };
    const r = optionalText(reason.value);
    if (r) body.reason = r;
    await api('/api/admin/group-snapshot', { method: 'POST', body });
    toast(t('saved'));
    await refreshMe();
    reload();
  });
  form.classList.add('form-wide');
  return form;
}

async function renderAudit(box) {
  const verifyOut = el('span', { class: 'verify-out', role: 'status' });
  const verifyBtn = el('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: t('verify_chain'),
    onclick: async () => {
      verifyBtn.disabled = true;
      put(verifyOut, loading());
      try {
        const v = await api('/api/admin/audit/verify');
        put(verifyOut,
          v.ok === true
            ? badge('state-up', t('verify_ok', { n: v.checked }), '✓')
            : badge('state-down', t('verify_fail', { id: v.broken_at_id, reason: v.reason }), '✕'),
        );
      } catch (err) {
        put(verifyOut, inlineError(err));
      } finally {
        verifyBtn.disabled = false;
      }
    },
  });
  const head = sectionHead(t('admin_audit'), el('span', { class: 'inline' }, verifyBtn, verifyOut));
  put(box, head, loading());
  let data;
  try {
    data = await api('/api/admin/audit?limit=100');
  } catch (err) {
    put(box, head, errorBox(err, () => renderAudit(box)));
    return;
  }
  const dict = DICT[state.lang] || DICT.ko;
  const rows = data.entries.map((e) =>
    el(
      'tr',
      {},
      el('td', { class: 'nowrap', text: fmtTime(e.ts) }),
      el('td', { text: e.actor_email }),
      el('td', {}, el('div', { text: dict[`action_${e.action}`] || e.action }), el('code', { class: 'sub', text: e.action })),
      el('td', {}, el('code', { text: e.target })),
      el('td', {}, el('code', { class: 'detail', text: JSON.stringify(e.detail) })),
    ),
  );
  put(box,
    head,
    rows.length ? table([t('col_time'), t('col_actor'), t('col_action'), t('col_target'), t('col_detail')], rows, { label: t('admin_audit'), stack: true }) : el('p', { class: 'empty', text: t('audit_empty') }),
  );
}

// ---------- 시작 ----------
async function refreshMe() {
  state.me = await api('/api/me');
  applyStaticText();
}

async function boot() {
  state.meError = null;
  state.me = null;
  render();
  try {
    await refreshMe();
  } catch (err) {
    state.meError = err;
  }
  render();
}

document.getElementById('lang-select').addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (!LANGS.includes(v)) return;
  state.lang = v;
  saveLang(v);
  render();
});
window.addEventListener('hashchange', () => render(true));
boot();
