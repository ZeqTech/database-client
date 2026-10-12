import type { Relation } from "./types";

/** Converts a driver value into something JSON/postMessage can carry. */
export function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString("hex");
    return `\\x${hex}${v.length > 64 ? `… (${v.length} bytes)` : ""}`;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

export interface Span {
  start: number;
  end: number;
}

/** Splits SQL text into statements on `;`, ignoring quotes, comments and $$ blocks. */
export function splitStatements(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const body = text
      .slice(start, end)
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "")
      .replace(/;/g, "")
      .trim();
    if (body) spans.push({ start, end });
    start = end;
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "-" && n === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (c === "/" && n === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && c !== "`") i += 2;
        else if (text[i] === c) {
          if (text[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
      if (m) {
        const e = text.indexOf(m[0], i + m[0].length);
        i = e < 0 ? text.length : e + m[0].length;
      } else i++;
    } else if (c === ";") {
      i++;
      push(i);
    } else i++;
  }
  push(text.length);
  return spans;
}

/** The statement containing `offset`, or the nearest one before it. */
export function statementAt(text: string, offset: number): string {
  const spans = splitStatements(text);
  if (spans.length === 0) return "";
  let pick = spans[0];
  for (const s of spans) {
    if (s.start <= offset) pick = s;
    else break;
  }
  return text.slice(pick.start, pick.end).trim();
}

/** Compares dotted numeric versions: >0 if a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const VSIX = /^database-client-(\d+(?:\.\d+)*)\.vsix$/i;

/** Newest `database-client-<version>.vsix` among the given file names. */
export function newestVsix(names: string[]): { name: string; version: string } | undefined {
  let best: { name: string; version: string } | undefined;
  for (const name of names) {
    const m = VSIX.exec(name);
    if (m && (!best || compareVersions(m[1], best.version) > 0)) best = { name, version: m[1] };
  }
  return best;
}

export function vsixVersion(name: string): string | undefined {
  return VSIX.exec(name)?.[1];
}

export interface FkRow {
  name: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

/** Groups per-column foreign key rows (in column order) into composite relations. */
export function groupRelations(rows: FkRow[]): Relation[] {
  const map = new Map<string, Relation>();
  for (const r of rows) {
    const key = `${r.table}\u0000${r.name}`;
    let rel = map.get(key);
    if (!rel) {
      rel = { name: r.name, table: r.table, columns: [], refTable: r.refTable, refColumns: [] };
      map.set(key, rel);
    }
    rel.columns.push(r.column);
    rel.refColumns.push(r.refColumn);
  }
  return [...map.values()];
}
