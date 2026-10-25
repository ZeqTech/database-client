import * as vscode from "vscode";
import { createDriver } from "./drivers";
import { ConnectionConfig, Driver } from "./types";

const KEY = "dbclient.connections";
const pwKey = (id: string) => `dbclient.password.${id}`;
const CLOSE_TIMEOUT_MS = 3000;
const sslPassKey = (id: string) => `dbclient.sslpass.${id}`;

/** `dbclient.connectTimeoutSeconds`, in milliseconds. */
export function connectTimeoutMs(): number {
  const s = vscode.workspace.getConfiguration("dbclient").get<number>("connectTimeoutSeconds", 30);
  return Math.max(1, s) * 1000;
}

/** Adds where we tried to connect to timeout errors, which otherwise give no hint what was unreachable. */
export function describeConnectError(cfg: ConnectionConfig, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (cfg.type === "sqlite" || !/timeout|timed out|ETIMEDOUT/i.test(msg)) return msg;
  const port = cfg.port ?? (cfg.type === "postgres" ? 5432 : 3306);
  return `${msg} (${cfg.host || "localhost"}:${port}, the server did not finish the connection handshake in time; check the network/VPN, firewall allow-list and the server's connection limit)`;
}

/** Persists connection configs in globalState and passwords in SecretStorage. No limit on count. */
export class ConnectionStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  getPassword(id: string): Promise<string> {
    return Promise.resolve(this.ctx.secrets.get(pwKey(id))).then((p) => p ?? "");
  }

  getSslPassphrase(id: string): Promise<string> {
    return Promise.resolve(this.ctx.secrets.get(sslPassKey(id))).then((p) => p ?? "");
  }

  /** `password` / `sslPassphrase` undefined keeps the stored one. */
  async save(cfg: ConnectionConfig, password?: string, sslPassphrase?: string): Promise<void> {
    const all = this.list();
    const i = all.findIndex((c) => c.id === cfg.id);
    if (i >= 0) all[i] = cfg;
    else all.push(cfg);
    await this.ctx.globalState.update(KEY, all);
    if (password !== undefined) await this.ctx.secrets.store(pwKey(cfg.id), password);
    const hasKey = cfg.ssl && typeof cfg.ssl === "object" && cfg.ssl.keyFile;
    if (!hasKey) await this.ctx.secrets.delete(sslPassKey(cfg.id));
    else if (sslPassphrase !== undefined) await this.ctx.secrets.store(sslPassKey(cfg.id), sslPassphrase);
    this.emitter.fire();
  }

  /** Updates several configs (matched by id) with a single tree refresh. */
  async saveMany(updates: ConnectionConfig[]): Promise<void> {
    const byId = new Map(updates.map((c) => [c.id, c]));
    await this.ctx.globalState.update(KEY, this.list().map((c) => byId.get(c.id) ?? c));
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(KEY, this.list().filter((c) => c.id !== id));
    await this.ctx.secrets.delete(pwKey(id));
    await this.ctx.secrets.delete(sslPassKey(id));
    this.emitter.fire();
  }
}

/** Lazily-created, cached driver per connection. */
export class Sessions {
  private readonly drivers = new Map<string, Promise<Driver>>();
  private readonly connected = new Set<string>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly store: ConnectionStore) {}

  get(id: string): Promise<Driver> {
    let p = this.drivers.get(id);
    if (!p) {
      p = (async () => {
        const cfg = this.store.get(id);
        if (!cfg) throw new Error("Connection no longer exists");
        return createDriver(cfg, await this.store.getPassword(id), await this.store.getSslPassphrase(id), connectTimeoutMs());
      })();
      p.catch(() => this.drivers.delete(id));
      this.drivers.set(id, p);
    }
    return p;
  }

  markConnected(id: string): void {
    this.connected.add(id);
  }

  isConnected(id: string): boolean {
    return this.connected.has(id);
  }

  /** Bumped on an explicit disconnect so the tree recreates (and collapses) the connection node. */
  epoch(id: string): number {
    return this.epochs.get(id) ?? 0;
  }

  /**
   * Drops the cached driver and closes it. `only` limits this to a specific session, so a stale
   * failure cannot tear down a newer connection. `collapse` marks an explicit user disconnect.
   * Closing is capped: a pool whose server stopped answering must not block the caller.
   */
  async disconnect(id: string, opts: { only?: Promise<Driver>; collapse?: boolean } = {}): Promise<void> {
    const p = this.drivers.get(id);
    if (opts.only && p !== opts.only) return;
    this.drivers.delete(id);
    this.connected.delete(id);
    if (opts.collapse) this.epochs.set(id, this.epoch(id) + 1);
    if (!p) return;
    const closed = p.then((d) => d.close()).catch(() => {});
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, CLOSE_TIMEOUT_MS))]);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.drivers.keys()].map((id) => this.disconnect(id)));
  }
}

/** Opens a driver for a config without caching it (used by "Test connection"). */
export async function testConnection(cfg: ConnectionConfig, password: string, sslKeyPassphrase?: string): Promise<void> {
  const d = createDriver(cfg, password, sslKeyPassphrase, connectTimeoutMs());
  try {
    if (cfg.type === "sqlite") await d.listObjects();
    else await d.query("select 1", 1);
  } catch (e) {
    throw new Error(describeConnectError(cfg, e));
  } finally {
    await d.close();
  }
}
