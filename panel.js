const $ = (s) => document.querySelector(s);

const store = {
  get(k, d) { try { const v = localStorage.getItem('tw.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tw.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const ui = {
  filter: '',
  styleSort: store.get('styleSort', 'az'),     // 'az' | 'rule'
  classSort: store.get('classSort', 'order'),  // 'order' | 'az'
  hideVars: store.get('hideVars', false),
  classesOpen: store.get('classesOpen', true),
  otherOpen: store.get('otherOpen', false),
  inactiveOpen: store.get('inactiveOpen', true),
};

document.documentElement.dataset.theme = chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked') el.checked = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// ---------- talking to the inspected page ----------
function run(op, args = []) {
  return new Promise((resolve) => {
    const expr = `(${twRun.toString()})($0, ${JSON.stringify(op)}, ${JSON.stringify(args)})`;
    chrome.devtools.inspectedWindow.eval(expr, (result, ex) => {
      if (ex) { resolve({ error: ex.value || ex.description || 'eval failed' }); return; }
      try { resolve(JSON.parse(result)); } catch { resolve({ error: 'unexpected response' }); }
    });
  });
}

let data = null, lastJson = '', seq = 0, applied = 0, visible = true;

async function act(op, args, quiet) {
  const my = ++seq;
  const r = await run(op, args);
  if (my < applied) return;
  applied = my;
  const json = JSON.stringify(r);
  if (quiet && json === lastJson) return;
  lastJson = json;
  data = r;
  render();
}
const refresh = (quiet) => act('collect', [], quiet);

// ---------- helpers ----------
const COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(.*\))$/i;
function colorOf(value) {
  if (COLOR_RE.test(value)) return value;
  const m = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  const resolved = m && data.vars[m[1]];
  return resolved && COLOR_RE.test(resolved) ? resolved : null;
}

function splitVariant(name) {
  let depth = 0, idx = -1;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) idx = i;
  }
  return idx < 0 ? ['', name] : [name.slice(0, idx + 1), name.slice(idx + 1)];
}

function valueEl(e) {
  const text = e.value + (e.important ? ' !important' : '');
  const parts = [];
  const color = colorOf(e.value);
  if (color) parts.push(h('span', { class: 'swatch', style: `background:${color}` }));
  const re = /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const resolved = data.vars[m[1]];
    parts.push(h('span', { class: 'var', title: resolved ? `${m[1]}: ${resolved}` : m[1] }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return h('span', { class: 'value' }, parts);
}

function sourceTitle(e) {
  return [e.tag, e.layer && `@layer ${e.layer}`, ...e.cond, e.sheet].filter(Boolean).join('\n');
}

// ---------- classes ----------
function renderClasses() {
  const f = ui.filter.toLowerCase();
  let list = data.classes.filter((c) => !f || c.name.toLowerCase().includes(f));
  if (ui.classSort === 'az') list = [...list].sort((a, b) => a.name.localeCompare(b.name));

  $('#classTitle').textContent = 'Classes';
  $('.twisty-head .twisty').classList.toggle('open', ui.classesOpen);
  $('#classes .section-head').classList.toggle('open', ui.classesOpen);
  $('#classBody').hidden = !ui.classesOpen;
  $('#classSort').textContent = ui.classSort === 'az' ? 'A–Z' : 'Order';

  const grid = $('#classGrid');
  // size columns for a typical class, not the longest one; outliers are ellipsized (full name on hover)
  const lens = list.map((c) => c.name.length).sort((a, b) => a - b);
  const typical = lens.length ? lens[Math.floor((lens.length - 1) * 0.7)] : 12;
  grid.style.setProperty('--col', Math.max(12, Math.min(26, typical)) + 'ch');
  grid.replaceChildren(...list.map((c) => {
    const [variant, rest] = splitVariant(c.name);
    return h('div', { class: 'cls' + (c.enabled ? '' : ' off') + (c.inactive ? ' inactive' : ''), 'data-name': c.name },
      h('label', { title: c.inactive ? `${c.name}\nNot matching right now: ${c.reason}` : c.name },
        h('input', { type: 'checkbox', checked: c.enabled, onchange: () => act('toggleClass', [c.name, !c.enabled]) }),
        h('span', { class: 'cname' }, variant && h('span', { class: 'variant' }, variant), rest)),
      h('button', { class: 'rm', title: 'Remove class', onclick: () => act('removeClass', [c.name]) }, '×'));
  }));
}

// ---------- styles ----------
const sorters = {
  az: (a, b) =>
    (a.name.startsWith('--') - b.name.startsWith('--')) ||
    a.name.localeCompare(b.name) ||
    (!!a.overridden - !!b.overridden) ||
    b.seq - a.seq,
  rule: (a, b) => (a.classIdx < 0 ? 1e6 : a.classIdx) - (b.classIdx < 0 ? 1e6 : b.classIdx) || a.seq - b.seq,
};

function renderRow(e) {
  const cls = 'prop' + (e.enabled ? '' : ' disabled') + (e.overridden ? ' overridden' : '') + (e.ghost ? ' ghost' : '');
  const src = e.label || e.tag;
  return h('div', { class: cls, 'data-src': e.inline ? null : src, title: e.inline ? null : (e.title || sourceTitle(e)) },
    !e.ghost && h('input', { type: 'checkbox', checked: e.enabled, title: e.enabled ? 'Disable for this element' : 'Enable for this element', onchange: () => act('toggleProp', [e.id, e.name, !e.enabled]) }),
    h('span', { class: 'decl' }, h('span', { class: 'name' }, e.name), ': ', valueEl(e), ';'),
    '');
}

function ruleBlock(title, entries) {
  return h('div', { class: 'rule' },
    h('div', { class: 'rule-head' }, h('span', { class: 'sel' }, title), ' {'),
    entries.map(renderRow),
    h('div', { class: 'rule-end' }, '}'));
}

function sectionHead(title, open, toggle) {
  return h('div', { class: 'section-head' + (open ? ' open' : ''), onclick: toggle },
    h('button', { class: 'twisty-head' }, h('span', { class: 'twisty' + (open ? ' open' : '') }), title));
}

function renderStyles() {
  const f = ui.filter.toLowerCase();
  const sort = sorters[ui.styleSort];
  $('#styleSort').textContent = ui.styleSort === 'az' ? 'A–Z' : 'By rule';
  const vis = (e) => (!ui.hideVars || !e.name.startsWith('--')) && (!f || `${e.name}: ${e.value} ${e.label || ''} ${e.tag}`.toLowerCase().includes(f));

  const all = data.entries.filter(vis).sort(sort);
  const inline = all.filter((e) => e.inline).sort((a, b) => a.seq - b.seq);
  const main = all.filter((e) => !e.inline && e.cls);
  const other = all.filter((e) => !e.inline && !e.cls);

  const order = new Map(data.classes.map((c, i) => [c.name, i]));
  const ghosts = (data.inactive || [])
    .flatMap((b) => b.decls.map((d, i) => ({
      id: b.id, name: d.name, value: d.value, important: d.important, enabled: true, overridden: false, ghost: true,
      tag: b.tag, label: b.classes.join(' '), title: sourceTitle(b), seq: b.seq * 1000 + i,
      classIdx: Math.min(...b.classes.map((n) => order.get(n) ?? 0)),
    })))
    .filter(vis)
    .sort(sort);

  const out = [];
  if (inline.length) out.push(ruleBlock('element.style', inline));
  out.push(main.length
    ? ruleBlock('class styles', main)
    : h('div', { class: 'empty' }, f ? 'No class styles match the filter.' : 'No styles from this element’s classes.'));

  if (ghosts.length) {
    const open = ui.inactiveOpen || !!f;
    out.push(sectionHead('Inactive class styles', open, () => { ui.inactiveOpen = !ui.inactiveOpen; store.set('inactiveOpen', ui.inactiveOpen); renderStyles(); }));
    if (open) out.push(h('div', { class: 'rows' }, ghosts.map(renderRow)));
  }
  if (other.length) {
    const open = ui.otherOpen || !!f;
    out.push(sectionHead('Other matching rules', open, () => { ui.otherOpen = !ui.otherOpen; store.set('otherOpen', ui.otherOpen); renderStyles(); }));
    if (open) out.push(h('div', { class: 'rows' }, other.map(renderRow)));
  }
  if (data.blocked) out.push(h('div', { class: 'blocked' }, `${data.blocked} stylesheet(s) not readable (cross-origin).`));
  $('#styles').replaceChildren(...out);
}

function render() {
  if (!data || data.empty || data.error) {
    $('#classGrid').replaceChildren();
    $('#classTitle').textContent = 'Classes';
    $('#styles').replaceChildren(h('div', { class: 'empty' }, data && data.error ? `Error: ${data.error}` : 'Select an element in the Elements panel.'));
    return;
  }
  renderClasses();
  renderStyles();
  updateSuggest();
}

// ---------- add-class input with suggestions ----------
let suggestions = [], suggestLoadedAt = 0, shown = [], active = -1;
const addInput = $('#add'), suggestEl = $('#suggest');

async function loadSuggestions() {
  if (Date.now() - suggestLoadedAt < 4000) return;
  suggestLoadedAt = Date.now();
  const r = await run('suggest');
  if (Array.isArray(r)) { suggestions = r; updateSuggest(); }
}

function currentToken() { return addInput.value.match(/(\S*)$/)[1]; }

function updateSuggest() {
  const tok = currentToken().toLowerCase();
  if (!tok || document.activeElement !== addInput || !data || !data.classes) { shown = []; }
  else {
    const have = new Set(data.classes.map((c) => c.name));
    const hits = suggestions.filter((n) => !have.has(n) && n.toLowerCase().includes(tok));
    shown = [...hits.filter((n) => n.toLowerCase().startsWith(tok)), ...hits.filter((n) => !n.toLowerCase().startsWith(tok))].slice(0, 12);
  }
  if (active >= shown.length) active = -1;
  suggestEl.hidden = !shown.length;
  suggestEl.replaceChildren(...shown.map((n, i) =>
    h('li', { class: i === active ? 'active' : '', onmousedown: (ev) => { ev.preventDefault(); pick(i); } }, n)));
}

function pick(i) {
  addInput.value = addInput.value.replace(/\S*$/, shown[i]) + ' ';
  active = -1;
  updateSuggest();
}

function commit() {
  let v = addInput.value;
  if (active >= 0 && shown[active]) v = v.replace(/\S*$/, shown[active]);
  v = v.trim();
  addInput.value = '';
  active = -1;
  updateSuggest();
  if (v) act('addClass', [v]);
}

addInput.addEventListener('focus', () => { loadSuggestions(); updateSuggest(); });
addInput.addEventListener('blur', () => { shown = []; suggestEl.hidden = true; });
addInput.addEventListener('input', () => { active = -1; loadSuggestions(); updateSuggest(); });
addInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
  else if (ev.key === 'ArrowDown' && shown.length) { ev.preventDefault(); active = (active + 1) % shown.length; updateSuggest(); }
  else if (ev.key === 'ArrowUp' && shown.length) { ev.preventDefault(); active = (active - 1 + shown.length) % shown.length; updateSuggest(); }
  else if (ev.key === 'Tab' && shown.length) { ev.preventDefault(); pick(active >= 0 ? active : 0); }
  else if (ev.key === 'Escape') { shown = []; active = -1; suggestEl.hidden = true; }
});

// ---------- toolbar ----------
$('#filter').addEventListener('input', (ev) => { ui.filter = ev.target.value; if (data && !data.empty) render(); });
$('#styleSort').addEventListener('click', () => {
  ui.styleSort = ui.styleSort === 'az' ? 'rule' : 'az';
  store.set('styleSort', ui.styleSort);
  render();
});
$('#classSort').addEventListener('click', () => {
  ui.classSort = ui.classSort === 'az' ? 'order' : 'az';
  store.set('classSort', ui.classSort);
  render();
});
$('#hideVars').addEventListener('click', () => {
  ui.hideVars = !ui.hideVars;
  store.set('hideVars', ui.hideVars);
  $('#hideVars').setAttribute('aria-pressed', ui.hideVars);
  render();
});
$('#classes .section-head').addEventListener('click', (ev) => {
  if (ev.target.closest('#classSort')) return;
  ui.classesOpen = !ui.classesOpen;
  store.set('classesOpen', ui.classesOpen);
  render();
});
$('#hideVars').setAttribute('aria-pressed', ui.hideVars);

// Shift + hovering a style row (or a class) highlights everything from the same class and dims the rest.
function setFocus(match) {
  document.body.classList.toggle('focus', !!match);
  for (const r of document.querySelectorAll('.prop')) r.classList.toggle('hl', !!match && r.dataset.src != null && match.row(r.dataset.src));
  for (const c of document.querySelectorAll('.cls')) c.classList.toggle('hl', !!match && match.cls(c.dataset.name));
}
// Focus only while Shift is held. Mouse events carry the modifier state even when the pane
// itself has no keyboard focus; key events cover pressing/releasing Shift without moving.
let hovered = null;
function updateFocus(shift) {
  if (!shift || !hovered) return setFocus(null);
  const row = hovered.closest('#styles .prop[data-src]');
  if (row) {
    const src = row.dataset.src, names = src.split(' ');
    return setFocus({ row: (s) => s === src, cls: (n) => names.includes(n) });
  }
  const c = hovered.closest('#classGrid .cls');
  if (c) {
    const name = c.dataset.name;
    return setFocus({ row: (s) => s.split(' ').includes(name), cls: (n) => n === name });
  }
  setFocus(null);
}
for (const type of ['mouseover', 'mousemove']) {
  document.addEventListener(type, (ev) => { hovered = ev.target; updateFocus(ev.shiftKey); });
}
document.addEventListener('mouseleave', () => { hovered = null; updateFocus(false); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Shift') updateFocus(true); });
window.addEventListener('keyup', (ev) => { if (ev.key === 'Shift') updateFocus(false); });
window.addEventListener('blur', () => updateFocus(false));

// ---------- lifecycle ----------
window.twShown = (v) => { visible = v; if (v) refresh(true); };
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => refresh());
chrome.devtools.network.onNavigated.addListener(() => refresh());
window.addEventListener('focus', () => refresh(true));
setInterval(() => { if (visible && !document.hidden) refresh(true); }, 1000);
refresh();
