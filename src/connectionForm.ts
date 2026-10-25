import * as crypto from "crypto";
import * as vscode from "vscode";
import { ConnectionStore, testConnection } from "./connections";
import { connectionFormHtml } from "./connectionFormHtml";
import { isSslMode } from "./ssl";
import { ConnColor, CONNECTION_COLORS, ConnectionConfig, DbType } from "./types";

const open = new Map<string, vscode.WebviewPanel>();

/** Webview form to create or edit a connection. */
export function openConnectionForm(store: ConnectionStore, existing?: ConnectionConfig): void {
  const formKey = existing?.id ?? "new";
  const prior = open.get(formKey);
  if (prior) {
    prior.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "dbclient.form",
    existing ? `Edit ${existing.name}` : "New Connection",
    vscode.ViewColumn.Active,
    // Keep typed-in fields when the user switches to another tab and back.
    { enableScripts: true, retainContextWhenHidden: true }
  );
  open.set(formKey, panel);
  panel.onDidDispose(() => open.delete(formKey));
  panel.webview.html = connectionFormHtml(existing, [...new Set(store.list().flatMap((c) => (c.group ? [c.group] : [])))].sort());

  const build = (m: any): ConnectionConfig => {
    const type = m.dbType as DbType;
    const cfg: ConnectionConfig = {
      id: existing?.id ?? crypto.randomUUID(),
      name:
        String(m.name || "").trim() ||
        (type === "sqlite"
          ? String(m.file || "").split(/[\\/]/).pop() || "SQLite"
          : `${m.database ? m.database + " @ " : ""}${m.host || "localhost"}`),
      type,
      group: String(m.group || "").trim() || undefined,
      color: m.color in CONNECTION_COLORS ? (m.color as ConnColor) : undefined,
    };
    if (type === "sqlite") cfg.file = String(m.file || "").trim();
    else {
      cfg.host = String(m.host || "localhost").trim();
      cfg.port = m.port ? Number(m.port) : undefined;
      cfg.user = String(m.user || "").trim() || undefined;
      cfg.database = String(m.database || "").trim() || undefined;
      const mode = isSslMode(m.sslMode) ? m.sslMode : "disable";
      const file = (v: unknown) => String(v || "").trim() || undefined;
      cfg.ssl =
        mode === "disable"
          ? undefined
          : { mode, caFile: file(m.sslCa), certFile: file(m.sslCert), keyFile: file(m.sslKey) };
    }
    return cfg;
  };

  // Blank password on edit keeps the stored one.
  const passwordFor = async (m: any, cfg: ConnectionConfig): Promise<string> =>
    m.password ? String(m.password) : existing ? await store.getPassword(existing.id) : "";

  // Blank key passphrase on edit keeps the stored one.
  const passphraseFor = async (m: any): Promise<string> =>
    m.sslPassphrase ? String(m.sslPassphrase) : existing ? await store.getSslPassphrase(existing.id) : "";

  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      if (m.type === "browse") {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { SQLite: ["db", "sqlite", "sqlite3", "db3"], All: ["*"] },
        });
        if (picked?.[0]) panel.webview.postMessage({ type: "file", path: picked[0].fsPath });
      } else if (m.type === "browseSsl") {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "PEM / certificate": ["pem", "crt", "cer", "key"], All: ["*"] },
        });
        if (picked?.[0] && ["sslCa", "sslCert", "sslKey"].includes(m.field)) {
          panel.webview.postMessage({ type: "sslFile", field: m.field, path: picked[0].fsPath });
        }
      } else if (m.type === "test") {
        const cfg = build(m);
        await testConnection(cfg, await passwordFor(m, cfg), await passphraseFor(m));
        panel.webview.postMessage({ type: "result", ok: true, text: "Connection successful" });
      } else if (m.type === "save") {
        const cfg = build(m);
        if (cfg.type === "sqlite" && !cfg.file) throw new Error("Choose a SQLite file");
        await store.save(
          cfg,
          m.password ? String(m.password) : existing ? undefined : "",
          m.sslPassphrase ? String(m.sslPassphrase) : existing ? undefined : ""
        );
        panel.dispose();
      }
    } catch (e) {
      panel.webview.postMessage({ type: "result", ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  });
}
