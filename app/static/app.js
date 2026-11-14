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

function ago(ts) {
  if (typeof ts !== 'string' || !ts) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 60000));
  if (min < 2) return 'právě teď';
  if (min < 60) return 'před ' + min + ' min';
  if (min < 48 * 60) return 'před ' + Math.round(min / 60) + ' h';
  return 'před ' + Math.round(min / 1440) + ' dny';
}

function groupTag(name, color) {
  const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#6b7c85';
  return el('span', { class: 'gtag', style: 'background:' + c + '2b;border-color:' + c }, name);
}

const AGENT_DOT = { 'odesílá': 'on', 'neaktivní': 'warn', 'nikdy': 'bad' };

function cell(col, row) {
  const v = row[col.key];
  if (col.key === 'agent_state') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    td.title = (v === 'nikdy' ? 'Agent zatím neposlal žádná data' : 'Poslední data: ' + fmtDate(row._inv)) +
      (row._agent ? ' · agent ' + row._agent : '');
    return add(td, [el('span', { class: 'dot ' + AGENT_DOT[v] }), v === 'nikdy' ? 'nikdy' : ago(row._inv)]);
  }
  if (col.key === 'groups') {
    const td = el('td');
    let list = [];
    try { list = JSON.parse(row._groups || '[]'); } catch (e) { list = []; }
    return add(td, [list.map((g) => groupTag(g.n, g.c))]);
  }
  if (col.key === 'logged_user' && '_cur' in row && v && !row._cur) {
    const td = el('td', { class: 'muted' });
    return add(td, [v, el('div', { class: 'small' }, 'naposledy ' + (row._login ? ago(row._login) : '–'))]);
  }
  if (col.key === 'hostname' && '_host' in row && !row._host && v) {
    return add(el('td', { class: 'nw muted' }), [v]);
  }
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
    list.replaceChildren(...cols.map((k, i) => el('li', { draggable: 'true', title: 'Přetáhněte myší na jiné místo', 'data-i': i,
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop'); },
      ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(from) && from !== i) { cols.splice(i, 0, cols.splice(from, 1)[0]); }
        draw();
      } }, el('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'), el('span', null, label(k)),
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
  const OPS_BY_TYPE = {
    text: ['contains', 'not_contains', 'eq', 'ne', 'starts', 'in', 'empty', 'not_empty'],
    secret: ['contains', 'eq', 'empty', 'not_empty'],
    num: ['eq', 'ne', 'gt', 'lt', 'in', 'empty', 'not_empty'],
    bool: ['eq', 'ne'],
    date: ['older_h', 'newer_h', 'contains', 'gt', 'lt', 'empty', 'not_empty'],
  };
  const typeOf = (key) => (defs.find((d) => d.key === key) || {}).type || 'text';
  const suggest = {};
  async function suggestions(key) {
    if (suggest[key]) return suggest[key];
    try { suggest[key] = (await api('GET', '/api/distinct?entity=' + encodeURIComponent(entity) + '&col=' + encodeURIComponent(key))).values; }
    catch (e) { suggest[key] = []; }
    return suggest[key];
  }
  let listSeq = 0;
  function addRow(f) {
    const col = el('select', null, defs.map((d) => el('option', { value: d.key, selected: f && f.col === d.key }, d.label)));
    const op = el('select');
    const val = el('input', { value: f ? f.value : '', placeholder: 'hodnota' });
    const listId = 'fl' + (++listSeq);
    const list = el('datalist', { id: listId });
    val.setAttribute('list', listId);
    const item = { col, op, val };
    const sync = async (keepOp) => {
      const type = typeOf(col.value);
      const wanted = OPS_BY_TYPE[type] || OPS_BY_TYPE.text;
      const cur = keepOp || op.value;
      op.replaceChildren(...wanted.map((k) => el('option', { value: k, selected: k === cur }, ops[k])));
      const noVal = op.value === 'empty' || op.value === 'not_empty';
      val.style.display = noVal ? 'none' : '';
      val.placeholder = type === 'bool' ? 'ano / ne' : (op.value === 'older_h' || op.value === 'newer_h') ? 'počet hodin'
        : op.value === 'in' ? 'např. notebook, server' : 'hodnota';
      list.replaceChildren();
      if (type === 'bool') ['ano', 'ne'].forEach((v) => list.append(el('option', { value: v })));
      else if (type === 'text' && op.value !== 'in') (await suggestions(col.value)).forEach((v) => list.append(el('option', { value: v })));
    };
    col.addEventListener('change', () => { op.value = ''; sync(); });
    op.addEventListener('change', () => sync(op.value));
    const line = el('div', { class: 'filter-row' }, col, op, val, list,
      el('button', { class: 'mini', onclick: () => { rows.splice(rows.indexOf(item), 1); line.remove(); } }, '✕'));
    rows.push(item);
    box.append(line);
    sync(f ? f.op : null);
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
    sel: new Set(), all: false, total: 0, rows: [], groups: null,
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
    timer = setTimeout(() => { st.search = search.value; st.page = 1; st.all = false; load(); }, 250);
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
    st.total = data.total; st.rows = data.rows;
    if (opts.viewId && !st.sort) { st.sort = data.sort; st.sortDir = data.sort_dir; }
    const rowClick = opts.onRow && (opts.rowClickable ? opts.rowClickable(data) : true);
    const keys = data.columns.map((c) => c.key);
    const moveCol = (from, to) => {
      if (from === to || from < 0 || to < 0) return;
      const next = keys.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      st.columns = next;
      load();
    };
    st.pageRows = data.rows;
    st.trs = [];
    const headBox = el('input', { type: 'checkbox', class: 'cbx', 'aria-label': 'Označit vše na stránce', title: 'Označit vše na stránce',
      onchange: (e) => { data.rows.forEach((r) => { if (e.target.checked) st.sel.add(r._id); else st.sel.delete(r._id); }); st.all = false; syncSel(); } });
    st.headBox = headBox;
    const selTh = opts.selectable ? el('th', { class: 'chk' }, headBox) : null;
    thead.replaceChildren(el('tr', null, selTh, data.columns.map((c, ci) => el('th', Object.assign({
      class: 'sortable' + (c.type === 'num' ? ' num' : ''),
      onclick: () => {
        if (st.sort === c.key) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
        else { st.sort = c.key; st.sortDir = 'asc'; }
        st.page = 1; load();
      } }, opts.adhoc ? {
      draggable: 'true', title: 'Klikněte pro seřazení, přetažením změníte pořadí sloupce',
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', 'col:' + ci); e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drop'); },
      ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        const m = /^col:(\d+)$/.exec(e.dataTransfer.getData('text/plain'));
        if (m) moveCol(parseInt(m[1], 10), ci);
      },
    } : {}), c.label, st.sort === c.key ? (st.sortDir === 'desc' ? ' ▼' : ' ▲') : ''))));
    tbody.replaceChildren(...(data.rows.length ? data.rows.map((r, ri) => {
      const box = el('input', { type: 'checkbox', class: 'cbx', 'aria-label': 'Označit řádek',
        onclick: (e) => {
          e.stopPropagation();
          const on = e.target.checked;
          if (e.shiftKey && st.last != null && st.last < data.rows.length) {
            const a = Math.min(st.last, ri), b = Math.max(st.last, ri);
            data.rows.slice(a, b + 1).forEach((x) => { if (on) st.sel.add(x._id); else st.sel.delete(x._id); });
          } else if (on) st.sel.add(r._id); else st.sel.delete(r._id);
          if (!on) st.all = false;
          st.last = ri; syncSel();
        } });
      const tr = el('tr', { class: rowClick ? 'click' : '', onclick: rowClick ? () => opts.onRow(r, data) : null },
        opts.selectable ? el('td', { class: 'chk', onclick: (e) => { if (e.target === e.currentTarget) { box.click(); } e.stopPropagation(); } }, box) : null,
        data.columns.map((c) => cell(c, r)));
      st.trs.push({ tr, box, id: r._id });
      return tr;
    }) : [el('tr', null, el('td', { class: 'empty', colspan: data.columns.length + (opts.selectable ? 1 : 0) },
      st.search || st.filters.length ? 'Podmínkám nic neodpovídá' : (opts.emptyText || 'Zatím žádná data')))]));
    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    pager.replaceChildren(...[
      el('span', null, 'Celkem ' + data.total),
      pages > 1 ? el('button', { class: 'mini', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, '‹ Předchozí') : null,
      pages > 1 ? el('span', null, 'Strana ' + st.page + ' z ' + pages) : null,
      pages > 1 ? el('button', { class: 'mini', disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, 'Další ›') : null].filter(Boolean));
    syncSel();
    chips.replaceChildren(...st.filters.map((f, i) => f.tab ? null : el('span', { class: 'chip' }, filterLabel(entity, f),
      opts.adhoc ? el('button', { 'aria-label': 'Zrušit filtr', onclick: () => { st.filters.splice(i, 1); st.page = 1; load(); } }, '✕') : null)).filter(Boolean));
  }

  const selBar = el('div', { class: 'selbar' });
  selBar.style.display = 'none';
  const selBody = () => (st.all ? { select_all: { filters: st.filters, search: st.search } } : { device_ids: [...st.sel] });
  const afterBulk = () => { st.sel.clear(); st.all = false; st.groups = null; load(); if (opts.onChanged) opts.onChanged(); };
  async function ensureGroups() {
    if (!st.groups) { try { st.groups = (await api('GET', '/api/groups')).groups; } catch (e) { st.groups = []; } }
    return st.groups;
  }
  async function moveSection(section, label) {
    const r = await api('POST', '/api/devices/section', Object.assign({ section }, selBody()));
    toast(label + ': ' + r.changed + ' zařízení', 'ok'); afterBulk();
  }
  async function groupBulk(groupId, action) {
    const r = await api('POST', '/api/groups/' + groupId + '/members', Object.assign({ action }, selBody()));
    toast((action === 'add' ? 'Přidáno do skupiny: ' : 'Odebráno ze skupiny: ') + r.changed + ' zařízení', 'ok'); afterBulk();
  }
  // rozbalovaci nabidka (misto nativniho select)
  function popMenu(label, build) {
    const pop = el('div', { class: 'pop', role: 'menu' });
    pop.style.display = 'none';
    const btn = el('button', { class: 'menu-btn', 'aria-haspopup': 'true' }, label, el('span', { class: 'caret' }, '▾'));
    const wrap = el('span', { class: 'pop-wrap' }, btn, pop);
    const close = () => { pop.style.display = 'none'; document.removeEventListener('mousedown', outside, true); };
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    btn.addEventListener('click', async () => {
      if (pop.style.display !== 'none') return close();
      pop.replaceChildren(el('div', { class: 'muted small pad' }, 'Načítám…'));
      pop.style.display = '';
      document.addEventListener('mousedown', outside, true);
      try { pop.replaceChildren(...(await build(close))); } catch (e) { close(); fail(e); }
    });
    return wrap;
  }
  const run = (fn, close) => async () => { close(); try { await fn(); } catch (e) { fail(e); } };
  function drawBar() {
    if (!opts.selectable) return;
    const count = st.all ? st.total : st.sel.size;
    if (!count) { selBar.style.display = 'none'; selBar.replaceChildren(); return; }
    selBar.style.display = '';
    const current = opts.currentSection ? opts.currentSection() : null;
    const sectionMenu = popMenu('Přesunout do sekce', (close) => [
      ...(opts.sections || []).map((n) => el('button', { class: 'pop-item', onclick: run(() => moveSection(n, 'Přesunuto do sekce ' + n), close) },
        n, current === n ? el('span', { class: 'muted small' }, ' (současná)') : null)),
      el('div', { class: 'pop-sep' }),
      el('button', { class: 'pop-item', onclick: run(() => moveSection('', 'Odebráno ze sekce'), close) }, 'Bez sekce (jen ve Vše)'),
      el('button', { class: 'pop-item', onclick: run(() => moveSection(null, 'Zařazeno automaticky'), close) }, 'Automaticky podle typu')]);
    const groupMenu = popMenu('Skupiny', async (close) => {
      const groups = await ensureGroups();
      return [
        ...(groups.length ? groups.map((g) => el('div', { class: 'pop-row' }, groupTag(g.name, g.color),
          el('span', { class: 'right row' },
            el('button', { class: 'mini', onclick: run(() => groupBulk(g.id, 'add'), close) }, 'Přidat'),
            el('button', { class: 'mini', onclick: run(() => groupBulk(g.id, 'remove'), close) }, 'Odebrat'))))
          : [el('div', { class: 'muted small pad' }, 'Zatím žádná skupina')]),
        el('div', { class: 'pop-sep' }),
        el('button', { class: 'pop-item', onclick: () => {
          close();
          const name = el('input', { placeholder: 'Název skupiny' });
          modal('Nová skupina', field('Název', name), [{ label: 'Zrušit' }, { label: 'Vytvořit a přidat', primary: true, onclick: async () => {
            const g = await api('POST', '/api/groups', { name: name.value }); await groupBulk(g.id, 'add');
          } }]);
        } }, '+ Nová skupina…')];
    });
    selBar.replaceChildren(
      el('span', { class: 'sel-count' }, '✓ ' + (st.all ? 'všech ' + st.total : count) + ' vybráno'),
      !st.all && st.total > count ? el('button', { class: 'link', onclick: () => { st.all = true; syncSel(); } }, 'Vybrat všech ' + st.total + ' odpovídajících filtru') : null,
      el('span', { class: 'sel-actions' }, sectionMenu, groupMenu,
        current ? el('button', { class: 'menu-btn', title: 'Zařízení zůstanou jen ve Vše', onclick: run(() => moveSection('', 'Odebráno ze sekce ' + current), () => {}) }, 'Odebrat ze sekce ' + current) : null),
      el('button', { class: 'clear', title: 'Zrušit výběr (Esc)', 'aria-label': 'Zrušit výběr', onclick: () => { st.sel.clear(); st.all = false; syncSel(); } }, '✕'));
  }
  // sladi zaskrtavatka, podbarveni radku a listu s aktualnim vyberem (bez nacitani dat)
  function syncSel() {
    (st.trs || []).forEach((x) => {
      const on = st.all || st.sel.has(x.id);
      x.box.checked = on; x.tr.classList.toggle('sel', on);
    });
    if (st.headBox) {
      const rows = st.pageRows || [];
      const n = rows.filter((r) => st.all || st.sel.has(r._id)).length;
      st.headBox.checked = rows.length > 0 && n === rows.length;
      st.headBox.indeterminate = n > 0 && n < rows.length;
    }
    drawBar();
  }
  if (opts.selectable) {
    const onKey = (e) => {
      if (!node.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape' && (st.sel.size || st.all) && !document.querySelector('.overlay')) { st.sel.clear(); st.all = false; syncSel(); }
    };
    document.addEventListener('keydown', onKey);
  }

  const tools = [search];
  if (opts.adhoc) {
    tools.push(el('button', { onclick: () => {
      const p = columnPicker(entity, st.columns.length ? st.columns : S.schema.entities[entity].default);
      modal('Sloupce', p.node, [{ label: 'Zrušit' }, { label: 'Použít', primary: true, onclick: () => { st.columns = p.get(); load(); } }]);
    } }, 'Sloupce'));
    tools.push(el('button', { onclick: () => {
      const f = filterBuilder(entity, st.filters);
      modal('Filtr', f.node, [{ label: 'Zrušit' }, { label: 'Použít', primary: true, onclick: () => { st.filters = f.get(); st.page = 1; st.all = false; load(); } }]);
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

  const node = el('div', null, el('div', { class: 'toolbar' }, tools), selBar, chips,
    el('div', { class: 'table-wrap' }, el('table', null, thead, tbody)), pager);
  load();
  return { node, reload: load, setFilters: (f) => { st.filters = f; st.page = 1; st.all = false; load(); },
    refreshGroups: () => { st.groups = null; load(); },
    selection: () => st.sel.size,
    setView: (v) => { st.filters = v.filters || []; st.columns = v.columns || []; st.sort = v.sort || ''; st.sortDir = v.sortDir || '';
      st.search = ''; search.value = ''; st.page = 1; st.all = false; st.sel.clear(); load(); } };
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

async function editDeviceGroups(d) {
  let groups = [];
  try { groups = (await api('GET', '/api/groups')).groups; } catch (e) { return fail(e); }
  const have = new Set((d.groups || []).map((g) => g.id));
  const boxes = groups.map((g) => ({ g, cb: el('input', { type: 'checkbox', checked: have.has(g.id) }) }));
  const body = groups.length ? el('div', null, boxes.map(({ g, cb }) => el('label', { class: 'check' }, cb, groupTag(g.name, g.color))))
    : el('p', { class: 'muted' }, 'Zatím žádná skupina. Vytvořte ji na stránce Zařízení tlačítkem Skupiny.');
  modal('Skupiny zařízení ' + (d.hostname || ''), body, [{ label: 'Zrušit' }, groups.length ? { label: 'Uložit', primary: true, onclick: async () => {
    await api('PUT', '/api/devices/' + d.id + '/groups', { group_ids: boxes.filter((b) => b.cb.checked).map((b) => b.g.id) });
    toast('Skupiny uloženy', 'ok'); route();
  } } : null].filter(Boolean));
}

async function groupManager(onChange) {
  const body = el('div');
  let editing = null;
  const name = el('input', { placeholder: 'Název skupiny', maxlength: 60 });
  const desc = el('input', { placeholder: 'Popis (nepovinné)', maxlength: 300 });
  let color = '#3b82a0';
  const swatches = el('div', { class: 'swatches' });
  const list = el('div', { class: 'group-list' });
  const formTitle = el('h3', null, 'Nová skupina');
  const saveBtn = el('button', { class: 'primary' }, 'Vytvořit skupinu');
  let palette = [];
  function drawSwatches() {
    swatches.replaceChildren(...palette.map((c) => el('button', { type: 'button', class: 'swatch' + (c === color ? ' on' : ''),
      style: 'background:' + c, 'aria-label': 'Barva ' + c, onclick: () => { color = c; drawSwatches(); } })));
  }
  function reset() { editing = null; name.value = ''; desc.value = ''; color = palette[0] || color; formTitle.textContent = 'Nová skupina'; saveBtn.textContent = 'Vytvořit skupinu'; drawSwatches(); }
  async function refresh() {
    const r = await api('GET', '/api/groups');
    palette = r.colors;
    if (!palette.includes(color)) color = palette[0];
    list.replaceChildren(...(r.groups.length ? r.groups.map((g) => el('div', { class: 'group-row' },
      groupTag(g.name, g.color), el('span', { class: 'muted small' }, g.devices + ' zařízení' + (g.description ? ' · ' + g.description : '')),
      el('span', { class: 'right row' },
        el('button', { class: 'mini', onclick: () => { editing = g; name.value = g.name; desc.value = g.description || ''; color = g.color; formTitle.textContent = 'Upravit skupinu'; saveBtn.textContent = 'Uložit změny'; drawSwatches(); name.focus(); } }, 'Upravit'),
        el('button', { class: 'mini', onclick: async () => {
          if (!(await confirmBox('Smazat skupinu „' + g.name + '“? Zařízení zůstanou, jen se z ní odeberou.', 'Smazat'))) return;
          try { await api('DELETE', '/api/groups/' + g.id); await refresh(); onChange(); } catch (e) { fail(e); }
        } }, 'Smazat'))))
      : [el('div', { class: 'muted' }, 'Zatím žádná skupina. Vytvořte první níže.')]));
    drawSwatches();
  }
  saveBtn.addEventListener('click', async () => {
    try {
      const payload = { name: name.value, description: desc.value, color };
      if (editing) await api('PUT', '/api/groups/' + editing.id, payload); else await api('POST', '/api/groups', payload);
      toast('Uloženo', 'ok'); reset(); await refresh(); onChange();
    } catch (e) { fail(e); }
  });
  body.append(list, el('hr'), formTitle, el('div', { class: 'form-grid' }, field('Název', name), field('Popis', desc)),
    el('div', { class: 'field' }, el('label', null, 'Barva štítku'), swatches),
    el('div', { class: 'row' }, saveBtn, el('button', { onclick: reset }, 'Zrušit úpravu')));
  await refresh();
  modal('Skupiny zařízení', body, [{ label: 'Hotovo', primary: true }]);
}

PAGES.zarizeni = async (main, parts, params) => {
  if (parts[0]) return deviceDetail(main, parts[0], params.get('view'));
  if (!isAdmin()) return PAGES.prehled(main);
  pageHead(main, 'Zařízení', 'Vše, co bylo nalezeno v doméně, v IP rozsahu nebo nahlášeno agentem',
    el('button', { onclick: () => groupManager(() => { loadGroupSel(); t.refreshGroups(); }) }, 'Skupiny'));
  const PC_COLS = ['hostname', 'agent_state', 'logged_user', 'groups', 'os_name', 'model', 'online', 'ip'];
  const NET_COLS = ['hostname', 'device_type', 'groups', 'online', 'ip', 'mac', 'manufacturer', 'model'];
  const ALL_COLS = ['hostname', 'section', 'agent_state', 'device_type', 'logged_user', 'groups', 'online', 'ip', 'os_name', 'model'];
  const SECTIONS = ['Počítače', 'Servery', 'IoT', 'Síť a tiskárny'];
  const secFilter = (n) => [{ col: 'section', op: 'eq', value: n, tab: true }];
  const TABS = [
    ['Počítače', secFilter('Počítače'), PC_COLS, 'agent_state'],
    ['Servery', secFilter('Servery'), PC_COLS, 'agent_state'],
    ['IoT', secFilter('IoT'), NET_COLS, 'ip'],
    ['Síť a tiskárny', secFilter('Síť a tiskárny'), NET_COLS, 'ip'],
    ['Vše', [], ALL_COLS, 'hostname'],
  ];
  const FLAGS = [
    ['never', 'Bez agenta', 'never', { col: 'agent_state', op: 'eq', value: 'nikdy', tab: true }],
    ['stale', 'Neaktivní agent', 'stale', { col: 'agent_state', op: 'eq', value: 'neaktivní', tab: true }],
    ['nosec', 'Bez sekce', 'no_section', { col: 'section', op: 'eq', value: '', tab: true }],
  ];
  let curTab = TABS[0];
  let curGroup = '';
  const flags = new Set();
  const viewOf = () => ({
    filters: curTab[1].concat(FLAGS.filter((f) => flags.has(f[0])).map((f) => f[3]),
      curGroup ? [{ col: 'groups', op: 'eq', value: curGroup, tab: true }] : []),
    columns: curTab[2], sort: curTab[3], sortDir: 'asc' });
  const t = dataTable({ entity: 'devices', adhoc: true, selectable: true, sections: SECTIONS,
    currentSection: () => (SECTIONS.includes(curTab[0]) ? curTab[0] : null),
    onChanged: () => { summary(); loadGroupSel(); },
    onRow: (r) => { location.hash = '#/zarizeni/' + r._id; },
    filters: viewOf().filters, columns: viewOf().columns, sort: 'agent_state', sortDir: 'asc' });
  const applyView = () => t.setView(viewOf());
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const counts = {};
  const tabButtons = TABS.map((tab) => {
    const n = el('span', { class: 'count' });
    counts[tab[0]] = n;
    const b = el('button', { role: 'tab', class: tab === curTab ? 'active' : '', onclick: () => {
      tabButtons.forEach((x) => x.classList.toggle('active', x === b));
      curTab = tab; applyView();
    } }, tab[0], ' ', n);
    return b;
  });
  const flagCounts = {};
  const flagButtons = FLAGS.map(([key, label, ck]) => {
    const n = el('span', { class: 'count' });
    flagCounts[ck] = n;
    const b = el('button', { class: 'flag', 'aria-pressed': 'false', onclick: () => {
      if (flags.has(key)) flags.delete(key); else flags.add(key);
      b.classList.toggle('on', flags.has(key)); b.setAttribute('aria-pressed', flags.has(key) ? 'true' : 'false');
      applyView();
    } }, label, ' ', n);
    return b;
  });
  const groupSel = el('select', { 'aria-label': 'Skupina', onchange: () => { curGroup = groupSel.value; applyView(); } });
  async function loadGroupSel() {
    let groups = [];
    try { groups = (await api('GET', '/api/groups')).groups; } catch (e) { groups = []; }
    if (curGroup && !groups.some((g) => g.name === curGroup)) curGroup = '';
    groupSel.replaceChildren(el('option', { value: '' }, 'Skupina: všechny'),
      ...groups.map((g) => el('option', { value: g.name, selected: g.name === curGroup }, g.name + ' (' + g.devices + ')')));
    groupSel.style.display = groups.length ? '' : 'none';
  }
  loadGroupSel();
  const info = el('div', { class: 'quick' });
  bar.append(...tabButtons);
  info.append(el('span', { class: 'muted small' }, 'Rychlé filtry:'), ...flagButtons, el('span', { class: 'right' }, groupSel));
  const legend = el('div', { class: 'hint', style: 'margin-bottom:10px' });
  main.append(bar, info, legend, t.node);
  async function summary() {
    try {
      const c = await api('GET', '/api/devices-summary');
      TABS.forEach((tab) => { counts[tab[0]].textContent = tab[0] === 'Vše' ? c.total : c.sections[tab[0]]; });
      flagCounts.never.textContent = c.never; flagCounts.stale.textContent = c.stale; flagCounts.no_section.textContent = c.no_section;
      legend.replaceChildren(
        el('span', { class: 'dot on' }), 'odesílá data (do ' + c.stale_hours + ' h)   ',
        el('span', { class: 'dot warn' }), 'agent neposlal data déle než ' + c.stale_hours + ' h   ',
        el('span', { class: 'dot bad' }), 'agent nikdy neposlal data');
    } catch (e) { /* souhrn je jen doplnek */ }
  }
  summary();
  S.live = (ev) => { if (ev.type === 'job') { t.reload(); summary(); } };
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
      ['BIOS', [d.bios_version, sys.bios_date].filter(Boolean).join(' · ')], ['Výrobce BIOS', sys.bios_vendor],
      ['SMBIOS', sys.smbios], ['Zavádění systému', (x.security || {}).boot_mode],
      ['Základní deska', [sys.board_manufacturer, sys.board_model].filter(Boolean).join(' ')], ['Sériové číslo desky', sys.board_serial],
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
      ['Přihlášený uživatel', !d.logged_user ? '—' : d.user_current || !d.last_login_at ? d.logged_user
        : d.logged_user + ' (není přihlášen, naposledy ' + fmtDate(d.last_login_at) + ')'],
      ['Skupiny', el('span', { class: 'row' }, (d.groups || []).length ? d.groups.map((g) => groupTag(g.name, g.color)) : el('span', { class: 'muted' }, 'žádná'),
        admin ? el('button', { class: 'mini', onclick: () => editDeviceGroups(d) }, 'Změnit') : null)],
      ['Jméno', p && p.display_name], ['E-mail', p && p.mail],
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
        section('Disky', simpleTable(['Model', 'Sériové číslo', 'Velikost', 'Typ', 'Rozhraní', 'Stav', 'Opotřebení', 'Teplota', 'Hodin provozu'],
          (x.disks || []).map((k) => [k.model, k.serial, gb(k.size_gb), k.type, k.interface,
            k.health ? el('span', { class: 'badge ' + (/^(Healthy|OK)$/i.test(k.health) ? 'ok' : 'warn') }, k.health) : '',
            k.wear_pct != null ? k.wear_pct + ' %' : '', k.temp_c != null ? k.temp_c + ' °C' : '', k.power_on_hours != null ? k.power_on_hours : '']),
          'Disky nebyly zjištěny')),
        section('Svazky', simpleTable(['Jednotka', 'Systém souborů', 'Velikost', 'Volné'],
          (x.volumes || []).map((v) => [v.drive, v.fs, gb(v.size_gb), gb(v.free_gb)]))),
        section('Grafika', simpleTable(['Název', 'Paměť', 'Ovladač'], (x.gpus || []).map((g) => [g.name, g.vram_mb ? g.vram_mb + ' MB' : '', g.driver]))),
        section('Tiskárny', simpleTable(['Název', 'Ovladač', 'Port', 'Výchozí'],
          (x.printers || []).map((t) => [t.name, t.driver, t.port, t.is_default ? 'ano' : '']))));
    }],
    ['sec', 'Zabezpečení', (box) => {
      const s = x.security;
      if (!s) { box.append(el('div', { class: 'note-box info' }, 'Údaje o zabezpečení zatím chybí – počkejte na další inventuru agenta (verze 1.1.0 a novější).')); return; }
      const yn = (v) => (v == null || v === '' ? '' : el('span', { class: 'badge ' + (v === true || v === 'ano' || v === 'zapnuto' ? 'ok' : 'warn') }, v === true ? 'ano' : v === false ? 'ne' : v));
      const bl = (s.bitlocker || []).map((v) => v.drive + ' ' + (v.protected ? 'chráněno' : 'nechráněno')).join(', ');
      const av = (s.antivirus || []).map((a) => a.name + (a.enabled ? '' : ' (vypnuto)') + (a.up_to_date ? '' : ' (zastaralé definice)')).join(', ');
      const df = s.defender ? 'Defender ' + (s.defender.enabled ? 'zapnut' : 'vypnut') + (s.defender.realtime ? ', ochrana v reálném čase' : '') +
        (s.defender.signatures ? ', definice ' + s.defender.signatures : '') : '';
      const fw = s.firewall || {};
      box.append(el('div', { class: 'card' }, el('h3', null, 'Stav zabezpečení'), kv([
        ['BitLocker', bl || 'nezjištěno'], ['Antivirus', av || (s.antivirus_text || '')], ['Windows Defender', df],
        ['Firewall – doména', fw.domain == null ? '' : yn(fw.domain)], ['Firewall – soukromá síť', fw.private == null ? '' : yn(fw.private)],
        ['Firewall – veřejná síť', fw.public == null ? '' : yn(fw.public)],
        ['Secure Boot', yn(s.secure_boot_text)], ['TPM', s.tpm_text], ['Řízení uživatelských účtů (UAC)', s.uac == null ? '' : yn(s.uac)],
        ['Vzdálená plocha (RDP)', s.rdp_enabled == null ? '' : (s.rdp_enabled ? 'zapnuta' + (s.rdp_nla ? ' (s ověřením NLA)' : ' (bez NLA)') : 'vypnuta')],
        ['Poslední aktualizace Windows', s.last_hotfix], ['Poslední úspěšná instalace', s.last_update_success],
        ['Počet nainstalovaných oprav', s.hotfix_count], ['Čeká na restart', s.pending_reboot_text],
        ['Stav disků', s.disk_health_text], ['Předpověď selhání disku (S.M.A.R.T.)', s.disk_failure_predicted ? 'ano – hrozí selhání' : '']])));
    }],
    ['lic', 'Licence systému', (box) => {
      const l = x.licenses;
      if (!l) { box.append(el('div', { class: 'note-box info' }, 'Údaje o licencích zatím chybí – počkejte na další inventuru agenta (verze 1.1.0 a novější).')); return; }
      box.append(
        el('div', { class: 'card' }, el('h3', null, 'Licenční klíč uložený v BIOSu'), kv([
          ['Klíč', admin ? l.oem_key : (l.windows_text ? '(zobrazuje jen administrátor)' : '')], ['Popis', l.oem_description], ['Windows', l.windows_text]])),
        section('Aktivované produkty (Windows, Office)', simpleTable(['Druh', 'Název', 'Stav', 'Poslední znaky klíče', 'Kanál', 'KMS server'],
          (l.products || []).map((p) => [p.kind, p.name, el('span', { class: 'badge ' + (p.status_code === 1 ? 'ok' : 'warn') }, p.status), p.partial_key, p.channel, p.kms_server]),
          'Žádný aktivovaný produkt nebyl nalezen')));
    }],
    ['net', 'Síť', (box) => {
      const n = x.network || {};
      box.append(
        section('Síťové adaptéry', simpleTable(['Název', 'Druh', 'MAC', 'IP adresy', 'Rychlost', 'Brána', 'DNS', 'DHCP'],
          (x.nics || []).map((a) => [a.name, a.kind, a.mac, (a.ips || []).join(', '), a.speed_mbps ? a.speed_mbps + ' Mb/s' : '',
            a.gateway, a.dns, a.dhcp ? 'ano (' + (a.dhcp_server || '?') + ')' : 'ne']))),
        el('div', { class: 'card' }, el('h3', null, 'Další údaje'), kv([['Wi-Fi síť', n.wifi_ssid],
          ['Naslouchající TCP porty', (n.listening || []).join(', ')]])),
        section('Sdílené složky', simpleTable(['Název', 'Cesta', 'Popis'], (n.shares || []).map((sh) => [sh.name, sh.path, sh.description]), 'Nic není sdíleno')));
    }],
    ['acc', 'Účty', (box) => {
      const a = x.accounts;
      if (!a) { box.append(el('div', { class: 'note-box info' }, 'Údaje o účtech zatím chybí – počkejte na další inventuru agenta (verze 1.1.0 a novější).')); return; }
      box.append(
        section('Místní administrátoři', simpleTable(['Účet'], (a.admins || []).map((u) => [u]), 'Nezjištěno')),
        section('Místní účty', simpleTable(['Účet', 'Celé jméno', 'Stav', 'Heslo vyžadováno', 'Heslo vyprší'],
          (a.local || []).map((u) => [u.name, u.full_name, el('span', { class: 'badge ' + (u.disabled ? '' : 'ok') }, u.disabled ? 'zakázán' : (u.locked ? 'uzamčen' : 'aktivní')),
            u.pw_required ? 'ano' : 'ne', u.pw_expires ? 'ano' : 'ne']))),
        section('Profily uživatelů (kdo se na počítači přihlásil)', simpleTable(['Uživatel', 'Naposledy použit', 'Složka', 'Přihlášen'],
          (a.profiles || []).map((u) => [u.user, u.last_use, u.path, u.loaded ? 'ano' : '']), 'Žádné profily')));
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
  main.append(...[
    a.server_url_set ? null : el('div', { class: 'note-box' }, 'V ', el('a', { href: '#/nastaveni' }, 'Nastavení'),
      ' není vyplněna adresa serveru. Příkazy níže používají adresu, ze které máte právě otevřený prohlížeč (', a.server_url,
      ') – ověřte, že je dostupná ze všech počítačů.'),
    el('div', { class: 'card' }, el('h2', null, 'Trvalá instalace (doporučeno)'),
      el('p', null, 'Spusťte na počítači v příkazovém řádku jako správce. Agent se uloží do C:\\ProgramData\\HWSW-Agent a poběží jako naplánovaná úloha pod účtem SYSTEM – i bez přihlášeného uživatele. Hromadně ho nasadíte přes GPO jako spouštěcí skript počítače se stejným příkazem.'),
      cmd(a.install),
      el('p', { class: 'muted' }, 'Agentů aktuálně hlásí: ', el('strong', null, a.agents), '. USB události chodí jen z počítačů s trvale nainstalovaným agentem.')),
    el('div', { class: 'card' }, el('h2', null, 'Test – co jde na počítači zjistit'),
      el('p', null, 'Nic neodesílá ani neinstaluje. Jen na obrazovku vypíše, které údaje se podařilo zjistit.'), cmd(a.test)),
    el('div', { class: 'card' }, el('h2', null, 'Jednorázová inventura'),
      el('p', null, 'Nic neinstaluje, jen jednou odešle inventuru. Stejný příkaz používá inventura přes WinRM.'), cmd(a.once)),
    el('div', { class: 'card' }, el('h2', null, 'Odinstalace'), cmd(a.uninstall)),
    a.cert_thumbprint ? el('div', { class: 'card' }, el('h2', null, 'Certifikát serveru (HTTPS)'),
      el('p', null, 'Spojení agentů je šifrované. Server používá vlastní certifikát a agenti ho ověřují podle otisku níže – je součástí příkazů výše, na počítače se nic neinstaluje. Po výměně certifikátu je potřeba agenty nainstalovat znovu.'),
      el('div', { class: 'cmd' }, el('pre', null, a.cert_thumbprint)),
      el('p', { class: 'muted' }, 'Aby prohlížeč nezobrazoval varování, můžete si certifikát stáhnout a přidat mezi důvěryhodné: ',
        el('a', { href: '/api/tls/cert' }, 'stáhnout certifikát'), '.')) : null,
    el('div', { class: 'card' }, el('h2', null, 'Token agentů'),
      el('p', null, 'Token je součástí příkazů výše a opravňuje počítače posílat data. Držte ho v tajnosti.'),
      el('div', { class: 'cmd' }, el('pre', null, a.token)),
      el('button', { class: 'danger', onclick: async () => {
        if (!(await confirmBox('Vygenerovat nový token? Všichni nainstalovaní agenti přestanou odesílat data, dokud je znovu nenainstalujete novým příkazem.', 'Vygenerovat nový'))) return;
        await api('POST', '/api/agent-token/regenerate'); route();
      } }, 'Vygenerovat nový token'))].filter(Boolean));
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
      text('server_url', 'Adresa této aplikace v síti', 'Např. https://192.168.1.10:8580 – na tuto adresu posílají data agenti. Musí být dostupná ze všech počítačů.'),
      el('div', { class: 'form-grid' },
        text('offline_after_min', 'Považovat za offline po (min)', null, 'number'),
        text('agent_inventory_hours', 'Agent posílá úplnou inventuru každých (h)', null, 'number'),
        text('agent_stale_hours', 'Agent je neaktivní (žlutě), když neposlal data déle než (h)', null, 'number'),
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
