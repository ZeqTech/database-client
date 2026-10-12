import { Pool } from "pg";
import { ColumnInfo, ConnectionConfig, DbObject, Diagram, Driver, QueryResult } from "../types";
import { cell, groupRelations } from "../util";

export class PostgresDriver implements Driver {
  readonly hasSchemas = true;
  private pool: Pool;

  constructor(cfg: ConnectionConfig, password: string) {
    this.pool = new Pool({
      host: cfg.host || "localhost",
      port: cfg.port ?? 5432,
      user: cfg.user || undefined,
      password: password || undefined,
      database: cfg.database || undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: 3,
      connectionTimeoutMillis: 10000,
    });
    this.pool.on("error", () => {});
  }

  quote(id: string): string {
    return `"${id.replace(/"/g, '""')}"`;
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.pool.query(
      `select schema_name from information_schema.schemata
       where schema_name not like 'pg\\_%' and schema_name <> 'information_schema'
       order by schema_name`
    );
    return r.rows.map((x) => x.schema_name);
  }

  async listObjects(schema?: string): Promise<DbObject[]> {
    const r = await this.pool.query(
      `select table_name, table_type from information_schema.tables
       where table_schema = $1 order by table_name`,
      [schema ?? "public"]
    );
    return r.rows.map((x) => ({
      name: x.table_name,
      kind: x.table_type === "VIEW" ? "view" : "table",
    }));
  }

  async listColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    const r = await this.pool.query(
      `select c.column_name, c.data_type, c.is_nullable,
         exists (
           select 1 from information_schema.table_constraints tc
           join information_schema.key_column_usage k
             on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
           where tc.constraint_type = 'PRIMARY KEY'
             and tc.table_schema = c.table_schema and tc.table_name = c.table_name
             and k.column_name = c.column_name
         ) as pk
       from information_schema.columns c
       where c.table_schema = $1 and c.table_name = $2
       order by c.ordinal_position`,
      [schema ?? "public", table]
    );
    return r.rows.map((x) => ({
      name: x.column_name,
      type: x.data_type,
      nullable: x.is_nullable === "YES",
      primaryKey: x.pk === true,
    }));
  }

  async getDiagram(schema = "public"): Promise<Diagram> {
    const objs = await this.listObjects(schema);
    const cols = await this.pool.query(
      `select c.table_name, c.column_name, c.data_type, c.is_nullable,
         exists (
           select 1 from information_schema.table_constraints tc
           join information_schema.key_column_usage k
             on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
           where tc.constraint_type = 'PRIMARY KEY'
             and tc.table_schema = c.table_schema and tc.table_name = c.table_name
             and k.column_name = c.column_name
         ) as pk
       from information_schema.columns c
       where c.table_schema = $1
       order by c.table_name, c.ordinal_position`,
      [schema]
    );
    const byTable = new Map<string, ColumnInfo[]>();
    for (const x of cols.rows) {
      const list = byTable.get(x.table_name) ?? [];
      list.push({ name: x.column_name, type: x.data_type, nullable: x.is_nullable === "YES", primaryKey: x.pk === true });
      byTable.set(x.table_name, list);
    }
    const fks = await this.pool.query(
      `select c.conname as name, cl.relname as tbl, a.attname as col,
              rcl.relname as rtbl, ra.attname as rcol
       from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
       join pg_class rcl on rcl.oid = c.confrelid
       join pg_namespace rn on rn.oid = rcl.relnamespace
       cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(attnum, rattnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = k.rattnum
       where c.contype = 'f' and n.nspname = $1 and rn.nspname = $1
       order by c.conname, k.ord`,
      [schema]
    );
    return {
      tables: objs.map((o) => ({ name: o.name, kind: o.kind, columns: byTable.get(o.name) ?? [] })),
      relations: groupRelations(
        fks.rows.map((r) => ({ name: r.name, table: r.tbl, column: r.col, refTable: r.rtbl, refColumn: r.rcol }))
      ),
    };
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const t = Date.now();
    // Multi-statement text yields an array of results; show the last one.
    const res: any = await this.pool.query({ text: sql, rowMode: "array" });
    const r = Array.isArray(res) ? res[res.length - 1] : res;
    const elapsedMs = Date.now() - t;
    if (!r.fields || r.fields.length === 0) {
      return { columns: [], rows: [], affected: r.rowCount ?? 0, elapsedMs };
    }
    const truncated = r.rows.length > maxRows;
    return {
      columns: r.fields.map((f: { name: string }) => f.name),
      rows: r.rows.slice(0, maxRows).map((row: unknown[]) => row.map(cell)),
      elapsedMs,
      truncated,
    };
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
