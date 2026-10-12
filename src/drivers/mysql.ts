import * as mysql from "mysql2/promise";
import { ColumnInfo, ConnectionConfig, DbObject, Diagram, Driver, QueryResult } from "../types";
import { cell, groupRelations } from "../util";

const SYSTEM_DBS = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

export class MySqlDriver implements Driver {
  readonly hasSchemas = true;
  private pool: mysql.Pool;

  constructor(cfg: ConnectionConfig, password: string) {
    this.pool = mysql.createPool({
      host: cfg.host || "localhost",
      port: cfg.port ?? 3306,
      user: cfg.user || undefined,
      password: password || undefined,
      database: cfg.database || undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      multipleStatements: true,
      connectionLimit: 3,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  }

  quote(id: string): string {
    return `\`${id.replace(/`/g, "``")}\``;
  }

  async listSchemas(): Promise<string[]> {
    const [rows] = await this.pool.query<any[]>("select schema_name as name from information_schema.schemata order by 1");
    return rows.map((r) => r.name as string).filter((n) => !SYSTEM_DBS.has(n.toLowerCase()));
  }

  async listObjects(schema?: string): Promise<DbObject[]> {
    const [rows] = await this.pool.query<any[]>(
      "select table_name as name, table_type as type from information_schema.tables where table_schema = ? order by 1",
      [schema]
    );
    return rows.map((r) => ({ name: r.name, kind: r.type === "VIEW" ? "view" : "table" }));
  }

  async listColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const [rows] = await this.pool.query<any[]>(
      `select column_name as name, column_type as type, is_nullable as nullable, column_key as ckey
       from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
      [schema, table]
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable === "YES",
      primaryKey: r.ckey === "PRI",
    }));
  }

  async getDiagram(schema?: string): Promise<Diagram> {
    const objs = await this.listObjects(schema);
    const [cols] = await this.pool.query<any[]>(
      `select table_name as tbl, column_name as name, column_type as type, is_nullable as nullable, column_key as ckey
       from information_schema.columns where table_schema = ? order by table_name, ordinal_position`,
      [schema]
    );
    const byTable = new Map<string, ColumnInfo[]>();
    for (const x of cols) {
      const list = byTable.get(x.tbl) ?? [];
      list.push({ name: x.name, type: x.type, nullable: x.nullable === "YES", primaryKey: x.ckey === "PRI" });
      byTable.set(x.tbl, list);
    }
    const [fks] = await this.pool.query<any[]>(
      `select constraint_name as name, table_name as tbl, column_name as col,
              referenced_table_name as rtbl, referenced_column_name as rcol
       from information_schema.key_column_usage
       where table_schema = ? and referenced_table_schema = ? and referenced_table_name is not null
       order by table_name, constraint_name, ordinal_position`,
      [schema, schema]
    );
    return {
      tables: objs.map((o) => ({ name: o.name, kind: o.kind, columns: byTable.get(o.name) ?? [] })),
      relations: groupRelations(
        fks.map((r) => ({ name: r.name, table: r.tbl, column: r.col, refTable: r.rtbl, refColumn: r.rcol }))
      ),
    };
  }

  async getDdl(schema?: string, table?: string): Promise<string> {
    const objs = (await this.listObjects(schema)).filter((o) => !table || o.name === table);
    // Tables first so views can reference them.
    objs.sort((a, b) => Number(a.kind === "view") - Number(b.kind === "view"));
    const parts: string[] = [];
    if (!table && schema) {
      parts.push(`CREATE DATABASE IF NOT EXISTS ${this.quote(schema)};\nUSE ${this.quote(schema)};`);
    }
    for (const o of objs) {
      const qn = (schema ? `${this.quote(schema)}.` : "") + this.quote(o.name);
      const [rows] = await this.pool.query<any[]>(`SHOW CREATE ${o.kind === "view" ? "VIEW" : "TABLE"} ${qn}`);
      const sql = rows[0]?.["Create Table"] ?? rows[0]?.["Create View"];
      if (sql) parts.push(`${sql};`);
    }
    return parts.join("\n\n");
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const t = Date.now();
    const [res, fields] = (await this.pool.query({ sql, rowsAsArray: true })) as [any, any];
    const elapsedMs = Date.now() - t;

    // With multipleStatements, results/fields are parallel arrays (one entry per statement).
    const isMulti =
      Array.isArray(res) &&
      (fields === undefined ||
        (Array.isArray(fields) && fields.every((f: unknown) => f === undefined || Array.isArray(f))));
    const results: any[] = isMulti ? res : [res];
    const fieldSets: any[] = isMulti ? fields ?? [] : [fields];

    let idx = -1;
    for (let i = results.length - 1; i >= 0; i--) {
      if (Array.isArray(fieldSets[i])) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      const last = results[results.length - 1];
      return { columns: [], rows: [], affected: last?.affectedRows ?? 0, elapsedMs };
    }
    const rows: unknown[][] = results[idx];
    return {
      columns: fieldSets[idx].map((f: { name: string }) => f.name),
      rows: rows.slice(0, maxRows).map((row) => row.map(cell)),
      elapsedMs,
      truncated: rows.length > maxRows,
    };
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
