const namePattern = /^[a-z][a-z0-9-]{0,39}$/;
const states = {
  health: ["healthy", "unhealthy", "unknown"],
  status: ["running", "degraded", "not-deployed", "recovery-required", "maintenance", "unknown"],
  automation: ["enabled", "paused", "manual"],
};

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateSnapshot(data) {
  if (!data || data.schemaVersion !== 1 || !timestamp(data.generatedAt) ||
      !Array.isArray(data.apps) || data.apps.length > 100) {
    throw new Error("Unsupported or invalid status snapshot");
  }
  const names = new Set();
  for (const app of data.apps) {
    if (!app || typeof app.name !== "string" || !namePattern.test(app.name) ||
        names.has(app.name) || typeof app.url !== "string" ||
        !/^https:\/\/[a-z][a-z0-9-]{0,39}\.rmstdope\.eu$/.test(app.url) ||
        !states.health.includes(app.health) || !states.health.includes(app.publicHealth) ||
        !states.health.includes(app.containerHealth) || !states.status.includes(app.status) ||
        !states.automation.includes(app.automation) || typeof app.recoveryRequired !== "boolean" ||
        !(app.updateSource === undefined || app.updateSource === null ||
          ["merge", "tag"].includes(app.updateSource)) ||
        !(app.applicationType === undefined || app.applicationType === null ||
          ["frontend", "fullstack"].includes(app.applicationType)) ||
        !(app.stateful === undefined || app.stateful === null || typeof app.stateful === "boolean") ||
        !(app.revision === null || /^[a-f0-9]{12}$/.test(app.revision)) ||
        !(app.version === null || /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(app.version)) ||
        !(app.deployedAt === null || timestamp(app.deployedAt))) {
      throw new Error("Invalid application entry in status snapshot");
    }
    names.add(app.name);
  }
  return data;
}

export function isStale(snapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot.generatedAt);
  return age > 180_000 || age < -30_000;
}

export function displayHealth(app, stale) {
  return stale || app.status === "maintenance" ? "unknown" : app.health;
}

export function applicationTypeLabel(app) {
  const type = app.applicationType === "frontend" ? "Frontend" :
    app.applicationType === "fullstack" ? "Fullstack" : "Unknown";
  const persistence = app.stateful === true ? "stateful" :
    app.stateful === false ? "stateless" : "persistence unknown";
  return type === "Unknown" && app.stateful == null ? "Unknown" : `${type} (${persistence})`;
}

export { title } from "./collection.js";
