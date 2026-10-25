import * as crypto from "crypto";
import { normalizeSsl, SSL_MODES } from "./ssl";
import { CONNECTION_COLORS, ConnectionConfig, DbType } from "./types";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function connectionFormHtml(c?: ConnectionConfig, groups: string[] = []): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const type = c?.type ?? "postgres";
  const card = (t: DbType, badge: string, title: string, sub: string) => `
      <label class="card" data-t="${t}">
        <input type="radio" name="dbtype" value="${t}"${type === t ? " checked" : ""}>
        <span class="badge b-${t}">${badge}</span>
        <span class="ctitle">${title}</span>
        <span class="csub">${sub}</span>
      </label>`;
  const ssl = normalizeSsl(c?.ssl);
  const sslFile = (id: string, label: string, value: string | undefined, hint: string) => `
      <label class="field"><span>${label} <i>(optional)</i></span>
        <div class="file"><input type="text" id="${id}" value="${esc(value)}" placeholder="C:\\path\\to\\file.pem"><button type="button" class="secondary" data-browse="${id}">Browse…</button></div>
        ${hint ? `<div class="hint">${hint}</div>` : ""}
      </label>`;
  return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:13px/1.5 var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
  .page { max-width:660px; margin:0 auto; padding:28px 24px 110px; }
  h1 { font-size:22px; font-weight:600; margin:0 0 2px; }
  .sub { opacity:.65; margin:0 0 24px; }
  h3 { font-size:11px; letter-spacing:.08em; text-transform:uppercase; opacity:.6; margin:26px 0 10px; font-weight:600; }

  .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .card { position:relative; display:grid; grid-template-columns:auto 1fr; column-gap:10px; align-items:center; padding:8px 12px; cursor:pointer;
    border:1px solid var(--vscode-panel-border); border-radius:6px; background:var(--vscode-editorWidget-background, transparent); transition:border-color .12s, box-shadow .12s; }
  .card:hover { border-color:var(--vscode-focusBorder); }
  .card input { position:absolute; opacity:0; pointer-events:none; }
  .card.on { border-color:var(--vscode-focusBorder); box-shadow:0 0 0 1px var(--vscode-focusBorder); }
  .badge { grid-row:1 / span 2; width:28px; height:28px; border-radius:7px; display:grid; place-items:center; color:#fff; font-weight:700; font-size:12px; }
  .b-postgres { background:#336791; } .b-mysql { background:#00758f; } .b-sqlite { background:#0f80cc; }
  .ctitle { font-weight:600; line-height:1.2; } .csub { font-size:11px; opacity:.6; line-height:1.2; }

  details { border:1px dashed var(--vscode-panel-border); border-radius:8px; padding:8px 12px; margin-top:16px; }
  summary { cursor:pointer; opacity:.85; }
  .import { display:flex; gap:8px; margin-top:10px; }

  .grid { display:grid; grid-template-columns:1fr 120px; gap:12px; }
  .field { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
  .field > span { font-size:12px; opacity:.8; } .field > span i { opacity:.6; font-style:normal; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  input[type=text], input[type=password], input[type=number] {
    width:100%; padding:6px 9px; font:inherit; color:var(--vscode-input-foreground); background:var(--vscode-input-background);
    border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:4px; outline:none; }
  input:focus { border-color:var(--vscode-focusBorder); }
  input.bad { border-color:var(--vscode-errorForeground); }
  .err { color:var(--vscode-errorForeground); font-size:11px; }
  .hint { font-size:11px; opacity:.6; }
  select { width:100%; padding:6px 9px; font:inherit; color:var(--vscode-dropdown-foreground); background:var(--vscode-dropdown-background);
    border:1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius:4px; outline:none; }
  select:focus { border-color:var(--vscode-focusBorder); }
  .pw { position:relative; } .pw input { padding-right:56px; }
  .pw button { position:absolute; right:4px; top:3px; padding:2px 8px; font-size:11px; }

  .switch { display:flex; align-items:center; gap:10px; cursor:pointer; margin:4px 0 12px; }
  .switch input { display:none; }
  .track { width:34px; height:18px; border-radius:9px; background:var(--vscode-input-background); border:1px solid var(--vscode-panel-border); position:relative; transition:.15s; }
  .track::after { content:""; position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%; background:var(--vscode-foreground); opacity:.7; transition:.15s; }
  .switch input:checked + .track { background:var(--vscode-button-background); border-color:var(--vscode-button-background); }
  .switch input:checked + .track::after { left:18px; background:var(--vscode-button-foreground); opacity:1; }

  .file { display:flex; gap:8px; }
  button { font:inherit; padding:6px 14px; border:0; border-radius:4px; cursor:pointer; color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
  button:hover:not(:disabled) { background:var(--vscode-button-hoverBackground); }
  button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
  button.secondary:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity:.5; cursor:default; }

  .footer { position:fixed; left:0; right:0; bottom:0; background:var(--vscode-editor-background); border-top:1px solid var(--vscode-panel-border); }
  .footer .in { max-width:660px; margin:0 auto; padding:12px 24px; display:flex; align-items:center; gap:10px; }
  .status { flex:1; min-width:0; display:flex; align-items:center; gap:8px; font-size:12px; }
  .status span.t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .status.ok { color:var(--vscode-testing-iconPassed, #3c3); } .status.ok .dot { background:var(--vscode-testing-iconPassed, #3c3); }
  .status.fail { color:var(--vscode-errorForeground); } .status.fail .dot { background:var(--vscode-errorForeground); }
  .status.busy .dot { border:2px solid var(--vscode-foreground); border-top-color:transparent; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .swatches { display:flex; gap:8px; align-items:center; height:30px; }
  .sw { width:20px; height:20px; border-radius:50%; border:2px solid transparent; padding:0; cursor:pointer; background:var(--c); outline-offset:2px; }
  .sw.none { background:transparent; border:2px dashed var(--vscode-panel-border); }
  .sw.on { outline:2px solid var(--vscode-focusBorder); }
  .hidden { display:none !important; }
</style></head>
<body>
<div class="page">
  <h1>${c ? "Edit connection" : "New connection"}</h1>
  <p class="sub">${c ? "Update the settings below." : "Choose a database and enter how to reach it."}</p>

  <h3>Database</h3>
  <div class="cards">
    ${card("postgres", "Pg", "PostgreSQL", "port 5432")}
    ${card("mysql", "My", "MySQL / MariaDB", "port 3306")}
    ${card("sqlite", "Sq", "SQLite", "local file")}
  </div>

  <details id="importBox">
    <summary>Import from a connection URL</summary>
    <div class="import">
      <input type="text" id="url" placeholder="postgres://user:password@host:5432/dbname">
      <button class="secondary" id="applyUrl">Apply</button>
    </div>
    <div class="err" id="urlErr"></div>
  </details>

  <h3>Connection</h3>
  <label class="field"><span>Name <i>(optional)</i></span>
    <input type="text" id="name" value="${esc(c?.name)}"></label>

  <div class="two">
    <label class="field"><span>Group <i>(optional)</i></span>
      <input type="text" id="group" list="groups" value="${esc(c?.group)}" placeholder="e.g. Production">
      <datalist id="groups">${groups.map((g) => `<option value="${esc(g)}">`).join("")}</datalist></label>
    <div class="field"><span>Color <i>(optional)</i></span>
      <div class="swatches" id="swatches">
        <button type="button" class="sw none${c?.color ? "" : " on"}" data-c="" title="No color"></button>
        ${Object.entries(CONNECTION_COLORS)
          .map(([id, v]) => `<button type="button" class="sw${c?.color === id ? " on" : ""}" data-c="${id}" style="--c:${v.hex}" title="${v.label}"></button>`)
          .join("")}
      </div>
    </div>
  </div>

  <div id="server">
    <div class="grid">
      <label class="field"><span>Host</span><input type="text" id="host" value="${esc(c?.host ?? "localhost")}"><div class="err" data-for="host"></div></label>
      <label class="field"><span>Port</span><input type="number" id="port" value="${esc(c?.port)}"></label>
    </div>
    <div class="two">
      <label class="field"><span>User</span><input type="text" id="user" value="${esc(c?.user)}" autocomplete="off"></label>
      <label class="field"><span>Password</span>
        <div class="pw"><input type="password" id="password" placeholder="${c ? "(unchanged)" : ""}" autocomplete="new-password"><button type="button" class="secondary" id="showpw">Show</button></div>
      </label>
    </div>
    <label class="field"><span>Database <i>(optional)</i></span><input type="text" id="database" value="${esc(c?.database)}"></label>
    <label class="field"><span>SSL / TLS</span>
      <select id="sslMode">${SSL_MODES.map((m) => `<option value="${m.id}"${ssl.mode === m.id ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
      <div class="hint" id="sslHint"></div>
      <div class="err" id="sslWarn"></div>
    </label>
    <div id="sslFiles" class="hidden">
      ${sslFile("sslCa", "CA certificate", ssl.caFile, "Needed for private or cloud CAs (e.g. RDS, Azure). Leave blank to use the system trust store.")}
      ${sslFile("sslCert", "Client certificate", ssl.certFile, "Only for servers that require a client certificate.")}
      ${sslFile("sslKey", "Client key", ssl.keyFile, "")}
      <label class="field"><span>Client key passphrase <i>(optional)</i></span>
        <input type="password" id="sslPassphrase" placeholder="${ssl.keyFile ? "(unchanged)" : ""}" autocomplete="new-password"></label>
    </div>
  </div>

  <div id="sqlite" class="hidden">
    <label class="field"><span>Database file</span>
      <div class="file"><input type="text" id="file" value="${esc(c?.file)}" placeholder="C:\\path\\to\\data.db"><button type="button" class="secondary" id="browse">Browse…</button></div>
      <div class="err" data-for="file"></div>
    </label>
    <p class="sub" style="margin:0">Type a path that doesn't exist yet to create a new database on first write.</p>
  </div>
</div>

<div class="footer"><div class="in">
  <div class="status" id="status"></div>
  <button class="secondary" id="test">Test connection</button>
  <button id="save">${c ? "Save changes" : "Create connection"}</button>
</div></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const PORTS = { postgres: 5432, mysql: 3306 };
  let autoPort = ${JSON.stringify(c?.port ?? null)};
  const dbType = () => document.querySelector('input[name=dbtype]:checked').value;

  function sync() {
    const t = dbType();
    document.querySelectorAll('.card').forEach((el) => el.classList.toggle('on', el.dataset.t === t));
    $('server').classList.toggle('hidden', t === 'sqlite');
    $('sqlite').classList.toggle('hidden', t !== 'sqlite');
    $('importBox').classList.toggle('hidden', t === 'sqlite');
    if (t !== 'sqlite') {
      $('port').placeholder = PORTS[t];
      // Follow the default port unless the user typed a custom one.
      if (!$('port').value || Number($('port').value) === autoPort) { $('port').value = PORTS[t]; autoPort = PORTS[t]; }
    }
    updateNamePlaceholder();
  }
  function updateNamePlaceholder() {
    if (dbType() === 'sqlite') $('name').placeholder = $('file').value.split(/[\\\\/]/).pop() || 'My SQLite database';
    else $('name').placeholder = ($('database').value ? $('database').value + ' @ ' : '') + ($('host').value || 'localhost');
  }

  const SSL_HINTS = ${JSON.stringify(Object.fromEntries(SSL_MODES.map((m) => [m.id, m.hint])))};
  const isLocalHost = (h) => /^(localhost|127(\\.\\d+){3}|\\[?::1\\]?)$/i.test(h.trim()) || h.trim() === '';
  // New connections follow the host (verified TLS for remote, off for local) until the user picks a mode.
  let sslTouched = ${JSON.stringify(!!c)};
  function autoSsl() {
    if (sslTouched || dbType() === 'sqlite') return;
    $('sslMode').value = isLocalHost($('host').value) ? 'disable' : 'verify-full';
    syncSsl();
  }
  function syncSsl() {
    const mode = $('sslMode').value;
    $('sslHint').textContent = SSL_HINTS[mode] || '';
    $('sslFiles').classList.toggle('hidden', mode === 'disable');
    const weak = (mode === 'disable' || mode === 'require') && !isLocalHost($('host').value);
    $('sslWarn').textContent = !weak ? '' : mode === 'disable'
      ? 'Traffic to a remote host, including your password, is sent unencrypted.'
      : 'The server certificate is not verified, so the connection can be intercepted. Prefer Verify full.';
  }
  // Mirrors sslModeFromParam in ssl.ts for URL import.
  function sslModeFromParam(v) {
    const s = String(v || '').toLowerCase();
    if (SSL_HINTS[s]) return s;
    if (s === 'verify_ca') return 'verify-ca';
    if (s === 'verify_identity') return 'verify-full';
    return /^(true|1|prefer|allow|preferred|required)$/.test(s) ? 'require' : 'disable';
  }

  function setStatus(kind, text) {
    const el = $('status');
    el.className = 'status ' + kind;
    el.textContent = '';
    if (!kind) return;
    const d = document.createElement('span'); d.className = 'dot';
    const t = document.createElement('span'); t.className = 't'; t.textContent = text; t.title = text;
    el.append(d, t);
  }

  function validate() {
    let ok = true;
    const check = (id, bad, msg) => {
      $(id).classList.toggle('bad', bad);
      const e = document.querySelector('[data-for=' + id + ']'); if (e) e.textContent = bad ? msg : '';
      if (bad) ok = false;
    };
    if (dbType() === 'sqlite') check('file', !$('file').value.trim(), 'Choose or enter a file path');
    else check('host', !$('host').value.trim(), 'Host is required');
    return ok;
  }

  function payload(kind) {
    return { type: kind, dbType: dbType(), name: $('name').value, host: $('host').value, port: $('port').value,
      user: $('user').value, password: $('password').value, database: $('database').value,
      sslMode: $('sslMode').value, sslCa: $('sslCa').value, sslCert: $('sslCert').value, sslKey: $('sslKey').value,
      sslPassphrase: $('sslPassphrase').value, file: $('file').value, group: $('group').value, color };
  }
  let color = ${JSON.stringify(c?.color ?? "")};
  document.querySelectorAll('.sw').forEach((b) => b.addEventListener('click', () => {
    color = b.dataset.c;
    document.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b));
  }));
  let busy = false;
  function run(kind) {
    if (busy || !validate()) return;
    busy = true; $('test').disabled = $('save').disabled = true;
    setStatus('busy', kind === 'test' ? 'Testing connection…' : 'Saving…');
    vscode.postMessage(payload(kind));
  }

  function applyUrl() {
    $('urlErr').textContent = '';
    const raw = $('url').value.trim();
    if (!raw) return;
    try {
      const u = new URL(raw);
      const proto = u.protocol.replace(':', '');
      const t = /^postgres(ql)?$/.test(proto) ? 'postgres' : /^(mysql|mariadb)$/.test(proto) ? 'mysql' : null;
      if (!t) throw new Error('Unsupported scheme "' + proto + '" (use postgres:// or mysql://)');
      document.querySelector('input[name=dbtype][value=' + t + ']').checked = true;
      autoPort = null; $('port').value = '';
      sync();
      $('host').value = decodeURIComponent(u.hostname) || 'localhost';
      if (u.port) $('port').value = u.port;
      $('user').value = decodeURIComponent(u.username);
      if (u.password) $('password').value = decodeURIComponent(u.password);
      $('database').value = decodeURIComponent(u.pathname.replace(/^\\//, ''));
      const q = u.searchParams;
      const sslParam = q.get('sslmode') || q.get('ssl') || q.get('ssl-mode');
      sslTouched = !!sslParam;
      if (sslParam) { $('sslMode').value = sslModeFromParam(sslParam); syncSsl(); } else autoSsl();
      $('url').value = '';
      updateNamePlaceholder();
      setStatus('ok', 'Imported — review the fields below');
    } catch (e) { $('urlErr').textContent = e.message; }
  }

  document.querySelectorAll('input[name=dbtype]').forEach((r) => r.addEventListener('change', sync));
  ['host', 'database', 'file'].forEach((id) => $(id).addEventListener('input', () => { updateNamePlaceholder(); $(id).classList.remove('bad'); }));
  $('applyUrl').onclick = applyUrl;
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyUrl(); });
  $('showpw').onclick = () => { const p = $('password'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('showpw').textContent = show ? 'Hide' : 'Show'; };
  $('browse').onclick = () => vscode.postMessage({ type: 'browse' });
  $('sslMode').addEventListener('change', () => { sslTouched = true; syncSsl(); });
  $('host').addEventListener('input', () => { autoSsl(); syncSsl(); });
  document.querySelectorAll('[data-browse]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'browseSsl', field: b.dataset.browse })));
  $('test').onclick = () => run('test');
  $('save').onclick = () => run('save');
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.id !== 'url') run('save'); });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'file') { $('file').value = m.path; $('file').classList.remove('bad'); updateNamePlaceholder(); }
    if (m.type === 'sslFile') $(m.field).value = m.path;
    if (m.type === 'result') {
      busy = false; $('test').disabled = $('save').disabled = false;
      setStatus(m.ok ? 'ok' : 'fail', m.text);
    }
  });
  syncSsl();
  sync();
</script></body></html>`;
}
