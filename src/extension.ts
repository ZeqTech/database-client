import * as crypto from "crypto";
import * as vscode from "vscode";
import { openConnectionForm } from "./connectionForm";
import { showDiagram } from "./diagram";
import { ConnectionStore, Sessions } from "./connections";
import { GridPanel } from "./grid";
import { DbNode, DbTreeProvider } from "./tree";
import { CONNECTION_COLORS, ConnColor, ConnectionConfig } from "./types";
import { checkForUpdates, reinstall } from "./updater";
import { statementAt } from "./util";

/** "zeqs-query" is ours alone, so other SQL extensions' Ctrl+Enter bindings do not fire in editors we open. */
const QUERY_LANGS = new Set(["sql", "zeqs-query"]);
const cfg = () => vscode.workspace.getConfiguration("dbclient");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One-time notice: connections saved with the old SSL checkbox never verified the server certificate. */
function warnLegacySsl(ctx: vscode.ExtensionContext, store: ConnectionStore): void {
  const FLAG = "dbclient.legacySslNoticeShown";
  if (ctx.globalState.get<boolean>(FLAG)) return;
  const names = store.list().filter((c) => c.ssl === true).map((c) => c.name);
  if (names.length === 0) return;
  void ctx.globalState.update(FLAG, true);
  void vscode.window.showWarningMessage(
    `${names.length === 1 ? `Connection "${names[0]}" uses` : `${names.length} connections use`} SSL without verifying the server certificate. ` +
      `Edit ${names.length === 1 ? "it" : "them"} and choose "Verify full" (or "Verify CA") to protect against impersonation.`
  );
}

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new ConnectionStore(ctx);
  warnLegacySsl(ctx, store);
  const sessions = new Sessions(store);
  const tree = new DbTreeProvider(store, sessions);
  /** SQL editor URI -> connection id. */
  const bound = new Map<string, string>();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "dbclient.selectConnection";
  const updateStatus = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !QUERY_LANGS.has(ed.document.languageId)) return status.hide();
    const id = bound.get(ed.document.uri.toString());
    const c = id ? store.get(id) : undefined;
    status.text = `$(database) ${c ? c.name : "No connection"}`;
    status.tooltip = "Select database connection for this SQL editor";
    status.show();
  };

  const pickConnection = async (): Promise<ConnectionConfig | undefined> => {
    const all = store.list();
    if (all.length === 0) {
      const a = await vscode.window.showInformationMessage("No connections yet.", "Add Connection");
      if (a) openConnectionForm(store);
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((c) => ({ label: c.name, description: c.type, c })),
      { placeHolder: "Select a connection" }
    );
    return pick?.c;
  };

  const connFrom = async (n?: DbNode) => (n && n.kind !== "group" ? n.cfg : pickConnection());

  /** The connections a tree command applies to: the multi-selection if any, else the clicked node. */
  const connectionsOf = (n?: DbNode, all?: DbNode[]): ConnectionConfig[] => {
    const nodes = all?.length ? all : n ? [n] : [];
    return nodes.flatMap((x) => (x.kind === "connection" ? [x.cfg] : []));
  };

  const openEditor = async (c: ConnectionConfig, content: string) => {
    const doc = await vscode.workspace.openTextDocument({ language: "zeqs-query", content });
    bound.set(doc.uri.toString(), c.id);
    await vscode.window.showTextDocument(doc);
    updateStatus();
  };

  /** Comment naming the target plus a harmless statement that shows what the connection points at. */
  const starterSql = (c: ConnectionConfig, n?: DbNode): string => {
    const where =
      c.type === "sqlite" ? c.file : `${c.host || "localhost"}${c.port ? `:${c.port}` : ""}${c.database ? ` / ${c.database}` : ""}`;
    const label = { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" }[c.type];
    const head = `-- ${c.name} (${label}: ${where})\n`;
    if (n?.kind === "schema") {
      const lit = `'${n.schema.replace(/'/g, "''")}'`;
      return `${head}-- Schema: ${n.schema}\nSELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ${lit} ORDER BY 1;\n`;
    }
    const probe = {
      postgres: "SELECT current_database(), current_user, version();",
      mysql: "SELECT DATABASE() AS db, CURRENT_USER() AS user, VERSION() AS version;",
      sqlite: "SELECT name, type FROM sqlite_master ORDER BY name;",
    }[c.type];
    return `${head}${probe}\n`;
  };

  const qualified = async (n: Extract<DbNode, { kind: "object" }>) => {
    const d = await sessions.get(n.cfg.id);
    return n.schema ? `${d.quote(n.schema)}.${d.quote(n.obj.name)}` : d.quote(n.obj.name);
  };

  /** DDL for the node's scope: one table/view, one schema, or the whole connection. */
  const loadDdl = (c: ConnectionConfig, n?: DbNode) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Loading DDL…" }, async () => {
      const d = await sessions.get(c.id);
      let schema: string | undefined;
      let table: string | undefined;
      if (n?.kind === "schema") schema = n.schema;
      else if (n?.kind === "object") [schema, table] = [n.schema, n.obj.name];
      else if (n?.kind === "column") [schema, table] = [n.schema, n.table];
      const label = [c.name, schema, table].filter(Boolean).join("_");
      const header = `-- DDL for ${[c.name, schema, table].filter(Boolean).join(" / ")} (${c.type})\n-- Generated ${new Date().toISOString()}\n\n`;
      if (table || !d.hasSchemas || schema) return { label, ddl: header + (await d.getDdl(schema, table)) + "\n" };
      const parts: string[] = [];
      for (const s of await d.listSchemas()) parts.push(`-- Schema: ${s}\n${await d.getDdl(s)}`);
      return { label, ddl: header + parts.join("\n\n") + "\n" };
    });

  /** Run indicator next to the connection item: spinner while running, then result summary or error. */
  const runStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  let runTimer: NodeJS.Timeout | undefined;
  const setRun = (text: string, o: { tooltip?: string; error?: boolean; clearAfterMs?: number } = {}) => {
    clearTimeout(runTimer);
    runStatus.text = text;
    runStatus.tooltip = o.tooltip;
    runStatus.backgroundColor = o.error ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    runStatus.show();
    if (o.clearAfterMs) runTimer = setTimeout(() => runStatus.hide(), o.clearAfterMs);
  };
  ctx.subscriptions.push(runStatus, { dispose: () => clearTimeout(runTimer) });

  const rowsText = (n: number, truncated?: boolean) =>
    `${n.toLocaleString()} row${n === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`;

  const runSql = async (c: ConnectionConfig, sql: string) => {
    const key = `results:${c.id}`;
    // Only result sets get a panel; an already-open one is kept up to date.
    const panel = (create: boolean) =>
      create || GridPanel.has(key) ? GridPanel.show(key, `Results — ${c.name}`, () => {}) : undefined;
    setRun(`$(sync~spin) Running on ${c.name}…`, { tooltip: sql.trim().slice(0, 300) });
    try {
      const d = await sessions.get(c.id);
      const r = await d.query(sql, cfg().get<number>("maxRows", 10000));
      const hasRows = r.columns.length > 0;
      const summary = hasRows ? rowsText(r.rows.length, r.truncated) : `${r.affected ?? 0} row(s) affected`;
      panel(hasRows)?.post({
        type: "data",
        columns: r.columns,
        rows: r.rows,
        info: hasRows ? `${summary} · ${r.elapsedMs} ms` : `Statement OK · ${summary} · ${r.elapsedMs} ms`,
      });
      setRun(`$(check) ${c.name}: ${summary} · ${r.elapsedMs} ms`, {
        tooltip: `Query succeeded on ${c.name}`,
        clearAfterMs: 10000,
      });
      if (/^\s*(create|drop|alter|rename)\b/i.test(sql)) tree.refresh();
    } catch (e) {
      const msg = errText(e);
      panel(false)?.post({ type: "data", error: msg });
      setRun(`$(error) ${c.name}: query failed`, { tooltip: msg, error: true });
      vscode.window.showErrorMessage(`${c.name}: ${msg}`);
    }
  };

  const run = async (all: boolean) => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const key = ed.document.uri.toString();
    let c = bound.get(key) ? store.get(bound.get(key)!) : undefined;
    if (!c) {
      c = await pickConnection();
      if (!c) return;
      bound.set(key, c.id);
      updateStatus();
    }
    let sql: string;
    if (!ed.selection.isEmpty) sql = ed.document.getText(ed.selection);
    else if (all) sql = ed.document.getText();
    else sql = statementAt(ed.document.getText(), ed.document.offsetAt(ed.selection.active));
    if (!sql.trim()) {
      vscode.window.showWarningMessage("Nothing to run.");
      return;
    }
    await runSql(c, sql);
  };

  const openTable = async (n: Extract<DbNode, { kind: "object" }>) => {
    const size = cfg().get<number>("pageSize", 100);
    const d = await sessions.get(n.cfg.id);
    const qn = await qualified(n);
    let page = 0;
    let total: number | undefined;
    let custom = false;
    const label = n.schema ? `${n.schema}.${n.obj.name}` : n.obj.name;

    const load = async () => {
      try {
        const r = await d.query(`SELECT * FROM ${qn} LIMIT ${size + 1} OFFSET ${page * size}`, size + 1);
        const hasNext = r.rows.length > size;
        const rows = r.rows.slice(0, size);
        const from = rows.length ? page * size + 1 : 0;
        const range = `Rows ${from.toLocaleString()}–${(page * size + rows.length).toLocaleString()}`;
        grid.post({
          type: "data",
          columns: r.columns,
          rows,
          info: `${label} · ${range}${total !== undefined ? ` of ${total.toLocaleString()}` : ""} · ${r.elapsedMs} ms`,
          paging: { page, hasPrev: page > 0, hasNext },
          editor: true,
        });
      } catch (e) {
        grid.post({ type: "data", error: errText(e) });
      }
    };
    const countRows = () =>
      d
        .query(`SELECT COUNT(*) FROM ${qn}`, 1)
        .then((r) => {
          total = Number(r.rows[0]?.[0]);
          return load();
        })
        .catch(() => {});

    /** Runs the SQL typed in the table view's input (selection, else statement at cursor). */
    const runCustom = async (m: { sql?: string; start?: number; end?: number }) => {
      const text = m.sql ?? "";
      const [a, b] = [Math.min(m.start ?? 0, m.end ?? 0), Math.max(m.start ?? 0, m.end ?? 0)];
      const sql = a !== b ? text.slice(a, b) : statementAt(text, a);
      if (!sql.trim()) {
        grid.post({ type: "data", error: "Nothing to run.", editor: true });
        return;
      }
      custom = true;
      try {
        const r = await d.query(sql, cfg().get<number>("maxRows", 10000));
        const info = r.columns.length
          ? `Query · ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? "" : "s"}${r.truncated ? " (truncated)" : ""} · ${r.elapsedMs} ms`
          : `Statement OK · ${r.affected ?? 0} row(s) affected · ${r.elapsedMs} ms`;
        grid.post({ type: "data", columns: r.columns, rows: r.rows, info, paging: null, editor: true });
        if (/^\s*(create|drop|alter|rename)\b/i.test(sql)) tree.refresh();
      } catch (e) {
        grid.post({ type: "data", error: errText(e), editor: true });
      }
    };

    const grid = GridPanel.show(
      `table:${n.cfg.id}:${label}`,
      label,
      (m) => {
        if (m.type === "page" && !custom) {
          page = Math.max(0, page + (m.dir ?? 0));
          load();
        } else if (m.type === "refresh" || m.type === "reset") {
          custom = false;
          load().then(countRows);
        } else if (m.type === "run") {
          runCustom(m);
        }
      },
      vscode.ViewColumn.Active
    );
    grid.post({ type: "data", editor: true, initSql: `SELECT * FROM ${qn} LIMIT 100;`, info: "Loading…" });
    await load();
    countRows();
  };

  ctx.subscriptions.push(
    status,
    vscode.window.createTreeView("dbclient.connections", {
      treeDataProvider: tree,
      dragAndDropController: tree,
      canSelectMany: true,
      showCollapseAll: true,
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidCloseTextDocument((d) => bound.delete(d.uri.toString())),
    { dispose: () => void sessions.disposeAll() },

    vscode.commands.registerCommand("dbclient.setGroup", async (n?: DbNode, all?: DbNode[]) => {
      const targets = connectionsOf(n, all);
      if (!targets.length) return;
      const groups = [...new Set(store.list().flatMap((c) => (c.group ? [c.group] : [])))].sort();
      const NEW = "$(add) New group…";
      const NONE = "$(close) No group";
      const pick = await vscode.window.showQuickPick([NEW, ...groups, NONE], { placeHolder: "Move to group" });
      if (!pick) return;
      let group: string | undefined;
      if (pick === NEW) {
        const name = (await vscode.window.showInputBox({ prompt: "Group name" }))?.trim();
        if (!name) return;
        group = name;
      } else if (pick !== NONE) group = pick;
      await store.saveMany(targets.map((c) => ({ ...c, group })));
    }),
    vscode.commands.registerCommand("dbclient.setColor", async (n?: DbNode, all?: DbNode[]) => {
      const targets = connectionsOf(n, all);
      if (!targets.length) return;
      const items = [
        { label: "None", id: undefined as ConnColor | undefined, iconPath: new vscode.ThemeIcon("circle-slash") },
        ...(Object.entries(CONNECTION_COLORS) as [ConnColor, (typeof CONNECTION_COLORS)[ConnColor]][]).map(([id, v]) => ({
          label: v.label,
          id,
          iconPath: new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(v.themeColor)),
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Connection color" });
      if (pick) await store.saveMany(targets.map((c) => ({ ...c, color: pick.id })));
    }),
    vscode.commands.registerCommand("dbclient.renameGroup", async (n?: DbNode) => {
      if (n?.kind !== "group") return;
      const name = (await vscode.window.showInputBox({ prompt: "Rename group", value: n.name }))?.trim();
      if (!name || name === n.name) return;
      await store.saveMany(store.list().filter((c) => c.group === n.name).map((c) => ({ ...c, group: name })));
    }),
    vscode.commands.registerCommand("dbclient.removeGroup", async (n?: DbNode) => {
      if (n?.kind !== "group") return;
      const ok = await vscode.window.showWarningMessage(
        `Remove group "${n.name}"? Its connections are kept and become ungrouped.`,
        { modal: true },
        "Remove Group"
      );
      if (ok) await store.saveMany(store.list().filter((c) => c.group === n.name).map((c) => ({ ...c, group: undefined })));
    }),
    vscode.commands.registerCommand("dbclient.addConnection", () => openConnectionForm(store)),
    vscode.commands.registerCommand("dbclient.editConnection", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (c) openConnectionForm(store, c);
    }),
    vscode.commands.registerCommand("dbclient.duplicateConnection", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      const copy = { ...c, id: crypto.randomUUID(), name: `${c.name} (copy)` };
      await store.save(copy, await store.getPassword(c.id), await store.getSslPassphrase(c.id));
    }),
    vscode.commands.registerCommand("dbclient.deleteConnection", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      const ok = await vscode.window.showWarningMessage(`Delete connection "${c.name}"?`, { modal: true }, "Delete");
      if (ok) {
        await sessions.disconnect(c.id);
        await store.remove(c.id);
      }
    }),
    vscode.commands.registerCommand("dbclient.disconnect", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      await sessions.disconnect(c.id, { collapse: true });
      tree.refresh();
    }),
    vscode.commands.registerCommand("dbclient.refresh", async (n?: DbNode) => {
      if (n?.kind === "connection") await sessions.disconnect(n.cfg.id);
      tree.refresh(n);
    }),
    vscode.commands.registerCommand("dbclient.openTable", async (n?: DbNode) => {
      if (n?.kind !== "object") return;
      try {
        await openTable(n);
      } catch (e) {
        vscode.window.showErrorMessage(errText(e));
      }
    }),
    vscode.commands.registerCommand("dbclient.newQuery", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      let sql = starterSql(c, n);
      if (n?.kind === "object") sql = `SELECT * FROM ${await qualified(n)} LIMIT 100;\n`;
      await openEditor(c, sql);
    }),
    vscode.commands.registerCommand("dbclient.showDiagram", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      try {
        const d = await sessions.get(c.id);
        let schema: string | undefined;
        let focus: string | undefined;
        if (n?.kind === "schema") schema = n.schema;
        else if (n?.kind === "object" || n?.kind === "column") {
          schema = n.schema;
          focus = n.kind === "object" ? n.obj.name : n.table;
        } else if (d.hasSchemas) {
          const schemas = await d.listSchemas();
          schema = schemas.length === 1 ? schemas[0] : await vscode.window.showQuickPick(schemas, { placeHolder: "Select a schema" });
          if (!schema) return;
        }
        const label = schema ? `${c.name} / ${schema}` : c.name;
        await showDiagram(`${c.id}:${schema ?? ""}`, label, () => d.getDiagram(schema), focus);
      } catch (e) {
        vscode.window.showErrorMessage(errText(e));
      }
    }),
    vscode.commands.registerCommand("dbclient.viewDdl", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      try {
        const { ddl } = await loadDdl(c, n);
        await openEditor(c, ddl);
      } catch (e) {
        vscode.window.showErrorMessage(errText(e));
      }
    }),
    vscode.commands.registerCommand("dbclient.generateSql", async (n?: DbNode) => {
      if (n?.kind !== "object") return;
      const pick = await vscode.window.showQuickPick(["SELECT", "INSERT", "UPDATE", "DELETE"], {
        placeHolder: `Generate SQL for ${n.obj.name}`,
      });
      if (!pick) return;
      try {
        const d = await sessions.get(n.cfg.id);
        const cols = await d.listColumns(n.obj.name, n.schema);
        const names = cols.map((c) => d.quote(c.name));
        const keys = cols.filter((c) => c.primaryKey).map((c) => d.quote(c.name));
        const where = `WHERE ${(keys.length ? keys : names.slice(0, 1)).map((k) => `${k} = `).join(" AND ")}`;
        const qn = await qualified(n);
        const sql = {
          SELECT: `SELECT ${names.join(", ")}\nFROM ${qn}\nLIMIT 100;\n`,
          INSERT: `INSERT INTO ${qn} (${names.join(", ")})\nVALUES (${names.map(() => "").join(", ")});\n`,
          UPDATE: `UPDATE ${qn}\nSET ${names.map((c) => `${c} = `).join(",\n    ")}\n${where};\n`,
          DELETE: `DELETE FROM ${qn}\n${where};\n`,
        }[pick];
        await openEditor(n.cfg, sql!);
      } catch (e) {
        vscode.window.showErrorMessage(errText(e));
      }
    }),
    vscode.commands.registerCommand("dbclient.copyDdl", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      try {
        await vscode.env.clipboard.writeText((await loadDdl(c, n)).ddl);
        vscode.window.setStatusBarMessage("DDL copied to clipboard", 3000);
      } catch (e) {
        vscode.window.showErrorMessage(errText(e));
      }
    }),
    vscode.commands.registerCommand("dbclient.exportDdl", async (n?: DbNode) => {
      const c = await connFrom(n);
      if (!c) return;
      try {
        const { ddl, label } = await loadDdl(c, n);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${label.replace(/[^\w.-]+/g, "_")}.sql`),
          filters: { SQL: ["sql"] },
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(ddl, "utf8"));
        vscode.window.showInformationMessage(`DDL exported to ${uri.fsPath}`);
      } catch (e) {
        vscode.window.showErrorMessage(errText(e));
      }
    }),
    vscode.commands.registerCommand("dbclient.runQuery", () => run(false)),
    vscode.commands.registerCommand("dbclient.runAll", () => run(true)),
    vscode.commands.registerCommand("dbclient.selectConnection", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const c = await pickConnection();
      if (c) {
        bound.set(ed.document.uri.toString(), c.id);
        updateStatus();
      }
    }),
    vscode.commands.registerCommand("dbclient.checkForUpdates", () => checkForUpdates(ctx)),
    vscode.commands.registerCommand("dbclient.reinstall", () => reinstall(ctx)),
    vscode.commands.registerCommand("dbclient.copyName", async (n?: DbNode) => {
      if (!n) return;
      const name =
        n.kind === "schema" ? n.schema : n.kind === "object" ? n.obj.name : n.kind === "column" ? n.col.name : undefined;
      if (name) await vscode.env.clipboard.writeText(name);
    })
  );
  updateStatus();
  if (cfg().get<boolean>("update.checkOnStartup", false)) void checkForUpdates(ctx, true);
}

export function deactivate(): void {}
