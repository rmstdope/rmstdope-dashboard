import path from "node:path";

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
  return {
    origin: origin.origin, admins: new Set(admins),
    clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET,
    storeDir: env.SESSION_STORE_DIR, socket: env.EXECUTOR_SOCKET,
  };
}
