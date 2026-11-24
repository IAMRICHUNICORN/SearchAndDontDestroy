'use strict';
/* HWSW Monitor - webove rozhrani. Vsechna data se vkladaji pres textContent (zadne innerHTML). */

const $app = document.getElementById('app');
const S = { me: null, schema: null, views: [], live: null, es: null, lang: 'cs' };
try { if (localStorage.getItem('hwsw_lang') === 'en') S.lang = 'en'; } catch (e) { /* bez ulozeni */ }

// ------------------------------------------------------------ jazyk (CZ / EN)
// Cesky text je zaklad; anglicky preklad (lang-en.js) se dosazuje pri vykreslovani. Data, cisla, datum a jednotky zustavaji ceske.
const I18N = { cache: new Map(), frags: null, pats: null };
function T(s) {
  if (typeof s === 'string' && s.indexOf('[[') >= 0) s = s.replace(/\[\[(.+?)\]\]/g, (m, ts) => fmtDate(ts));
  if (S.lang !== 'en' || typeof s !== 'string' || s.length < 2 || !window.HWSW_EN) return s;
  const hit = I18N.cache.get(s);
  if (hit !== undefined) return hit;
  const en = window.HWSW_EN;
  if (!I18N.frags) {
    I18N.frags = Object.keys(en.dict).filter((k) => k.length >= 5).sort((a, b) => b.length - a.length);
    I18N.pats = en.patterns.map(([re, rep]) => [new RegExp(re), rep]);
  }
  let r = s;
  if (Object.prototype.hasOwnProperty.call(en.dict, s)) r = en.dict[s];
  else {
    let done = false;
    if (s.indexOf('; ') > 0) {   // vycet duvodu oddeleny strednikem: kazdy kus zvlast
      const joined = s.split('; ').map((x) => T(x)).join('; ');
      if (joined !== s) { r = joined; done = true; }
    }
    for (const [re, rep] of I18N.pats) {
      if (done) break;
      const m = re.exec(s);
      if (m) { r = rep.replace(/\$(\d)/g, (_, i) => T(m[Number(i)] == null ? '' : m[Number(i)])); done = true; break; }
    }
    if (!done && /[^\x00-\x7f]/.test(s)) {
      // slozeny text (cesky text + promenne): prelozi se jen tehdy, kdyz po nahrazeni neostane cesky text mimo „uvozovky“ (data)
      let t = s;
      for (const k of I18N.frags) if (t.indexOf(k) >= 0) t = t.split(k).join(en.dict[k]);
      if (t !== s && !/[ěščřžýáíéúůďťňóĚŠČŘŽÝÁÍÉÚŮĎŤŇÓ]/.test(t.replace(/„[^“”"]*[“”"]/g, ''))) r = t;
    }
  }
  if (I18N.cache.size > 5000) I18N.cache.clear();
  I18N.cache.set(s, r);
  return r;
}
function setLang(lang) {
  S.lang = lang === 'en' ? 'en' : 'cs';
  try { localStorage.setItem('hwsw_lang', S.lang); } catch (e) { /* bez ulozeni */ }
  document.documentElement.lang = S.lang;
  I18N.cache.clear();
}

// ------------------------------------------------------------ pomocne funkce

// replaceChildren() zapise null/false jako text "null"; vyradime je (stejne jako el()/add()).
(function () {
  const orig = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) {
    return orig.apply(this, kids.flat(Infinity).filter((c) => c != null && c !== false));
  };
})();

function add(node, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(T(String(c))));
  }
  return node;
}

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'title' || k === 'placeholder' || k === 'aria-label') n.setAttribute(k, T(String(v)));
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

function toast(text, kind, sticky) {
  const t = el('div', { class: 'toast ' + (kind || '') }, text);
  if (sticky) {
    // varovani zustane na obrazovce, dokud ho nekdo nezavre
    t.classList.add('sticky');
    t.append(el('button', { class: 'toast-close', title: T('Zavřít'), onclick: () => t.remove() }, '×'));
  }
  document.getElementById('toasts').append(t);
  if (!sticky) setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
}
const fail = (e) => toast(e.message || String(e), 'error');

function fmtDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) return s == null ? '' : s;
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const opt = { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  try { return d.toLocaleString('cs-CZ', Object.assign({ timeZone: (S.me && S.me.tz) || 'Europe/Prague' }, opt)); } catch (e) { return d.toLocaleString('cs-CZ', opt); }
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

const ACTION_BADGE = { 'připojeno': 'ok', 'nainstalováno': 'ok', 'odpojeno': '', 'odebráno': 'warn', 'nalezeno': 'warn' };

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
const VER_BADGE = { 'aktuální': 'ok', 'zastaralý': 'warn', 'neznámá': 'bad', 'novější': '' };
const HEALTH_DOT = { 'v pořádku': 'on', 'varování': 'warn', 'chyba': 'bad', 'bez agenta': '' };

// doba v minutach jako "5 min", "3 h 20 min", "5 d 2 h"
function fmtMinutes(m) {
  m = Math.round(Number(m));
  if (!isFinite(m) || m < 0) return '';
  if (m < 60) return m + ' min';
  if (m < 1440) return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d + ' d' + (h ? ' ' + h + ' h' : '');
}

// stari: vzdy jen pocet dni (CS "70 dní", EN "70 days")
function daysSince(dateStr) {
  const t = Date.parse(String(dateStr).slice(0, 10));
  return isFinite(t) ? Math.round((Date.now() - t) / 86400000) : null;
}
function fmtAge(days) {
  days = Math.floor(Number(days));
  if (!isFinite(days) || days < 0) return '';
  if (S.lang === 'en') return days + (days === 1 ? ' day' : ' days');
  return days + ' ' + (days === 1 ? 'den' : (days >= 2 && days <= 4 ? 'dny' : 'dní'));
}
const fmtAgeFull = fmtAge;
// sloupce, jejichz hodnota je pocet dni (zobrazi se jako stari; razeni a filtry zustavaji podle dni)
const AGE_KEYS = new Set(['os_age_days', 'hotfix_age', 'monitor_age']);
function ageNode(days) {
  return el('span', { title: fmtAgeFull(days) }, fmtAge(days));
}

const verGe = (v, min) => {
  const a = String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
  const b = String(min).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
};
const AGENT_CMD_MIN = '2.1.0';

async function sendAgentCmd(ids, cmd) {
  const r = await api('POST', '/api/devices/agent-cmd', { cmd, device_ids: ids });
  toast(r.changed ? 'Příkaz odeslán – agent ho dostane do 5 minut' : 'Příkaz nebylo komu zadat (PC nemá agenta)', r.changed ? 'ok' : 'error');
  return r;
}

// okno s duvodem chyby/varovani agenta a akcemi (zkusit znovu / znovu spojit)
function errorHistory(list) {
  if (!list.length) return el('div', { class: 'muted' }, 'Agent zatím nehlásil žádnou chybu.');
  return el('table', { class: 'plain' }, el('thead', null, el('tr', null, ['Den', 'Chyba', 'Poprvé', 'Naposledy', 'Počet'].map((h) => el('th', null, h)))),
    el('tbody', null, list.map((e) => el('tr', null, el('td', { class: 'nw' }, e.day), el('td', null, e.msg), el('td', { class: 'nw' }, fmtDate(e.first_ts)),
      el('td', { class: 'nw' }, fmtDate(e.last_ts)), el('td', { class: 'num' }, e.count)))));
}

function agentIssueDialog(row, health) {
  const id = row._device_id || row._id;
  const supports = verGe(row._agent, AGENT_CMD_MIN);
  const reasons = String(row._hreason || '').split('; ').filter(Boolean);
  const last = (row._beat && row._beat > (row._inv || '')) ? row._beat : row._inv;
  const kv = (pairs) => el('dl', { class: 'kv' }, pairs.filter((p) => p[1] != null && p[1] !== '').map(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
  const histBox = el('div', { class: 'muted' }, 'Načítám…');
  if (isAdmin()) api('GET', '/api/devices/' + id).then((d) => histBox.replaceChildren(errorHistory(d.agent_errors || []))).catch(() => histBox.replaceChildren('Historii se nepodařilo načíst'));
  const body = el('div', null,
    kv([['Počítač', row.hostname || row._host], ['Stav', el('span', null, el('span', { class: 'dot ' + (HEALTH_DOT[health] || '') }), health)],
      ['Komunikace', row._comm], ['Poslední kontakt', last ? ago(last) + ' (' + fmtDate(last) + ')' : 'nikdy'],
      ['Poslední inventura', row._inv ? ago(row._inv) + ' (' + fmtDate(row._inv) + ')' : 'nikdy'], ['Verze agenta', row._agent || 'bez agenta']]),
    reasons.length ? el('h3', null, 'Důvod') : null,
    reasons.length ? el('ul', null, reasons.map((r) => el('li', null, r))) : null,
    row._commr ? el('div', { class: 'note-box info' }, row._commr) : null,
    isAdmin() ? el('h3', null, 'Historie chyb (uchovaná)') : null,
    isAdmin() ? histBox : null,
    isAdmin() ? el('h3', null, 'Co můžete udělat') : null,
    isAdmin() ? el('ul', null,
      el('li', null, el('strong', null, 'Zkusit znovu'), ' – agent při nejbližším kontaktu (do 5 minut) hned pošle inventuru.'),
      el('li', null, el('strong', null, 'Znovu spojit'), ' – navíc zapomene verze, které se nepovedlo nainstalovat, a zkusí aktualizaci znovu.')) : null,
    isAdmin() && row._agent && !supports ? el('div', { class: 'note-box' }, 'Tento agent má verzi ' + row._agent + '. Příkazy fungují od agenta ' + AGENT_CMD_MIN
      + ' – nejdřív ho aktualizujte (stránka Agent, nebo GPO naplánovaná úloha).') : null,
    isAdmin() && !row._agent ? el('div', { class: 'note-box' }, 'PC nemá nainstalovaného agenta – příkazy nelze doručit. Nainstalujte ho (stránka Agent).') : null);
  const buttons = [];
  if (isAdmin() && row._agent && supports) {
    buttons.push({ label: 'Zkusit znovu', onclick: async () => { await sendAgentCmd([id], 'retry'); } });
    buttons.push({ label: 'Znovu spojit', primary: true, onclick: async () => { await sendAgentCmd([id], 'reconnect'); } });
  }
  buttons.push({ label: 'Detail počítače', onclick: () => { location.hash = '#/zarizeni/' + id; } });
  buttons.push({ label: 'Zavřít' });
  modal('Stav agenta', body, buttons);
}

// bunka seznamu, ktera po kliknuti otevre detail PC rovnou na dane zalozce (zabezpeceni / agent)
function jumpCell(td, row, tab) {
  td.classList.add('clickable');
  td.addEventListener('click', (e) => { e.stopPropagation(); S.nextTab = tab; location.hash = '#/zarizeni/' + row._id; });
  return td;
}

function cell(col, row) {
  const v = row[col.key];
  if (col.key === 'agent_state') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    if (row._agent || v !== 'nikdy') jumpCell(td, row, 'agent');
    const last = (row._beat && row._beat > (row._inv || '')) ? row._beat : row._inv;
    td.title = [v === 'nikdy' ? T('Agent zatím neposlal žádná data') : T('Poslední kontakt:') + ' ' + fmtDate(last) + ' · ' + T('poslední inventura:') + ' ' + fmtDate(row._inv),
      row._agent ? 'agent ' + row._agent : '', row._commr ? T(row._commr) : ''].filter(Boolean).join(' · ');
    const st = row._vstat || '';
    const verBad = st && st !== 'aktuální' && st !== 'novější';
    return add(td, [el('span', { class: 'dot ' + AGENT_DOT[v] }), v === 'nikdy' ? 'nikdy' : ago(last),
      row._agent ? [' ', el('span', { class: 'badge ' + (VER_BADGE[st] || '') }, row._agent), verBad ? el('span', { class: 'small muted' }, ' ' + st) : null] : null]);
  }
  if (col.key === 'agent_version') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    const st = row._vstat || '';
    td.title = T('Cílová verze: ' + (row._vtarget || '–') + (st ? ' · ' + st : '') + (row._vpin ? ' · připnuto k tomuto PC' : ''));
    return add(td, [el('span', { class: 'badge ' + (VER_BADGE[st] || '') }, v), st && st !== 'aktuální' ? el('span', { class: 'small muted' }, ' ' + st) : null,
      row._vpin ? el('span', { class: 'small muted' }, ' (připnuta)') : null]);
  }
  if (col.key === 'agent_health') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    td.title = T((row._hreason || 'Bez výhrad') + (v !== 'v pořádku' ? ' · klikněte pro podrobnosti' : ''));
    if (v !== 'v pořádku') {
      td.classList.add('clickable');
      td.addEventListener('click', (e) => { e.stopPropagation(); agentIssueDialog(row, v); });
    }
    return add(td, [el('span', { class: 'dot ' + (HEALTH_DOT[v] || '') }), v]);
  }
  if (col.key === 'agent_issue') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    const parts = String(v).split('; ').filter(Boolean);
    td.title = T(String(v)) + ' · ' + T('klikněte pro detail agenta');
    jumpCell(td, row, 'agent');
    return add(td, [parts[0], parts.length > 1 ? el('span', { class: 'small muted' }, ' +' + (parts.length - 1)) : null]);
  }
  if (col.key === 'sec_level') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    td.title = T('Klikněte pro kartu Zabezpečení');
    jumpCell(td, row, 'sec');
    return add(td, [el('span', { class: 'dot ' + (v === 'chyba' ? 'bad' : (v === 'varování' ? 'warn' : 'on')) }), v]);
  }
  if (col.key === 'sec_problem') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    td.title = T('Klikněte pro kartu Zabezpečení');
    jumpCell(td, row, 'sec');
    const m = /^(.*?)(?:: (.*?))?(?: \+(\d+))?$/.exec(String(v)) || [];
    return add(td, [T(m[1] || '') + (m[2] ? ': ' + T(m[2]) : '') + (m[3] ? ' +' + m[3] : '')]);
  }
  if (col.key === 'os_install_date') {
    const td = el('td', { class: 'nw' });
    if (!v) return add(td, [el('span', { class: 'muted' }, '–')]);
    return add(td, [fmtDate(v), ' ', el('span', { class: 'small muted' }, ageNode(daysSince(v)))]);
  }
  if (col.key === 'os_name' && v) {
    const td = el('td', { class: 'nw', title: v });
    return add(td, [String(v).replace(/^Microsoft /, '').replace(/^Windows/, 'Win')]);
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
  if (col.key === 'ip' && row._ipc) {
    const td = el('td', { class: 'nw' });
    td.title = T('Konflikt IP: stejnou adresu má i ') + row._ipc;
    return add(td, [v, ' ', el('span', { class: 'badge bad' }, '⚠ konflikt')]);
  }
  if (col.key === 'ip' && row._ipold) {
    const td = el('td', { class: 'nw' });
    td.title = T('Stejnou adresu má i starší záznam (offline): ') + row._ipold;
    return add(td, [v, ' ', el('span', { class: 'badge' }, 'starší záznam')]);
  }
  const nw = col.type === 'date' || ['hostname', 'ip', 'device_ip', 'mac', 'serial', 'online'].includes(col.key);
  const td = el('td', { class: col.type === 'num' ? 'num' : (nw ? 'nw' : '') });
  if (col.key === 'online') {
    const off = !v && row._offmin != null ? fmtMinutes(row._offmin) : '';
    return add(td, [el('span', { class: 'dot' + (v ? ' on' : '') }), v ? 'online' : 'offline',
      off ? el('span', { class: 'small muted' }, ' · ' + off) : null]);
  }
  if (col.key === 'offline_min') return add(el('td', { class: 'nw' }), [v == null ? el('span', { class: 'muted' }, '–') : fmtMinutes(v)]);
  if (col.key === 'rdp' && v == null) return add(td, [el('span', { class: 'badge', title: T('Skutečný stav zatím nikdo nezjistil: počkejte na agenta 2.4.1 nebo novější') }, 'neověřeno')]);
  if (col.type === 'bool') return add(td, [el('span', { class: 'badge' + (v ? ' ok' : '') }, v ? 'ano' : 'ne')]);
  if (v == null || v === '') return td;
  if (col.key === 'action') return add(td, [el('span', { class: 'badge ' + (ACTION_BADGE[v] || '') }, v)]);
  if (col.key === 'free' && v < 0) return add(td, [el('span', { class: 'badge bad' }, v)]);
  if (col.type === 'date') return add(td, [fmtDate(v)]);
  if (AGE_KEYS.has(col.key)) return add(td, [ageNode(v)]);
  if (col.type === 'num') return add(td, [String(v).replace('.', ',')]);
  return add(td, [v]);
}

// ------------------------------------------------- vyber sloupcu a filtry

// seznam sloupcu (nabidka "pridat sloupec", filtry) razeny abecedne podle jazyka rozhrani: cesky (ch za h) / anglicky
function sortedDefs(defs) {
  const coll = new Intl.Collator(S.lang === 'en' ? 'en' : 'cs', { sensitivity: 'base', numeric: true });
  return defs.slice().sort((a, b) => coll.compare(T(a.label), T(b.label)));
}

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
      ...sortedDefs(defs.filter((d) => !cols.includes(d.key))).map((d) => el('option', { value: d.key }, d.label)));
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
    const col = el('select', null, sortedDefs(defs).map((d) => el('option', { value: d.key, selected: f && f.col === d.key }, d.label)));
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
      val.placeholder = T(type === 'bool' ? 'ano / ne' : (op.value === 'older_h' || op.value === 'newer_h') ? 'počet hodin'
        : op.value === 'in' ? 'např. notebook, server' : 'hodnota');
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
      if (opts.onLayout) opts.onLayout();
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
        data.columns.map((c) => { const td = cell(c, r); td.dataset.col = c.key; return td; }));
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
  const selBody = () => (st.all ? { select_all: { filters: st.filters, search: st.search } } : { device_ids: [...st.sel], ids: [...st.sel] });
  const afterBulk = () => { st.sel.clear(); st.all = false; st.groups = null; load(); if (opts.onChanged) opts.onChanged(); };
  async function ensureGroups() {
    if (!st.groups) { try { st.groups = (await api('GET', '/api/groups')).groups; } catch (e) { st.groups = []; } }
    return st.groups;
  }
  async function moveSection(section, label) {
    const r = await api('POST', '/api/devices/section', Object.assign({ section }, selBody()));
    toast(label + ': ' + r.changed + ' zařízení', 'ok'); afterBulk();
  }
  async function agentVersionBulk(version) {
    const r = await api('POST', '/api/devices/agent-version', Object.assign({ version }, selBody()));
    toast((version ? 'Připnuta verze ' + version : 'Připnutí zrušeno') + ': ' + r.changed + ' zařízení', 'ok'); afterBulk();
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
    const sectionMenu = !opts.sections ? null : popMenu('Přesunout do sekce', (close) => [
      ...(opts.sections || []).map((n) => el('button', { class: 'pop-item', onclick: run(() => moveSection(n, 'Přesunuto do sekce ' + n), close) },
        n, current === n ? el('span', { class: 'muted small' }, ' (současná)') : null)),
      el('div', { class: 'pop-sep' }),
      el('button', { class: 'pop-item', onclick: run(() => moveSection('', 'Odebráno ze sekce'), close) }, 'Bez sekce (jen ve Vše)'),
      el('button', { class: 'pop-item', onclick: run(() => moveSection(null, 'Zařazeno automaticky'), close) }, 'Automaticky podle typu')]);
    const verMenu = !opts.sections ? null : popMenu('Verze agenta', async (close) => {
      const rel = (await api('GET', '/api/agent-releases')).versions.filter((v) => !v.legacy);
      return [el('div', { class: 'muted small pad' }, 'Připnout vybraným PC verzi (platí nejpozději za 5 minut):'),
        ...rel.map((v) => el('button', { class: 'pop-item', onclick: run(() => agentVersionBulk(v.version), close) }, v.version + (v.latest ? ' (nejnovější)' : ''))),
        el('div', { class: 'pop-sep' }),
        el('button', { class: 'pop-item', onclick: run(() => agentVersionBulk(null), close) }, 'Podle globálního cíle (zrušit připnutí)')];
    });
    const groupMenu = !opts.sections ? null : popMenu('Skupiny', async (close) => {
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
      el('span', { class: 'sel-actions' }, sectionMenu, groupMenu, verMenu,
        current ? el('button', { class: 'menu-btn', title: 'Zařízení zůstanou jen ve Vše', onclick: run(() => moveSection('', 'Odebráno ze sekce ' + current), () => {}) }, 'Odebrat ze sekce ' + current) : null,
        ...(opts.bulk || []).map((b) => el('button', { class: 'menu-btn' + (b.danger ? ' danger' : ''), title: b.title || '',
          onclick: run(async () => { if (await b.run(selBody(), count)) afterBulk(); }, () => {}) }, b.label))),
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
      modal('Sloupce', p.node, [{ label: 'Zrušit' }, { label: 'Použít', primary: true, onclick: () => { st.columns = p.get(); load(); if (opts.onLayout) opts.onLayout(); } }]);
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
    el('div', { class: 'table-wrap' + (opts.compact ? ' compact' : '') }, el('table', null, thead, tbody)), pager);
  load();
  return { node, reload: load, setFilters: (f) => { st.filters = f; st.page = 1; st.all = false; load(); },
    refreshGroups: () => { st.groups = null; load(); },
    selection: () => st.sel.size,
    getLayout: () => ({ columns: st.columns.slice(), sort: st.sort, sortDir: st.sortDir }),
    setLayout: (l) => { st.columns = (l.columns || []).slice(); st.sort = l.sort || ''; st.sortDir = l.sortDir || 'asc'; st.page = 1; load(); },
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
    catch (ex) { err.textContent = T(ex.message); }
  } }, el('h1', null, 'HWSW Monitor'), el('p', { class: 'muted' }, 'Evidence hardwaru a softwaru'),
    field('Přihlašovací jméno', user), field('Heslo', pass), err, el('button', { class: 'primary', type: 'submit' }, 'Přihlásit'),
    langSwitch(() => renderLogin()));
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
  ['Evidence', [['zarizeni', 'Zařízení'], ['software', 'Software'], ['monitory', 'Monitory'], ['usb', 'USB zařízení'], ['licence', 'Licence'], ['security', 'Security']]],
  ['Pohledy', [['pohledy', 'Šablony pohledů']]],
  ['Správa', [['skenovani', 'Skenování'], ['agent', 'Agent pro Windows'], ['uzivatele', 'Uživatelé'], ['nastaveni', 'Nastavení'], ['zalohy', 'Zálohy']]],
];

function isAdmin() { return S.me && S.me.role === 'admin'; }

function langSwitch(onChange) {
  const pick = async (lang) => {
    if (lang === S.lang) return;
    setLang(lang);
    if (S.me) { try { await api('PUT', '/api/me/lang', { lang }); S.me.lang = lang; } catch (e) { /* jazyk zustane jen v prohlizeci */ } }
    if (onChange) onChange(); else { renderShell(); route(); }
  };
  return el('div', { class: 'lang-switch', role: 'group', 'aria-label': 'Jazyk / Language' },
    ['cs', 'en'].map((l) => el('button', { class: 'ghost' + (S.lang === l ? ' on' : ''), 'aria-pressed': S.lang === l ? 'true' : 'false',
      onclick: () => pick(l) }, l.toUpperCase())));
}

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
        langSwitch(),
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
  if (d.agent_versions && d.agent_versions.target !== d.agent_versions.latest) {
    main.append(el('div', { class: 'note-box' }, el('strong', null, 'Cílová verze agentů: '), d.agent_versions.target + ' (nejnovější je ' + d.agent_versions.latest + '). ',
      el('a', { href: '#/nastaveni' }, 'Nastavení'), ' → Agent: verze a aktualizace.'));
  }
  if (d.usb_alerts && d.usb_alerts.length) {
    main.append(el('div', { class: 'note-box usb-alert' },
      el('div', { class: 'row' }, el('strong', null, '⚠ USB varování: '), el('span', null, d.usb_alerts_total + ' nepřevzatých (připojené úložiště nebo telefon)'),
        el('button', { class: 'right', onclick: async () => { try { await api('POST', '/api/usb/ack', { all: true }); route(); } catch (e) { fail(e); } } }, 'Převzít vše')),
      el('ul', { class: 'feed usb-who' }, d.usb_alerts.slice(0, 8).map((e) => el('li', null,
        el('div', null, el('span', { class: 'badge warn' }, e.class), ' ', el('strong', null, e.name || 'USB zařízení'),
          e.label ? el('span', { class: 'muted' }, ' · ' + e.label + (e.drive ? ' (' + e.drive + ')' : '')) : null),
        el('div', { class: 'muted' }, el('strong', null, 'Kdy: '), fmtDate(e.ts), '   ',
          el('strong', null, 'Kdo: '), e.user ? (e.user_name ? e.user_name + ' (' + e.user + ')' : e.user) : 'nikdo nebyl přihlášen / neznámo', '   ',
          el('strong', null, 'Kde: '), el('a', { href: '#/zarizeni/' + e.device_id }, e.hostname),
          (e.ip ? ' · ' + e.ip : '') + (e.location ? ' · ' + e.location : '')),
        el('button', { class: 'small right', onclick: async () => { try { await api('POST', '/api/usb/ack', { ids: [e.id] }); route(); } catch (x) { fail(x); } } }, 'Převzít')))),
      d.usb_alerts_total > 8 ? el('a', { href: '#/usb' }, 'Zobrazit všechna (' + d.usb_alerts_total + ')') : null));
  }
  if (d.agent_summary) {
    const a = d.agent_summary;
    main.append(el('a', { class: 'note-box info', href: '#/zarizeni', style: 'display:block;color:inherit;text-decoration:none' },
      el('strong', null, 'Agenti: '), a.cur + ' s aktuální verzí, ', el('strong', null, String(a.old)), ' zastaralých' + (a.newer ? ', ' + a.newer + ' novějších' : '') + '. ',
      'Zdraví: ' + a.h_ok + ' v pořádku, ' + a.h_warn + ' varování, ' + a.h_bad + ' s chybou' + (a.h_noagent ? ', ' + a.h_noagent + ' počítačů bez agenta' : '') + '.'));
  }
  if (d.ip_conflicts) {
    main.append(el('div', { class: 'note-box' }, el('strong', null, '⚠ Konflikt IP adres: '),
      d.ip_conflicts + ' zařízení sdílí IP adresu s jiným zařízením. ',
      el('a', { href: '#/zarizeni' }, 'Otevřít Zařízení'), ' a použít filtr „Konflikt IP“.'));
  }
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
    if (ev.type === 'usb_ack' || (ev.type === 'usb' && ev.alert)) { route(); return; }
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
  function reset() { editing = null; name.value = ''; desc.value = ''; color = palette[0] || color; formTitle.textContent = T('Nová skupina'); saveBtn.textContent = T('Vytvořit skupinu'); drawSwatches(); }
  async function refresh() {
    const r = await api('GET', '/api/groups');
    palette = r.colors;
    if (!palette.includes(color)) color = palette[0];
    list.replaceChildren(...(r.groups.length ? r.groups.map((g) => el('div', { class: 'group-row' },
      groupTag(g.name, g.color), el('span', { class: 'muted small' }, g.devices + ' zařízení' + (g.description ? ' · ' + g.description : '')),
      el('span', { class: 'right row' },
        el('button', { class: 'mini', onclick: () => { editing = g; name.value = g.name; desc.value = g.description || ''; color = g.color; formTitle.textContent = T('Upravit skupinu'); saveBtn.textContent = T('Uložit změny'); drawSwatches(); name.focus(); } }, 'Upravit'),
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
  const PC_COLS = ['hostname', 'model', 'logged_user', 'os_name', 'ip', 'agent_state', 'agent_health', 'agent_issue', 'sec_level', 'sec_problem', 'online', 'groups', 'os_install_date'];
  const NET_COLS = ['hostname', 'device_type', 'groups', 'online', 'ip', 'mac', 'manufacturer', 'model'];
  const ALL_COLS = ['hostname', 'section', 'agent_state', 'agent_version', 'device_type', 'logged_user', 'groups', 'online', 'ip', 'os_name', 'model'];
  const SECTIONS = ['Počítače', 'Servery', 'IoT', 'Síťové prvky', 'Tiskárny'];
  const secFilter = (n) => [{ col: 'section', op: 'eq', value: n, tab: true }];
  const TABS = [
    ['Počítače', secFilter('Počítače'), PC_COLS, 'agent_state'],
    ['Servery', secFilter('Servery'), PC_COLS, 'agent_state'],
    ['IoT', secFilter('IoT'), NET_COLS, 'ip'],
    ['Síťové prvky', secFilter('Síťové prvky'), NET_COLS, 'ip'],
    ['Tiskárny', secFilter('Tiskárny'), NET_COLS, 'ip'],
    ['Vše', [], ALL_COLS, 'hostname'],
  ];
  const MAIN_FLAGS = new Set(['online', 'offline', 'never', 'agentissue', 'secbad']);
  const FLAGS = [
    ['online', 'Online', 'online', { col: 'online', op: 'eq', value: 'ano', tab: true }],
    ['offline', 'Offline', 'offline', { col: 'online', op: 'eq', value: 'ne', tab: true }],
    ['never', 'Bez agenta', 'never', { col: 'agent_state', op: 'eq', value: 'nikdy', tab: true }],
    ['stale', 'Neaktivní agent', 'stale', { col: 'agent_state', op: 'eq', value: 'neaktivní', tab: true }],
    ['ipc', 'Konflikt IP', 'ip_conflicts', { col: 'ip_conflict', op: 'eq', value: 'ano', tab: true }],
    ['oldagent', 'Zastaralý agent', 'old', { col: 'agent_ver_status', op: 'in', value: 'zastaralý,neznámá', tab: true }],
    ['agentissue', 'Chyba agenta', 'h_issue', { col: 'agent_health', op: 'in', value: 'chyba,varování', tab: true }],
    ['secbad', 'Security', 'sec_bad', { col: 'sec_level', op: 'in', value: 'chyba,varování', tab: true }],
    ['rdp', 'RDP zapnuto', 'rdp', { col: 'rdp', op: 'eq', value: 'ano', tab: true }],
    ['pinned', 'Verze připnuta', 'pinned', { col: 'agent_pinned', op: 'eq', value: 'ano', tab: true }],
    ['nosec', 'Bez sekce', 'no_section', { col: 'section', op: 'eq', value: '', tab: true }],
  ];
  let curTab = TABS[0];
  let curGroup = '';
  const flags = new Set();
  // ulozene pohledy sloupcu (na kartu a prohlizec): { vychozi: nazev|null, pohledy: [{ name, columns, sort, sortDir }] }
  const LKEY = 'hwsw_layouts_' + (S.me && S.me.id);
  const loadStore = () => { try { return JSON.parse(localStorage.getItem(LKEY) || '{}'); } catch (e) { return {}; } };
  const saveStore = (o) => { try { localStorage.setItem(LKEY, JSON.stringify(o)); } catch (e) { toast('Pohled se nepodařilo uložit (prohlížeč to blokuje)', 'err'); } };
  const tabStore = () => { const o = loadStore(); const x = o[curTab[0]] || {}; return { vychozi: x.vychozi || null, pohledy: Array.isArray(x.pohledy) ? x.pohledy : [] }; };
  const putTabStore = (x) => { const o = loadStore(); o[curTab[0]] = x; saveStore(o); };
  const factory = () => ({ columns: curTab[2].slice(), sort: curTab[3], sortDir: 'asc' });
  const defaultLayout = () => { const x = tabStore(); return x.pohledy.find((v) => v.name === x.vychozi) || null; };
  const viewOf = () => {
    const l = defaultLayout() || factory();
    const valid = S.schema.entities.devices.columns.map((c) => c.key);
    const cols = (l.columns || []).filter((k) => valid.includes(k));
    return {
      filters: curTab[1].concat(FLAGS.filter((f) => flags.has(f[0])).map((f) => f[3]),
        curGroup ? [{ col: 'groups', op: 'eq', value: curGroup, tab: true }] : []),
      columns: cols.length ? cols : curTab[2], sort: l.sort || curTab[3], sortDir: l.sortDir || 'asc' };
  };
  const t = dataTable({ entity: 'devices', adhoc: true, compact: true, selectable: true, onLayout: () => { curLayoutName = '__mod'; drawLayouts(); }, sections: SECTIONS, bulk: [bulkDelete('devices', 'zařízení')],
    currentSection: () => (SECTIONS.includes(curTab[0]) ? curTab[0] : null),
    onChanged: () => { summary(); loadGroupSel(); },
    onRow: (r) => { location.hash = '#/zarizeni/' + r._id; },
    filters: viewOf().filters, columns: viewOf().columns, sort: 'agent_state', sortDir: 'asc' });
  const applyView = () => { t.setView(viewOf()); curLayoutName = (defaultLayout() || {}).name || ''; drawLayouts(); };
  let curLayoutName = (defaultLayout() || {}).name || '';
  const layoutSel = el('select', { 'aria-label': 'Pohled sloupců', onchange: () => {
    const x = tabStore();
    if (layoutSel.value === '__mod') return;
    const l = layoutSel.value === '' ? factory() : x.pohledy.find((v) => v.name === layoutSel.value);
    if (l) { curLayoutName = layoutSel.value; t.setLayout(l); }
    drawLayouts();
  } });
  function drawLayouts() {
    const x = tabStore();
    layoutSel.replaceChildren(el('option', { value: '' }, T('Základní pohled')),
      ...x.pohledy.map((v) => el('option', { value: v.name }, (v.name === x.vychozi ? '★ ' : '') + v.name)),
      curLayoutName === '__mod' ? el('option', { value: '__mod' }, T('(upraveno)')) : null);
    layoutSel.value = (curLayoutName === '__mod' || x.pohledy.some((v) => v.name === curLayoutName)) ? curLayoutName : '';
    const named = x.pohledy.some((v) => v.name === curLayoutName);
    layoutBtns.setDef.disabled = !named || curLayoutName === x.vychozi;
    layoutBtns.del.disabled = !named;
  }
  const layoutBtns = {
    save: el('button', { onclick: () => {
      const x = tabStore();
      const name = el('input', { value: curLayoutName === '__mod' ? '' : curLayoutName, placeholder: 'Název pohledu', maxlength: '40' });
      const def = el('input', { type: 'checkbox', checked: true });
      modal('Uložit pohled sloupců', el('div', null,
        field('Název pohledu', name),
        el('label', { class: 'check' }, def, 'Nastavit jako výchozí (zobrazí se vždy po otevření karty)'),
        el('div', { class: 'hint' }, 'Uloží se právě zobrazené sloupce, jejich pořadí a řazení. Pohled platí pro tuto kartu a tento prohlížeč. Stejný název přepíše existující pohled.')),
      [{ label: 'Zrušit' }, { label: 'Uložit', primary: true, onclick: () => {
        const nm = name.value.trim();
        if (!nm) { toast('Zadejte název pohledu', 'err'); return false; }
        const l = t.getLayout();
        x.pohledy = x.pohledy.filter((v) => v.name !== nm).concat([{ name: nm, columns: l.columns, sort: l.sort, sortDir: l.sortDir }]);
        if (def.checked) x.vychozi = nm;
        putTabStore(x); curLayoutName = nm; drawLayouts(); toast('Pohled uložen', 'ok');
      } }]);
    } }, 'Uložit pohled…'),
    setDef: el('button', { onclick: () => { const x = tabStore(); x.vychozi = curLayoutName; putTabStore(x); drawLayouts(); toast('Nastaveno jako výchozí', 'ok'); } }, '★ Výchozí'),
    del: el('button', { class: 'danger', onclick: async () => {
      if (!(await confirmBox('Smazat pohled „' + curLayoutName + '“?', 'Smazat'))) return;
      const x = tabStore();
      x.pohledy = x.pohledy.filter((v) => v.name !== curLayoutName);
      if (x.vychozi === curLayoutName) x.vychozi = null;
      putTabStore(x); curLayoutName = ''; t.setLayout(factory()); drawLayouts();
    } }, 'Smazat pohled'),
    reset: el('button', { onclick: () => { const l = defaultLayout() || factory(); curLayoutName = (defaultLayout() || {}).name || ''; t.setLayout(l); drawLayouts(); } }, 'Obnovit výchozí'),
  };
  const layoutBar = el('div', { class: 'quick' }, el('span', { class: 'muted small' }, 'Pohled sloupců:'), layoutSel,
    layoutBtns.save, layoutBtns.setDef, layoutBtns.del, layoutBtns.reset);
  drawLayouts();
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
      if (flags.has(key)) flags.delete(key); else {
        flags.add(key);
        // online a offline se vzajemne vylucuji
        const other = key === 'online' ? 'offline' : (key === 'offline' ? 'online' : '');
        if (other) flags.delete(other);
      }
      flagButtons.forEach((x) => { const on = flags.has(x.dataset.flag); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      applyView();
    } }, label, ' ', n);
    b.dataset.flag = key;
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
  const extraBox = el('div', { class: 'quick extra' });
  extraBox.style.display = 'none';
  const moreBtn = el('button', { class: 'flag', 'aria-expanded': 'false', onclick: () => {
    const open = extraBox.style.display === 'none';
    extraBox.style.display = open ? '' : 'none'; moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    moreBtn.firstChild.textContent = T(open ? 'Další filtry ▴' : 'Další filtry ▾');
  } }, el('span', null, T('Další filtry ▾')));
  info.append(el('span', { class: 'muted small' }, 'Rychlé filtry:'), ...flagButtons.filter((b) => MAIN_FLAGS.has(b.dataset.flag)), moreBtn,
    el('span', { class: 'right' }, groupSel));
  extraBox.append(...flagButtons.filter((b) => !MAIN_FLAGS.has(b.dataset.flag)));
  const legend = el('div', { class: 'hint', style: 'margin-bottom:10px' });
  main.append(bar, info, extraBox, layoutBar, legend, t.node);
  async function summary() {
    try {
      const c = await api('GET', '/api/devices-summary');
      TABS.forEach((tab) => { counts[tab[0]].textContent = tab[0] === 'Vše' ? c.total : c.sections[tab[0]]; });
      flagCounts.online.textContent = c.online; flagCounts.offline.textContent = c.offline;
      flagCounts.never.textContent = c.never; flagCounts.stale.textContent = c.stale; flagCounts.no_section.textContent = c.no_section;
      flagCounts.ip_conflicts.textContent = c.ip_conflicts;
      flagCounts.old.textContent = c.old; flagCounts.h_issue.textContent = c.h_bad + c.h_warn; flagCounts.sec_bad.textContent = c.sec_bad; flagCounts.pinned.textContent = c.pinned; flagCounts.rdp.textContent = c.rdp;
      legend.replaceChildren(
        el('span', { class: 'dot on' }), T('odesílá data (do ' + c.stale_hours + ' h)') + '   ',
        el('span', { class: 'dot warn' }), T('agent neposlal data déle než ' + c.stale_hours + ' h') + '   ',
        el('span', { class: 'dot bad' }), T('agent nikdy neposlal data'));
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

// hromadne mazani oznacenych radku (potvrzeni + zaloha na serveru)
function bulkDelete(entity, noun) {
  return { label: 'Smazat', danger: true, title: 'Trvale smaže označené ' + noun,
    run: async (body, count) => {
      const text = 'Smazat ' + count + ' ' + noun + '? Smazání nelze vrátit zpět (před smazáním se vytvoří záloha databáze).' +
        (entity === 'devices' ? ' Zařízení, která jsou stále v síti, se při dalším skenu objeví znovu.' : '');
      if (!(await confirmBox(text, 'Smazat'))) return false;
      const r = await api('POST', '/api/bulk-delete', Object.assign({ entity }, body));
      toast('Smazáno: ' + r.deleted, 'ok');
      return true;
    } };
}

async function countRows(entity, filters) {
  try { return (await api('POST', '/api/query', { entity, filters, page_size: 10, page: 1 })).total; } catch (e) { return ''; }
}

// stranka evidence ve stylu Zarizeni: zalozky s pocty, rychle filtry, filtr podle vsech parametru, sloupce, vyber radku
function evidencePage(box, cfg) {
  const mark = (arr) => (arr || []).map((f) => Object.assign({ tab: true }, f));
  let curTab = cfg.tabs[0];
  const flags = new Set();
  const flagList = cfg.flags || [];
  const viewOf = () => ({ filters: (cfg.base || []).concat(mark(curTab.filters), ...flagList.filter((f) => flags.has(f.key)).map((f) => mark([f.filter]))),
    columns: curTab.columns || [], sort: curTab.sort || cfg.sort || '', sortDir: curTab.sortDir || cfg.sortDir || '' });
  const v0 = viewOf();
  const t = dataTable(Object.assign({ entity: cfg.entity, adhoc: true, filters: v0.filters, columns: v0.columns, sort: v0.sort, sortDir: v0.sortDir,
    selectable: !!(cfg.table && cfg.table.bulk), onChanged: () => counts() }, cfg.table || {}));
  const tabCount = {}; const flagCount = {};
  const tabButtons = cfg.tabs.map((tab) => {
    const n = el('span', { class: 'count' }); tabCount[tab.label] = n;
    const b = el('button', { role: 'tab', class: tab === curTab ? 'active' : '', onclick: () => {
      tabButtons.forEach((x) => x.classList.toggle('active', x === b));
      curTab = tab; t.setView(viewOf()); counts();
    } }, tab.label, ' ', n);
    return b;
  });
  const flagButtons = flagList.map((f) => {
    const n = el('span', { class: 'count' }); flagCount[f.key] = n;
    const b = el('button', { class: 'flag', 'aria-pressed': 'false', onclick: () => {
      if (flags.has(f.key)) flags.delete(f.key); else flags.add(f.key);
      b.classList.toggle('on', flags.has(f.key)); b.setAttribute('aria-pressed', flags.has(f.key) ? 'true' : 'false');
      t.setView(viewOf());
    } }, f.label, ' ', n);
    return b;
  });
  async function counts() {
    for (const tab of cfg.tabs) tabCount[tab.label].textContent = await countRows(cfg.entity, mark(tab.filters));
    for (const f of flagList) flagCount[f.key].textContent = await countRows(cfg.entity, mark(curTab.filters).concat(mark([f.filter])));
  }
  if (cfg.tabs.length > 1) box.append(el('div', { class: 'tabs', role: 'tablist' }, ...tabButtons));
  if (flagList.length) box.append(el('div', { class: 'quick' }, el('span', { class: 'muted small' }, 'Rychlé filtry:'), ...flagButtons));
  box.append(t.node);
  counts();
  return t;
}

PAGES.software = async (main) => {
  pageHead(main, 'Software', 'Nainstalovaný software podle hlášení agentů');
  const openDevice = (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id; };
  const show = tabbed(main, [
    ['souhrn', 'Souhrn', (box) => evidencePage(box, { entity: 'software_summary', tabs: [{ label: 'Vše', filters: [] }],
      flags: [{ key: 'one', label: 'Jen 1 instalace', filter: { col: 'installs', op: 'eq', value: '1' } },
        { key: 'multi', label: 'Více verzí', filter: { col: 'versions', op: 'gt', value: '1' } }],
      sort: 'installs', sortDir: 'desc', table: { onRow: (r) => show('instalace', r.name) } })],
    ['instalace', 'Instalace na počítačích', (box, name) => evidencePage(box, { entity: 'software', tabs: [{ label: 'Vše', filters: [] }],
      base: name ? [{ col: 'name', op: 'eq', value: name }] : [], sort: 'name', table: { onRow: openDevice } })],
    ['zmeny', 'Změny', (box) => evidencePage(box, { entity: 'sw_changes', tabs: [{ label: 'Vše', filters: [] }],
      flags: [{ key: 'd1', label: 'Posledních 24 h', filter: { col: 'ts', op: 'newer_h', value: '24' } },
        { key: 'd7', label: 'Posledních 7 dní', filter: { col: 'ts', op: 'newer_h', value: '168' } }],
      sort: 'ts', sortDir: 'desc', table: { onRow: openDevice, bulk: [bulkDelete('sw_changes', 'záznamů změn')],
        emptyText: 'Změny se zaznamenávají od druhé inventury každého počítače' } })],
  ]);
};

PAGES.monitory = async (main) => {
  pageHead(main, 'Monitory', 'Výrobce, model, sériové číslo a úhlopříčka z EDID monitoru');
  evidencePage(main, { entity: 'monitors', sort: 'manufacturer',
    tabs: [{ label: 'Připojené', filters: [{ col: 'connected', op: 'eq', value: 'ano' }] },
      { label: 'Odpojené', filters: [{ col: 'connected', op: 'eq', value: 'ne' }] },
      { label: 'Vše', filters: [] }],
    flags: [{ key: 'old', label: 'Bez roku výroby', filter: { col: 'year', op: 'empty', value: '' } },
      { key: 'noted', label: 'S poznámkou', filter: { col: 'note', op: 'not_empty', value: '' } }],
    table: { onRow: (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id; }, bulk: [bulkDelete('monitors', 'monitorů')] } });
};

PAGES.usb = async (main) => {
  pageHead(main, 'USB zařízení', 'Hlídá se připojení úložišť s médiem (disky, flash, karty) a telefonů. Myš, klávesnice a dongle se neevidují. Události přicházejí z agentů během několika sekund');
  let current = null;
  const openDevice = (r) => { if (r._device_id) location.hash = '#/zarizeni/' + r._device_id; };
  const cfg = await api('GET', '/api/settings');
  tabbed(main, [
    ['varovani', 'Varování', (box) => {
      box.append(el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Připojené úložiště nebo telefon, které ještě nikdo nepřevzal.'),
        el('button', { class: 'right', onclick: async () => { try { await api('POST', '/api/usb/ack', { all: true }); toast('Varování převzata', 'ok'); route(); } catch (e) { fail(e); } } }, 'Převzít vše')));
      current = evidencePage(box, { entity: 'usb_events', sort: 'ts', sortDir: 'desc',
        columns: ['ts', 'class', 'name', 'label', 'serial', 'hostname', 'event_user', 'action'],
        tabs: [{ label: 'Nepřevzatá', filters: [{ col: 'alert', op: 'eq', value: 'ano', tab: true }] },
          { label: 'Všechna varování', filters: [{ col: 'action', op: 'in', value: 'připojeno,nalezeno', tab: true }, { col: 'class', op: 'in', value: 'úložiště,telefon / přenosné zařízení', tab: true }] }],
        table: { onRow: openDevice, emptyText: 'Žádná nepřevzatá varování' } });
    }],
    ['pripojena', 'Právě připojená', (box) => { current = evidencePage(box, { entity: 'usb_current', sort: 'connected_at', sortDir: 'desc',
      tabs: [{ label: 'Vše', filters: [] }],
      flags: [{ key: 'd1', label: 'Připojeno do 24 h', filter: { col: 'connected_at', op: 'newer_h', value: '24' } },
        { key: 'found', label: 'Nalezeno při první inventuře', filter: { col: 'source', op: 'eq', value: 'nalezeno při první inventuře' } },
        { key: 'plain', label: 'Nešifrováno', filter: { col: 'encrypted', op: 'eq', value: 'ne' } }],
      table: { onRow: openDevice, emptyText: 'Právě není připojeno žádné USB úložiště' } }); }],
    ['historie', 'Historie', (box) => { current = evidencePage(box, { entity: 'usb_events', sort: 'ts', sortDir: 'desc',
      tabs: [{ label: 'Vše', filters: [] }],
      flags: [{ key: 'c', label: 'Připojeno', filter: { col: 'action', op: 'eq', value: 'připojeno' } },
        { key: 'o', label: 'Odpojeno', filter: { col: 'action', op: 'eq', value: 'odpojeno' } },
        { key: 'f', label: 'Nalezeno při inventuře', filter: { col: 'action', op: 'eq', value: 'nalezeno' } },
        { key: 'big', label: 'Přeneseno nad 500 MB', filter: { col: 'delta_mb', op: 'gt', value: '500' } },
        { key: 'd1', label: 'Posledních 24 h', filter: { col: 'ts', op: 'newer_h', value: '24' } },
        { key: 'd7', label: 'Posledních 7 dní', filter: { col: 'ts', op: 'newer_h', value: '168' } }],
      table: { onRow: openDevice, bulk: [bulkDelete('usb_events', 'událostí')] } }); }],
    ['soubory', 'Soubory na USB', (box) => {
      box.append(cfg.usb_files_enabled === '1'
        ? el('div', { class: 'hint' }, 'Zobrazují se soubory zapsané na USB (směr „na USB“)' + (cfg.usb_audit_enabled === '1'
          ? ' i soubory čtené z USB (směr „z USB“, z auditu Windows – vyžaduje GPO, návod na stránce Agent).'
          : '. Soubory čtené z USB se sledují jen po zapnutí auditu v Nastavení (karta Agent) a GPO.') + ' Uchování: ' + cfg.usb_files_days + ' dní.')
        : el('div', { class: 'note-box info' }, 'Sledování souborů na USB je vypnuté. Zapnete ho v ', el('a', { href: '#/nastaveni' }, 'Nastavení'),
          ' (karta Agent). Před zapnutím zajistěte směrnici o monitoringu zaměstnanců.'));
      evidencePage(box, { entity: 'usb_files', sort: 'ts', sortDir: 'desc', tabs: [{ label: 'Vše', filters: [] }],
        flags: [{ key: 'to', label: 'Na USB', filter: { col: 'direction', op: 'eq', value: 'na USB' } },
          { key: 'from', label: 'Z USB', filter: { col: 'direction', op: 'eq', value: 'z USB' } },
          { key: 'd1', label: 'Posledních 24 h', filter: { col: 'ts', op: 'newer_h', value: '24' } },
          { key: 'big', label: 'Nad 100 MB', filter: { col: 'size_mb', op: 'gt', value: '100' } }],
        table: { onRow: openDevice, bulk: [bulkDelete('usb_files', 'záznamů')], emptyText: 'Zatím žádné záznamy' } });
    }],
  ]);
  S.live = (ev) => { if ((ev.type === 'usb' || ev.type === 'usb_ack') && current) current.reload(); };
};

// ------------------------------------------------------- detail zarizeni

async function agentTab(box, d, id) {
  const st = d.agent_status || {};
  const info = d.agent_info || {};
  const rel = (await api('GET', '/api/agent-releases')).versions.filter((v) => !v.legacy);
  const kvl = (pairs) => el('dl', { class: 'kv' }, pairs.filter((p) => p[1] != null && p[1] !== '').map(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
  const yn = (v) => (v == null ? '' : (v ? 'ano' : 'ne'));
  const sel = el('select', null, el('option', { value: '' }, 'Podle globálního cíle'),
    ...rel.map((v) => el('option', { value: v.version, selected: d.agent_target === v.version }, v.version + (v.latest ? ' (nejnovější)' : ''))));
  box.append(
    el('div', { class: 'card' }, el('h3', null, 'Verze a stav agenta'), kvl([
      ['Verze agenta', d.agent_version], ['Stav verze', el('span', { class: 'badge ' + (VER_BADGE[st.agent_ver_status] || '') }, st.agent_ver_status || '–')],
      ['Cílová verze', st.agent_target_eff], ['Připnuto k tomuto PC', d.agent_target || 'ne – podle globálního cíle'],
      ['Zdraví', el('span', null, el('span', { class: 'dot ' + (HEALTH_DOT[st.agent_health] || '') }), st.agent_health || '–')],
      ['Důvod', st.agent_health_reason], ['Komunikace', st.agent_comm], ['Diagnostika komunikace', st.agent_comm_reason],
      ['Poslední kontakt agenta', d.agent_beat ? ago(d.agent_beat) + ' (' + fmtDate(d.agent_beat) + ')' : ''],
      ['Očekávaný další kontakt', fmtDate(st.agent_next_beat)], ['Poslední inventura', fmtDate(d.last_inventory)],
      ['Stav aktualizace', info.upd_state ? ({ ok: 'proběhla', stahuje: 'probíhá', vraceno: 'selhala, vráceno' }[info.upd_state] || info.upd_state)
        + (info.upd_target ? ' (' + info.upd_target + ')' : '') + (info.upd_at ? ' · ' + fmtDate(info.upd_at) : '') : ''],
      ['Zapamatované vadné verze', (info.bad || []).join(', ')]]),
      isAdmin() && d.agent_version ? el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { disabled: !verGe(d.agent_version, AGENT_CMD_MIN), onclick: () => sendAgentCmd([Number(id)], 'retry').catch(fail) }, 'Zkusit znovu'),
        el('button', { disabled: !verGe(d.agent_version, AGENT_CMD_MIN), onclick: () => sendAgentCmd([Number(id)], 'reconnect').catch(fail) }, 'Znovu spojit'),
        verGe(d.agent_version, AGENT_CMD_MIN) ? null : el('span', { class: 'hint' }, 'Příkazy fungují od agenta ' + AGENT_CMD_MIN)) : null,
      el('h3', { style: 'margin-top:18px' }, 'Nastavit verzi pro tento počítač'),
      el('div', { class: 'row' }, sel, el('button', { class: 'primary', onclick: async () => {
        try {
          await api('POST', '/api/devices/agent-version', { version: sel.value || null, device_ids: [Number(id)] });
          toast('Uloženo – agent se přepne nejpozději za 5 minut', 'ok'); route();
        } catch (e) { fail(e); }
      } }, 'Uložit')),
      el('div', { class: 'hint', style: 'margin-top:10px' }, 'Připnutí platí jen pro agenty od verze 2.0.0. Starší agent následuje globální cíl.')),
    el('div', { class: 'card' }, el('h3', null, 'Poslední chyba a provoz'), kvl([
      ['Poslední chyba', d.agent_error], ['Čas chyby', fmtDate(d.agent_error_at)],
      ['Stav chyby', d.agent_error ? ((Date.now() - Date.parse(String(d.agent_error_at).replace(' ', 'T') + 'Z')) / 60000 > 30
        ? 'opraveno (agent se už o chybě nehlásí; zůstává jen v historii)' : 'trvá (agent se o ní stále hlásí)') : ''], ['Běží s právy správce', yn(info.elevated)],
      ['Sledování USB', yn(info.usb_watch)], ['Sledování souborů na USB', yn(info.usb_files)],
      ['Sledované disky USB', (info.watch_drives || []).join(', ') || (info.usb_files ? 'žádný (nic není připojeno, nebo se nepodařilo zjistit písmeno disku)' : '')],
      ['Zachycené události souborů', info.file_events != null && info.usb_files ? info.file_events + (info.file_last ? ' · poslední ' + fmtDate(info.file_last) : '') : ''],
      ['Čtení z USB (audit Windows)', info.usb_audit ? 'zapnuto · stav: ' + (info.audit_state || '–') + ' · zachyceno ' + (info.audit_events || 0) : ''],
      ['Diagnostika sledování souborů', info.usb_files ? 'syrové události ' + (info.file_raw != null ? info.file_raw : '–') + ' · chyby sledování ' + (info.file_errors != null ? info.file_errors : '–') : ''],
      ['Audit Windows – Removable Storage', info.usb_audit ? (info.audit_policy || 'nezjištěno') + ' · událostí na USB discích ' + (info.audit_seen != null ? info.audit_seen : '–') : ''],
      ['Neúplné části inventury', (info.partial || []).join(', ')], ['Délka inventury', info.inv_ms ? Math.round(info.inv_ms / 1000) + ' s' : ''],
      ['Odchylka hodin', info.skew_s != null ? info.skew_s + ' s' : ''], ['PowerShell', info.ps]]),
      el('h3', { style: 'margin-top:18px' }, 'Historie chyb (uchovaná)'),
      errorHistory(d.agent_errors || [])));
}

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
      ['Instalace OS', os.install_date ? el('span', null, fmtDate(os.install_date), ' · ', ageNode(daysSince(os.install_date))) : ''], ['Poslední start', os.last_boot],
      ['Procesor', d.cpu], ['Paměť', d.ram_mb ? (d.ram_mb / 1024).toFixed(1).replace('.', ',') + ' GB' : ''],
      ['Disky celkem', d.disk_gb ? d.disk_gb + ' GB' : ''],
      ['IP adresa', d.ip], ['MAC adresa', d.mac], ['Otevřené porty', d.open_ports], ['Doména', d.domain], ['FQDN', d.fqdn],
      ['AD jednotka', d.ad_ou], ['Popis v AD', d.ad_description], ['Poslední přihlášení v AD', fmtDate(d.ad_last_logon)],
      ['Účet v AD', d.ad_enabled === 0 ? 'zakázaný' : ''],
      ['Zdroj dat', d.source], ['Agent', d.agent_version ? d.agent_version + (d.agent_status && d.agent_status.agent_ver_status ? ' (' + d.agent_status.agent_ver_status + ')' : '') : ''], ['Poprvé viděn', fmtDate(d.first_seen)],
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
      if (!s) { box.append(el('div', { class: 'note-box info' }, 'Údaje o zabezpečení zatím chybí – počkejte na další inventuru agenta (verze 1.1.0 a novější).')); }
      box.append(securityStateCard(d, s, () => { S.nextTab = 'sec'; route(); }));
    }],
    ['lic', 'Licence systému', (box) => {
      const l = x.licenses;
      if (!l) { box.append(el('div', { class: 'note-box info' }, 'Údaje o licencích zatím chybí – počkejte na další inventuru agenta (verze 1.1.0 a novější).')); return; }
      box.append(
        el('div', { class: 'card' }, el('h3', null, 'Licenční klíč uložený v BIOSu'), kv([
          ['Klíč', admin ? l.oem_key : (l.windows_text ? '(zobrazuje jen administrátor)' : '')], ['Popis', l.oem_description], ['Windows', l.windows_text]])),
        section('Aktivované produkty (Windows, Office)', simpleTable(['Druh', 'Název', 'Stav', 'Poslední znaky klíče', 'Kanál', 'KMS server'],
          (l.products || []).map((p) => {
            // předplatné Microsoft 365 je vázané na uživatele: stav podle přihlášeného účtu v Office, ne podle licenční služby PC
            const sub = p.kind === 'Office' && /O365|Microsoft ?365|Subscription/i.test((p.name || '') + ' ' + (p.description || ''));
            if (!sub) return [p.kind, p.name, el('span', { class: 'badge ' + (p.status_code === 1 ? 'ok' : 'warn') }, p.status), p.partial_key, p.channel, p.kms_server];
            const act = (l.office_accounts || []).filter((a) => !a.signed_out);
            let badge;
            if (act.length) badge = el('span', { class: 'badge ok', title: act.map((a) => a.email).join(', ') }, 'aktivováno uživatelem');
            else if (p.status_code === 1) badge = el('span', { class: 'badge ok' }, p.status);
            else if (l.office_accounts) badge = el('span', { class: 'badge warn', title: 'V Office na tomto počítači není přihlášen žádný účet; předplatné se aktivuje přihlášením uživatele.' }, 'nikdo není přihlášen');
            else badge = el('span', { class: 'badge warn', title: 'Předplatné je vázané na uživatele; údaj o přihlášených účtech dodá agent 2.4.0 a novější.' }, p.status);
            return ['Office (předplatné na uživatele)', p.name, el('span', null, badge, act.length ? el('div', { class: 'small muted' }, act.map((a) => a.email).join(', ')) : null),
              p.partial_key, 'Předplatné', ''];
          }),
          'Žádný aktivovaný produkt nebyl nalezen')),
        l.office_accounts && l.office_accounts.length ? section('Office: účty přihlášené na tomto počítači', simpleTable(['Účet', 'Profil Windows', 'Stav'],
          l.office_accounts.map((a) => [a.email, a.profile, el('span', { class: 'badge ' + (a.signed_out ? '' : 'ok') }, a.signed_out ? 'odhlášen' : 'přihlášen')]))) : null);
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
      section('Právě připojená úložiště', simpleTable(['Zařízení', 'Název svazku', 'Jednotka', 'Velikost', 'Obsazeno', 'Šifrováno', 'Sériové číslo', 'Od', 'Zdroj'],
        d.usb_current.map((u) => [u.name, u.label, u.drive, gb(u.size_gb), gb(u.used_gb), u.encrypted, u.serial, fmtDate(u.connected_at), u.source]), 'Nic připojeno')),
      section('Historie', simpleTable(['Čas', 'Událost', 'Zařízení', 'Název svazku', 'Změna obsazení', 'Sériové číslo', 'Uživatel'],
        d.usb_events.map((u) => [fmtDate(u.ts), el('span', { class: 'badge ' + (ACTION_BADGE[u.action] || '') }, u.action), u.name, u.label,
          u.delta_mb == null ? '' : (u.delta_mb > 0 ? '+' : '') + String(u.delta_mb).replace('.', ',') + ' MB', u.serial, u.logged_user]), 'Zatím žádné události')))],
    admin && (d.agent_version || d.last_inventory) ? ['agent', 'Agent', (box) => agentTab(box, d, id)] : null,
    ['hist', 'Změny softwaru', (box) => box.append(simpleTable(['Čas', 'Událost', 'Software', 'Verze'],
      d.sw_changes.map((c) => [fmtDate(c.ts), el('span', { class: 'badge ' + (ACTION_BADGE[c.action] || '') }, c.action), c.name, c.version]),
      'Zatím žádné změny'))],
  ].filter(Boolean), (() => { const t = S.nextTab; S.nextTab = null; return t || undefined; })());
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
  t = evidencePage(main, { entity: 'licenses', sort: 'product',
    tabs: [{ label: 'Vše', filters: [] }, { label: 'Překročené', filters: [{ col: 'free', op: 'lt', value: '0' }] }],
    flags: [{ key: 'nopat', label: 'Bez vzoru názvu SW', filter: { col: 'match_pattern', op: 'empty', value: '' } },
      { key: 'unassigned', label: 'Nepřiděleno', filter: { col: 'assigned_to', op: 'empty', value: '' } }],
    table: { onRow: (r) => licenseDialog(r._id, reload).catch(fail), bulk: [bulkDelete('licenses', 'licencí')],
      emptyText: 'Zatím žádné licence – přidejte je ručně nebo importujte z CSV',
      buttons: [el('button', { onclick: () => licenseImport(reload) }, 'Import CSV'),
        el('button', { class: 'primary', onclick: () => licenseDialog(null, reload).catch(fail) }, 'Přidat licenci')] } });
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

// --------------------------------------------------------------- Security
const SEC_SHORT = { bitlocker: 'Šifr.', antivirus: 'AV', firewall: 'FW', secureboot: 'SB', tpm: 'TPM', uac: 'UAC', rdp: 'RDP', os: 'OS', updates: 'Akt.', restart: 'Rest.', disk: 'Disk', agent: 'Agent' };
const SEC_RANK = { err: 3, warn: 2, exc: 1, ok: 1, info: 0, none: 0 };
function secText(key, c) {
  if (c.st === 'exc') return S.lang === 'en' ? 'OK-E' : 'OK-V';
  if (key === 'updates' && c.days != null) return fmtAge(c.days);
  return c.text || '';
}
function secTitle(label, key, c) {
  const parts = [T(label)];
  if (key === 'updates' && c.days != null) parts.push(fmtAgeFull(c.days));
  else if (c.text) parts.push(T(c.text));
  if (c.hint) parts.push(T(c.hint));
  if (c.st === 'exc') {
    parts.push(T('Výjimka') + ': ' + (c.note || '–') + (c.by ? ' (' + c.by + (c.ts ? ', ' + String(c.ts).slice(0, 10) : '') + ')' : ''));
  }
  return parts.join(' · ');
}
function secCell(key, label, c) {
  return el('span', { class: 'sec-cell ' + c.st, title: secTitle(label, key, c) }, el('span', { class: 't' }, secText(key, c) || '—'));
}
const secCountText = (err, warn) => {
  const en = S.lang === 'en';
  const e = en ? (err === 1 ? 'error' : 'errors') : (err === 1 ? 'chyba' : (err >= 2 && err <= 4 ? 'chyby' : 'chyb'));
  const w = en ? (warn === 1 ? 'warning' : 'warnings') : 'varování';
  return [err ? err + ' ' + e : '', warn ? warn + ' ' + w : ''].filter(Boolean).join(' · ');
};
const secSev = (lv) => (S.lang === 'en' ? (lv === 'err' ? 'Error' : 'Warning') : (lv === 'err' ? 'Chyba' : 'Varování'));

// karta "Stav zabezpeceni" u PC: udaje zjistene agentem; u zasadnich radku je stav kontroly (OK / varovani / chyba) a vyjimka
function securityStateCard(d, s, reload) {
  const ev = d.security_eval;
  const x = d.details || {};
  const rm = x.remote || {};
  const labels = { bitlocker: 'Šifrování disku (BitLocker)', antivirus: 'Antivirus', firewall: 'Firewall', updates: 'Aktualizace Windows',
    os: 'Podpora operačního systému', rdp: 'Vzdálená plocha (RDP)', disk: 'Disk (S.M.A.R.T.)', agent: 'Spojení s agentem',
    secureboot: 'Secure Boot', tpm: 'TPM', uac: 'Řízení uživatelských účtů (UAC)', restart: 'Čeká na restart' };
  const cs = ev ? Object.entries(ev.checks) : [];
  const err = cs.filter(([, c]) => c.st === 'err').length, warn = cs.filter(([, c]) => c.st === 'warn').length;
  const admin = isAdmin();
  const setExc = (key) => {
    const note = el('input', { placeholder: 'Důvod výjimky (např. schváleno vedením)' });
    modal('Výjimka: ' + labels[key], el('div', null, el('p', null, 'Kontrola se označí jako výjimka (OK-V) a nebude se počítat jako problém. Výjimku můžete kdykoli zrušit.'),
      field('Poznámka', note)),
    [{ label: 'Zrušit' }, { label: 'Uložit výjimku', primary: true, onclick: async () => {
      await api('PUT', '/api/security/exception', { device_id: d.id, check: key, note: note.value }); reload();
    } }]);
  };
  const delExc = async (key) => { await api('DELETE', '/api/security/exception?device_id=' + d.id + '&check=' + key); reload(); };
  const yn = (v) => (v == null || v === '' ? '' : el('span', { class: 'badge ' + (v === true || v === 'ano' || v === 'zapnuto' ? 'ok' : 'warn') }, v === true ? 'ano' : v === false ? 'ne' : v));
  const sv = s || {};
  const bl = (sv.bitlocker || []).map((v) => v.drive + ' ' + (v.protected ? 'chráněno' : 'nechráněno')).join(', ');
  const av = (sv.antivirus || []).map((a) => a.name + (a.enabled ? '' : ' (vypnuto)') + (a.up_to_date ? '' : ' (zastaralé definice)')).join(', ');
  const df = sv.defender ? 'Defender ' + (sv.defender.enabled ? 'zapnut' : 'vypnut') + (sv.defender.realtime ? ', ochrana v reálném čase' : '') +
    (sv.defender.signatures ? ', definice ' + sv.defender.signatures : '') : '';
  const fw = sv.firewall || {};
  // RDP podle skutecneho stavu (agent 2.4.1+); u starsiho agenta jen neovereno
  let rdpText = '';
  if (rm.rdp_listening != null && rm.rdp_port != null) {
    const nla = sv.rdp_nla != null ? sv.rdp_nla : rm.rdp_nla;
    rdpText = !rm.rdp_listening ? 'vypnuta (na portu ' + rm.rdp_port + ' se neposlouchá)'
      : 'zapnuta' + (rm.rdp_fw === false ? ', ale firewall ji blokuje' : (nla ? ' (s ověřením NLA)' : ' (bez NLA)')) + ', port ' + rm.rdp_port;
  } else rdpText = 'neověřeno (skutečný stav zjistí agent 2.4.1 nebo novější)';
  const rows = [
    ['BitLocker', bl || (s ? 'nezjištěno' : ''), 'bitlocker'], ['Antivirus', av || sv.antivirus_text || '', 'antivirus'], ['Windows Defender', df],
    ['Firewall – doména', fw.domain == null ? '' : yn(fw.domain), 'firewall'], ['Firewall – soukromá síť', fw.private == null ? '' : yn(fw.private)],
    ['Firewall – veřejná síť', fw.public == null ? '' : yn(fw.public)],
    ['Secure Boot', yn(sv.secure_boot_text), 'secureboot'], ['TPM', sv.tpm_text, 'tpm'], ['Řízení uživatelských účtů (UAC)', sv.uac == null ? '' : yn(sv.uac), 'uac'],
    ['Vzdálená plocha (RDP)', rdpText, 'rdp'],
    ['Podpora operačního systému', (x.os && x.os.name) || d.os_name || '', 'os'],
    ['Poslední aktualizace Windows', sv.last_hotfix, 'updates'], ['Poslední úspěšná instalace', sv.last_update_success],
    ['Počet nainstalovaných oprav', sv.hotfix_count], ['Čeká na restart', sv.pending_reboot_text, 'restart'],
    ['Stav disků', sv.disk_health_text, 'disk'], ['Předpověď selhání disku (S.M.A.R.T.)', sv.disk_failure_predicted ? 'ano – hrozí selhání' : ''],
    ['Spojení s agentem', ev && ev.checks.agent ? ev.checks.agent.text : '', 'agent']];
  const stat = (key) => {
    const c = ev && ev.checks[key];
    if (!c || c.st === 'none') return null;
    const word = c.st === 'err' ? (S.lang === 'en' ? 'error' : 'chyba') : c.st === 'warn' ? (S.lang === 'en' ? 'warning' : 'varování') : c.st === 'exc' ? (S.lang === 'en' ? 'OK-E' : 'OK-V') : c.st === 'info' ? 'info' : 'OK';
    return el('span', { class: 'badge ' + (c.st === 'err' ? 'bad' : c.st === 'warn' ? 'warn' : c.st === 'info' ? '' : 'ok'), title: secTitle(labels[key], key, c) }, word);
  };
  return el('div', { class: 'card' }, el('div', { class: 'row' }, el('h3', null, 'Stav zabezpečení'),
    el('span', { class: 'right' }, err ? el('span', { class: 'badge bad' }, secCountText(err, 0)) : null,
      warn ? el('span', { class: 'badge warn' }, secCountText(0, warn)) : null,
      ev && !err && !warn ? el('span', { class: 'badge ok' }, 'v pořádku') : null)),
  el('div', { class: 'sec-checks' }, rows.filter((r) => r[1] != null && r[1] !== '').map(([label, val, key]) => {
    const c = key && ev ? ev.checks[key] : null;
    return el('div', { class: 'sec-line st' },
      el('span', { class: 'sec-name muted' }, label),
      el('span', { class: 'sec-val2' }, val, c && c.hint && c.st !== 'exc' ? el('div', { class: 'small muted' }, c.hint) : null,
        c && c.st === 'exc' ? el('div', { class: 'small muted' }, T('Výjimka') + ': ' + (c.note || '–')) : null),
      el('span', { class: 'sec-stat' }, key ? stat(key) : null),
      admin && c ? el('span', { class: 'sec-act' }, c.st === 'exc'
        ? el('button', { class: 'ghost', onclick: () => delExc(key) }, 'Zrušit výjimku')
        : (c.st === 'err' || c.st === 'warn' ? el('button', { class: 'ghost', onclick: () => setExc(key) }, 'Výjimka') : null)) : el('span'));
  })));
}

PAGES.security = async (main, parts, params) => {
  pageHead(main, 'Security', 'Zásadní bezpečnostní kontroly počítačů a serverů');
  const [data, grp] = await Promise.all([api('GET', '/api/security'), api('GET', '/api/groups').catch(() => ({ groups: [] }))]);
  const checks = data.checks;
  const flt = { f: params.get('f') || 'all', t: params.get('t') || '', c: params.get('c') || '', g: params.get('g') || '', q: params.get('q') || '',
    sort: params.get('s') || '', dir: params.get('d') === 'asc' ? 1 : -1 };
  let show;
  let tabKey = parts[0] === 'matice' ? 'matice' : 'prehled';
  const sync = () => {
    const qs = new URLSearchParams();
    for (const [k, v] of [['f', flt.f === 'all' ? '' : flt.f], ['t', flt.t], ['c', flt.c], ['g', flt.g], ['q', flt.q], ['s', flt.sort], ['d', flt.sort && flt.dir === 1 ? 'asc' : '']]) if (v) qs.set(k, v);
    history.replaceState(null, '', '#/security/' + tabKey + (qs.toString() ? '?' + qs.toString() : ''));
  };
  const open = (r) => { S.nextTab = 'sec'; location.hash = '#/zarizeni/' + r.id; };
  const label = (k) => (checks.find((c) => c.key === k) || {}).label || k;
  const chip = (text, on, fn, count) => el('button', { class: 'flag' + (on ? ' on' : ''), onclick: fn }, text, count != null ? el('span', { class: 'count' }, ' ' + count) : null);

  // --- Prehled
  const overviewTab = (box) => {
    tabKey = 'prehled'; sync();
    const t = data.total || 0;
    const w = (n) => (t ? (100 * n / t).toFixed(1) : 0) + '%';
    let mode = 'all';
    const list = el('div', { class: 'sec-list' });
    const bad = data.rows.filter((r) => r.level === 'err' || r.level === 'warn');
    const draw = () => {
      const rows = bad.filter((r) => mode === 'all' || (mode === 'err' && r.level === 'err') || (mode === 'srv' && r.section === 'Servery') || (mode === 'pc' && r.section === 'Počítače'));
      list.replaceChildren(rows.length ? rows.map((r) => el('div', { class: 'sec-row ' + r.level, onclick: () => open(r) },
        el('div', { class: 'sec-who' }, el('strong', null, r.name), el('div', { class: 'small muted' }, [r.user, r.os].filter(Boolean).join(' · '))),
        el('div', { class: 'sec-pills' }, checks.filter((c) => ['err', 'warn'].includes(r.checks[c.key].st)).map((c) => el('span', { class: 'sec-pill ' + r.checks[c.key].st, title: secTitle(c.label, c.key, r.checks[c.key]) },
          T(c.label) + ': ' + T(secText(c.key, r.checks[c.key]) || '—')))),
        el('div', { class: 'sec-sev' }, el('span', { class: 'dot ' + (r.level === 'err' ? 'bad' : 'warn') }), secSev(r.level))))
        : el('div', { class: 'muted pad' }, t ? 'Žádný problém – všechna zařízení jsou v pořádku' : 'Zatím nejsou žádná zařízení'));
    };
    const chips = el('div', { class: 'quick' });
    const drawChips = () => chips.replaceChildren(chip('Vše problémové', mode === 'all', () => { mode = 'all'; drawChips(); draw(); }, bad.length),
      chip('Jen chyby', mode === 'err', () => { mode = 'err'; drawChips(); draw(); }, data.err),
      chip('Stanice', mode === 'pc', () => { mode = 'pc'; drawChips(); draw(); }),
      chip('Servery', mode === 'srv', () => { mode = 'srv'; drawChips(); draw(); }));
    drawChips(); draw();
    box.append(el('div', { class: 'sec-top' },
      el('div', { class: 'card sec-score' }, el('div', { class: 'muted' }, 'V pořádku'),
        el('div', { class: 'sec-big' }, String(data.ok), el('span', { class: 'muted' }, ' ' + (S.lang === 'en' ? 'of' : 'z') + ' ' + t)),
        el('div', { class: 'sec-bar' }, el('i', { class: 'ok', style: 'width:' + w(data.ok) }), el('i', { class: 'warn', style: 'width:' + w(data.warn) }), el('i', { class: 'err', style: 'width:' + w(data.err) })),
        el('div', { class: 'small muted' }, secCountText(data.err, data.warn) || 'bez problémů')),
      el('div', { class: 'sec-cards' }, checks.map((c) => {
        const s = data.summary[c.key], n = s.err + s.warn;
        return el('button', { class: 'sec-card ' + (s.err ? 'err' : (s.warn ? 'warn' : 'ok')), onclick: () => { flt.c = c.key; flt.f = 'all'; show('matice'); },
          title: 'Zobrazit v matici' },
        el('span', { class: 'small muted' }, c.label), el('span', { class: 'sec-num' }, String(n)),
        el('span', { class: 'small' }, secCountText(s.err, s.warn) || 'v pořádku'), s.exc ? el('span', { class: 'small muted' }, T('výjimky') + ': ' + s.exc) : null);
      }))),
    el('h3', { class: 'sec-h' }, 'Co je špatně'), chips, list);
  };

  // --- Matice
  const matrixTab = (box) => {
    tabKey = 'matice'; sync();
    const q = el('input', { type: 'search', placeholder: 'Hledat zařízení nebo uživatele…', 'aria-label': 'Hledat zařízení', value: flt.q });
    const bar = el('div', { class: 'quick' });
    const holder = el('div', { class: 'sec-matrix card' });
    const groupSel = el('select', { 'aria-label': 'Skupina', onchange: () => { flt.g = groupSel.value; draw(); } },
      el('option', { value: '' }, 'Skupina: všechny'), (grp.groups || []).map((g) => el('option', { value: String(g.id), selected: String(g.id) === flt.g }, g.name)));
    const filtered = () => {
      const needle = flt.q.toLowerCase();
      let rows = data.rows.filter((r) => (flt.f === 'all' || (flt.f === 'bad' && (r.level === 'err' || r.level === 'warn')) || (flt.f === 'err' && r.level === 'err'))
        && (!flt.t || r.section === flt.t) && (!flt.g || r.groups.includes(Number(flt.g)))
        && (!needle || (r.name + ' ' + r.user + ' ' + r.ip + ' ' + r.os).toLowerCase().includes(needle))
        && (!flt.c || ['err', 'warn'].includes(r.checks[flt.c].st)));
      if (flt.sort === 'name') rows = rows.slice().sort((a, b) => flt.dir * a.name.localeCompare(b.name, S.lang));
      else if (flt.sort) rows = rows.slice().sort((a, b) => flt.dir * (SEC_RANK[a.checks[flt.sort].st] - SEC_RANK[b.checks[flt.sort].st]) || a.name.localeCompare(b.name));
      return rows;
    };
    const exportCsv = () => {
      const safe = (v) => { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      const head = [T('Zařízení'), T('Uživatel'), T('Typ'), ...checks.map((c) => T(c.label))];
      const lines = [head.map(safe).join(';')].concat(filtered().map((r) => [r.name, r.user, r.section, ...checks.map((c) => {
        const x = r.checks[c.key]; return secText(c.key, x) + (x.st === 'exc' ? '' : (x.st === 'err' ? ' [!]' : (x.st === 'warn' ? ' [?]' : '')));
      })].map(safe).join(';')));
      const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: 'security.csv' });
      document.body.append(a); a.click(); a.remove();
    };
    const sortBy = (k) => { if (flt.sort === k) flt.dir = -flt.dir; else { flt.sort = k; flt.dir = k === 'name' ? 1 : -1; } draw(); };
    const draw = () => {
      sync();
      const rows = filtered();
      const nBad = data.rows.filter((r) => r.level === 'err' || r.level === 'warn').length;
      bar.replaceChildren(chip('Vše', flt.f === 'all', () => { flt.f = 'all'; draw(); }, data.total),
        chip('Problémové', flt.f === 'bad', () => { flt.f = 'bad'; draw(); }, nBad), chip('Jen chyby', flt.f === 'err', () => { flt.f = 'err'; draw(); }, data.err),
        chip('Stanice', flt.t === 'Počítače', () => { flt.t = flt.t === 'Počítače' ? '' : 'Počítače'; draw(); }),
        chip('Servery', flt.t === 'Servery', () => { flt.t = flt.t === 'Servery' ? '' : 'Servery'; draw(); }),
        grp.groups && grp.groups.length ? groupSel : null,
        flt.c ? el('button', { class: 'flag on', onclick: () => { flt.c = ''; draw(); } }, T('Kontrola') + ': ' + T(label(flt.c)) + ' ×') : null,
        el('span', { class: 'muted small' }, T('Zobrazeno') + ' ' + rows.length + ' ' + (S.lang === 'en' ? 'of' : 'z') + ' ' + data.total));
      const head = (k, text, short) => el('th', { class: 'sortable' + (flt.sort === k ? ' sorted' : ''), onclick: () => sortBy(k), title: text },
        el('span', { class: 'full' }, text), el('span', { class: 'short' }, short || text), flt.sort === k ? (flt.dir === 1 ? ' ▲' : ' ▼') : '');
      const table = el('table', { class: 'sec-table' },
        el('thead', null, el('tr', null, head('name', 'Zařízení'), checks.map((c) => head(c.key, c.label, SEC_SHORT[c.key])))),
        el('tbody', null, rows.map((r) => el('tr', { class: 'clickable', onclick: () => open(r) },
          el('td', { class: 'sec-dev' }, el('div', null, r.name), el('div', { class: 'small muted' }, r.user)),
          checks.map((c) => el('td', null, secCell(c.key, c.label, r.checks[c.key])))))),
        el('tfoot', null, el('tr', null, el('td', null, 'Problémů'), checks.map((c) => {
          const n = rows.filter((r) => ['err', 'warn'].includes(r.checks[c.key].st)).length;
          const e = rows.filter((r) => r.checks[c.key].st === 'err').length;
          return el('td', null, el('span', { class: 'sec-cell ' + (e ? 'err' : (n ? 'warn' : 'ok')) + ' clickable', title: 'Zobrazit jen problémová zařízení',
            onclick: () => { flt.c = flt.c === c.key ? '' : c.key; draw(); } }, el('span', null, String(n))));
        }))));
      holder.replaceChildren(rows.length ? table : el('div', { class: 'muted pad' }, 'Žádné zařízení neodpovídá filtru'),
        el('div', { class: 'sec-legend small muted' }, el('span', { class: 'sec-cell ok' }, 'v pořádku'), el('span', { class: 'sec-cell warn' }, 'varování'),
          el('span', { class: 'sec-cell err' }, 'chyba'), el('span', { class: 'sec-cell info' }, 'informace'), el('span', { class: 'sec-cell none' }, 'nezjištěno'),
          el('span', { class: 'sec-cell exc' }, S.lang === 'en' ? 'OK-E exception' : 'OK-V výjimka')));
    };
    q.addEventListener('input', () => { flt.q = q.value; draw(); });
    box.append(el('div', { class: 'toolbar' }, q, el('button', { onclick: exportCsv }, 'Export CSV')), bar, holder);
    draw();
  };
  show = tabbed(main, [['prehled', 'Přehled', overviewTab], ['matice', 'Matice', matrixTab]], tabKey);
};

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

async function compareDialog(sn) {
  const r = await api('GET', '/api/snapshots/' + sn.id + '/compare');
  const dev = (d) => [d.name, d.ip, d.mac, d.device_type];
  const diffText = (d) => (d.added_n != null
    ? d.field + ': ' + (d.added_n ? '+' + d.added_n + ' (' + d.added.slice(0, 5).join(', ') + (d.added_n > 5 ? ', …' : '') + ') ' : '') +
      (d.removed_n ? '−' + d.removed_n + ' (' + d.removed.slice(0, 5).join(', ') + (d.removed_n > 5 ? ', …' : '') + ')' : '')
    : d.field + ': ' + (d.old || '–') + ' → ' + (d.new || '–'));
  const body = el('div', null,
    el('p', { class: 'muted' }, 'Snímek z ' + fmtDate(r.snapshot.taken_at) + ' (' + r.snapshot.device_count + ' zařízení) × současný stav (' + r.now_count + ' zařízení)'),
    el('h3', null, 'Nová zařízení (' + r.added.length + ')'),
    simpleTable(['Název', 'IP', 'MAC', 'Typ'], r.added.map(dev), 'Žádná nová zařízení'),
    el('h3', { style: 'margin-top:14px' }, 'Zmizelá zařízení (' + r.removed.length + ')'),
    simpleTable(['Název', 'IP', 'MAC', 'Typ'], r.removed.map(dev), 'Nic nezmizelo'),
    el('h3', { style: 'margin-top:14px' }, 'Změněná zařízení (' + r.changed.length + ')'),
    simpleTable(['Zařízení', 'Změny'], r.changed.map((c) => [el('a', { href: '#/zarizeni/' + c.device_id, onclick: () => document.querySelector('.overlay') && document.querySelector('.overlay').remove() }, c.name),
      el('div', null, c.diffs.map((d) => el('div', { class: 'small' }, diffText(d))))]), 'Beze změn'));
  modal('Porovnání se snímkem', body, [{ label: 'Zavřít', primary: true }], true);
}

PAGES.skenovani = async (main) => {
  const [cfg, jobs] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/jobs')]);
  pageHead(main, 'Skenování', 'Zjišťování zařízení v doméně a v síti');
  const running = new Set(jobs.filter((j) => j.status === 'running').map((j) => j.kind));
  const snaps = (await api('GET', '/api/snapshots')).snapshots;
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
    el('div', { class: 'card' }, el('h2', null, 'Čistý sken'),
      el('p', { class: 'muted' }, 'Uloží snímek současného stavu a zálohu databáze, smaže údaje nalezené jen skenem a prohledá rozsah znovu. Data z agentů, ruční údaje, skupiny a sekce zůstanou. Výsledek pak porovnáte se snímkem níže.'),
      el('div', { class: 'row' }, el('button', { class: 'primary right', disabled: running.has('clean_scan'), onclick: async (e) => {
        if (!(await confirmBox('Spustit čistý sken? Nejdřív se uloží snímek a záloha databáze. Poté se smažou zařízení nalezená jen skenem (bez agenta, ručních údajů, skupiny a SW) a rozsah ' + (cfg.scan_ranges || '') + ' se prohledá znovu.', 'Spustit čistý sken'))) return;
        e.target.disabled = true;
        try { await api('POST', '/api/jobs/clean_scan/run'); toast('Čistý sken spuštěn', 'ok'); setTimeout(route, 600); } catch (ex) { fail(ex); e.target.disabled = false; }
      } }, running.has('clean_scan') ? 'Běží…' : 'Spustit čistý sken'))),
    card('winrm', 'Inventura přes WinRM', 'Bez předchozí instalace spustí inventuru (nebo instalaci agenta) na počítačích s Windows, které ji dlouho neposlaly.', cfg.winrm_enabled === '1', cfg.winrm_interval_min)));
  main.append(el('h2', null, 'Snímky stavu a porovnání'),
    el('p', { class: 'muted' }, 'Snímek uchová zařízení, jejich IP, MAC, typ, software, USB a monitory. Porovnání ukáže nová, zmizelá a změněná zařízení oproti současnému stavu.'),
    el('div', { class: 'row', style: 'margin-bottom:10px' }, el('button', { onclick: async () => {
      await api('POST', '/api/snapshots', { label: 'Ruční snímek' }); toast('Snímek uložen', 'ok'); route();
    } }, 'Vytvořit snímek teď')),
    simpleTable(['Pořízen', 'Popis', 'Zařízení', ''], snaps.map((sn) => [fmtDate(sn.taken_at), sn.label || sn.kind, String(sn.device_count),
      el('div', { class: 'row' }, el('button', { class: 'mini', onclick: () => compareDialog(sn).catch(fail) }, 'Porovnat se současností'),
        el('button', { class: 'mini danger', onclick: async () => {
          if (!(await confirmBox('Smazat snímek z ' + fmtDate(sn.taken_at) + '?', 'Smazat'))) return;
          await api('DELETE', '/api/snapshots/' + sn.id); route();
        } }, 'Smazat'))]), 'Zatím žádný snímek – vznikne při čistém skenu nebo tlačítkem výše'));
  main.append(el('h2', null, 'Historie úloh'), simpleTable(['Spuštěno', 'Úloha', 'Stav', 'Výsledek', 'Dokončeno'], jobs.map((j) => [
    fmtDate(j.started), j.label, el('span', { class: 'badge ' + (j.status === 'ok' ? 'ok' : (j.status === 'chyba' ? 'bad' : 'warn')) }, j.status === 'running' ? 'běží' : j.status),
    j.summary, fmtDate(j.finished)]), 'Zatím neproběhla žádná úloha'));
  S.live = (ev) => { if (ev.type === 'job') route(); };
};

// kontrola spojeni agentu se serverem (adresa, port, HTTPS, certifikat)
function connectionCard(c) {
  if (!c) return null;
  const cert = c.cert || {};
  const kv = (pairs) => el('dl', { class: 'kv' }, pairs.filter((p) => p[1] != null && p[1] !== '').map(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
  return el('div', { class: 'card' }, el('h2', null, 'Spojení agentů se serverem'),
    kv([['Adresa pro agenty', (c.scheme || '') + '://' + (c.host || '')], ['Port', c.port], ['HTTPS', c.https ? 'ano' : 'ne'],
      ['Otisk certifikátu (SHA-1)', c.thumbprint], ['Certifikát platí do', cert.not_after ? cert.not_after + (cert.days_left != null ? ' (zbývá ' + cert.days_left + ' dní)' : '') : ''],
      ['Jména v certifikátu', (cert.names || []).join(', ')]]),
    ...(c.warnings || []).map((w) => el('div', { class: 'note-box' }, w)),
    (c.warnings || []).length ? null : el('div', { class: 'hint' }, 'Bez výhrad.'),
    c.thumb_changed && isAdmin() ? el('div', { class: 'row' }, el('button', { onclick: async () => {
      if (!(await confirmBox('Potvrdit aktuální otisk certifikátu jako známý? Agenti s původním otiskem se nepřipojí, dokud se neaktualizují.', 'Potvrdit'))) return;
      await api('POST', '/api/agent-info/confirm-thumb'); route();
    } }, 'Potvrdit nový otisk')) : null,
    el('div', { class: 'hint' }, 'Certifikát je uložen ve složce /data/tls. Zálohujte ji spolu s databází – po jejím ztrátě se vytvoří nový certifikát a existující agenti se přestanou připojovat. ',
      'Po změně tokenu, adresy nebo certifikátu aktualizujte příkaz v GPO.'));
}

PAGES.agent = async (main, parts, params) => {
  const wantVer = (params && params.get('verze')) || '';
  const a = await api('GET', '/api/agent-info' + (wantVer ? '?version=' + encodeURIComponent(wantVer) : ''));
  const rels = (await api('GET', '/api/agent-releases')).versions;
  pageHead(main, 'Agent pro Windows', 'Malý skript, který z počítače posílá přesný popis hardwaru, softwaru, monitorů a hlídá USB');
  const verSel = el('select', { onchange: () => { location.hash = '#/agent' + (verSel.value ? '?verze=' + encodeURIComponent(verSel.value) : ''); } },
    el('option', { value: '' }, 'cílová verze (' + a.target + ')'),
    ...rels.filter((v) => v.version !== a.target).map((v) => el('option', { value: v.version, selected: v.version === a.version }, v.version + (v.latest ? ' (nejnovější)' : ''))));
  const cmd = (text) => el('div', { class: 'cmd' }, el('pre', null, text), copyButton(text));
  const problemsHolder = el('div');
  evidencePage(problemsHolder, { entity: 'agent_problems', sort: 'last_ts', sortDir: 'desc',
    tabs: [{ label: 'Vše', filters: [] }],
    flags: [{ key: 'tok', label: 'Odmítnutý token', filter: { col: 'kind', op: 'eq', value: 'odmítnutý token' } },
      { key: 'err', label: 'Chyba agenta', filter: { col: 'kind', op: 'eq', value: 'chyba agenta' } },
      { key: 'd1', label: 'Posledních 24 h', filter: { col: 'last_ts', op: 'newer_h', value: '24' } }],
    table: { bulk: [bulkDelete('agent_problems', 'záznamů')], emptyText: 'Žádné problémy agentů' } });
  main.append(...[
    a.target !== a.latest ? el('div', { class: 'note-box' }, 'Cílová verze agentů je ', el('strong', null, a.target), ', nejnovější verze je ', el('strong', null, a.latest),
      '. Agenti zůstávají na cílové verzi, dokud v ', el('a', { href: '#/nastaveni' }, 'Nastavení'), ' nepřepnete na „Nejnovější". Novou verzi můžete nejdřív vyzkoušet na jednom PC: vyberte ji níže a použijte příkaz Test nebo Trvalá instalace; pak ji v detailu PC (záložka Agent) připněte.') : null,
    connectionCard(a.check),
    el('div', { class: 'row', style: 'margin-bottom:10px' }, el('span', null, 'Verze agenta v příkazech níže:'), verSel),
    a.server_url_set ? null : el('div', { class: 'note-box' }, 'V ', el('a', { href: '#/nastaveni' }, 'Nastavení'),
      ' není vyplněna adresa serveru. Příkazy níže používají adresu, ze které máte právě otevřený prohlížeč (', a.server_url,
      ') – ověřte, že je dostupná ze všech počítačů.'),
    el('div', { class: 'card' }, el('h2', null, 'Trvalá instalace (doporučeno)'),
      el('p', null, 'Spusťte na počítači v příkazovém řádku jako správce. Agent se uloží do C:\\ProgramData\\HWSW-Agent a poběží jako naplánovaná úloha pod účtem SYSTEM – i bez přihlášeného uživatele. Hromadně ho nasadíte přes GPO jako spouštěcí skript počítače se stejným příkazem.'),
      cmd(a.install),
      el('p', { class: 'muted' }, 'Agentů aktuálně hlásí: ', el('strong', null, a.agents), '. USB události chodí jen z počítačů s trvale nainstalovaným agentem.')),
    el('div', { class: 'card' }, el('h2', null, 'Nasazení přes GPO bez restartu'),
      el('p', null, 'Startup skript se spouští jen při skutečném startu Windows. Počítače s rychlým spuštěním (Fast Startup) ho po „vypnutí" ráno nespustí. Proto přidejte do GPO i naplánovanou úlohu:'),
      el('ol', null,
        el('li', null, 'Group Policy Management: upravte GPO připojené na OU s počítači.'),
        el('li', null, 'Computer Configuration → Preferences → Control Panel Settings → Scheduled Tasks → New → Scheduled Task (At least Windows 7).'),
        el('li', null, 'General: Action = Update, User account = NT AUTHORITY\\System, zaškrtněte Run with highest privileges.'),
        el('li', null, 'Triggers: At startup, a Daily (např. v 12:00). Příkaz je bezpečné spouštět opakovaně.'),
        el('li', null, 'Actions: Start a program → Program = powershell.exe, Arguments = příkaz Trvalé instalace výše bez úvodního „powershell".'),
        el('li', null, 'Settings: Run task as soon as possible after a scheduled start is missed.'),
        el('li', null, 'Volitelně: Computer Configuration → Administrative Templates → System → Logon → Always wait for the network at computer startup and logon = Enabled.')),
      el('p', { class: 'muted' }, 'Agenti se pak sami udržují aktuální (do 5 minut od vydání nové verze), restart není potřeba.')),
    el('div', { class: 'card' }, el('h2', null, 'Sledování souborů na USB (GPO audit)'),
      el('p', null, 'Soubory zapsané NA USB agent zachytí sám. Soubory zkopírované Z USB na počítač zjistí jen z auditu Windows, který se zapíná v GPO. Bez něj se směr „z USB“ nezaznamenává.'),
      el('ol', null,
        el('li', null, 'Group Policy Management: upravte GPO připojené na OU s počítači (stejné jako u agenta).'),
        el('li', null, 'Computer Configuration → Policies → Windows Settings → Security Settings → Advanced Audit Policy Configuration → Audit Policies → Object Access.'),
        el('li', null, 'Otevřete Audit Removable Storage (v české Windows „Auditovat vyměnitelné úložiště“, název se může lišit), zaškrtněte Configure the following audit events a Success.'),
        el('li', null, 'Doporučeno: Computer Configuration → … → Security Settings → Local Policies → Security Options → Audit: Force audit policy subcategory settings = Enabled.'),
        el('li', null, 'Zvyšte velikost Security logu (Event Log → Security → Maximum log size, např. 256 MB), aby se události nepřepisovaly.'),
        el('li', null, 'V Nastavení → Agent zapněte „Sledování souborů“ a „Sledovat i soubory čtené Z USB“. Na PC pak vyvolejte gpupdate /force (nebo počkejte na obnovení GPO).')),
      el('p', { class: 'muted' }, 'Kontrola: na PC spusťte auditpol /get /category:"Object Access" – u Removable Storage musí být Success. U zařízení → záložka Agent uvidíte „Čtení z USB (audit Windows): zapnuto“ a počet zachycených událostí. Před zapnutím zajistěte směrnici o monitoringu (§ 316 zákoníku práce).')),
    el('div', { class: 'card' }, el('h2', null, 'Vzdálený PowerShell (WinRM) přes GPO'),
      el('p', null, 'Nepotřebujete ho pro HWSW (agent běží na každém PC sám). Hodí se správci: příkaz na dálku bez rušení uživatele, třeba Invoke-Command -ComputerName PC01 -ScriptBlock { ... }. Zapněte ho jen, když ho budete používat, a jen pro správce a vaši síť.'),
      el('ol', null,
        el('li', null, 'Group Policy Management: upravte GPO pro OU s počítači (nebo vytvořte samostatné).'),
        el('li', null, 'Computer Configuration → Policies → Administrative Templates → Windows Components → Windows Remote Management (WinRM) → WinRM Service → Allow remote server management through WinRM = Enabled; do IPv4 filter zadejte jen rozsah vaší sítě (např. 192.168.10.0/24).'),
        el('li', null, 'Computer Configuration → Policies → Windows Settings → Security Settings → System Services → Windows Remote Management (WS-Management) → Startup Mode = Automatic.'),
        el('li', null, 'Computer Configuration → Policies → Windows Settings → Security Settings → Windows Defender Firewall with Advanced Security → Inbound Rules → New Rule → Predefined: Windows Remote Management; omezte Scope na adresu vašeho PC a profil Domain.'),
        el('li', null, 'Na PC vyvolejte gpupdate /force. Kontrola z vašeho PC: Test-WSMan PC01. Port 5985 pak bude v seznamu naslouchajících portů a v Zařízeních u sloupce „Vzdálený PowerShell (WinRM)“.')),
      el('p', { class: 'muted' }, 'Do WinRM se může přihlásit jen správce. Jiná práva než u RDP nepotřebujete. Zapnutí se v HWSW nijak nemění – aplikace jen zobrazuje stav.')),
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
    el('div', { class: 'card' }, el('h2', null, 'Agent – problémy'),
      el('p', { class: 'muted' }, 'Odmítnuté požadavky agentů (špatný token, chybná data) a chyby, které agenti sami nahlásili. Počítač, který se k serveru vůbec nedostal, tady není – ten poznáte podle stavu „nikdy" v Zařízení.'),
      problemsHolder),
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
  const save = async () => { try { await api('PUT', '/api/settings', values()); if (inputs.timezone && inputs.timezone.value) S.me.tz = inputs.timezone.value; toast('Nastavení uloženo', 'ok'); } catch (e) { fail(e); } };
  pageHead(main, 'Nastavení', null, el('button', { class: 'primary', onclick: save }, 'Uložit nastavení'));
  inputs.scan_ranges = el('textarea', { value: cfg.scan_ranges || '', placeholder: '192.168.1.0/24\n10.0.5.10-10.0.5.80' });
  inputs.winrm_mode = el('select', null, el('option', { value: 'once' }, 'jen odeslat inventuru (nic neinstaluje)'),
    el('option', { value: 'install', selected: cfg.winrm_mode === 'install' }, 'nainstalovat trvalého agenta (USB v reálném čase)'));
  const adResult = el('span', { class: 'small' });
  const agentVersionsBox = el('div');
  async function drawAgentVersions() {
    const r = await api('GET', '/api/agent-releases');
    const sel = el('select', null, el('option', { value: '' }, 'Nejnovější (automaticky) – ' + r.latest),
      ...r.versions.filter((v) => !v.latest).map((v) => el('option', { value: v.version, selected: r.pinned_global && r.target === v.version }, v.version + (v.legacy ? ' (starší agent)' : ''))));
    agentVersionsBox.replaceChildren(
      el('p', { class: 'muted' }, 'Všichni agenti se do 5 minut přepnou na cílovou verzi (nahoru i dolů), bez restartu. Výběr starší verze znamená návrat a zároveň zamknutí – nové verze se nerozesílají, dokud nevrátíte „Nejnovější".'),
      el('div', { class: 'row' }, el('span', null, 'Cílová verze:'), sel, el('button', { class: 'primary', onclick: async () => {
        const name = sel.value || 'nejnovější';
        if (!(await confirmBox('Nastavit cílovou verzi agentů na „' + name + '“? Všichni agenti se přepnou do 5 minut.', 'Nastavit'))) return;
        try { await api('PUT', '/api/agent-target', { version: sel.value }); toast('Cílová verze nastavena', 'ok'); drawAgentVersions(); } catch (e) { fail(e); }
      } }, 'Nasadit vybranou verzi'), el('button', { onclick: async () => {
        try { await api('PUT', '/api/agent-target', { version: '' }); toast('Cíl: nejnovější verze', 'ok'); drawAgentVersions(); } catch (e) { fail(e); }
      } }, 'Vrátit na nejnovější')),
      simpleTable(['Verze', 'Vydána', 'Poznámka', 'Počítačů', 'Připnuto k PC', ''], r.versions.map((v) => [
        el('strong', null, v.version), v.date, v.notes, String(v.devices), String(v.pinned),
        el('span', { class: 'row' }, v.latest ? el('span', { class: 'badge ok' }, 'nejnovější') : null,
          v.version === r.target ? el('span', { class: 'badge' }, 'cíl') : null, v.legacy ? el('span', { class: 'badge' }, 'starší') : null)]), 'Žádné verze'),
      r.other.length ? el('div', { class: 'hint' }, 'Další verze v evidenci: ' + r.other.map((o) => o.version + ' (' + o.devices + ')').join(', ')) : null);
  }
  drawAgentVersions().catch(fail);
  main.append(
    el('div', { class: 'card' }, el('h2', null, 'Server'),
      text('timezone', 'Časové pásmo pro zobrazení časů', 'Např. Europe/Prague. Časy se přepočítají včetně letního a zimního času.'),
      text('server_url', 'Adresa této aplikace v síti', 'Např. https://192.168.1.10:8580 – na tuto adresu posílají data agenti. Musí být dostupná ze všech počítačů.'),
      el('div', { class: 'form-grid' },
        text('offline_after_min', 'Považovat za offline po (min)', null, 'number'),
        text('agent_inventory_hours', 'Agent posílá úplnou inventuru každých (h)', null, 'number'),
        text('agent_stale_hours', 'Agent je neaktivní (žlutě), když neposlal data déle než (h)', null, 'number'),
        text('usb_events_keep_days', 'Uchovávat historii USB a změn SW (dní)', null, 'number')),
      el('div', { class: 'hint' }, 'Agenti se aktualizují sami (do 5 minut od změny), viz karta Agent níže. Agent běží pod účtem SYSTEM, proto používejte HTTPS nebo důvěryhodnou síť.')),
    el('div', { class: 'card' }, el('h2', null, 'Agent: verze a aktualizace'), agentVersionsBox, 
      el('h3', { style: 'margin-top:18px' }, 'Sledování souborů zapsaných na USB'),
      check('usb_files_enabled', 'Zapnout (agenti hlásí názvy a velikosti souborů zapsaných na USB úložiště)'),
      check('agent_store_apps', 'Software: hlásit i aplikace z Microsoft Store (WhatsApp, Teams a další; bez systémových součástí)'),
      check('usb_audit_enabled', 'Sledovat i soubory čtené Z USB (audit Windows – vyžaduje GPO, návod je na stránce Agent)'),
      el('div', { class: 'form-grid' }, text('usb_files_days', 'Uchovávat záznamy souborů (dní)', null, 'number'),
        text('agent_problems_days', 'Uchovávat problémy agentů (dní)', null, 'number'),
        text('agent_error_days', 'Chyba agenta se z varování mění na „chybu“ po (dnech opakování)', null, 'number')),
      el('div', { class: 'hint' }, 'Sledování zapisuje jména souborů zaměstnanců. Před zapnutím zajistěte vnitřní směrnici o monitoringu a informování zaměstnanců (§ 316 zákoníku práce). Výchozí stav je vypnuto.')),
    el('div', { class: 'card' }, el('h2', null, 'Security'),
      el('div', { class: 'form-grid' }, text('sec_update_warn_days', 'Aktualizace Windows: varování od (dní od poslední opravy)', null, 'number'),
        text('sec_update_err_days', 'Aktualizace Windows: chyba od (dní od poslední opravy)', null, 'number'),
        text('sec_os_warn_days', 'Podpora OS: varovat předem (dní před koncem podpory)', null, 'number'))),
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
        e.target.disabled = true; adResult.textContent = T('Zkouším…');
        try { const r = await api('POST', '/api/settings/test-ad', values()); adResult.textContent = T(r.message); adResult.className = 'small ' + (r.ok ? '' : 'muted'); }
        catch (ex) { adResult.textContent = T(ex.message); }
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
    if (ev.type === 'usb' && isAdmin() && ev.name) {
      if (ev.alert) toast('⚠ USB ' + ev.action + ': ' + ev.class + ' – ' + ev.name + '\nKdo: ' + (ev.user ? (ev.user_name ? ev.user_name + ' (' + ev.user + ')' : ev.user) : 'neznámo') + '\nKde: ' + ev.hostname + (ev.ip ? ' · ' + ev.ip : '') + (ev.location ? ' · ' + ev.location : '') + '\nKdy: ' + fmtDate(ev.ts), 'warn', true);
      else toast(ev.hostname + ': ' + ev.action + ' – ' + ev.name);
    }
    if (S.live) { try { S.live(ev); } catch (e) { /* stranka se mezitim zmenila */ } }
  };
}

async function start() {
  try { S.me = await api('GET', '/api/me'); } catch (e) { return; }
  if (S.me.lang && S.me.lang !== S.lang) setLang(S.me.lang); else setLang(S.lang);
  if (S.me.must_change) return passwordDialog(true);
  [S.schema, S.views] = await Promise.all([api('GET', '/api/schema'), api('GET', '/api/views')]);
  renderShell();
  connectEvents();
  route();
}

window.addEventListener('hashchange', route);
start();
