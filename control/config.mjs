import path from "node:path";
import { isIP } from "node:net";

export function configuration(env = process.env) {
  const origin = new URL(env.CONTROL_ORIGIN || "https://control.rmstdope.eu");
  if (origin.protocol !== "https:" || origin.origin !== env.CONTROL_ORIGIN ||
      origin.username || origin.password) throw new Error("Invalid CONTROL_ORIGIN");
  const admins = (env.ADMIN_GITHUB_IDS || "").split(",").map(id => id.trim());
  if (!admins.length || admins.some(id => !/^[1-9]\d{0,19}$/.test(id))) {
    throw new Error("ADMIN_GITHUB_IDS must explicitly list numeric IDs");
  }
  for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SESSION_STORE_DIR", "EXECUTOR_SOCKET"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (!path.isAbsolute(env.SESSION_STORE_DIR) || !path.isAbsolute(env.EXECUTOR_SOCKET)) {
    throw new Error("Runtime paths must be absolute");
  }
  const trustedProxyIPs = (env.TRUSTED_PROXY_IPS || "").split(",").map(ip => ip.trim()).filter(Boolean);
  if (trustedProxyIPs.some(ip => !isIP(ip))) throw new Error("TRUSTED_PROXY_IPS must contain exact IP addresses");
  return {
    origin: origin.origin, admins: new Set(admins),
    clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    storeDir: env.SESSION_STORE_DIR, socket: env.EXECUTOR_SOCKET,
    trustedProxyIPs: new Set(trustedProxyIPs),
  };
}
