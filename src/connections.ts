import * as vscode from "vscode";
import { createDriver } from "./drivers";
import { ConnectionConfig, Driver } from "./types";

const KEY = "dbclient.connections";
const pwKey = (id: string) => `dbclient.password.${id}`;

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

  /** `password` undefined keeps the stored one. */
  async save(cfg: ConnectionConfig, password?: string): Promise<void> {
    const all = this.list();
    const i = all.findIndex((c) => c.id === cfg.id);
    if (i >= 0) all[i] = cfg;
    else all.push(cfg);
    await this.ctx.globalState.update(KEY, all);
    if (password !== undefined) await this.ctx.secrets.store(pwKey(cfg.id), password);
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
    this.emitter.fire();
  }
}

/** Lazily-created, cached driver per connection. */
export class Sessions {
  private readonly drivers = new Map<string, Promise<Driver>>();
  private readonly connected = new Set<string>();

  constructor(private readonly store: ConnectionStore) {}

  get(id: string): Promise<Driver> {
    let p = this.drivers.get(id);
    if (!p) {
      p = (async () => {
        const cfg = this.store.get(id);
        if (!cfg) throw new Error("Connection no longer exists");
        return createDriver(cfg, await this.store.getPassword(id));
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

  async disconnect(id: string): Promise<void> {
    const p = this.drivers.get(id);
    this.drivers.delete(id);
    this.connected.delete(id);
    if (p) await p.then((d) => d.close()).catch(() => {});
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.drivers.keys()].map((id) => this.disconnect(id)));
  }
}

/** Opens a driver for a config without caching it (used by "Test connection"). */
export async function testConnection(cfg: ConnectionConfig, password: string): Promise<void> {
  const d = createDriver(cfg, password);
  try {
    if (cfg.type === "sqlite") await d.listObjects();
    else await d.query("select 1", 1);
  } finally {
    await d.close();
  }
}
