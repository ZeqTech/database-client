import { ConnectionConfig, Driver } from "../types";
import { MySqlDriver } from "./mysql";
import { PostgresDriver } from "./postgres";
import { SqliteDriver } from "./sqlite";

export function createDriver(cfg: ConnectionConfig, password: string): Driver {
  switch (cfg.type) {
    case "postgres":
      return new PostgresDriver(cfg, password);
    case "mysql":
      return new MySqlDriver(cfg, password);
    case "sqlite":
      return new SqliteDriver(cfg);
  }
}
