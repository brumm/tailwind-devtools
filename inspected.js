// Runs inside the inspected page. The panel stringifies this function and evaluates it
// with `$0` (the selected element) as `el`. It must stay self-contained.
function twRun(el, op, args) {
  const S = window.__twPane || (window.__twPane = {
    nextId: 1,
    ids: new WeakMap(),     // holder (CSSRule | Element) -> id
    byId: new Map(),        // id -> WeakRef(holder)
    props: new WeakMap(),   // holder -> { order: string[], disabled: Map(name -> decl) }  (inline style / fallback)
    splits: new WeakMap(),  // rule -> { order: string[], items: Map(name -> { token, value, important }) }
    classes: new WeakMap(), // element -> { order: string[], disabled: Set(name) }
  });
  // state left behind by an older version of this script
  if (!S.splits) S.splits = new WeakMap();
  if (!el || el.nodeType !== 1) return JSON.stringify({ empty: true });

  // ---------- string helpers ----------
  const splitTop = (str) => {
    const out = [];
    let depth = 0, quote = '', start = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { out.push(str.slice(start, i).trim()); start = i + 1; }
    }
    out.push(str.slice(start).trim());
    return out.filter(Boolean);
  };

  const parseDecls = (text) => {
    const out = [];
    let depth = 0, quote = '', start = 0;
    const flush = (end) => {
      const part = text.slice(start, end).trim();
      start = end + 1;
      const i = part.indexOf(':');
      if (!part || i < 0) return;
      const name = part.slice(0, i).trim();
      let value = part.slice(i + 1).trim();
      let important = false;
      const m = value.match(/\s*!\s*important\s*$/i);
      if (m) { important = true; value = value.slice(0, m.index); }
      out.push({ name, value, important });
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth <= 0) flush(i);
    }
    flush(text.length);
    return out;
  };

  // ---------- specificity ----------
  const identEnd = (s, i) => {
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') i += 2;
      else if (/[\w-]/.test(c) || c > '\x7f') i++;
      else break;
    }
    return i;
  };
  const parenEnd = (s, i) => {
    let d = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '(') d++;
      else if (c === ')' && --d === 0) return i;
    }
    return s.length;
  };
  const specOf = (s) => {
    let a = 0, b = 0, c = 0, i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '#') { a++; i = identEnd(s, i + 1); }
      else if (ch === '.') { b++; i = identEnd(s, i + 1); }
      else if (ch === '[') {
        b++;
        let d = 0;
        for (; i < s.length; i++) {
          if (s[i] === '\\') i++;
          else if (s[i] === '[') d++;
          else if (s[i] === ']' && --d === 0) break;
        }
        i++;
      } else if (ch === ':') {
        const dbl = s[i + 1] === ':';
        i += dbl ? 2 : 1;
        const st = i;
        i = identEnd(s, i);
        const name = s.slice(st, i).toLowerCase();
        let arg = null;
        if (s[i] === '(') { const e = parenEnd(s, i); arg = s.slice(i + 1, e); i = e + 1; }
        if (dbl || ['before', 'after', 'first-line', 'first-letter'].includes(name)) c++;
        else if (name === 'where') { /* zero */ }
        else if (arg != null && ['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any'].includes(name)) {
          let m = [0, 0, 0];
          for (const p of splitTop(arg)) {
            const v = specOf(p);
            const vv = [Math.floor(v / 1e6), Math.floor(v / 1e3) % 1e3, v % 1e3];
            if (v > m[0] * 1e6 + m[1] * 1e3 + m[2]) m = vv;
          }
          a += m[0]; b += m[1]; c += m[2];
        } else b++;
      } else if (/[a-zA-Z_]/.test(ch) || ch === '\\' || ch > '\x7f') { c++; i = identEnd(s, i); }
      else i++;
    }
    return a * 1e6 + b * 1e3 + c;
  };

  const safe = (sel) => { try { return el.matches(sel); } catch { return false; } };

  const idOf = (holder) => {
    let id = S.ids.get(holder);
    if (!id) { id = S.nextId++; S.ids.set(holder, id); S.byId.set(id, new WeakRef(holder)); }
    return id;
  };

  // Declarations of a rule/element, including ones the user switched off.
  const OFF_ATTR = 'data-tw-off';
  const offTokens = () => new Set((el.getAttribute(OFF_ATTR) || '').split(/\s+/).filter(Boolean));
  const setToken = (token, on) => {
    const t = offTokens();
    if (on) t.add(token); else t.delete(token);
    if (t.size) el.setAttribute(OFF_ATTR, [...t].join(' ')); else el.removeAttribute(OFF_ATTR);
  };

  // Declarations of a rule/element, including ones switched off (for this element).
  const declsOf = (holder) => {
    const live = parseDecls(holder.style.cssText).map((d) => ({ ...d, enabled: true }));
    const sp = S.splits.get(holder);
    const st = S.props.get(holder);
    if (!sp && !st) return live;
    const tokens = sp ? offTokens() : null;
    const order = [...(sp ? sp.order : []), ...(st ? st.order : [])];
    const extra = (n) => {
      if (sp && sp.items.has(n)) { const it = sp.items.get(n); return { name: n, value: it.value, important: it.important, enabled: !tokens.has(it.token) }; }
      if (st && st.disabled.has(n)) return { ...st.disabled.get(n), enabled: false };
      return null;
    };
    const out = [], seen = new Set();
    for (const n of order) {
      if (seen.has(n)) continue;
      seen.add(n);
      const l = live.filter((d) => d.name === n);
      if (l.length) { out.push(...l); continue; }
      const x = extra(n);
      if (x) out.push(x);
    }
    for (const d of live) if (!seen.has(d.name)) out.push(d);
    return out;
  };

  // Moves one declaration of a shared rule into a sibling rule that is guarded by
  // `:where(:not([data-tw-off~=token]))`, so it can be switched off for a single element.
  const ensureSplit = (holder, name) => {
    let sp = S.splits.get(holder);
    if (sp && sp.items.has(name)) return sp.items.get(name);
    const d = parseDecls(holder.style.cssText).find((x) => x.name === name);
    if (!d) return null;
    try {
      const token = 't' + (S.nextId++);
      const base = holder.constructor.name === 'CSSNestedDeclarations' ? '&' : holder.selectorText;
      if (!base) return null;
      const guard = `:where(:not([${OFF_ATTR}~="${token}"]))`;
      const text = `${splitTop(base).map((p) => p + guard).join(', ')} { ${name}: ${d.value}${d.important ? ' !important' : ''}; }`;
      const parent = holder.parentRule || holder.parentStyleSheet;
      const idx = [...parent.cssRules].indexOf(holder);
      if (idx < 0) return null;
      const order = parseDecls(holder.style.cssText).map((x) => x.name);
      parent.insertRule(text, idx + 1);
      holder.style.removeProperty(name);
      if (!sp) { sp = { order, items: new Map() }; S.splits.set(holder, sp); }
      const item = { token, value: d.value, important: d.important };
      sp.items.set(name, item);
      return item;
    } catch { return null; }
  };

  // ---------- operations ----------
  const classState = () => {
    let st = S.classes.get(el);
    if (!st) { st = { order: [...el.classList], disabled: new Set() }; S.classes.set(el, st); }
    return st;
  };

  switch (op) {
    case 'toggleProp': {
      const [id, name, enable] = args;
      const holder = S.byId.get(id)?.deref();
      if (!holder) break;
      if (holder !== el) {
        // class rules: switch off for this element only
        const item = ensureSplit(holder, name);
        if (item) { setToken(item.token, !enable); break; }
      }
      let st = S.props.get(holder);
      if (!st) { st = { order: parseDecls(holder.style.cssText).map((d) => d.name), disabled: new Map() }; S.props.set(holder, st); }
      if (enable) {
        const d = st.disabled.get(name);
        if (d) { holder.style.setProperty(name, d.value, d.important ? 'important' : ''); st.disabled.delete(name); }
      } else {
        const d = parseDecls(holder.style.cssText).find((x) => x.name === name);
        if (d) { st.disabled.set(name, d); holder.style.removeProperty(name); }
      }
      break;
    }
    case 'toggleClass': {
      const [name, enable] = args;
      const st = classState();
      if (!st.order.includes(name)) st.order.push(name);
      if (enable) {
        st.disabled.delete(name);
        el.classList.add(name);
        const present = new Set(el.classList);
        const next = st.order.filter((n) => present.has(n));
        for (const n of present) if (!next.includes(n)) next.push(n);
        el.setAttribute('class', next.join(' '));
      } else {
        el.classList.remove(name);
        st.disabled.add(name);
      }
      break;
    }
    case 'removeClass': {
      const st = classState();
      el.classList.remove(args[0]);
      st.disabled.delete(args[0]);
      st.order = st.order.filter((n) => n !== args[0]);
      break;
    }
    case 'addClass': {
      const st = classState();
      for (const n of String(args[0]).split(/\s+/).filter(Boolean)) {
        if (!st.order.includes(n)) st.order.push(n);
        st.disabled.delete(n);
        el.classList.add(n);
      }
      break;
    }
    case 'suggest': {
      const counts = new Map();
      const nodes = el.ownerDocument.querySelectorAll('[class]');
      const lim = Math.min(nodes.length, 20000);
      for (let i = 0; i < lim; i++) for (const n of nodes[i].classList) counts.set(n, (counts.get(n) || 0) + 1);
      return JSON.stringify([...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4000).map((x) => x[0]));
    }
  }

  // ---------- collect ----------
  const classNames = [...el.classList];
  const entries = [];
  const layerRank = new Map();
  let order = 0, seq = 0, blocked = 0;

  const regLayer = (full) => { if (!layerRank.has(full)) layerRank.set(full, layerRank.size); };
  const layerKey = (name, parent) => (parent ? parent + '.' + name : name);
  const sheetName = (sheet) => {
    if (sheet.href) { try { return new URL(sheet.href).pathname.split('/').pop() || sheet.href; } catch { return sheet.href; } }
    return sheet.ownerNode ? '<' + sheet.ownerNode.localName + '>' : '(constructed)';
  };

  const resolveSel = (text, parent) => {
    const list = splitTop(text);
    if (!parent) return list.map((t) => ({ m: t, d: t }));
    const pm = ':is(' + parent.map((e) => e.m).join(',') + ')';
    const pe = parent.find((e) => safe(e.m)) || parent[0];
    return list.map((t) => (t.includes('&')
      ? { m: t.replace(/&/g, pm), d: t.replace(/&/g, pe.d) }
      : { m: pm + ' ' + t, d: pe.d + ' ' + t }));
  };

  // Matches ".<one of the element's classes>" (not a longer class that merely starts the same way).
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenToName = new Map(classNames.map((n) => ['.' + CSS.escape(n), n]));
  const classRe = tokenToName.size ? new RegExp('(' + [...tokenToName.keys()].map(escRe).join('|') + ')(?![\\w-]|\\\\)', 'g') : null;
  const classesIn = (s) => (classRe ? [...new Set([...s.matchAll(classRe)].map((m) => tokenToName.get(m[1])))] : []);
  const subjectOf = (s) => {
    let depth = 0, last = 0, quote = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) last = i + 1;
    }
    return s.slice(last);
  };

  const inactive = [];
  const activeClasses = new Set();

  const emit = (holder, sel, ctx) => {
    order++;
    if (!sel) return;
    const matched = sel.filter((e) => safe(e.m));
    if (!matched.length || ctx.off.length) {
      // Not applying right now (false media/supports condition, or state like :hover). Only
      // interesting when the subject of the selector is one of the element's classes.
      if (!classRe) return;
      const subj = sel.filter((e) => classesIn(subjectOf(e.m)).length);
      if (!subj.length) return;
      const decls = declsOf(holder);
      if (!decls.length) return;
      const names = classesIn(subjectOf(subj[0].m));
      inactive.push({
        id: idOf(holder), tag: subj[0].d, cond: ctx.cond, off: ctx.off, layer: ctx.layer || '', sheet: ctx.sheet,
        classes: names, classIdx: Math.min(...names.map((n) => classNames.indexOf(n))), seq: seq++,
        decls: decls.map(({ name, value, important }) => ({ name, value, important })),
      });
      return;
    }
    const decls = declsOf(holder);
    if (!decls.length) return;
    let best = matched[0], bestSpec = specOf(best.m);
    for (const e of matched.slice(1)) { const sp = specOf(e.m); if (sp > bestSpec) { best = e; bestSpec = sp; } }
    let classIdx = -1;
    for (const e of matched) {
      for (const n of classesIn(e.m)) {
        activeClasses.add(n);
        const i = classNames.indexOf(n);
        if (classIdx < 0 || i < classIdx) classIdx = i;
      }
    }
    const id = idOf(holder);
    const subjNames = classesIn(subjectOf(best.m));
    const label = (subjNames.length ? subjNames : classesIn(best.m)).join(' ');
    const rank = ctx.layer ? (layerRank.get(ctx.layer) ?? -1) : Infinity;
    for (const d of decls) {
      entries.push({
        id, name: d.name, value: d.value, important: d.important, enabled: d.enabled,
        tag: best.d, label, layer: ctx.layer || '', cond: ctx.cond, sheet: ctx.sheet,
        spec: bestSpec, rank, order, seq: seq++, classIdx, cls: classIdx >= 0, inline: false,
      });
    }
  };

  const walk = (rules, ctx) => {
    for (const rule of rules) {
      try {
        switch (rule.constructor.name) {
          case 'CSSStyleRule': {
            if (rule.selectorText.includes(':where(:not([' + OFF_ATTR + '~=')) break; // per-element toggle helper rule
            const full = resolveSel(rule.selectorText, ctx.sel);
            emit(rule, full, ctx);
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, { ...ctx, sel: full });
            break;
          }
          case 'CSSNestedDeclarations': emit(rule, ctx.sel, ctx); break;
          case 'CSSMediaRule': {
            const c = '@media ' + rule.media.mediaText;
            walk(rule.cssRules, { ...ctx, cond: [...ctx.cond, c], off: matchMedia(rule.media.mediaText).matches ? ctx.off : [...ctx.off, c] });
            break;
          }
          case 'CSSSupportsRule': {
            const c = '@supports ' + rule.conditionText;
            walk(rule.cssRules, { ...ctx, cond: [...ctx.cond, c], off: CSS.supports(rule.conditionText) ? ctx.off : [...ctx.off, c] });
            break;
          }
          case 'CSSContainerRule':
            walk(rule.cssRules, { ...ctx, cond: [...ctx.cond, '@container ' + rule.conditionText] });
            break;
          case 'CSSLayerBlockRule': {
            const full = layerKey(rule.name || '(anonymous)', ctx.layer);
            regLayer(full);
            walk(rule.cssRules, { ...ctx, layer: full });
            break;
          }
          case 'CSSLayerStatementRule':
            for (const n of rule.nameList) regLayer(layerKey(n, ctx.layer));
            break;
          case 'CSSImportRule': {
            if (!rule.styleSheet) break;
            if (rule.media && rule.media.length && !matchMedia(rule.media.mediaText).matches) break;
            let layer = ctx.layer;
            if (rule.layerName != null) { layer = layerKey(rule.layerName || '(import)', ctx.layer); regLayer(layer); }
            walkSheet(rule.styleSheet, { ...ctx, layer });
            break;
          }
        }
      } catch { /* skip unsupported rule */ }
    }
  };

  const walkSheet = (sheet, ctx) => {
    if (sheet.disabled) return;
    if (sheet.media && sheet.media.length && !matchMedia(sheet.media.mediaText).matches) return;
    let rules;
    try { rules = sheet.cssRules; } catch { blocked++; return; }
    walk(rules, { ...ctx, sheet: sheetName(sheet) });
  };

  const root = el.getRootNode();
  for (const sheet of [...(root.styleSheets || []), ...(root.adoptedStyleSheets || [])]) {
    walkSheet(sheet, { sel: null, cond: [], off: [], layer: '', sheet: '' });
  }

  // inline style
  const inlineId = idOf(el);
  for (const d of declsOf(el)) {
    entries.push({
      id: inlineId, name: d.name, value: d.value, important: d.important, enabled: d.enabled,
      tag: 'element.style', layer: '', cond: [], sheet: '', spec: 1e12, rank: Infinity,
      order: 1e9, seq: seq++, classIdx: -1, cls: false, inline: true,
    });
  }

  // cascade winners (same-property only)
  const beats = (a, b) => {
    if (a.important !== b.important) return a.important;
    if (a.rank !== b.rank) return a.important ? a.rank < b.rank : a.rank > b.rank;
    if (a.spec !== b.spec) return a.spec > b.spec;
    return a.order > b.order || (a.order === b.order && a.seq > b.seq);
  };
  const byName = new Map();
  for (const e of entries) if (e.enabled) { if (!byName.has(e.name)) byName.set(e.name, []); byName.get(e.name).push(e); }
  for (const list of byName.values()) {
    let w = list[0];
    for (const e of list) if (beats(e, w)) w = e;
    for (const e of list) e.overridden = e !== w;
  }

  const cs = getComputedStyle(el);
  const vars = {};
  for (const e of [...entries, ...inactive.flatMap((b) => b.decls)]) {
    for (const m of e.value.matchAll(/var\(\s*(--[\w-]+)/g)) if (!(m[1] in vars)) vars[m[1]] = cs.getPropertyValue(m[1]).trim();
  }

  // classes that only have inactive rules are shown muted
  const mutedReason = new Map();
  for (const b of inactive) {
    for (const n of b.classes) if (!activeClasses.has(n) && !mutedReason.has(n)) mutedReason.set(n, b.off.length ? b.off.join(', ') : b.tag);
  }

  // class list incl. switched-off classes
  const cst = S.classes.get(el);
  let classes;
  if (cst) {
    const seen = new Set();
    classes = [];
    for (const n of cst.order) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (el.classList.contains(n)) classes.push({ name: n, enabled: true });
      else if (cst.disabled.has(n)) classes.push({ name: n, enabled: false });
    }
    for (const n of classNames) if (!seen.has(n)) classes.push({ name: n, enabled: true });
  } else {
    classes = classNames.map((name) => ({ name, enabled: true }));
  }

  for (const c of classes) if (mutedReason.has(c.name)) { c.inactive = true; c.reason = mutedReason.get(c.name); }

  return JSON.stringify({
    tag: el.localName + (el.id ? '#' + el.id : ''),
    classes,
    inactive,
    entries: entries.map(({ spec, rank, order: o, ...e }) => ({ ...e, overridden: !!e.overridden })),
    vars,
    blocked,
  });
}
