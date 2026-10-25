import { ConnectionConfig, Driver } from "../types";
import { MySqlDriver } from "./mysql";
import { PostgresDriver } from "./postgres";
import { SqliteDriver } from "./sqlite";

export function createDriver(cfg: ConnectionConfig, password: string, sslKeyPassphrase?: string, connectTimeoutMs = 10000): Driver {
  switch (cfg.type) {
    case "postgres":
      return new PostgresDriver(cfg, password, sslKeyPassphrase, connectTimeoutMs);
    case "mysql":
      return new MySqlDriver(cfg, password, sslKeyPassphrase, connectTimeoutMs);
    case "sqlite":
      return new SqliteDriver(cfg);
  }
}
