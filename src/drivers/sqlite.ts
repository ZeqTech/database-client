import * as fs from "fs";
import * as path from "path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { ColumnInfo, ConnectionConfig, DbObject, Diagram, Driver, QueryResult, Relation } from "../types";
import { cell } from "../util";

let sqlJs: Promise<SqlJsStatic> | undefined;
function loadSqlJs(): Promise<SqlJsStatic> {
  // The wasm file is copied next to the bundle by esbuild.js.
  sqlJs ??= initSqlJs({ locateFile: (f) => path.join(__dirname, f) });
  return sqlJs;
}

const READ_ONLY = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(select|explain)\b/i;

/** SQLite through sql.js (pure wasm: no native build per Electron version). The file is rewritten after any statement that may change it. */
export class SqliteDriver implements Driver {
  readonly hasSchemas = false;
  private db?: Database;
  private mtime = 0;
  private file: string;

  constructor(cfg: ConnectionConfig) {
    if (!cfg.file) throw new Error("No SQLite file configured");
    this.file = cfg.file;
  }

  quote(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }

  /** (Re)loads the file when it changed on disk. */
  private async open(): Promise<Database> {
    const mtime = fs.existsSync(this.file) ? fs.statSync(this.file).mtimeMs : 0;
    if (!this.db || mtime !== this.mtime) {
      const SQL = await loadSqlJs();
      this.db?.close();
      this.db = mtime ? new SQL.Database(fs.readFileSync(this.file)) : new SQL.Database();
      this.mtime = mtime;
    }
    return this.db;
  }

  private async rows(sql: string, params: (string | number)[] = []): Promise<Record<string, unknown>[]> {
    const db = await this.open();
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const out: Record<string, unknown>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listObjects(): Promise<DbObject[]> {
    const r = await this.rows(
      "select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite\\_%' escape '\\' order by name"
    );
    return r.map((x) => ({ name: String(x.name), kind: x.type === "view" ? "view" : "table" }));
  }

  async listColumns(table: string): Promise<ColumnInfo[]> {
    const r = await this.rows(`pragma table_info(${this.quote(table)})`);
    return r.map((x) => ({
      name: String(x.name),
      type: String(x.type ?? ""),
      nullable: !x.notnull,
      primaryKey: Number(x.pk) > 0,
    }));
  }

  async getDiagram(): Promise<Diagram> {
    const objs = await this.listObjects();
    const tables: Diagram["tables"] = [];
    const relations: Relation[] = [];
    const pkOf = new Map<string, string[]>();
    for (const o of objs) {
      const columns = await this.listColumns(o.name);
      tables.push({ name: o.name, kind: o.kind, columns });
      pkOf.set(o.name, columns.filter((c) => c.primaryKey).map((c) => c.name));
    }
    for (const o of objs.filter((x) => x.kind === "table")) {
      const rows = await this.rows(`pragma foreign_key_list(${this.quote(o.name)})`);
      const byId = new Map<number, Relation>();
      for (const r of rows) {
        const id = Number(r.id);
        let rel = byId.get(id);
        if (!rel) {
          rel = { name: `fk_${o.name}_${id}`, table: o.name, columns: [], refTable: String(r.table), refColumns: [] };
          byId.set(id, rel);
          relations.push(rel);
        }
        rel.columns.push(String(r.from));
        // `to` is null when the FK implicitly targets the parent's primary key.
        rel.refColumns.push(r.to ? String(r.to) : pkOf.get(rel.refTable)?.[rel.columns.length - 1] ?? "");
      }
    }
    return { tables, relations: relations.filter((r) => pkOf.has(r.refTable)) };
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const db = await this.open();
    const t = Date.now();
    const sets = db.exec(sql);
    const elapsedMs = Date.now() - t;
    // export() resets the change counter, so read it first.
    const modified = db.getRowsModified();
    if (!READ_ONLY.test(sql)) {
      fs.writeFileSync(this.file, Buffer.from(db.export()));
      this.mtime = fs.statSync(this.file).mtimeMs;
    }
    const last = sets[sets.length - 1];
    if (!last) {
      return { columns: [], rows: [], affected: modified, elapsedMs };
    }
    return {
      columns: last.columns,
      rows: last.values.slice(0, maxRows).map((row) => row.map(cell)),
      elapsedMs,
      truncated: last.values.length > maxRows,
    };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
