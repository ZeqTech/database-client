import * as fs from "fs";
import type { ConnectionOptions } from "tls";
import type { ConnectionConfig, SslConfig, SslMode } from "./types";

export const SSL_MODES: { id: SslMode; label: string; hint: string }[] = [
  { id: "disable", label: "Disable", hint: "No encryption." },
  { id: "require", label: "Require", hint: "Encrypt, but do not check the server certificate." },
  { id: "verify-ca", label: "Verify CA", hint: "Encrypt and check the certificate chain, not the host name." },
  { id: "verify-full", label: "Verify full", hint: "Encrypt and check the certificate chain and host name (recommended)." },
];

export function isSslMode(v: unknown): v is SslMode {
  return SSL_MODES.some((m) => m.id === v);
}

/** Reads the stored value, which older versions saved as a plain boolean. */
export function normalizeSsl(ssl: ConnectionConfig["ssl"]): SslConfig {
  if (ssl && typeof ssl === "object") return isSslMode(ssl.mode) ? ssl : { ...ssl, mode: "disable" };
  return { mode: ssl ? "require" : "disable" };
}

/** Maps a `sslmode` / `ssl` connection-URL parameter to a mode. */
export function sslModeFromParam(v: string | null | undefined): SslMode {
  const s = (v ?? "").toLowerCase();
  if (isSslMode(s)) return s;
  // Postgres "prefer"/"allow" and MySQL "preferred" try TLS first; treat as require.
  if (/^(true|1|prefer|allow|preferred|required|verify_ca|verify_identity)$/.test(s)) {
    if (s === "verify_ca") return "verify-ca";
    if (s === "verify_identity") return "verify-full";
    return "require";
  }
  return "disable";
}

function readPem(path: string | undefined, what: string): Buffer | undefined {
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch (e) {
    throw new Error(`Cannot read ${what} "${path}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * TLS options for pg and mysql2, or undefined when SSL is off. Certificate files are read
 * here, at connect time, so rotated certificates are picked up without editing the connection.
 */
export function buildSslOptions(cfg: ConnectionConfig, keyPassphrase?: string): ConnectionOptions | undefined {
  const s = normalizeSsl(cfg.ssl);
  if (s.mode === "disable") return undefined;
  const verify = s.mode === "verify-ca" || s.mode === "verify-full";
  const opts: ConnectionOptions = {
    rejectUnauthorized: verify,
    ca: readPem(s.caFile, "CA certificate"),
    cert: readPem(s.certFile, "client certificate"),
    key: readPem(s.keyFile, "client key"),
    passphrase: keyPassphrase || undefined,
  };
  // verify-ca checks the chain only; accept any host name.
  if (s.mode === "verify-ca") opts.checkServerIdentity = () => undefined;
  return opts;
}
