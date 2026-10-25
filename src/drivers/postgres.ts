import { Pool } from "pg";
import { ColumnInfo, ConnectionConfig, DbObject, Diagram, Driver, QueryResult } from "../types";
import { buildSslOptions } from "../ssl";
import { cell, groupRelations } from "../util";

export class PostgresDriver implements Driver {
  readonly hasSchemas = true;
  private pool: Pool;

  constructor(cfg: ConnectionConfig, password: string, sslKeyPassphrase?: string, connectTimeoutMs = 10000) {
    this.pool = new Pool({
      host: cfg.host || "localhost",
      port: cfg.port ?? 5432,
      user: cfg.user || undefined,
      password: password || undefined,
      database: cfg.database || undefined,
      ssl: buildSslOptions(cfg, sslKeyPassphrase),
      max: 3,
      connectionTimeoutMillis: connectTimeoutMs,
      keepAlive: true,
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

  async getDdl(schema = "public", table?: string): Promise<string> {
    const q = (id: string) => this.quote(id);
    const parts: string[] = [];
    if (!table && schema !== "public") parts.push(`CREATE SCHEMA IF NOT EXISTS ${q(schema)};`);

    const rels = (
      await this.pool.query(
        `select c.oid::int8 as oid, c.relname, c.relkind, c.relispartition,
                case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partkey,
                case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end as bound,
                (select pc.relname from pg_inherits i join pg_class pc on pc.oid = i.inhparent
                  where i.inhrelid = c.oid) as parent,
                case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end as viewdef
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in ('r','p','v','m') and ($2::text is null or c.relname = $2)
         order by c.relname`,
        [schema, table ?? null]
      )
    ).rows;
    const oids = rels.map((r) => r.oid);

    if (!table) {
      const seqs = await this.pool.query(
        `select s.sequencename as name, s.data_type::text as type, s.start_value, s.min_value, s.max_value,
                s.increment_by, s.cycle
         from pg_sequences s
         where s.schemaname = $1 and not exists (
           select 1 from pg_depend d
           where d.objid = (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))::regclass
             and d.deptype = 'i')
         order by s.sequencename`,
        [schema]
      );
      for (const s of seqs.rows) {
        parts.push(
          `CREATE SEQUENCE ${q(schema)}.${q(s.name)} AS ${s.type} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} ` +
            `MAXVALUE ${s.max_value} START WITH ${s.start_value}${s.cycle ? " CYCLE" : ""};`
        );
      }
    }

    const cols = await this.pool.query(
      `select a.attrelid::int8 as oid, a.attname, format_type(a.atttypid, a.atttypmod) as typ,
              a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) as def
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
       order by a.attrelid, a.attnum`,
      [oids]
    );
    const cons = await this.pool.query(
      `select conrelid::int8 as oid, conname, contype, pg_get_constraintdef(oid) as def
       from pg_constraint where conrelid = any($1::oid[])
       order by case contype when 'p' then 0 when 'u' then 1 when 'c' then 2 else 3 end, conname`,
      [oids]
    );
    const idx = await this.pool.query(
      `select i.indrelid::int8 as oid, pg_get_indexdef(i.indexrelid) as def
       from pg_index i
       where i.indrelid = any($1::oid[])
         and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
       order by 2`,
      [oids]
    );
    const group = <T extends { oid: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) m.set(r.oid, [...(m.get(r.oid) ?? []), r]);
      return m;
    };
    const colsBy = group(cols.rows);
    const consBy = group(cons.rows);
    const idxBy = group(idx.rows);
    const alters: string[] = [];
    const indexes: string[] = [];
    const views: string[] = [];

    for (const r of rels) {
      const name = `${q(schema)}.${q(r.relname)}`;
      if (r.viewdef) {
        const kind = r.relkind === "m" ? "MATERIALIZED VIEW" : "VIEW";
        views.push(`CREATE ${kind} ${name} AS\n${String(r.viewdef).trim().replace(/;$/, "")};`);
      } else if (r.relispartition) {
        parts.push(`CREATE TABLE ${name} PARTITION OF ${q(schema)}.${q(r.parent)} ${r.bound};`);
      } else {
        const lines = (colsBy.get(r.oid) ?? []).map((c) => {
          let l = `  ${q(c.attname)} ${c.typ}`;
          if (c.attgenerated === "s") l += ` GENERATED ALWAYS AS (${c.def}) STORED`;
          else if (c.attidentity === "a") l += " GENERATED ALWAYS AS IDENTITY";
          else if (c.attidentity === "d") l += " GENERATED BY DEFAULT AS IDENTITY";
          else if (c.def !== null) l += ` DEFAULT ${c.def}`;
          if (c.attnotnull) l += " NOT NULL";
          return l;
        });
        for (const k of consBy.get(r.oid) ?? []) {
          // Foreign keys go last so referenced tables already exist.
          if (k.contype === "f") alters.push(`ALTER TABLE ONLY ${name}\n  ADD CONSTRAINT ${q(k.conname)} ${k.def};`);
          else lines.push(`  CONSTRAINT ${q(k.conname)} ${k.def}`);
        }
        parts.push(`CREATE TABLE ${name} (\n${lines.join(",\n")}\n)${r.partkey ? ` PARTITION BY ${r.partkey}` : ""};`);
      }
      for (const i of idxBy.get(r.oid) ?? []) indexes.push(`${i.def};`);
    }
    return [...parts, ...alters, ...indexes, ...views].join("\n\n");
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
