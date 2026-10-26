import * as vscode from "vscode";
import { ConnectionStore, describeConnectError, Sessions } from "./connections";
import { CONNECTION_COLORS, ColumnInfo, ConnectionConfig, DbObject, Driver } from "./types";

export type DbNode =
  | { kind: "group"; name: string }
  | { kind: "connection"; cfg: ConnectionConfig }
  | { kind: "schema"; cfg: ConnectionConfig; schema: string }
  | { kind: "object"; cfg: ConnectionConfig; schema?: string; obj: DbObject }
  | { kind: "column"; cfg: ConnectionConfig; schema?: string; table: string; col: ColumnInfo }
  | { kind: "error"; cfg: ConnectionConfig; message: string };

const TYPE_LABEL = { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" } as const;

const DRAG_MIME = "application/vnd.code.tree.dbclient.connections";
const byName = (a: ConnectionConfig, b: ConnectionConfig) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

const CONNECTION_SCHEME = "dbclient-connection";
const connectionUri = (id: string) => vscode.Uri.from({ scheme: CONNECTION_SCHEME, path: `/${id}` });

/** Green dot badge and green name on connections that currently hold an open session. */
export class ConnectionDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly sessions: Sessions) {
    sessions.onDidChangeConnected((id) => this.emitter.fire([connectionUri(id)]));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CONNECTION_SCHEME || !this.sessions.isConnected(uri.path.slice(1))) return undefined;
    return new vscode.FileDecoration("●", "Connected", new vscode.ThemeColor("charts.green"));
  }
}

export class DbTreeProvider implements vscode.TreeDataProvider<DbNode>, vscode.TreeDragAndDropController<DbNode> {
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

  private readonly emitter = new vscode.EventEmitter<DbNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: ConnectionStore, private readonly sessions: Sessions) {
    store.onDidChange(() => this.refresh());
    // Re-render a node when it connects so its Close button appears (disconnects refresh via the command).
    sessions.onDidChangeConnected((id) => {
      const cfg = store.get(id);
      if (cfg && sessions.isConnected(id)) this.refresh({ kind: "connection", cfg });
    });
  }

  refresh(node?: DbNode): void {
    this.emitter.fire(node);
  }

  /** Dragging connections onto a group (or another connection) moves them there; onto empty space ungroups. */
  handleDrag(source: readonly DbNode[], data: vscode.DataTransfer): void {
    const ids = source.flatMap((n) => (n.kind === "connection" ? [n.cfg.id] : []));
    if (ids.length) data.set(DRAG_MIME, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target: DbNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(DRAG_MIME);
    if (!item) return;
    let group: string | undefined;
    if (target?.kind === "group") group = target.name;
    else if (target?.kind === "connection") group = target.cfg.group;
    else if (target) return;
    const ids: string[] = item.value;
    const moved = this.store.list().filter((c) => ids.includes(c.id)).map((c) => ({ ...c, group }));
    if (moved.length) await this.store.saveMany(moved);
  }

  getTreeItem(n: DbNode): vscode.TreeItem {
    switch (n.kind) {
      case "group": {
        const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${n.name}`;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.description = String(this.store.list().filter((c) => c.group === n.name).length);
        item.contextValue = "group";
        return item;
      }
      case "connection": {
        const item = new vscode.TreeItem(n.cfg.name, vscode.TreeItemCollapsibleState.Collapsed);
        // The epoch changes on Disconnect, which makes VS Code rebuild the node collapsed instead of re-expanding (and silently reconnecting).
        item.id = `connection:${n.cfg.id}:${this.sessions.epoch(n.cfg.id)}`;
        const where = n.cfg.type === "sqlite" ? n.cfg.file : `${n.cfg.host || "localhost"}`;
        item.description = `${TYPE_LABEL[n.cfg.type]} · ${where}`;
        const connected = this.sessions.isConnected(n.cfg.id);
        const color = n.cfg.color ? CONNECTION_COLORS[n.cfg.color].themeColor : undefined;
        // Open: plug icon, green name and a dot badge (see ConnectionDecorations). Closed: dimmed database icon.
        item.iconPath = connected
          ? new vscode.ThemeIcon("plug", new vscode.ThemeColor(color ?? "charts.green"))
          : new vscode.ThemeIcon("database", new vscode.ThemeColor(color ?? "disabledForeground"));
        item.resourceUri = connectionUri(n.cfg.id);
        item.contextValue = connected ? "connection-open" : "connection";
        item.tooltip = `${n.cfg.name}\n${TYPE_LABEL[n.cfg.type]} · ${where}\n${connected ? "Connected" : "Not connected (expand to connect)"}`;
        return item;
      }
      case "schema": {
        const item = new vscode.TreeItem(
          n.schema,
          n.schema === "public" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.iconPath = new vscode.ThemeIcon("symbol-namespace");
        item.contextValue = "schema";
        return item;
      }
      case "object": {
        const item = new vscode.TreeItem(n.obj.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(n.obj.kind === "view" ? "eye" : "table");
        item.contextValue = n.obj.kind;
        item.command = { command: "dbclient.openTable", title: "Open Table Data", arguments: [n] };
        return item;
      }
      case "column": {
        const item = new vscode.TreeItem(n.col.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${n.col.type}${n.col.nullable ? "" : " not null"}`;
        item.iconPath = new vscode.ThemeIcon(n.col.primaryKey ? "key" : "symbol-field");
        item.contextValue = "column";
        return item;
      }
      case "error": {
        const item = new vscode.TreeItem(n.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
        item.tooltip = n.message;
        item.contextValue = "error";
        return item;
      }
    }
  }

  async getChildren(n?: DbNode): Promise<DbNode[]> {
    if (!n || n.kind === "group") {
      const all = this.store.list().sort(byName);
      if (n) return all.filter((c) => c.group === n.name).map((cfg) => ({ kind: "connection", cfg }));
      const groups = [...new Set(all.flatMap((c) => (c.group ? [c.group] : [])))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
      return [
        ...groups.map((name): DbNode => ({ kind: "group", name })),
        ...all.filter((c) => !c.group).map((cfg): DbNode => ({ kind: "connection", cfg })),
      ];
    }
    let session: Promise<Driver> | undefined;
    try {
      switch (n.kind) {
        case "connection": {
          session = this.sessions.get(n.cfg.id);
          const d = await session;
          if (d.hasSchemas) {
            const schemas = await d.listSchemas();
            this.sessions.markConnected(n.cfg.id);
            return schemas.map((schema) => ({ kind: "schema", cfg: n.cfg, schema }));
          }
          const objs = await d.listObjects();
          this.sessions.markConnected(n.cfg.id);
          return objs.map((obj) => ({ kind: "object", cfg: n.cfg, obj }));
        }
        case "schema": {
          const d = await this.sessions.get(n.cfg.id);
          const objs = await d.listObjects(n.schema);
          return objs.map((obj) => ({ kind: "object", cfg: n.cfg, schema: n.schema, obj }));
        }
        case "object": {
          const d = await this.sessions.get(n.cfg.id);
          const cols = await d.listColumns(n.obj.name, n.schema);
          return cols.map((col) => ({ kind: "column", cfg: n.cfg, schema: n.schema, table: n.obj.name, col }));
        }
        default:
          return [];
      }
    } catch (e) {
      if (n.kind === "connection") {
        // Drop the cached driver so the next expand retries with fresh settings.
        await this.sessions.disconnect(n.cfg.id, { only: session });
      }
      return [{ kind: "error", cfg: n.cfg, message: describeConnectError(n.cfg, e) }];
    }
  }
}
