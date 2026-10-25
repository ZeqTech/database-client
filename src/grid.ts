import * as vscode from "vscode";
import sqlEditorJs from "./webview/sqlEditor.js.txt";

export interface GridData {
  type: "data";
  columns?: string[];
  rows?: unknown[][];
  info?: string;
  error?: string;
  paging?: { page: number; hasPrev: boolean; hasNext: boolean } | null;
  /** Show the SQL input bar (table views). */
  editor?: boolean;
  /** Initial SQL text; only applied the first time. */
  initSql?: string;
}

export interface GridMessage {
  type: string;
  dir?: number;
  sql?: string;
  start?: number;
  end?: number;
}

/** A webview panel showing a result grid. Panels are reused by key. */
export class GridPanel {
  private static readonly open = new Map<string, GridPanel>();

  private ready = false;
  private pending?: GridData;
  private handler: (msg: GridMessage) => void;

  private constructor(
    private readonly key: string,
    private readonly panel: vscode.WebviewPanel,
    handler: (msg: GridMessage) => void
  ) {
    this.handler = handler;
    panel.onDidDispose(() => GridPanel.open.delete(key));
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "ready") {
        this.ready = true;
        if (this.pending) panel.webview.postMessage(this.pending);
        this.pending = undefined;
      } else if (m.type === "export") {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`result.${m.ext}`),
          filters: m.ext === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(m.content, "utf8"));
          vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
      } else {
        this.handler(m);
      }
    });
    panel.webview.html = gridHtml();
  }

  static has(key: string): boolean {
    return GridPanel.open.has(key);
  }

  static show(
    key: string,
    title: string,
    handler: (msg: GridMessage) => void,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside
  ): GridPanel {
    // Beside: results next to the editor without stealing focus. Active: a normal tab in the current group.
    const keepFocus = column === vscode.ViewColumn.Beside;
    const existing = GridPanel.open.get(key);
    if (existing) {
      existing.panel.title = title;
      existing.handler = handler;
      existing.panel.reveal(undefined, keepFocus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      "dbclient.grid",
      title,
      { viewColumn: column, preserveFocus: keepFocus },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const g = new GridPanel(key, panel, handler);
    GridPanel.open.set(key, g);
    return g;
  }

  post(data: GridData): void {
    if (this.ready) this.panel.webview.postMessage(data);
    else this.pending = data;
  }
}

export function gridHtml(): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html,body { height:100%; margin:0; }
  body { display:flex; flex-direction:column; font:12px var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
  .bar { display:flex; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border); }
  .bar .info { flex:1; opacity:.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  button, input { font:inherit; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); border:0; padding:3px 10px; border-radius:2px; cursor:pointer; }
  button:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity:.4; cursor:default; }
  input { cursor:text; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, transparent); width:160px; }
  .wrap { flex:1; overflow:auto; }
  table { border-collapse:collapse; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); }
  th { position:sticky; top:0; background:var(--vscode-editorGroupHeader-tabsBackground); text-align:left; cursor:pointer; user-select:none; z-index:1; }
  th, td { border:1px solid var(--vscode-panel-border); padding:3px 8px; max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  td.num { text-align:right; }
  td.null { opacity:.45; font-style:italic; }
  tbody tr:nth-child(even) { background:var(--vscode-list-hoverBackground); }
  td:hover { background:var(--vscode-list-activeSelectionBackground); }
  .rn { opacity:.5; text-align:right; background:var(--vscode-editorGroupHeader-tabsBackground); }
  .sqlbar { border-bottom:1px solid var(--vscode-panel-border); padding:6px 10px 8px; }
  .sqlbar .row { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
  .sqlbar .row .lbl { opacity:.7; flex:1; }
  .sqlbar button.primary { color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
  .sqlbar button.primary:hover { background:var(--vscode-button-hoverBackground); }
  .sqlbox { position:relative; height:96px; min-height:48px; max-height:60vh; resize:vertical; overflow:hidden;
    border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); background:var(--vscode-editor-background); border-radius:3px; }
  .sqlbox:focus-within { border-color:var(--vscode-focusBorder); }
  .sqlbox pre, .sqlbox textarea { position:absolute; inset:0; margin:0; padding:6px 8px; border:0; box-sizing:border-box;
    font-family:var(--vscode-editor-font-family, monospace); font-size:var(--vscode-editor-font-size, 13px); line-height:1.5; tab-size:2;
    white-space:pre; overflow:auto; background:transparent; letter-spacing:0; }
  .sqlbox pre { pointer-events:none; color:var(--vscode-editor-foreground, var(--vscode-foreground)); overflow:hidden; }
  .sqlbox textarea { color:transparent; -webkit-text-fill-color:transparent; caret-color:var(--vscode-editor-foreground, var(--vscode-foreground)); resize:none; outline:none; width:100%; height:100%; }
  /* The textarea sits above the highlighted <pre>, so the selection must be translucent or it hides the text. */
  .sqlbox textarea::selection { background:color-mix(in srgb, var(--vscode-editor-selectionBackground) 40%, transparent); -webkit-text-fill-color:transparent; }
  .t-k { color:#569cd6; font-weight:600; } .t-s { color:#ce9178; } .t-q { color:#9cdcfe; } .t-n { color:#b5cea8; }
  .t-c { color:#6a9955; font-style:italic; } .t-f { color:#dcdcaa; }
  .vscode-light .t-k { color:#0000ff; } .vscode-light .t-s { color:#a31515; } .vscode-light .t-q { color:#001080; }
  .vscode-light .t-n { color:#098658; } .vscode-light .t-c { color:#008000; } .vscode-light .t-f { color:#795e26; }
  .hint { opacity:.55; font-size:11px; }
  .msg { padding:14px; }
  .err { color:var(--vscode-errorForeground); white-space:pre-wrap; }
</style></head>
<body>
  <div class="bar">
    <span class="info" id="info"></span>
    <span id="pager" hidden>
      <button id="prev">◀</button> <span id="page"></span> <button id="next">▶</button>
    </span>
    <input id="filter" placeholder="Filter rows…">
    <button id="refresh" hidden>↻</button>
    <button id="export">Export CSV</button>
    <button id="exportJson">Export JSON</button>
  </div>
  <div class="sqlbar" id="sqlbar" hidden>
    <div class="row">
      <span class="lbl">SQL <span class="hint">· Ctrl+Enter runs the selection or the statement at the cursor</span></span>
      <button id="reset" title="Back to the paged table view">Table view</button>
      <button id="run" class="primary">▶ Run</button>
    </div>
    <div class="sqlbox">
      <pre id="hl" aria-hidden="true"></pre>
      <textarea id="sql" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="SELECT * FROM ..."></textarea>
    </div>
  </div>
  <div class="wrap" id="out"><div class="msg">Waiting for results…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let columns = [], rows = [], sortCol = -1, sortDir = 1, shown = [];

  function view() {
    const q = $('filter').value.toLowerCase();
    let idx = rows.map((_, i) => i);
    if (q) idx = idx.filter((i) => rows[i].some((v) => v !== null && String(v).toLowerCase().includes(q)));
    if (sortCol >= 0) {
      idx.sort((a, b) => {
        const x = rows[a][sortCol], y = rows[b][sortCol];
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortDir;
      });
    }
    shown = idx;
    const out = $('out');
    out.textContent = '';
    if (!columns.length) return;
    const t = document.createElement('table');
    const head = t.createTHead().insertRow();
    head.appendChild(Object.assign(document.createElement('th'), { textContent: '#' }));
    columns.forEach((c, i) => {
      const th = document.createElement('th');
      th.textContent = c + (sortCol === i ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
      th.onclick = () => { sortDir = sortCol === i ? -sortDir : 1; sortCol = i; view(); };
      head.appendChild(th);
    });
    const body = t.createTBody();
    idx.forEach((ri, n) => {
      const tr = body.insertRow();
      const rn = tr.insertCell(); rn.className = 'rn'; rn.textContent = n + 1;
      rows[ri].forEach((v) => {
        const td = tr.insertCell();
        if (v === null) { td.textContent = 'NULL'; td.className = 'null'; }
        else { td.textContent = String(v); if (typeof v === 'number') td.className = 'num'; td.title = String(v); }
      });
    });
    out.appendChild(t);
  }

  function csvCell(v) {
    if (v === null) return '';
    const s = String(v);
    return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type !== 'data') return;
    onEditorMessage(m);
    if (m.error) {
      columns = []; rows = [];
      $('info').textContent = 'Error';
      $('out').innerHTML = '';
      const d = document.createElement('div'); d.className = 'msg err'; d.textContent = m.error;
      $('out').appendChild(d);
      return;
    }
    columns = m.columns || []; rows = m.rows || []; sortCol = -1;
    $('info').textContent = m.info || '';
    $('pager').hidden = !m.paging;
    $('refresh').hidden = !m.paging;
    if (m.paging) {
      $('page').textContent = 'Page ' + (m.paging.page + 1);
      $('prev').disabled = !m.paging.hasPrev;
      $('next').disabled = !m.paging.hasNext;
    }
    if (!columns.length) {
      $('out').innerHTML = '';
      const d = document.createElement('div'); d.className = 'msg'; d.textContent = m.info || 'No result set.';
      $('out').appendChild(d);
      return;
    }
    view();
  });

  $('filter').oninput = view;
  $('prev').onclick = () => vscode.postMessage({ type: 'page', dir: -1 });
  $('next').onclick = () => vscode.postMessage({ type: 'page', dir: 1 });
  $('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
  $('export').onclick = () => {
    const lines = [columns.map(csvCell).join(',')].concat(shown.map((i) => rows[i].map(csvCell).join(',')));
    vscode.postMessage({ type: 'export', ext: 'csv', content: lines.join('\\r\\n') + '\\r\\n' });
  };
  $('exportJson').onclick = () => {
    const objs = shown.map((i) => Object.fromEntries(columns.map((c, j) => [c, rows[i][j]])));
    vscode.postMessage({ type: 'export', ext: 'json', content: JSON.stringify(objs, null, 2) + '\\n' });
  };
${sqlEditorJs}
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
