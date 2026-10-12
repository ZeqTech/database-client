import * as crypto from "crypto";

/** Self-contained SVG ER diagram viewer (no external libraries). */
export function diagramHtml(): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height:100%; margin:0; overflow:hidden; }
  body { display:flex; flex-direction:column; font:12px var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
  .bar { display:flex; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border); flex-wrap:wrap; }
  .bar .info { flex:1; opacity:.75; min-width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  button, input { font:inherit; border:0; border-radius:3px; padding:4px 10px; }
  button { cursor:pointer; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
  button:hover { background:var(--vscode-button-secondaryHoverBackground); }
  input { width:150px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, transparent); }
  #stage { flex:1; position:relative; overflow:hidden; cursor:grab; }
  #stage.panning { cursor:grabbing; }
  svg { width:100%; height:100%; display:block; }
  .msg { position:absolute; inset:0; display:grid; place-items:center; opacity:.7; pointer-events:none; text-align:center; padding:20px; }
  .hidden { display:none !important; }
  .legend { display:flex; gap:12px; align-items:center; opacity:.75; }
</style></head>
<body>
  <div class="bar">
    <span class="info" id="info">Loading…</span>
    <span class="legend"><b style="color:#d7ba7d">PK</b> primary key <b style="color:#4fa3ff">FK</b> foreign key</span>
    <input id="search" placeholder="Find table…">
    <button id="all" class="hidden">Show all tables</button>
    <button id="keys">Keys only</button>
    <button id="layout">Auto layout</button>
    <button id="fit">Fit</button>
    <button id="export">Export SVG</button>
  </div>
  <div id="stage"><svg id="svg" xmlns="http://www.w3.org/2000/svg"><g id="vp"><g id="edges"></g><g id="nodes"></g></g></svg><div class="msg hidden" id="msg"></div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const HEAD = 28, ROW = 20, FONT = 'Segoe UI, Helvetica, Arial, sans-serif';
  const $ = (id) => document.getElementById(id);
  let C = {};
  let data = null;            // { title, tables, relations, focus }
  let nodes = new Map();      // name -> node
  let rels = [];              // relations whose both tables exist
  let keysOnly = false, focusMode = false, hover = null, query = '';
  let view = { x: 0, y: 0, k: 1 };

  function readColors() {
    const s = getComputedStyle(document.body);
    const g = (n, f) => s.getPropertyValue(n).trim() || f;
    C = { fg: g('--vscode-foreground', '#ccc'), bg: g('--vscode-editor-background', '#1e1e1e'),
      border: g('--vscode-panel-border', '#555'), head: g('--vscode-editorGroupHeader-tabsBackground', '#2d2d2d'),
      accent: g('--vscode-focusBorder', '#007fd4'), muted: g('--vscode-descriptionForeground', '#999'),
      pk: g('--vscode-charts-yellow', '#d7ba7d'), fk: g('--vscode-charts-blue', '#4fa3ff'),
      edge: g('--vscode-editorLineNumber-foreground', '#888') };
  }

  const ctx = document.createElement('canvas').getContext('2d');
  const textW = (t, bold) => { ctx.font = (bold ? '600 ' : '') + '12px ' + FONT; return ctx.measureText(t).width; };
  const SHORT = { 'character varying': 'varchar', 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
    'double precision': 'double', 'time without time zone': 'time', 'time with time zone': 'timetz' };
  const shortType = (t) => (SHORT[t] || t || '').toLowerCase();

  function el(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- model -------------------------------------------------------------
  function build() {
    const fkCols = new Map(), refCols = new Map();
    nodes = new Map();
    for (const t of data.tables) nodes.set(t.name, { name: t.name, kind: t.kind, columns: t.columns, x: 0, y: 0, w: 0, h: 0, fk: new Set(), ref: new Set() });
    rels = data.relations.filter((r) => nodes.has(r.table) && nodes.has(r.refTable));
    for (const r of rels) {
      r.columns.forEach((c) => nodes.get(r.table).fk.add(c));
      r.refColumns.forEach((c) => nodes.get(r.refTable).ref.add(c));
    }
    measure();
  }
  function shown(n) {
    return keysOnly ? n.columns.filter((c) => c.primaryKey || n.fk.has(c.name) || n.ref.has(c.name)) : n.columns;
  }
  function measure() {
    for (const n of nodes.values()) {
      const cols = shown(n);
      const nameW = Math.max(0, ...cols.map((c) => textW(c.name)));
      const typeW = Math.max(0, ...cols.map((c) => textW(shortType(c.type))));
      n.w = Math.max(170, textW(n.name + (n.kind === 'view' ? ' (view)' : ''), true) + 28, 34 + nameW + 24 + typeW + 12);
      n.h = HEAD + Math.max(1, cols.length) * ROW + 6;
    }
  }
  function visible() {
    const all = [...nodes.values()];
    if (!(focusMode && data.focus && nodes.has(data.focus))) return all;
    const keep = new Set([data.focus]);
    for (const r of rels) { if (r.table === data.focus) keep.add(r.refTable); if (r.refTable === data.focus) keep.add(r.table); }
    return all.filter((n) => keep.has(n.name));
  }

  // ---- layout ------------------------------------------------------------
  function layout() {
    const vis = visible();
    const set = new Set(vis.map((n) => n.name));
    const es = rels.filter((r) => set.has(r.table) && set.has(r.refTable) && r.table !== r.refTable);
    const deg = new Map(vis.map((n) => [n.name, 0]));
    es.forEach((r) => { deg.set(r.table, deg.get(r.table) + 1); deg.set(r.refTable, deg.get(r.refTable) + 1); });
    const linked = vis.filter((n) => deg.get(n.name) > 0).sort((a, b) => deg.get(b.name) - deg.get(a.name));
    const loose = vis.filter((n) => deg.get(n.name) === 0);

    // Seed: BFS order on a grid so related tables start close together.
    const adj = new Map(vis.map((n) => [n.name, []]));
    es.forEach((r) => { adj.get(r.table).push(r.refTable); adj.get(r.refTable).push(r.table); });
    const order = [], seen = new Set();
    for (const s of linked) {
      if (seen.has(s.name)) continue;
      const q = [s.name]; seen.add(s.name);
      while (q.length) { const c = q.shift(); order.push(nodes.get(c)); adj.get(c).forEach((m) => { if (!seen.has(m)) { seen.add(m); q.push(m); } }); }
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
    const cw = Math.max(0, ...order.map((n) => n.w)) + 140, rh = Math.max(0, ...order.map((n) => n.h)) + 100;
    order.forEach((n, i) => { n.x = (i % cols) * cw + ((i / cols | 0) % 2) * 40; n.y = (i / cols | 0) * rh; });

    // Force relaxation on box centres: springs on edges, repulsion between all.
    const P = order;
    for (let it = 0; it < 350; it++) {
      const t = 1 - it / 350;
      const f = new Map(P.map((n) => [n, [0, 0]]));
      for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
        const a = P[i], b = P[j];
        let dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
        const d = Math.max(1, Math.hypot(dx, dy));
        const gapX = (a.w + b.w) / 2 + 60 - Math.abs(dx), gapY = (a.h + b.h) / 2 + 50 - Math.abs(dy);
        let rep = 60000 / (d * d);
        if (gapX > 0 && gapY > 0) rep += 2 + Math.min(gapX, gapY) * 0.15;   // overlap: push apart hard
        dx /= d; dy /= d;
        f.get(a)[0] -= dx * rep; f.get(a)[1] -= dy * rep; f.get(b)[0] += dx * rep; f.get(b)[1] += dy * rep;
      }
      for (const r of es) {
        const a = nodes.get(r.table), b = nodes.get(r.refTable);
        const dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
        const d = Math.max(1, Math.hypot(dx, dy));
        const rest = (a.w + b.w) / 2 + 130;
        const pull = (d - rest) * 0.02;
        f.get(a)[0] += dx / d * pull; f.get(a)[1] += dy / d * pull; f.get(b)[0] -= dx / d * pull; f.get(b)[1] -= dy / d * pull;
      }
      for (const n of P) { const v = f.get(n); n.x += Math.max(-30, Math.min(30, v[0] * 8)) * t; n.y += Math.max(-30, Math.min(30, v[1] * 8)) * t; }
    }
    // Isolated tables go in a tidy grid underneath.
    let top = P.length ? Math.max(...P.map((n) => n.y + n.h)) + 90 : 0;
    const left = P.length ? Math.min(...P.map((n) => n.x)) : 0;
    const lc = Math.max(1, Math.ceil(Math.sqrt(loose.length * 1.6)));
    let x = left, y = top, rowH = 0, col = 0;
    loose.forEach((n) => { if (col === lc) { col = 0; x = left; y += rowH + 40; rowH = 0; } n.x = x; n.y = y; x += n.w + 40; rowH = Math.max(rowH, n.h); col++; });
  }

  // ---- drawing -----------------------------------------------------------
  function rowY(n, colName) {
    const i = shown(n).findIndex((c) => c.name === colName);
    return n.y + (i < 0 ? HEAD / 2 : HEAD + i * ROW + ROW / 2);
  }
  function edgePath(r) {
    const a = nodes.get(r.table), b = nodes.get(r.refTable);
    const y1 = rowY(a, r.columns[0]), y2 = rowY(b, r.refColumns[0]);
    let x1, x2, d1, d2;
    if (a === b) { x1 = a.x + a.w; x2 = a.x + a.w; d1 = 1; d2 = 1; }
    else if (a.x + a.w + 20 < b.x) { x1 = a.x + a.w; x2 = b.x; d1 = 1; d2 = -1; }
    else if (b.x + b.w + 20 < a.x) { x1 = a.x; x2 = b.x + b.w; d1 = -1; d2 = 1; }
    else { x1 = a.x + a.w; x2 = b.x + b.w; d1 = 1; d2 = 1; }
    const s = a === b ? 60 : Math.max(40, Math.min(110, Math.abs(x2 - x1) / 2 + 30));
    return { d: 'M' + x1 + ',' + y1 + ' C' + (x1 + d1 * s) + ',' + y1 + ' ' + (x2 + d2 * s) + ',' + y2 + ' ' + x2 + ',' + y2, x1, y1, d1, x2, y2, d2 };
  }
  function marks(p) {
    // crow's foot at the FK (many) side, double bar at the referenced (one) side
    const m = 'M' + (p.x1 + p.d1 * 12) + ',' + p.y1 + ' L' + p.x1 + ',' + (p.y1 - 6) + ' M' + (p.x1 + p.d1 * 12) + ',' + p.y1 + ' L' + p.x1 + ',' + (p.y1 + 6)
      + ' M' + (p.x1 + p.d1 * 12) + ',' + p.y1 + ' L' + p.x1 + ',' + p.y1;
    const o = 'M' + (p.x2 + p.d2 * 8) + ',' + (p.y2 - 5) + ' L' + (p.x2 + p.d2 * 8) + ',' + (p.y2 + 5)
      + ' M' + (p.x2 + p.d2 * 13) + ',' + (p.y2 - 5) + ' L' + (p.x2 + p.d2 * 13) + ',' + (p.y2 + 5);
    return m + ' ' + o;
  }

  function drawEdges() {
    const g = $('edges'); g.textContent = '';
    const set = new Set(visible().map((n) => n.name));
    for (const r of rels) {
      if (!set.has(r.table) || !set.has(r.refTable)) continue;
      const p = edgePath(r);
      const on = !hover || r.table === hover || r.refTable === hover;
      const grp = el('g', { opacity: on ? 1 : 0.12 });
      const col = hover && on ? C.accent : C.edge;
      const path = el('path', { d: p.d, fill: 'none', stroke: col, 'stroke-width': hover && on ? 2 : 1.4 });
      path.appendChild(el('title', {}, r.name + ': ' + r.table + '(' + r.columns.join(', ') + ') → ' + r.refTable + '(' + r.refColumns.join(', ') + ')'));
      grp.appendChild(path);
      grp.appendChild(el('path', { d: marks(p), fill: 'none', stroke: col, 'stroke-width': hover && on ? 2 : 1.4 }));
      g.appendChild(grp);
    }
  }

  function drawNodes() {
    const g = $('nodes'); g.textContent = '';
    const q = query.toLowerCase();
    const related = new Set();
    if (hover) { related.add(hover); rels.forEach((r) => { if (r.table === hover) related.add(r.refTable); if (r.refTable === hover) related.add(r.table); }); }
    for (const n of visible()) {
      const dim = (hover && !related.has(n.name)) || (q && !n.name.toLowerCase().includes(q));
      const isFocus = data.focus === n.name;
      const grp = el('g', { transform: 'translate(' + n.x + ',' + n.y + ')', opacity: dim ? 0.25 : 1, 'data-n': n.name, style: 'cursor:grab' });
      grp.appendChild(el('rect', { width: n.w, height: n.h, rx: 6, fill: C.bg, stroke: isFocus || (q && !dim) ? C.accent : C.border, 'stroke-width': isFocus || (q && !dim) ? 2 : 1.2 }));
      grp.appendChild(el('path', { d: 'M0,' + HEAD + ' V6 a6,6 0 0 1 6,-6 H' + (n.w - 6) + ' a6,6 0 0 1 6,6 V' + HEAD + ' Z', fill: C.head }));
      grp.appendChild(el('text', { x: 12, y: 18, fill: C.fg, 'font-size': 12.5, 'font-weight': 600, 'font-family': FONT, 'font-style': n.kind === 'view' ? 'italic' : 'normal' }, n.name + (n.kind === 'view' ? ' (view)' : '')));
      shown(n).forEach((c, i) => {
        const y = HEAD + i * ROW;
        if (i % 2) grp.appendChild(el('rect', { x: 1, y, width: n.w - 2, height: ROW, fill: C.fg, opacity: 0.04 }));
        const isFk = n.fk.has(c.name);
        const tag = c.primaryKey && isFk ? 'PK·FK' : c.primaryKey ? 'PK' : isFk ? 'FK' : '';
        if (tag) grp.appendChild(el('text', { x: 6, y: y + 14, 'font-size': 8, 'font-weight': 700, fill: c.primaryKey ? C.pk : C.fk, 'font-family': FONT }, tag));
        grp.appendChild(el('text', { x: 34, y: y + 14, 'font-size': 12, fill: C.fg, 'font-family': FONT, 'font-weight': c.primaryKey ? 600 : 400 }, c.name + (c.nullable || c.primaryKey ? '' : ' *')));
        grp.appendChild(el('text', { x: n.w - 10, y: y + 14, 'font-size': 11, fill: C.muted, 'text-anchor': 'end', 'font-family': FONT }, shortType(c.type)));
      });
      g.appendChild(grp);
    }
  }
  function redraw() { drawEdges(); drawNodes(); applyView(); updateInfo(); }
  function updateInfo() {
    const vis = visible(); const set = new Set(vis.map((n) => n.name));
    const rc = rels.filter((r) => set.has(r.table) && set.has(r.refTable)).length;
    $('info').textContent = data.title + ' · ' + vis.length + ' table' + (vis.length === 1 ? '' : 's') + ' · ' + rc + ' relationship' + (rc === 1 ? '' : 's')
      + (focusMode ? ' (related to ' + data.focus + ')' : '');
    $('all').classList.toggle('hidden', !focusMode);
    $('msg').classList.toggle('hidden', vis.length > 0);
    $('msg').textContent = 'No tables in this schema.';
  }

  // ---- view (pan / zoom) ---------------------------------------------------
  function applyView() { $('vp').setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'); }
  function fit() {
    const vis = visible(); if (!vis.length) return;
    const minX = Math.min(...vis.map((n) => n.x)), minY = Math.min(...vis.map((n) => n.y));
    const maxX = Math.max(...vis.map((n) => n.x + n.w)), maxY = Math.max(...vis.map((n) => n.y + n.h));
    const r = $('stage').getBoundingClientRect(), pad = 40;
    const k = Math.min(1.2, (r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY));
    view = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k };
    applyView();
  }
  function toWorld(ev) { const r = $('stage').getBoundingClientRect(); return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k }; }

  let drag = null;
  $('stage').addEventListener('pointerdown', (e) => {
    const g = e.target.closest && e.target.closest('g[data-n]');
    if (g) { const n = nodes.get(g.dataset.n); const w = toWorld(e); drag = { node: n, dx: w.x - n.x, dy: w.y - n.y, el: g }; g.style.cursor = 'grabbing'; }
    else { drag = { pan: true, sx: e.clientX - view.x, sy: e.clientY - view.y }; $('stage').classList.add('panning'); }
    $('stage').setPointerCapture(e.pointerId);
  });
  $('stage').addEventListener('pointermove', (e) => {
    if (drag) {
      if (drag.pan) { view.x = e.clientX - drag.sx; view.y = e.clientY - drag.sy; applyView(); }
      else { const w = toWorld(e); drag.node.x = w.x - drag.dx; drag.node.y = w.y - drag.dy; drag.el.setAttribute('transform', 'translate(' + drag.node.x + ',' + drag.node.y + ')'); drawEdges(); }
      return;
    }
    const g = e.target.closest && e.target.closest('g[data-n]');
    const h = g ? g.dataset.n : null;
    if (h !== hover) { hover = h; redraw(); }
  });
  const endDrag = () => { drag = null; $('stage').classList.remove('panning'); };
  $('stage').addEventListener('pointerup', endDrag);
  $('stage').addEventListener('pointercancel', endDrag);
  $('stage').addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; redraw(); } });
  $('stage').addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = $('stage').getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.max(0.1, Math.min(3, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
    applyView();
  }, { passive: false });
  $('stage').addEventListener('dblclick', (e) => {
    const g = e.target.closest && e.target.closest('g[data-n]');
    if (g) { data.focus = g.dataset.n; focusMode = true; layout(); redraw(); fit(); }
  });

  // ---- toolbar ---------------------------------------------------------------
  $('layout').onclick = () => { layout(); redraw(); fit(); };
  $('fit').onclick = fit;
  $('keys').onclick = () => { keysOnly = !keysOnly; $('keys').textContent = keysOnly ? 'All columns' : 'Keys only'; measure(); layout(); redraw(); fit(); };
  $('all').onclick = () => { focusMode = false; layout(); redraw(); fit(); };
  $('search').oninput = (e) => { query = e.target.value; drawNodes(); };
  $('export').onclick = () => {
    const vis = visible(); if (!vis.length) return;
    const pad = 30;
    const minX = Math.min(...vis.map((n) => n.x)) - pad, minY = Math.min(...vis.map((n) => n.y)) - pad;
    const w = Math.max(...vis.map((n) => n.x + n.w)) + pad - minX, h = Math.max(...vis.map((n) => n.y + n.h)) + pad - minY;
    const body = $('edges').innerHTML + $('nodes').innerHTML;
    const svg = '<svg xmlns="' + NS + '" viewBox="' + minX + ' ' + minY + ' ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">'
      + '<rect x="' + minX + '" y="' + minY + '" width="' + w + '" height="' + h + '" fill="' + C.bg + '"/>' + body + '</svg>';
    vscode.postMessage({ type: 'export', svg });
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'error') { $('info').textContent = 'Error'; $('msg').classList.remove('hidden'); $('msg').textContent = m.error; return; }
    if (m.type !== 'diagram') return;
    readColors();
    data = m; hover = null; query = ''; $('search').value = '';
    focusMode = !!(m.focus && m.tables.length > 12);
    build(); layout(); redraw(); fit();
  });
  window.addEventListener('resize', () => data && fit());
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
