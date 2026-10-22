import net from "node:net";

export const LIMIT = 256 * 1024;
export const ACTIONS = ["offline", "online", "pause", "resume", "update", "restart", "rollback"];
export const FRESH_ACTIONS = ["offline", "online", "update", "restart", "rollback"];
export const protectedName = name => ["dashboard", "control", "rmstdope-control"].includes(name);
export const appName = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const text = (value, max = 120) => typeof value === "string" && value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
export const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const revision = value => value === null || (typeof value === "string" && /^[a-f0-9]{7,64}$/.test(value));
const version = value => value === null || (typeof value === "string" && /^v\d+\.\d+\.\d+$/.test(value));
const statuses = ["queued", "running", "succeeded", "failed", "interrupted"];
const messages = {
  queued: "Waiting for the executor.", running: "Operation in progress.",
  succeeded: "Operation completed.", failed: "Operation failed. Inspect host recovery status.",
  interrupted: "Operation interrupted. Manual host recovery may be required.",
};
export const warnings = {
  offline: "Stops application HTTP services and enables maintenance mode. The database stays running. Automatic updates remain paused.",
  online: "Starts the current release and checks health. Automatic updates remain paused.",
  pause: "Pauses automatic updates without stopping the application.",
  resume: "Enables automatic updates. The executor rejects offline or recovery-required applications.",
  update: "Deploys the previewed release and checks health. Automatic updates remain paused. Database migrations may be forward-only.",
  restart: "Restarts application HTTP services, not the database. Automatic updates remain paused.",
  rollback: "Restores the previous application image only. The database is NOT rolled back: schema migrations may be incompatible. Automatic updates remain paused.",
};

export function cleanApp(app) {
  if (!app || !appName(app.name) || !text(app.url) ||
      !/^https:\/\/[a-z][a-z0-9-]{0,39}\.rmstdope\.eu$/.test(app.url) ||
      !["online", "offline"].includes(app.desired) ||
      !["enabled", "paused", "manual"].includes(app.automation) ||
      !["healthy", "unhealthy", "unknown"].includes(app.health) ||
      !revision(app.revision) || !version(app.version) ||
      typeof app.stateful !== "boolean" || typeof app.recoveryRequired !== "boolean" ||
      typeof app.protected !== "boolean") throw new Error("Invalid executor app");
  return {
    name: app.name, url: app.url,
    profile: app.profile === "static" ? "frontend" : app.profile === "frontend-api" ? "fullstack" :
      ["frontend", "fullstack"].includes(app.profile) ? app.profile : "unknown",
    stateful: app.stateful, desired: app.desired, revision: app.revision,
    version: app.version, automation: app.automation,
    pauseReason: app.automation === "paused" ? "Automatic updates paused" : null,
    recoveryRequired: app.recoveryRequired, protected: app.protected || protectedName(app.name) ||
      ["https://dashboard.rmstdope.eu", "https://control.rmstdope.eu"].includes(app.url),
    health: app.desired === "offline" ? "unknown" : app.health,
  };
}
export function cleanJob(job) {
  if (!job || !identifier(job.id) || !appName(job.app) ||
      !ACTIONS.includes(job.action) || !statuses.includes(job.status) ||
      !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt) ||
      !revision(job.revision)) throw new Error("Invalid executor job");
  return Object.fromEntries(Object.entries({
    id: job.id, app: job.app, action: job.action, status: job.status,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    message: messages[job.status], revision: job.revision,
  }));
}
export function cleanPreview(preview, app, action, now) {
  if (!preview || !identifier(preview.id) || preview.app !== app || preview.action !== action ||
      !Number.isSafeInteger(preview.expiresAt) || preview.expiresAt <= Math.floor(now / 1000) ||
      preview.expiresAt > Math.floor(now / 1000) + 900 ||
      !revision(preview.revision) || !version(preview.version)) throw new Error("Invalid executor preview");
  return {
    id: preview.id, app, action, expiresAt: preview.expiresAt,
    revision: preview.revision, version: preview.version, warning: warnings[action],
  };
}

export function execute(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0), settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    const deadline = setTimeout(() => finish(new Error("Executor timeout")), 90_000);
    socket.setTimeout(90_000, () => finish(new Error("Executor timeout")));
    socket.on("error", () => finish(new Error("Executor unavailable")));
    socket.on("end", () => finish(new Error("Incomplete executor response")));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      if (buffer.length + chunk.length > LIMIT) return finish(new Error("Executor response limit"));
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        if (buffer.length !== end + 1) throw new Error("Unexpected executor data");
        const value = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid executor response");
        finish(null, value);
      } catch { finish(new Error("Invalid executor response")); }
    });
  });
}
