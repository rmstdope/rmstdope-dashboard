import net from "node:net";

export const LIMIT = 256 * 1024;
export const ACTIONS = ["offline", "online", "pause", "resume", "update", "restart", "rollback", "restore"];
export const FRESH_ACTIONS = ["offline", "online", "update", "restart", "rollback", "restore"];
// Release directories are named by the infra worker; rollback targets must be one of them.
export const releaseId = value => typeof value === "string" && /^\d{8}T\d{6}-[a-f0-9]{8}$/.test(value);
export const protectedName = name => ["dashboard", "control", "rmstdope-control"].includes(name);
export const appName = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const text = (value, max = 120) => typeof value === "string" && value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
export const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const revision = value => value === null || (typeof value === "string" && /^[a-f0-9]{7,64}$/.test(value));
const version = value => value === null || (typeof value === "string" && /^v\d+\.\d+\.\d+$/.test(value));
const statuses = ["queued", "running", "succeeded", "failed", "interrupted"];
const healthStates = ["healthy", "unhealthy", "unknown"];
const appUrl = /^https:\/\/(?:[a-z][a-z0-9-]{0,39}\.)?rmstdope\.eu$/;
const appStatuses = ["running", "degraded", "not-deployed", "recovery-required", "maintenance", "unknown"];
// Card details are optional so an older executor still yields explicit unknowns.
const optional = (value, valid) => value === undefined || value === null || valid(value);
// Only headless workers lack a web address and a public HTTPS check.
const validReach = app => app.profile === "worker" ?
  app.url === null && optional(app.publicHealth, value => value === "n/a") :
  text(app.url) && appUrl.test(app.url) && optional(app.publicHealth, value => healthStates.includes(value));
const deployedAt = value => typeof value === "string" && value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T[^Z+]*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const epoch = value => typeof value === "number" && Number.isFinite(value) &&
  value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const isoTime = value => typeof value === "string" && value.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const releaseVersion = value => value === null || (typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value));
const snapshotStatuses = ["recorded", "outdated", "missing", "pending", "none", "unknown"];
const skipReasons = ["operator", "first-release", "no-service", "not-configured", "rollback", "unknown"];
const outcomes = ["success", "failed", "incomplete", "unknown"];
const failedSteps = ["validation", "pull", "backup", "deploy"];
const restoreSteps = ["offline", "backup", "restore", "online"];
const plain = (value, keys, optionalKeys = []) => value && typeof value === "object" && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => keys.includes(key) || optionalKeys.includes(key));
const nullable = (value, valid) => value === null || valid(value);
const messages = {
  queued: "Waiting for the executor.", running: "Operation in progress.",
  succeeded: "Operation completed.", failed: "Operation failed. Inspect host recovery status.",
  interrupted: "Operation interrupted. Manual host recovery may be required.",
};
export const warnings = {
  offline: "Stops application services and enables maintenance mode. The database stays running. Automatic updates remain paused.",
  online: "Starts the current release and checks health. Automatic updates remain paused.",
  pause: "Pauses automatic updates without stopping the application.",
  resume: "Enables automatic updates. An eligible newer release deploys on the next poll, replacing the current release; this may undo a rollback. The executor rejects offline or recovery-required applications.",
  update: "Deploys the previewed release and checks health. Automatic updates remain paused. Database migrations may be forward-only.",
  restart: "Restarts application services, not the database. Automatic updates remain paused.",
  rollback: "Restores the previous application image only. The database is NOT rolled back: schema migrations may be incompatible. Automatic updates remain paused.",
  restore: "Restores the database to the running release's snapshot. Everything written since the snapshot was taken is discarded. The application goes offline while the current data is saved and the snapshot is loaded; a failed restore leaves it offline. Automatic updates remain paused.",
};
// Exact executor failure messages for a restore. Each is a fixed string that names no path,
// and each tells the operator whether the application stayed offline.
export const restoreFailures = new Set([
  "Taking the application offline failed, so nothing was restored; the database is unchanged, but the application may be in maintenance. Inspect with the CLI.",
  "The backup before the restore failed and the application could not be brought online again; it stays offline. The database is unchanged.",
  "The backup before the restore failed. The database is unchanged and the application is online again.",
  "The database restore failed. The application stays offline for maintenance; the data from before the restore was saved first.",
  "The database was restored, but the application could not be brought online; it stays offline.",
  "The rollback completed, but the restore did not start; the database is unchanged. Inspect with the CLI.",
]);
export function cleanSnapshot(snapshot) {
  if (!plain(snapshot, ["status", "restorable"], ["takenAt", "size", "kind", "skipReason"]) ||
      !snapshotStatuses.includes(snapshot.status) || typeof snapshot.restorable !== "boolean" ||
      (snapshot.restorable && snapshot.status !== "recorded") ||
      !optional(snapshot.takenAt, isoTime) ||
      !optional(snapshot.size, value => Number.isSafeInteger(value) && value >= 0) ||
      !optional(snapshot.kind, value => ["pre-release", "pre-rollback"].includes(value)) ||
      !optional(snapshot.skipReason, value => skipReasons.includes(value))) {
    throw new Error("Invalid executor snapshot");
  }
  return {
    status: snapshot.status, restorable: snapshot.restorable,
    takenAt: snapshot.takenAt ? new Date(snapshot.takenAt).toISOString() : null,
    size: snapshot.size ?? null, kind: snapshot.kind ?? null, skipReason: snapshot.skipReason ?? null,
  };
}
function cleanRelease(release) {
  const valid = plain(release, ["release", "current", "previous", "periods", "outcome", "snapshot"], [
    "version", "revision", "failedStep", "createdAt", "completedAt", "lastRestore"]) &&
    releaseId(release.release) && typeof release.current === "boolean" &&
    typeof release.previous === "boolean" && outcomes.includes(release.outcome) &&
    Array.isArray(release.periods) && release.periods.length <= 100 &&
    release.periods.every(period => plain(period, ["start", "end"]) &&
      nullable(period.start, isoTime) && nullable(period.end, isoTime)) &&
    optional(release.version, releaseVersion) &&
    optional(release.revision, value => /^[a-f0-9]{40}$/.test(value)) &&
    optional(release.failedStep, value => failedSteps.includes(value)) &&
    optional(release.createdAt, isoTime) && optional(release.completedAt, isoTime) &&
    optional(release.lastRestore, value => plain(value, ["outcome", "failedStep", "startedAt", "completedAt"]) &&
      outcomes.includes(value.outcome) && nullable(value.failedStep, step => restoreSteps.includes(step)) &&
      nullable(value.startedAt, isoTime) && nullable(value.completedAt, isoTime));
  if (!valid) throw new Error("Invalid executor release");
  const time = value => value ? new Date(value).toISOString() : null;
  return {
    release: release.release, current: release.current, previous: release.previous,
    version: release.version ?? null, revision: release.revision ?? null,
    outcome: release.outcome, failedStep: release.failedStep ?? null,
    createdAt: time(release.createdAt), completedAt: time(release.completedAt),
    periods: release.periods.map(period => ({ start: time(period.start), end: time(period.end) })),
    snapshot: cleanSnapshot(release.snapshot),
    lastRestore: release.lastRestore ? {
      outcome: release.lastRestore.outcome, failedStep: release.lastRestore.failedStep,
      startedAt: time(release.lastRestore.startedAt), completedAt: time(release.lastRestore.completedAt),
    } : null,
  };
}
export function cleanReleases(result, app) {
  if (!plain(result, ["app", "busy", "stateful", "protected", "backup", "releases"]) ||
      result.app !== app || typeof result.busy !== "boolean" || typeof result.stateful !== "boolean" ||
      typeof result.protected !== "boolean" ||
      !plain(result.backup, ["configured", "restore"]) || typeof result.backup.configured !== "boolean" ||
      typeof result.backup.restore !== "boolean" ||
      !Array.isArray(result.releases) || result.releases.length > 200) {
    throw new Error("Invalid executor releases");
  }
  const releases = result.releases.map(cleanRelease);
  if (new Set(releases.map(release => release.release)).size !== releases.length ||
      releases.filter(release => release.current).length > 1 ||
      releases.filter(release => release.previous).length > 1) throw new Error("Invalid executor releases");
  return {
    app, busy: result.busy, stateful: result.stateful,
    protected: result.protected || protectedName(app),
    backup: { configured: result.backup.configured, restore: result.backup.restore },
    releases,
  };
}
// The warning comes from fixed text here, never from the executor; only the validated
// snapshot time is filled in.
function previewWarning(action, options, snapshot) {
  const taken = snapshot?.takenAt ? new Date(snapshot.takenAt).toISOString().replace(".000Z", "Z") : "an unknown time";
  if (action === "restore") {
    return `Restores the database to the running release's snapshot from ${taken}. Everything written ` +
      "since the snapshot was taken is discarded. The application goes offline while the current data " +
      "is saved and the snapshot is loaded; a failed restore leaves it offline. Automatic updates remain paused.";
  }
  if (action !== "rollback" || !options) return warnings[action];
  const backup = options.backup ? "The current database is saved before the rollback. " : "";
  if (!options.restore) return backup + warnings.rollback;
  return `${backup}Rolls back the application image, then restores the database to the target's snapshot from ${taken}. ` +
    "Everything written since the snapshot was taken is discarded. The target release first starts against " +
    "the current data, then the application goes offline while the current data is saved and the snapshot " +
    "is loaded; a failed restore leaves it offline. Automatic updates remain paused.";
}

export function cleanApp(app) {
  if (!app || !appName(app.name) || !validReach(app) ||
      !["online", "offline"].includes(app.desired) ||
      !["enabled", "paused", "manual"].includes(app.automation) ||
      !["healthy", "unhealthy", "unknown"].includes(app.health) ||
      !revision(app.revision) || !version(app.version) ||
      typeof app.stateful !== "boolean" || typeof app.recoveryRequired !== "boolean" ||
      typeof app.protected !== "boolean" ||
      !optional(app.containerHealth, value => healthStates.includes(value)) ||
      !optional(app.status, value => appStatuses.includes(value)) ||
      !optional(app.deployedAt, deployedAt) ||
      !optional(app.updateSource, value => ["merge", "tag"].includes(value))) throw new Error("Invalid executor app");
  const offline = app.desired === "offline";
  return {
    name: app.name, url: app.url,
    profile: app.profile === "static" ? "frontend" : app.profile === "frontend-api" ? "fullstack" :
      ["frontend", "fullstack", "worker"].includes(app.profile) ? app.profile : "unknown",
    stateful: app.stateful, desired: app.desired, revision: app.revision,
    version: app.version, automation: app.automation,
    pauseReason: app.automation === "paused" ? "Automatic updates paused" : null,
    recoveryRequired: app.recoveryRequired, protected: app.protected || protectedName(app.name) ||
      ["https://dashboard.rmstdope.eu", "https://control.rmstdope.eu"].includes(app.url),
    health: offline ? "unknown" : app.health,
    // A worker has no public check in any state, so offline cannot make it unknown.
    publicHealth: app.profile === "worker" ? "n/a" : offline ? "unknown" : app.publicHealth ?? "unknown",
    containerHealth: offline ? "unknown" : app.containerHealth ?? "unknown",
    status: offline && !["recovery-required", "not-deployed"].includes(app.status) ? "maintenance" :
      app.status ?? "unknown",
    deployedAt: app.deployedAt ? new Date(app.deployedAt).toISOString() : null,
    updateSource: app.updateSource ?? null,
  };
}
export function cleanJob(job) {
  if (!job || !identifier(job.id) || !appName(job.app) ||
      !ACTIONS.includes(job.action) || !statuses.includes(job.status) ||
      !epoch(job.createdAt) || !epoch(job.updatedAt) ||
      !revision(job.revision)) throw new Error("Invalid executor job");
  // A failed restore says whether the application stayed offline; only fixed texts pass.
  const restoreFailure = job.status === "failed" && ["rollback", "restore"].includes(job.action) &&
    restoreFailures.has(job.message);
  return Object.fromEntries(Object.entries({
    id: job.id, app: job.app, action: job.action, status: job.status,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    message: restoreFailure ? job.message : messages[job.status], revision: job.revision,
  }));
}
export function cleanPreview(preview, app, action, now, options = null) {
  if (!preview || !identifier(preview.id) || preview.app !== app || preview.action !== action ||
      !epoch(preview.expiresAt) || preview.expiresAt <= now / 1000 ||
      preview.expiresAt > Math.floor(now / 1000) + 900 ||
      !revision(preview.revision) || !version(preview.version)) throw new Error("Invalid executor preview");
  // Rollback and restore previews from this executor name the release and its snapshot.
  const planned = ["rollback", "restore"].includes(action) && preview.release !== undefined;
  // A restore is only confirmed against a named, restorable snapshot.
  if ((options || action === "restore") && !planned) throw new Error("Invalid executor preview");
  let snapshot = null, release = null, granted = null;
  if (planned) {
    release = preview.release;
    granted = preview.options;
    if (!releaseId(release) || !plain(granted, ["backup", "restore"]) ||
        typeof granted.backup !== "boolean" || typeof granted.restore !== "boolean" ||
        (options?.target && options.target !== release) ||
        granted.backup !== Boolean(options?.backup) || granted.restore !== Boolean(options?.restore)) {
      throw new Error("Invalid executor preview");
    }
    snapshot = cleanSnapshot(preview.snapshot);
    if ((action === "restore" || granted.restore) && !snapshot.restorable) throw new Error("Invalid executor preview");
  }
  return {
    id: preview.id, app, action, expiresAt: preview.expiresAt,
    revision: preview.revision, version: preview.version,
    warning: previewWarning(action, granted, snapshot),
    ...(planned ? { release, options: granted, snapshot } : {}),
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
