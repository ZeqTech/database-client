export type DbType = "postgres" | "mysql" | "sqlite";

export type ConnColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "gray";

/** `themeColor` colours tree icons (VS Code only allows theme colour ids there); `hex` is for the webview swatches. */
export const CONNECTION_COLORS: Record<ConnColor, { label: string; themeColor: string; hex: string }> = {
  red: { label: "Red", themeColor: "charts.red", hex: "#f14c4c" },
  orange: { label: "Orange", themeColor: "charts.orange", hex: "#d18616" },
  yellow: { label: "Yellow", themeColor: "charts.yellow", hex: "#cca700" },
  green: { label: "Green", themeColor: "charts.green", hex: "#89d185" },
  blue: { label: "Blue", themeColor: "charts.blue", hex: "#3794ff" },
  purple: { label: "Purple", themeColor: "charts.purple", hex: "#b180d7" },
  pink: { label: "Pink", themeColor: "terminal.ansiBrightMagenta", hex: "#d670d6" },
  gray: { label: "Gray", themeColor: "disabledForeground", hex: "#8a8a8a" },
};

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: boolean;
  /** SQLite database file path. */
  file?: string;
  /** Folder the connection is listed under in the tree. */
  group?: string;
  color?: ConnColor;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows changed, for statements that return no result set. */
  affected?: number;
  elapsedMs: number;
  truncated?: boolean;
}

export interface DbObject {
  name: string;
  kind: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface DiagramTable {
  name: string;
  kind: "table" | "view";
  columns: ColumnInfo[];
}

/** A foreign key: `table.columns` references `refTable.refColumns`. */
export interface Relation {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface Diagram {
  tables: DiagramTable[];
  relations: Relation[];
}

export interface Driver {
  /** True when objects live under schemas/databases (Postgres, MySQL). */
  readonly hasSchemas: boolean;
  quote(identifier: string): string;
  listSchemas(): Promise<string[]>;
  listObjects(schema?: string): Promise<DbObject[]>;
  listColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
  /** All tables/views of a schema with columns, plus foreign keys between them. */
  getDiagram(schema?: string): Promise<Diagram>;
  query(sql: string, maxRows: number): Promise<QueryResult>;
  close(): Promise<void>;
}
