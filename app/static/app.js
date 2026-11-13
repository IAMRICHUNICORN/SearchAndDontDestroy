'use strict';
/* HWSW Monitor - webove rozhrani. Vsechna data se vkladaji pres textContent (zadne innerHTML). */

const $app = document.getElementById('app');
const S = { me: null, schema: null, views: [], live: null, es: null };

// ------------------------------------------------------------ pomocne funkce

function add(node, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v);
  }
  return add(n, kids);
}

async function api(method, url, body, raw) {
  const opt = { method, headers: { 'X-HWSW': '1' }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof Blob) opt.body = body;
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  const r = await fetch(url, opt);
  if (r.status === 401 && url !== '/api/login') {
    S.me = null; renderLogin();
    throw new Error('Přihlášení vypršelo');
  }
  if (!r.ok) {
    let msg = 'Chyba ' + r.status;
    try { const j = await r.json(); if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (e) { /* bez tela */ }
    throw new Error(msg);
  }
  return raw ? r : r.json();
}

function toast(text, kind) {
  const t = el('div', { class: 'toast ' + (kind || '') }, text);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
}
const fail = (e) => toast(e.message || String(e), 'error');

function fmtDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) return s == null ? '' : s;
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(b) {
  if (b > 1048576) return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' kB';
}
const dash = (v) => (v == null || v === '' ? '—' : v);

function modal(title, body, buttons, wide) {
  const overlay = el('div', { class: 'overlay' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const foot = el('footer', null, (buttons || []).map((b) => el('button', {
    class: b.primary ? 'primary' : (b.danger ? 'danger' : ''),
    onclick: async (ev) => {
      if (!b.onclick) return close();
      ev.target.disabled = true;
      try { if ((await b.onclick()) !== false) close(); } catch (e) { fail(e); }
      ev.target.disabled = false;
    } }, b.label)));
  overlay.append(el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    el('header', null, el('h2', null, title), el('button', { class: 'link right', onclick: close, 'aria-label': 'Zavřít' }, '✕')),
    el('div', { class: 'body' }, body), foot));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = overlay.querySelector('input, select, textarea');
  if (first) first.focus();
  return close;
}

function confirmBox(text, label) {
  return new Promise((resolve) => {
    modal('Potvrzení', el('p', null, text), [
      { label: 'Zrušit', onclick: () => resolve(false) },
      { label: label || 'Potvrdit', primary: true, onclick: () => resolve(true) },
    ]);
  });
}

function field(label, input, hint) {
  return [el('label', { class: 'field' }, el('span', null, label), input), hint ? el('div', { class: 'hint' }, hint) : null];
}

function simpleTable(headers, rows, emptyText) {
  return el('div', { class: 'table-wrap' }, el('table', null,
    el('thead', null, el('tr', null, headers.map((h) => el('th', null, h)))),
    el('tbody', null, rows.length ? rows.map((r) => el('tr', null, r.map((c) => el('td', null, c == null ? '' : c))))
      : el('tr', null, el('td', { class: 'empty', colspan: headers.length }, emptyText || 'Žádná data')))));
}

function copyButton(text) {
  return el('button', { onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast('Zkopírováno', 'ok'); }
    catch (e) { toast('Kopírování se nepovedlo, označte text ručně', 'error'); }
  } }, 'Kopírovat');
}

async function download(url, body, filename) {
  const r = await api('POST', url, body, true);
  const blob = await r.blob();
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- bunky

const ACTION_BADGE = { 'připojeno': 'ok', 'nainstalováno': 'ok', 'odpojeno': '', 'odebráno': 'warn' };

function cell(col, row) {
  const v = row[col.key];
  const nw = col.type === 'date' || ['hostname', 'ip', 'device_ip', 'mac', 'serial', 'online'].includes(col.key);
  const td = el('td', { class: col.type === 'num' ? 'num' : (nw ? 'nw' : '') });
  if (col.key === 'online') return add(td, [el('span', { class: 'dot' + (v ? ' on' : '') }), v ? 'online' : 'offline']);
  if (col.type === 'bool') return add(td, [el('span', { class: 'badge' + (v ? ' ok' : '') }, v ? 'ano' : 'ne')]);
  if (v == null || v === '') return td;
  if (col.key === 'action') return add(td, [el('span', { class: 'badge ' + (ACTION_BADGE[v] || '') }, v)]);
  if (col.key === 'free' && v < 0) return add(td, [el('span', { class: 'badge bad' }, v)]);
  if (col.type === 'date') return add(td, [fmtDate(v)]);
  if (col.type === 'num') return add(td, [String(v).replace('.', ',')]);
  return add(td, [v]);
}

// ------------------------------------------------- vyber sloupcu a filtry

function columnPicker(entity, selected) {
  const defs = S.schema.entities[entity].columns;
  const label = (k) => (defs.find((d) => d.key === k) || {}).label || k;
  let cols = selected.filter((k) => defs.some((d) => d.key === k));
  const list = el('ul', { class: 'col-list' });
  const adder = el('select');
  function draw() {
    list.replaceChildren(...cols.map((k, i) => el('li', null, el('span', null, label(k)),
      el('button', { class: 'mini', disabled: i === 0, title: 'Posunout výš', onclick: () => { cols.splice(i - 1, 0, cols.splice(i, 1)[0]); draw(); } }, '↑'),
      el('button', { class: 'mini', disabled: i === cols.length - 1, title: 'Posunout níž', onclick: () => { cols.splice(i + 1, 0, cols.splice(i, 1)[0]); draw(); } }, '↓'),
      el('button', { class: 'mini', title: 'Odebrat', onclick: () => { cols.splice(i, 1); draw(); } }, '✕'))));
    adder.replaceChildren(el('option', { value: '' }, '+ přidat sloupec…'),
      ...defs.filter((d) => !cols.includes(d.key)).map((d) => el('option', { value: d.key }, d.label)));
  }
  adder.addEventListener('change', () => { if (adder.value) { cols.push(adder.value); draw(); } });
  draw();
  return { node: el('div', null, list, adder), get: () => cols.slice() };
}

function filterBuilder(entity, filters) {
  const defs = S.schema.entities[entity].columns;
  const ops = S.schema.operators;
  const box = el('div');
  const rows = [];
  function addRow(f) {
    const col = el('select', null, defs.map((d) => el('option', { value: d.key, selected: f && f.col === d.key }, d.label)));
    const op = el('select', null, Object.entries(ops).map(([k, l]) => el('option', { value: k, selected: f && f.op === k }, l)));
    const val = el('input', { value: f ? f.value : '', placeholder: 'hodnota' });
    const item = { col, op, val };
    const line = el('div', { class: 'filter-row' }, col, op, val,
      el('button', { class: 'mini', onclick: () => { rows.splice(rows.indexOf(item), 1); line.remove(); } }, '✕'));
    rows.push(item);
    box.append(line);
  }
  (filters || []).forEach(addRow);
  const node = el('div', null, box, el('button', { class: 'mini', onclick: () => addRow(null) }, '+ přidat podmínku'));
  return { node, get: () => rows.map((r) => ({ col: r.col.value, op: r.op.value, value: r.val.value.trim() })) };
}

function filterLabel(entity, f) {
  const d = S.schema.entities[entity].columns.find((c) => c.key === f.col);
  const noVal = f.op === 'empty' || f.op === 'not_empty';
  return (d ? d.label : f.col) + ' ' + S.schema.operators[f.op] + (noVal ? '' : ' „' + f.value + '“');
}

// --------------------------------------------------------------- tabulka

function dataTable(opts) {
  const st = {
    page: 1, search: '', sort: opts.sort || '', sortDir: opts.sortDir || '',
    columns: (opts.columns || []).slice(), filters: (opts.filters || []).slice(), seq: 0,
  };
  const entity = opts.entity;
  const tbody = el('tbody');
  const thead = el('thead');
  const pager = el('div', { class: 'pager' });
  const chips = el('div', { class: 'chips' });
  const search = el('input', { type: 'search', placeholder: 'Hledat…', 'aria-label': 'Hledat' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { st.search = search.value; st.page = 1; load(); }, 250);
  });

  const request = (extra) => Object.assign({
    search: st.search, sort: st.sort, sort_dir: st.sortDir, page: st.page,
  }, opts.viewId ? {} : { entity, columns: st.columns, filters: st.filters }, extra || {});
  const url = opts.viewId ? '/api/views/' + opts.viewId + '/data' : '/api/query';

  async function load() {
    const seq = ++st.seq;
    let data;
    try { data = await api('POST', url, request()); } catch (e) { return fail(e); }
    if (seq !== st.seq) return;
    if (opts.viewId && !st.sort) { st.sort = data.sort; st.sortDir = data.sort_dir; }
    const rowClick = opts.onRow && (opts.rowClickable ? opts.rowClickable(data) : true);
    thead.replaceChildren(el('tr', null, data.columns.map((c) => el('th', {
      class: 'sortable' + (c.type === 'num' ? ' num' : ''),
      onclick: () => {
        if (st.sort === c.key) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
        else { st.sort = c.key; st.sortDir = 'asc'; }
        st.page = 1; load();
      } }, c.label, st.sort === c.key ? (st.sortDir === 'desc' ? ' ▼' : ' ▲') : ''))));
    tbody.replaceChildren(...(data.rows.length ? data.rows.map((r) => el('tr', {
      class: rowClick ? 'click' : '', onclick: rowClick ? () => opts.onRow(r, data) : null,
    }, data.columns.map((c) => cell(c, r)))) : [el('tr', null, el('td', { class: 'empty', colspan: data.columns.length },
      st.search || st.filters.length ? 'Podmínkám nic neodpovídá' : (opts.emptyText || 'Zatím žádná data')))]));
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    pager.replaceChildren(
      el('span', null, 'Celkem ' + data.total),
      pages > 1 ? el('button', { class: 'mini', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, '‹ Předchozí') : null,
      pages > 1 ? el('span', null, 'Strana ' + st.page + ' z ' + pages) : null,
      pages > 1 ? el('button', { class: 'mini', disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, 'Další ›') : null);
    chips.replaceChildren(...st.filters.map((f, i) => el('span', { class: 'chip' }, filterLabel(entity, f),
      opts.adhoc ? el('button', { 'aria-label': 'Zrušit filtr', onclick: () => { st.filters.splice(i, 1); st.page = 1; load(); } }, '✕') : null)));
  }

  const tools = [search];
  if (opts.adhoc) {
    tools.push(el('button', { onclick: () => {
      const p = columnPicker(entity, st.columns.length ? st.columns : S.schema.entities[entity].default);
      modal('Sloupce', p.node, [{ label: 'Zrušit' }, { label: 'Použít', primary: true, onclick: () => { st.columns = p.get(); load(); } }]);
    } }, 'Sloupce'));
    tools.push(el('button', { onclick: () => {
      const f = filterBuilder(entity, st.filters);
      modal('Filtr', f.node, [{ label: 'Zrušit' }, { label: 'Použít', primary: true, onclick: () => { st.filters = f.get(); st.page = 1; load(); } }]);
    } }, 'Filtr'));
  }
  tools.push(el('button', { onclick: () => download(url, request({ export: true }), 'hwsw-' + (entity || 'pohled') + '.csv').catch(fail) }, 'Export CSV'));
  if (opts.adhoc) {
    tools.push(el('button', { onclick: () => viewEditor({
      entity, columns: st.columns.length ? st.columns : S.schema.entities[entity].default, filters: st.filters,
      sort: st.sort, sort_dir: st.sortDir,
    }) }, 'Uložit jako pohled'));
  }
  (opts.buttons || []).forEach((b) => tools.push(b));

  const node = el('div', null, el('div', { class: 'toolbar' }, tools), chips,
    el('div', { class: 'table-wrap' }, el('table', null, thead, tbody)), pager);
  load();
  return { node, reload: load, setFilters: (f) => { st.filters = f; st.page = 1; load(); } };
}

// ----------------------------------------------------------- prihlaseni

function renderLogin() {
  if (S.es) { S.es.close(); S.es = null; }
  const err = el('div', { class: 'err', role: 'alert' });
  const user = el('input', { autocomplete: 'username', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    try { await api('POST', '/api/login', { username: user.value, password: pass.value }); await start(); }
    catch (ex) { err.textContent = ex.message; }
  } }, el('h1', null, 'HWSW Monitor'), el('p', { class: 'muted' }, 'Evidence hardwaru a softwaru'),
    field('Přihlašovací jméno', user), field('Heslo', pass), err, el('button', { class: 'primary', type: 'submit' }, 'Přihlásit'));
  $app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'card' }, form)));
  user.focus();
}

function passwordDialog(forced) {
  const oldP = el('input', { type: 'password', autocomplete: 'current-password' });
  const newP = el('input', { type: 'password', autocomplete: 'new-password' });
  const again = el('input', { type: 'password', autocomplete: 'new-password' });
  const body = el('div', null,
    forced ? el('div', { class: 'note-box' }, 'Před prvním použitím si nastavte vlastní heslo.') : null,
    field('Současné heslo', oldP), field('Nové heslo (alespoň 8 znaků)', newP), field('Nové heslo znovu', again));
  const save = { label: 'Změnit heslo', primary: true, onclick: async () => {
    if (newP.value !== again.value) { toast('Nová hesla se neshodují', 'error'); return false; }
    await api('POST', '/api/password', { old: oldP.value, new: newP.value });
    toast('Heslo změněno', 'ok');
    if (forced) start();
  } };
  if (forced) {
    $app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'card' }, el('h1', null, 'Změna hesla'), body,
      el('button', { class: 'primary', onclick: async (e) => {
        e.target.disabled = true;
        try { await save.onclick(); } catch (ex) { fail(ex); }
        e.target.disabled = false;
      } }, 'Změnit heslo'))));
  } else modal('Změna hesla', body, [{ label: 'Zrušit' }, save]);
}

// ------------------------------------------------------------ rozlozeni

const ADMIN_NAV = [
  ['', [['prehled', 'Přehled']]],
  ['Evidence', [['zarizeni', 'Zařízení'], ['software', 'Software'], ['monitory', 'Monitory'], ['usb', 'USB zařízení'], ['licence', 'Licence']]],
  ['Pohledy', [['pohledy', 'Šablony pohledů']]],
  ['Správa', [['skenovani', 'Skenování'], ['agent', 'Agent pro Windows'], ['uzivatele', 'Uživatelé'], ['nastaveni', 'Nastavení'], ['zalohy', 'Zálohy']]],
];

function isAdmin() { return S.me && S.me.role === 'admin'; }

function renderShell() {
  const groups = isAdmin() ? ADMIN_NAV
    : [['', [['prehled', 'Přehled']]], ['Pohledy', S.views.map((v) => ['pohled/' + v.id, v.name])]];
  const nav = el('nav', { class: 'nav', 'aria-label': 'Hlavní nabídka' }, groups.map(([title, items]) => [
    title && items.length ? el('div', { class: 'nav-group' }, title) : null,
    items.map(([path, label]) => el('a', { href: '#/' + path, 'data-path': path }, label)),
  ]));
  const main = el('main', { class: 'main', id: 'main' });
  $app.replaceChildren(el('div', { class: 'shell' },
    el('aside', { class: 'side' },
      el('div', { class: 'brand' }, el('div', { class: 'brand-mark' }, 'HW'), 'HWSW Monitor'), nav,
      el('div', { class: 'side-foot' },
        el('div', { class: 'who' }, S.me.full_name || S.me.username),
        el('div', null, isAdmin() ? 'administrátor' : 'uživatel', ' · v', S.me.version),
        el('button', { class: 'ghost', onclick: () => passwordDialog(false) }, 'Heslo'),
        el('button', { class: 'ghost', onclick: async () => { await api('POST', '/api/logout'); S.me = null; renderLogin(); } }, 'Odhlásit'))),
    main));
}

function pageHead(main, title, sub, ...actions) {
  main.append(el('div', { class: 'page-head' }, el('h1', null, title), el('div', { class: 'right row' }, actions),
    sub ? el('div', { class: 'sub' }, sub) : null));
}

const PAGES = {};

function route() {
  if (!S.me) return;
  const hash = location.hash.replace(/^#\/?/, '') || 'prehled';
  const [path, qs] = hash.split('?');
  const parts = path.split('/');
  const params = new URLSearchParams(qs || '');
  const main = document.getElementById('main');
  if (!main) return;
  S.live = null;
  main.replaceChildren();
  document.querySelectorAll('.nav a').forEach((a) => {
    const p = a.getAttribute('data-path');
    a.classList.toggle('active', p === path || (p === parts[0] && parts[0] !== 'pohled'));
  });
  const userPages = ['prehled', 'pohled', 'zarizeni'];
  let page = PAGES[parts[0]];
  if (!page || (!isAdmin() && !userPages.includes(parts[0]))) page = PAGES.prehled;
  Promise.resolve(page(main, parts.slice(1), params)).catch(fail);
  window.scrollTo(0, 0);
}

// --------------------------------------------------------------- prehled

function bars(items) {
  if (!items.length) return el('div', { class: 'muted' }, 'Zatím žádná data');
  const max = Math.max(...items.map((i) => i.n));
  return el('div', { class: 'bars' }, items.map((i) => [
    el('div', { class: 'k', title: i.label }, i.label),
    el('div', null, el('div', { class: 'bar', style: 'width:' + Math.max(2, Math.round(100 * i.n / max)) + '%' })),
    el('div', { class: 'v' }, i.n)]));
}

function usbFeedItem(e, fresh) {
  return el('li', { class: fresh ? 'fresh' : '' },
    el('time', null, fmtDate(e.ts)),
    el('span', { class: 'badge ' + (ACTION_BADGE[e.action] || '') }, e.action),
    el('strong', null, e.name || 'USB zařízení'),
    el('span', { class: 'muted' }, [e.class, e.serial ? 'SN ' + e.serial : ''].filter(Boolean).join(' · ')),
    el('a', { class: 'right', href: '#/zarizeni/' + e.device_id }, e.hostname),
    e.user ? el('span', { class: 'muted' }, e.user) : null);
}

PAGES.prehled = async (main) => {
  const d = await api('GET', '/api/dashboard');
  pageHead(main, 'Přehled', isAdmin() ? 'Stav sítě, hardwaru a softwaru' : 'Souhrn evidence');
  const stat = (n, label, href) => {
    const inner = [el('div', { class: 'n' }, n), el('div', { class: 'l' }, label)];
    return href && isAdmin() ? el('a', { class: 'card stat', href }, inner) : el('div', { class: 'card stat' }, inner);
  };
  main.append(el('div', { class: 'grid stats' },
    stat(d.devices, 'zařízení celkem', '#/zarizeni'), stat(d.online, 'právě online', '#/zarizeni'),
    stat(d.inventoried, 's úplnou inventurou', '#/zarizeni'), stat(d.monitors, 'monitorů', '#/monitory'),
    stat(d.software_titles, 'titulů softwaru', '#/software'), stat(d.usb_now, 'připojených USB', '#/usb'),
    stat(d.usb_24h, 'USB událostí za 24 h', '#/usb'), stat(d.licenses, 'evidovaných licencí', '#/licence')));
  main.append(el('div', { class: 'grid two' },
    el('div', { class: 'card' }, el('h3', null, 'Podle typu'), bars(d.by_type)),
    el('div', { class: 'card' }, el('h3', null, 'Operační systémy'), bars(d.by_os)),
    el('div', { class: 'card' }, el('h3', null, 'Výrobci počítačů'), bars(d.by_maker))));
  if (!isAdmin()) {
    if (S.views.length) {
      main.append(el('div', { class: 'card' }, el('h3', null, 'Vaše pohledy'), el('ul', { class: 'feed' },
        S.views.map((v) => el('li', null, el('a', { href: '#/pohled/' + v.id }, v.name), el('span', { class: 'muted' }, v.description))))));
    } else main.append(el('div', { class: 'card muted' }, 'Administrátor vám zatím nepřidělil žádný pohled.'));
    return;
  }
  if (d.devices === 0) {
    main.prepend(el('div', { class: 'note-box info' }, 'Evidence je zatím prázdná. Začněte v ',
      el('a', { href: '#/nastaveni' }, 'Nastavení'), ' (Active Directory, IP rozsah) a nasaďte ',
      el('a', { href: '#/agent' }, 'agenta'), ' na počítače.'));
    main.prepend(main.querySelector('.page-head'));
  }
  const feed = el('ul', { class: 'feed' }, d.usb_recent.map((e) => usbFeedItem(e, false)));
  const emptyFeed = el('div', { class: 'muted' }, 'Zatím žádné události. Zobrazují se okamžitě po připojení USB na počítači s agentem.');
  main.append(el('div', { class: 'grid two' },
    el('div', { class: 'card' }, el('h3', null, 'USB – živě'), d.usb_recent.length ? null : emptyFeed, feed),
    el('div', { class: 'card' }, el('h3', null, 'Licence – upozornění'),
      d.license_alerts.length ? el('ul', { class: 'feed' }, d.license_alerts.map((a) => el('li', null,
        el('span', { class: 'badge ' + (a.kind === 'expiring' ? 'warn' : 'bad') }, a.kind === 'over' ? 'překročeno' : (a.kind === 'expired' ? 'propadlá' : 'končí')),
        el('strong', null, a.product), el('span', { class: 'muted' }, a.text))))
        : el('div', { class: 'muted' }, 'Žádná upozornění'),
      el('h3', { style: 'margin-top:18px' }, 'Poslední úlohy'),
      d.jobs.length ? el('ul', { class: 'feed' }, d.jobs.map((j) => el('li', null, el('time', null, fmtDate(j.started)),
        el('span', { class: 'badge ' + (j.status === 'ok' ? 'ok' : (j.status === 'chyba' ? 'bad' : 'warn')) }, j.status === 'running' ? 'běží' : j.status),
        el('span', null, j.summary || j.kind)))) : el('div', { class: 'muted' }, 'Zatím neproběhla žádná úloha'))));
  S.live = (ev) => {
    if (ev.type !== 'usb') return;
    emptyFeed.remove();
    feed.prepend(usbFeedItem(ev, true));
    while (feed.children.length > 15) feed.lastChild.remove();
  };
};

// -------------------------------------------------------------- evidence

PAGES.zarizeni = async (main, parts, params) => {
  if (parts[0]) return deviceDetail(main, parts[0], params.get('view'));
  if (!isAdmin()) return PAGES.prehled(main);
  pageHead(main, 'Zařízení', 'Vše, co bylo nalezeno v doméně, v IP rozsahu nebo nahlášeno agentem');
  const t = dataTable({ entity: 'devices', adhoc: true, onRow: (r) => { location.hash = '#/zarizeni/' + r._id; } });
  main.append(t.node);
  S.live = (ev) => { if (ev.type === 'job') t.reload(); };
};

function tabbed(main, tabs, initial) {
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const box = el('div');
  const show = (key, arg) => {
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
    box.replaceChildren();
    tabs.find((t) => t[0] === key)[2](box, arg);
  };
  tabs.forEach(([key, label]) => bar.append(el('button', { 'data-key': key, role: 'tab', onclick: () => show(key) }, label)));
  main.append(bar, box);
  show(initial || tabs[0][0]);
  return show;
}

PAGES.software = async (main) => {
  pageHead(main, 'Software', 'Nainstalovaný software podle hlášení agentů');
  const openDevice = (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id; };
  const show = tabbed(main, [
    ['souhrn', 'Souhrn', (box) => box.append(dataTable({ entity: 'software_summary', adhoc: true,
      onRow: (r) => show('instalace', r.name) }).node)],
    ['instalace', 'Instalace na počítačích', (box, name) => box.append(dataTable({ entity: 'software', adhoc: true,
      filters: name ? [{ col: 'name', op: 'eq', value: name }] : [], onRow: openDevice }).node)],
    ['zmeny', 'Změny', (box) => box.append(dataTable({ entity: 'sw_changes', adhoc: true, onRow: openDevice,
      emptyText: 'Změny se zaznamenávají od druhé inventury každého počítače' }).node)],
  ]);
};

PAGES.monitory = async (main) => {
  pageHead(main, 'Monitory', 'Výrobce, model, sériové číslo a úhlopříčka z EDID monitoru');
  main.append(dataTable({ entity: 'monitors', adhoc: true,
    onRow: (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id; } }).node);
};

PAGES.usb = async (main) => {
  pageHead(main, 'USB zařízení', 'Události přicházejí z agentů během několika sekund po připojení nebo odpojení');
  let current = null;
  const openDevice = (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id; };
  tabbed(main, [
    ['udalosti', 'Události', (box) => { current = dataTable({ entity: 'usb_events', adhoc: true, onRow: openDevice }); box.append(current.node); }],
    ['pripojena', 'Právě připojená', (box) => { current = dataTable({ entity: 'usb_current', adhoc: true, onRow: openDevice }); box.append(current.node); }],
  ]);
  S.live = (ev) => { if (ev.type === 'usb' && current) current.reload(); };
};

// ------------------------------------------------------- detail zarizeni

async function deviceDetail(main, id, viewId) {
  const d = await api('GET', '/api/devices/' + id + (viewId ? '?view=' + encodeURIComponent(viewId) : ''));
  const x = d.details || {};
  const sys = x.system || {};
  const os = x.os || {};
  const admin = isAdmin();
  pageHead(main, d.hostname || d.ip || 'Zařízení',
    [d.manufacturer, d.model].filter(Boolean).join(' ') || null,
    el('span', { class: 'badge' }, d.device_type || 'neznámé'),
    el('span', { class: 'badge ' + (d.online ? 'ok' : '') }, d.online ? 'online' : 'offline'),
    el('button', { onclick: () => history.back() }, '← Zpět'),
    admin ? el('button', { class: 'danger', onclick: async () => {
      if (!(await confirmBox('Smazat zařízení „' + (d.hostname || d.ip) + '“ včetně historie? Pokud je stále v síti, při dalším skenu se objeví znovu.', 'Smazat'))) return;
      await api('DELETE', '/api/devices/' + id); location.hash = '#/zarizeni';
    } }, 'Smazat') : null);

  const kv = (pairs) => el('dl', { class: 'kv' }, pairs.filter((p) => p[1] != null && p[1] !== '').map(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
  const inputs = {};
  const edit = (key, label, multi) => {
    inputs[key] = multi ? el('textarea', { value: d[key] || '' }) : el('input', { value: d[key] || '' });
    return field(label, inputs[key]);
  };
  const p = d.person;
  main.append(el('div', { class: 'grid two' },
    el('div', { class: 'card' }, el('h3', null, 'Systém'), kv([
      ['Výrobce', d.manufacturer], ['Model', d.model], ['Sériové číslo', d.serial], ['SKU', sys.sku],
      ['BIOS', [d.bios_version, sys.bios_date].filter(Boolean).join(' · ')],
      ['Operační systém', d.os_name], ['Verze', d.os_version], ['Architektura', os.arch],
      ['Instalace OS', os.install_date], ['Poslední start', os.last_boot],
      ['Procesor', d.cpu], ['Paměť', d.ram_mb ? (d.ram_mb / 1024).toFixed(1).replace('.', ',') + ' GB' : ''],
      ['Disky celkem', d.disk_gb ? d.disk_gb + ' GB' : ''],
      ['IP adresa', d.ip], ['MAC adresa', d.mac], ['Otevřené porty', d.open_ports], ['Doména', d.domain], ['FQDN', d.fqdn],
      ['AD jednotka', d.ad_ou], ['Popis v AD', d.ad_description], ['Poslední přihlášení v AD', fmtDate(d.ad_last_logon)],
      ['Účet v AD', d.ad_enabled === 0 ? 'zakázaný' : ''],
      ['Zdroj dat', d.source], ['Agent', d.agent_version], ['Poprvé viděn', fmtDate(d.first_seen)],
      ['Naposledy viděn', fmtDate(d.last_seen)], ['Poslední inventura', fmtDate(d.last_inventory)]])),
    el('div', { class: 'card' }, el('h3', null, 'Uživatel'), kv([
      ['Přihlášený uživatel', d.logged_user || '—'], ['Jméno', p && p.display_name], ['E-mail', p && p.mail],
      ['Oddělení', p && p.department], ['Pozice', p && p.title]]),
      el('h3', { style: 'margin-top:18px' }, 'Evidence'),
      admin ? [el('div', { class: 'form-grid' }, edit('device_type', 'Typ zařízení'), edit('asset_tag', 'Inventární číslo'),
        edit('location', 'Umístění'), edit('assigned_user', 'Přidělen komu')), edit('note', 'Poznámka', true),
        el('button', { class: 'primary', onclick: async () => {
          const body = {}; Object.keys(inputs).forEach((k) => { body[k] = inputs[k].value; });
          try { await api('PUT', '/api/devices/' + id, body); toast('Uloženo', 'ok'); } catch (e) { fail(e); }
        } }, 'Uložit')]
        : kv([['Typ zařízení', d.device_type], ['Inventární číslo', d.asset_tag], ['Umístění', d.location],
          ['Přidělen komu', d.assigned_user], ['Poznámka', d.note]]))));

  const section = (title, table) => el('div', { class: 'card' }, el('h3', null, title), table);
  const gb = (v) => (v || v === 0 ? String(v).replace('.', ',') + ' GB' : '');
  tabbed(main, [
    ['hw', 'Hardware', (box) => {
      if (!d.last_inventory) {
        box.append(el('div', { class: 'note-box info' }, 'Podrobný popis hardwaru zatím chybí – počítač ještě neposlal inventuru. Nasaďte na něj agenta nebo zapněte inventuru přes WinRM.'));
        return;
      }
      box.append(
        section('Procesor', simpleTable(['Název', 'Jader', 'Vláken'], (x.cpu || []).map((c) => [c.name, c.cores, c.threads]))),
        section('Paměťové moduly', simpleTable(['Slot', 'Velikost', 'Rychlost', 'Výrobce', 'Označení', 'Sériové číslo'],
          (x.ram_modules || []).map((m) => [m.slot, m.size_mb ? Math.round(m.size_mb / 1024) + ' GB' : '', m.speed ? m.speed + ' MHz' : '', m.manufacturer, m.part, m.serial]))),
        section('Disky', simpleTable(['Model', 'Sériové číslo', 'Velikost', 'Typ', 'Rozhraní'],
          (x.disks || []).map((k) => [k.model, k.serial, gb(k.size_gb), k.type, k.interface]))),
        section('Svazky', simpleTable(['Jednotka', 'Systém souborů', 'Velikost', 'Volné'],
          (x.volumes || []).map((v) => [v.drive, v.fs, gb(v.size_gb), gb(v.free_gb)]))),
        section('Grafika', simpleTable(['Název', 'Paměť', 'Ovladač'], (x.gpus || []).map((g) => [g.name, g.vram_mb ? g.vram_mb + ' MB' : '', g.driver]))),
        section('Síťové adaptéry', simpleTable(['Název', 'MAC', 'IP adresy', 'Brána', 'DNS', 'DHCP'],
          (x.nics || []).map((n) => [n.name, n.mac, (n.ips || []).join(', '), n.gateway, n.dns, n.dhcp ? 'ano' : 'ne']))),
        section('Tiskárny', simpleTable(['Název', 'Ovladač', 'Port', 'Výchozí'],
          (x.printers || []).map((t) => [t.name, t.driver, t.port, t.is_default ? 'ano' : '']))));
    }],
    ['mon', 'Monitory (' + d.monitors.filter((m) => m.connected).length + ')', (box) => box.append(simpleTable(
      ['Výrobce', 'Model', 'Sériové číslo', 'Úhlopříčka', 'Rok výroby', 'Připojení', 'Stav', 'Naposledy viděn'],
      d.monitors.map((m) => [m.manufacturer, m.model, m.serial, m.size_inch ? String(m.size_inch).replace('.', ',') + '"' : '', m.year,
        m.connection, el('span', { class: 'badge ' + (m.connected ? 'ok' : '') }, m.connected ? 'připojen' : 'dříve připojen'), fmtDate(m.last_seen)]),
      'Žádný monitor nebyl zjištěn'))],
    ['sw', 'Software (' + d.software.length + ')', (box) => {
      const q = el('input', { type: 'search', placeholder: 'Hledat v softwaru…', 'aria-label': 'Hledat v softwaru' });
      const holder = el('div');
      const draw = () => {
        const needle = q.value.toLowerCase();
        holder.replaceChildren(simpleTable(['Název', 'Verze', 'Vydavatel', 'Nainstalováno'],
          d.software.filter((s) => !needle || (s.name + ' ' + s.publisher).toLowerCase().includes(needle))
            .map((s) => [s.name, s.version, s.publisher, s.install_date]), 'Žádný software'));
      };
      q.addEventListener('input', draw);
      box.append(el('div', { class: 'toolbar' }, q), holder);
      draw();
    }],
    ['usb', 'USB (' + d.usb_current.length + ')', (box) => box.append(
      section('Právě připojeno', simpleTable(['Zařízení', 'Třída', 'Výrobce', 'VID:PID', 'Sériové číslo', 'Od'],
        d.usb_current.map((u) => [u.name, u.class, u.manufacturer, u.vid + ':' + u.pid, u.serial, fmtDate(u.connected_at)]), 'Nic připojeno')),
      section('Historie', simpleTable(['Čas', 'Událost', 'Zařízení', 'Třída', 'VID:PID', 'Sériové číslo', 'Uživatel'],
        d.usb_events.map((u) => [fmtDate(u.ts), el('span', { class: 'badge ' + (ACTION_BADGE[u.action] || '') }, u.action), u.name, u.class,
          u.vid + ':' + u.pid, u.serial, u.logged_user]), 'Zatím žádné události')))],
    ['hist', 'Změny softwaru', (box) => box.append(simpleTable(['Čas', 'Událost', 'Software', 'Verze'],
      d.sw_changes.map((c) => [fmtDate(c.ts), el('span', { class: 'badge ' + (ACTION_BADGE[c.action] || '') }, c.action), c.name, c.version]),
      'Zatím žádné změny'))],
  ]);
  S.live = (ev) => {
    if ((ev.type === 'usb' || ev.type === 'inventory') && String(ev.device_id) === String(id) && !document.querySelector('.overlay')) {
      const active = document.activeElement;
      if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
      route();
    }
  };
}

// --------------------------------------------------------------- licence

const LICENSE_FORM = [
  ['product', 'Produkt *'], ['vendor', 'Výrobce'], ['license_type', 'Typ licence (OEM, předplatné, multilicence…)'],
  ['seats', 'Počet zakoupených licencí', 'number'], ['license_key', 'Licenční klíč'],
  ['match_pattern', 'Vzor názvu softwaru'], ['purchased', 'Zakoupeno dne', 'date'], ['expires', 'Platnost do', 'date'],
  ['cost', 'Cena'], ['supplier', 'Dodavatel'], ['invoice', 'Faktura / doklad'], ['assigned_to', 'Přiděleno (osoba, oddělení)'],
];

async function licenseDialog(id, reload) {
  const lic = id ? await api('GET', '/api/licenses/' + id) : { seats: 1 };
  const inputs = {};
  const grid = el('div', { class: 'form-grid' }, LICENSE_FORM.map(([key, label, type]) => {
    inputs[key] = el('input', { type: type || 'text', value: lic[key] == null ? '' : lic[key] });
    return field(label, inputs[key]);
  }));
  inputs.note = el('textarea', { value: lic.note || '' });
  const body = el('div', null, grid,
    el('div', { class: 'hint' }, 'Vzor názvu softwaru slouží ke spočítání instalací, např. „Microsoft Office“ nebo „Adobe Acrobat%Pro“ (% = libovolný text).'),
    field('Poznámka', inputs.note));
  if (id && lic.match_pattern) {
    body.append(el('h3', null, 'Nalezené instalace (' + new Set(lic.installs.map((i) => i.device_id)).size + ' počítačů)'),
      simpleTable(['Počítač', 'Uživatel', 'Software', 'Verze'],
        lic.installs.map((i) => [el('a', { href: '#/zarizeni/' + i.device_id }, i.hostname), i.logged_user, i.name, i.version]),
        'Vzoru neodpovídá žádný nainstalovaný software'));
  }
  const values = () => { const b = {}; Object.keys(inputs).forEach((k) => { b[k] = inputs[k].value; }); return b; };
  const buttons = [{ label: 'Zrušit' }];
  if (id) {
    buttons.unshift({ label: 'Smazat', danger: true, onclick: async () => {
      if (!(await confirmBox('Smazat licenci „' + lic.product + '“?', 'Smazat'))) return false;
      await api('DELETE', '/api/licenses/' + id); reload();
    } });
  }
  buttons.push({ label: 'Uložit', primary: true, onclick: async () => {
    await api(id ? 'PUT' : 'POST', '/api/licenses' + (id ? '/' + id : ''), values()); toast('Licence uložena', 'ok'); reload();
  } });
  modal(id ? 'Licence' : 'Nová licence', body, buttons, true);
}

function licenseImport(reload) {
  const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  const body = el('div', null,
    el('p', null, 'Nahrajte CSV soubor (oddělovač středník, čárka nebo tabulátor; první řádek je hlavička). Rozpoznané sloupce:'),
    el('p', { class: 'mono' }, 'produkt; výrobce; typ; počet; klíč; vzor; zakoupeno; platnost; cena; dodavatel; faktura; přiděleno; poznámka'),
    el('p', { class: 'muted' }, 'Povinný je jen sloupec „produkt“. Data mohou být ve tvaru 31.12.2026 nebo 2026-12-31. Soubor z Excelu uložte jako „CSV UTF-8“.'),
    file);
  modal('Import licencí z CSV', body, [{ label: 'Zrušit' }, { label: 'Importovat', primary: true, onclick: async () => {
    if (!file.files[0]) { toast('Vyberte soubor', 'error'); return false; }
    const r = await api('POST', '/api/licenses/import', { csv: await file.files[0].text() });
    toast('Importováno ' + r.imported + ' licencí' + (r.skipped ? ', přeskočeno ' + r.skipped + ' řádků' : ''), 'ok');
    reload();
  } }]);
}

PAGES.licence = async (main) => {
  pageHead(main, 'Licence', 'Evidence licencí a porovnání se skutečně nainstalovaným softwarem');
  let t = null;
  const reload = () => t.reload();
  t = dataTable({ entity: 'licenses', adhoc: true, onRow: (r) => licenseDialog(r._id, reload).catch(fail),
    emptyText: 'Zatím žádné licence – přidejte je ručně nebo importujte z CSV',
    buttons: [el('button', { onclick: () => licenseImport(reload) }, 'Import CSV'),
      el('button', { class: 'primary', onclick: () => licenseDialog(null, reload).catch(fail) }, 'Přidat licenci')] });
  main.append(t.node);
};

// --------------------------------------------------------------- pohledy

async function refreshViews() { S.views = await api('GET', '/api/views'); }

async function viewEditor(view) {
  const users = (await api('GET', '/api/users')).filter((u) => u.role !== 'admin');
  const v = Object.assign({ name: '', description: '', entity: 'devices', columns: null, filters: [], shared_all: false, user_ids: [], allow_detail: true }, view);
  const name = el('input', { value: v.name, placeholder: 'např. Počítače účetního oddělení' });
  const desc = el('input', { value: v.description || '' });
  const entity = el('select', null, Object.entries(S.schema.entities).map(([k, e]) => el('option', { value: k, selected: k === v.entity }, e.label)));
  const colBox = el('div'); const filBox = el('div');
  const sort = el('select'); const dir = el('select', null, el('option', { value: 'asc' }, 'vzestupně'), el('option', { value: 'desc', selected: v.sort_dir === 'desc' }, 'sestupně'));
  let cols = null; let fil = null;
  const build = (first) => {
    const e = S.schema.entities[entity.value];
    cols = columnPicker(entity.value, first && v.columns ? v.columns : e.default);
    fil = filterBuilder(entity.value, first ? v.filters : []);
    colBox.replaceChildren(cols.node); filBox.replaceChildren(fil.node);
    const wanted = first && v.sort ? v.sort : e.sort;
    sort.replaceChildren(...e.columns.map((c) => el('option', { value: c.key, selected: c.key === wanted }, c.label)));
    if (!first) dir.value = e.sort_dir;
  };
  entity.addEventListener('change', () => build(false));
  build(true);
  const all = el('input', { type: 'checkbox', checked: !!v.shared_all });
  const detail = el('input', { type: 'checkbox', checked: !!v.allow_detail });
  const userChecks = users.map((u) => [u.id, el('input', { type: 'checkbox', checked: v.user_ids.includes(u.id) })]);
  const userBox = el('div', null, users.length ? users.map((u, i) => el('label', { class: 'check' }, userChecks[i][1], u.full_name ? u.full_name + ' (' + u.username + ')' : u.username))
    : el('div', { class: 'muted small' }, 'Zatím neexistuje žádný účet s rolí „uživatel“.'));
  const sync = () => { userBox.classList.toggle('hidden', all.checked); };
  all.addEventListener('change', sync); sync();
  const body = el('div', null,
    el('div', { class: 'form-grid' }, field('Název pohledu', name), field('Typ dat', entity)),
    field('Popis', desc),
    el('h3', null, 'Sloupce'), colBox,
    el('h3', { style: 'margin-top:14px' }, 'Podmínky (filtr)'), filBox,
    el('div', { class: 'form-grid', style: 'margin-top:14px' }, field('Řadit podle', sort), field('Směr', dir)),
    el('h3', null, 'Kdo pohled uvidí'),
    el('label', { class: 'check' }, all, 'Všichni uživatelé'), userBox,
    el('label', { class: 'check' }, detail, 'Povolit uživatelům otevřít detail zařízení'),
    el('div', { class: 'hint' }, 'Uživatelé vidí jen vybrané sloupce a řádky. Administrátoři vidí všechny pohledy.'));
  modal(v.id ? 'Úprava pohledu' : 'Nový pohled', body, [{ label: 'Zrušit' }, { label: 'Uložit pohled', primary: true, onclick: async () => {
    const payload = { name: name.value, description: desc.value, entity: entity.value, columns: cols.get(), filters: fil.get(),
      sort: sort.value, sort_dir: dir.value, shared_all: all.checked, allow_detail: detail.checked,
      user_ids: userChecks.filter((c) => c[1].checked).map((c) => c[0]) };
    await api(v.id ? 'PUT' : 'POST', '/api/views' + (v.id ? '/' + v.id : ''), payload);
    await refreshViews();
    toast('Pohled uložen', 'ok');
    if (location.hash.startsWith('#/pohled')) route(); else location.hash = '#/pohledy';
  } }], true);
}

PAGES.pohledy = async (main) => {
  await refreshViews();
  pageHead(main, 'Šablony pohledů', 'Připravené pohledy na síť, hardware a software, které můžete zpřístupnit uživatelům',
    el('button', { class: 'primary', onclick: () => viewEditor(null).catch(fail) }, 'Nový pohled'));
  main.append(simpleTable(['Název', 'Typ dat', 'Popis', 'Sdílení', ''], S.views.map((v) => [
    el('a', { href: '#/pohled/' + v.id }, v.name), v.entity_label, v.description,
    v.shared_all ? el('span', { class: 'badge ok' }, 'všichni uživatelé')
      : (v.user_ids.length ? el('span', { class: 'badge' }, 'vybraní: ' + v.user_ids.length) : el('span', { class: 'badge' }, 'jen administrátoři')),
    el('div', { class: 'row' }, el('button', { class: 'mini', onclick: () => viewEditor(v).catch(fail) }, 'Upravit'),
      el('button', { class: 'mini danger', onclick: async () => {
        if (!(await confirmBox('Smazat pohled „' + v.name + '“?', 'Smazat'))) return;
        await api('DELETE', '/api/views/' + v.id); route();
      } }, 'Smazat'))]), 'Zatím žádné pohledy'));
};

PAGES.pohled = async (main, parts) => {
  const id = Number(parts[0]);
  const v = S.views.find((x) => x.id === id);
  if (!v) { main.append(el('div', { class: 'card muted' }, 'Pohled neexistuje nebo k němu nemáte přístup.')); return; }
  pageHead(main, v.name, v.description || v.entity_label,
    isAdmin() ? el('button', { onclick: () => viewEditor(v).catch(fail) }, 'Upravit pohled') : null);
  const canOpen = isAdmin() || v.allow_detail;
  const t = dataTable({ viewId: id, entity: v.entity, rowClickable: () => canOpen && S.schema.entities[v.entity].has_device,
    onRow: (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id + (isAdmin() ? '' : '?view=' + id); } });
  main.append(t.node);
  S.live = (ev) => { if ((ev.type === 'usb' && v.entity.startsWith('usb')) || ev.type === 'job') t.reload(); };
};

// ---------------------------------------------------------------- sprava

PAGES.skenovani = async (main) => {
  const [cfg, jobs] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/jobs')]);
  pageHead(main, 'Skenování', 'Zjišťování zařízení v doméně a v síti');
  const running = new Set(jobs.filter((j) => j.status === 'running').map((j) => j.kind));
  const card = (kind, title, text, enabled, interval) => el('div', { class: 'card' }, el('h2', null, title), el('p', { class: 'muted' }, text),
    el('div', { class: 'row' },
      el('span', { class: 'badge ' + (enabled ? 'ok' : '') }, enabled ? 'automaticky každých ' + interval + ' min' : 'automatika vypnuta'),
      el('button', { class: 'primary right', disabled: running.has(kind), onclick: async (e) => {
        e.target.disabled = true;
        try { await api('POST', '/api/jobs/' + kind + '/run'); toast('Úloha spuštěna', 'ok'); setTimeout(route, 600); } catch (ex) { fail(ex); e.target.disabled = false; }
      } }, running.has(kind) ? 'Běží…' : 'Spustit teď')));
  main.append(el('div', { class: 'grid two' },
    card('ad_sync', 'Active Directory', 'Načte počítače a uživatele z domény (název, OS, organizační jednotka, poslední přihlášení).', cfg.ad_enabled === '1', cfg.ad_interval_min),
    card('ip_scan', 'Sken IP rozsahu', 'Najde vše, co v síti odpovídá: tiskárny, switche, NAS, kamery i počítače mimo doménu. Rozsah: ' + (cfg.scan_ranges || 'není zadán'), cfg.scan_enabled === '1', cfg.scan_interval_min),
    card('winrm', 'Inventura přes WinRM', 'Bez předchozí instalace spustí inventuru (nebo instalaci agenta) na počítačích s Windows, které ji dlouho neposlaly.', cfg.winrm_enabled === '1', cfg.winrm_interval_min)));
  main.append(el('h2', null, 'Historie úloh'), simpleTable(['Spuštěno', 'Úloha', 'Stav', 'Výsledek', 'Dokončeno'], jobs.map((j) => [
    fmtDate(j.started), j.label, el('span', { class: 'badge ' + (j.status === 'ok' ? 'ok' : (j.status === 'chyba' ? 'bad' : 'warn')) }, j.status === 'running' ? 'běží' : j.status),
    j.summary, fmtDate(j.finished)]), 'Zatím neproběhla žádná úloha'));
  S.live = (ev) => { if (ev.type === 'job') route(); };
};

PAGES.agent = async (main) => {
  const a = await api('GET', '/api/agent-info');
  pageHead(main, 'Agent pro Windows', 'Malý skript, který z počítače posílá přesný popis hardwaru, softwaru, monitorů a hlídá USB');
  const cmd = (text) => el('div', { class: 'cmd' }, el('pre', null, text), copyButton(text));
  main.append(
    a.server_url_set ? null : el('div', { class: 'note-box' }, 'V ', el('a', { href: '#/nastaveni' }, 'Nastavení'),
      ' není vyplněna adresa serveru. Příkazy níže používají adresu, ze které máte právě otevřený prohlížeč (', a.server_url,
      ') – ověřte, že je dostupná ze všech počítačů.'),
    el('div', { class: 'card' }, el('h2', null, 'Trvalá instalace (doporučeno)'),
      el('p', null, 'Spusťte na počítači v příkazovém řádku jako správce. Agent se uloží do C:\\ProgramData\\HWSW-Agent a poběží jako naplánovaná úloha pod účtem SYSTEM – i bez přihlášeného uživatele. Hromadně ho nasadíte přes GPO jako spouštěcí skript počítače se stejným příkazem.'),
      cmd(a.install),
      el('p', { class: 'muted' }, 'Agentů aktuálně hlásí: ', el('strong', null, a.agents), '. USB události chodí jen z počítačů s trvale nainstalovaným agentem.')),
    el('div', { class: 'card' }, el('h2', null, 'Jednorázová inventura'),
      el('p', null, 'Nic neinstaluje, jen jednou odešle inventuru. Stejný příkaz používá inventura přes WinRM.'), cmd(a.once)),
    el('div', { class: 'card' }, el('h2', null, 'Odinstalace'), cmd(a.uninstall)),
    el('div', { class: 'card' }, el('h2', null, 'Token agentů'),
      el('p', null, 'Token je součástí příkazů výše a opravňuje počítače posílat data. Držte ho v tajnosti.'),
      el('div', { class: 'cmd' }, el('pre', null, a.token)),
      el('button', { class: 'danger', onclick: async () => {
        if (!(await confirmBox('Vygenerovat nový token? Všichni nainstalovaní agenti přestanou odesílat data, dokud je znovu nenainstalujete novým příkazem.', 'Vygenerovat nový'))) return;
        await api('POST', '/api/agent-token/regenerate'); route();
      } }, 'Vygenerovat nový token')));
};

PAGES.uzivatele = async (main) => {
  const users = await api('GET', '/api/users');
  const dialog = (u) => {
    const username = el('input', { value: u ? u.username : '', disabled: !!u, autocomplete: 'off' });
    const full = el('input', { value: u ? u.full_name : '' });
    const role = el('select', null, el('option', { value: 'user' }, 'uživatel – vidí jen přidělené pohledy'),
      el('option', { value: 'admin', selected: u && u.role === 'admin' }, 'administrátor – plný přístup'));
    const pass = el('input', { type: 'password', autocomplete: 'new-password' });
    modal(u ? 'Úprava uživatele' : 'Nový uživatel', el('div', null, field('Přihlašovací jméno', username), field('Celé jméno', full),
      field('Role', role), field(u ? 'Nové heslo (prázdné = beze změny)' : 'Heslo (alespoň 8 znaků)', pass,
        'Uživatel si heslo při prvním přihlášení musí změnit.')),
    [{ label: 'Zrušit' }, { label: 'Uložit', primary: true, onclick: async () => {
      const body = { username: username.value, full_name: full.value, role: role.value, password: pass.value };
      await api(u ? 'PUT' : 'POST', '/api/users' + (u ? '/' + u.id : ''), body); route();
    } }]);
  };
  pageHead(main, 'Uživatelé', 'Účty pro přihlášení do této aplikace', el('button', { class: 'primary', onclick: () => dialog(null) }, 'Nový uživatel'));
  main.append(simpleTable(['Jméno', 'Celé jméno', 'Role', 'Poslední přihlášení', ''], users.map((u) => [
    u.username, u.full_name, el('span', { class: 'badge ' + (u.role === 'admin' ? 'ok' : '') }, u.role === 'admin' ? 'administrátor' : 'uživatel'),
    fmtDate(u.last_login) || 'nikdy',
    el('div', { class: 'row' }, el('button', { class: 'mini', onclick: () => dialog(u) }, 'Upravit'),
      u.id === S.me.id ? null : el('button', { class: 'mini danger', onclick: async () => {
        if (!(await confirmBox('Smazat uživatele „' + u.username + '“?', 'Smazat'))) return;
        try { await api('DELETE', '/api/users/' + u.id); route(); } catch (e) { fail(e); }
      } }, 'Smazat'))])));
};

PAGES.nastaveni = async (main) => {
  const cfg = await api('GET', '/api/settings');
  const inputs = {};
  const text = (key, label, hint, type) => { inputs[key] = el('input', { type: type || 'text', value: cfg[key] || '' }); return field(label, inputs[key], hint); };
  const check = (key, label) => { inputs[key] = el('input', { type: 'checkbox', checked: cfg[key] === '1' }); return el('label', { class: 'check' }, inputs[key], label); };
  const values = () => { const b = {}; Object.keys(inputs).forEach((k) => { b[k] = inputs[k].type === 'checkbox' ? (inputs[k].checked ? '1' : '0') : inputs[k].value; }); return b; };
  const save = async () => { try { await api('PUT', '/api/settings', values()); toast('Nastavení uloženo', 'ok'); } catch (e) { fail(e); } };
  pageHead(main, 'Nastavení', null, el('button', { class: 'primary', onclick: save }, 'Uložit nastavení'));
  inputs.scan_ranges = el('textarea', { value: cfg.scan_ranges || '', placeholder: '192.168.1.0/24\n10.0.5.10-10.0.5.80' });
  inputs.winrm_mode = el('select', null, el('option', { value: 'once' }, 'jen odeslat inventuru (nic neinstaluje)'),
    el('option', { value: 'install', selected: cfg.winrm_mode === 'install' }, 'nainstalovat trvalého agenta (USB v reálném čase)'));
  const adResult = el('span', { class: 'small' });
  main.append(
    el('div', { class: 'card' }, el('h2', null, 'Server'),
      text('server_url', 'Adresa této aplikace v síti', 'Např. http://192.168.1.10:8580 – na tuto adresu posílají data agenti. Musí být dostupná ze všech počítačů.'),
      el('div', { class: 'form-grid' },
        text('offline_after_min', 'Považovat za offline po (min)', null, 'number'),
        text('agent_inventory_hours', 'Agent posílá úplnou inventuru každých (h)', null, 'number'),
        text('usb_events_keep_days', 'Uchovávat historii USB a změn SW (dní)', null, 'number')),
      check('agent_autoupdate', 'Agenti se po aktualizaci serveru sami aktualizují'),
      el('div', { class: 'hint' }, 'Agent běží pod účtem SYSTEM. Automatickou aktualizaci zapínejte jen tehdy, když je aplikace dostupná přes HTTPS nebo v důvěryhodné síti.')),
    el('div', { class: 'card' }, el('h2', null, 'Active Directory'),
      check('ad_enabled', 'Pravidelně synchronizovat počítače a uživatele z domény'),
      el('div', { class: 'form-grid' },
        text('ad_server', 'Řadič domény (název nebo IP)'),
        text('ad_base_dn', 'Base DN (nepovinné)', 'Např. DC=firma,DC=local nebo jen jedna OU. Prázdné = celá doména.'),
        text('ad_user', 'Účet pro čtení', 'Tvar uzivatel@firma.local nebo FIRMA\\uzivatel. Stačí běžný účet bez zvláštních práv.'),
        text('ad_password', 'Heslo', null, 'password'),
        text('ad_interval_min', 'Interval (min)', null, 'number')),
      check('ad_use_ssl', 'Použít LDAPS (port 636)'),
      el('div', { class: 'row' }, el('button', { onclick: async (e) => {
        e.target.disabled = true; adResult.textContent = 'Zkouším…';
        try { const r = await api('POST', '/api/settings/test-ad', values()); adResult.textContent = r.message; adResult.className = 'small ' + (r.ok ? '' : 'muted'); }
        catch (ex) { adResult.textContent = ex.message; }
        e.target.disabled = false;
      } }, 'Vyzkoušet připojení'), adResult)),
    el('div', { class: 'card' }, el('h2', null, 'Sken IP rozsahu'),
      check('scan_enabled', 'Pravidelně prohledávat síť'),
      field('IP rozsahy', inputs.scan_ranges, 'Jeden na řádek: síť 192.168.1.0/24, rozsah 192.168.1.10-192.168.1.50 nebo jednotlivá adresa. Nejvýše 8192 adres.'),
      el('div', { class: 'form-grid' }, text('scan_interval_min', 'Interval (min)', null, 'number'),
        text('snmp_community', 'SNMP community', 'Pro rozpoznání tiskáren, switchů a NAS. Prázdné = SNMP nepoužívat.'))),
    el('div', { class: 'card' }, el('h2', null, 'Inventura přes WinRM (bez ruční instalace)'),
      check('winrm_enabled', 'Pravidelně oslovovat počítače s Windows přes WinRM'),
      el('div', { class: 'form-grid' },
        text('winrm_user', 'Účet s právy správce na počítačích', 'Tvar FIRMA\\uzivatel'),
        text('winrm_password', 'Heslo', null, 'password'),
        field('Co na počítači provést', inputs.winrm_mode),
        text('winrm_interval_min', 'Interval (min)', null, 'number')),
      el('div', { class: 'hint' }, 'Vyžaduje povolený WinRM na počítačích (GPO „Allow remote server management through WinRM“) a vyplněnou adresu serveru.')),
    el('div', { class: 'card' }, el('h2', null, 'Automatické zálohy databáze'),
      check('backup_enabled', 'Zálohovat databázi každý den'),
      el('div', { class: 'form-grid' }, text('backup_hour', 'Hodina zálohy (0–23)', null, 'number'), text('backup_keep', 'Kolik denních záloh uchovávat', null, 'number'))),
    el('div', { class: 'row' }, el('button', { class: 'primary', onclick: save }, 'Uložit nastavení')));
};

const BACKUP_LABELS = { auto: 'denní automatická', manual: 'ruční', 'pre-restore': 'před obnovou' };

PAGES.zalohy = async (main) => {
  const b = await api('GET', '/api/backups');
  const restoreFile = el('input', { type: 'file', accept: '.gz,.db,.tar.gz', class: 'hidden' });
  restoreFile.addEventListener('change', async () => {
    const f = restoreFile.files[0];
    if (!f) return;
    if (await confirmBox('Obnovit databázi ze souboru „' + f.name + '“? Současná data budou nahrazena. Před obnovou se automaticky vytvoří záloha současného stavu.', 'Obnovit')) {
      try { const r = await api('POST', '/api/backups/upload-restore', f); toast('Obnoveno. Původní stav uložen jako ' + r.safety_backup, 'ok'); start(); } catch (e) { fail(e); }
    }
    restoreFile.value = '';
  });
  pageHead(main, 'Zálohy', 'Databáze ' + fmtSize(b.db_size) + ' · verze aplikace ' + b.version + ' · schéma ' + b.schema,
    el('button', { class: 'primary', onclick: async (e) => {
      e.target.disabled = true;
      try { await api('POST', '/api/backups'); toast('Záloha vytvořena', 'ok'); route(); } catch (ex) { fail(ex); e.target.disabled = false; }
    } }, 'Zálohovat databázi teď'),
    el('a', { class: 'btn', href: '/api/backups/full' }, 'Stáhnout kompletní zálohu'),
    el('button', { onclick: () => restoreFile.click() }, 'Obnovit ze souboru…'), restoreFile);
  main.append(
    el('div', { class: 'note-box info' }, 'Před každou aktualizací aplikace se databáze zálohuje automaticky – při startu nové verze, ještě před jakoukoli změnou dat. Zálohy leží v ',
      el('code', null, b.data_dir + '/backups'), ' na datovém svazku kontejneru.'),
    simpleTable(['Soubor', 'Druh', 'Vytvořeno', 'Velikost', ''], b.backups.map((x) => [
      el('span', { class: 'mono' }, x.name),
      BACKUP_LABELS[x.label] || (x.label.startsWith('pre-update') ? 'před aktualizací (' + x.label.replace('pre-update-', '').replace('-to-', ' → ') + ')' : x.label),
      fmtDate(x.created), fmtSize(x.size),
      el('div', { class: 'row' },
        el('a', { class: 'btn mini', href: '/api/backups/' + encodeURIComponent(x.name) + '/download' }, 'Stáhnout'),
        el('button', { class: 'mini', onclick: async () => {
          if (!(await confirmBox('Obnovit databázi ze zálohy „' + x.name + '“? Současná data budou nahrazena (předtím se sama zazálohují).', 'Obnovit'))) return;
          try { await api('POST', '/api/backups/' + encodeURIComponent(x.name) + '/restore'); toast('Databáze obnovena', 'ok'); start(); } catch (e) { fail(e); }
        } }, 'Obnovit'),
        el('button', { class: 'mini danger', onclick: async () => {
          if (!(await confirmBox('Trvale smazat zálohu „' + x.name + '“? Tuto akci nelze vrátit.', 'Smazat'))) return;
          try { await api('DELETE', '/api/backups/' + encodeURIComponent(x.name)); route(); } catch (e) { fail(e); }
        } }, 'Smazat'))]), 'Zatím žádné zálohy'),
    el('div', { class: 'card', style: 'margin-top:16px' }, el('h2', null, 'Záloha celého Dockeru'),
      el('p', null, '„Kompletní záloha“ výše obsahuje databázi a šifrovací klíč – vše, co je potřeba k obnově na jiném stroji. Zálohu včetně samotného Docker image a konfigurace vytvoříte na QNAPu skriptem:'),
      el('div', { class: 'cmd' }, el('pre', null, './scripts/backup-full.sh /share/Backup/hwsw')),
      el('p', { class: 'muted' }, 'Skript uloží image (docker save), datový svazek a docker-compose.yml do jednoho adresáře. Postup obnovy je v README.')));
};

// ----------------------------------------------------------------- start

function connectEvents() {
  if (S.es) S.es.close();
  S.es = new EventSource('/api/events');
  S.es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
    if (ev.type === 'usb' && isAdmin() && ev.name) toast(ev.hostname + ': ' + ev.action + ' – ' + ev.name);
    if (S.live) { try { S.live(ev); } catch (e) { /* stranka se mezitim zmenila */ } }
  };
}

async function start() {
  try { S.me = await api('GET', '/api/me'); } catch (e) { return; }
  if (S.me.must_change) return passwordDialog(true);
  [S.schema, S.views] = await Promise.all([api('GET', '/api/schema'), api('GET', '/api/views')]);
  renderShell();
  connectEvents();
  route();
}

window.addEventListener('hashchange', route);
start();
