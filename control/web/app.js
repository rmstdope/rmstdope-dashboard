import { collection, title } from "/collection.js";

const $ = selector => document.querySelector(selector);
const refreshFailureMessage = "Refresh failed. Displayed state may be stale. Operations require a new executor preview.";
const historyFailureMessage = "Operation history refresh failed. It may be stale and retries automatically.";
const actions = {
  offline: "Take offline (maintenance)", online: "Bring online",
  pause: "Pause automatic updates", resume: "Resume automatic updates",
  update: "Update now", restart: "Restart services", rollback: "Rollback application image",
};
// Job history also names operations started from the release page.
const jobActions = { ...actions, restore: "Restore database" };
const labels = {
  healthy: "Healthy", unhealthy: "Unhealthy", unknown: "Unknown",
  running: "Running", degraded: "Degraded", "not-deployed": "Not deployed",
  "recovery-required": "Recovery required", maintenance: "Maintenance (intentionally offline)",
  enabled: "Automatic", paused: "Paused", manual: "Manual", "n/a": "Not applicable",
};
let session = null, pending = null, busy = false, loading = false;
const selectedActions = new Map();
let renderedApps = null;
let latestApps = [];
let refreshFailed = false;
let refreshDeferred = false;
// The executor read the apps without its lock: health and status may be changing.
let operationRunning = false;
let historyFailed = false;
// Release history per application: { data, error, loadedAt }. Cards show a summary.
const releaseData = new Map();
let summariesLoading = false, lastSummaries = 0;
let rollbackTarget = null;
let focusHeading = false;
const SUMMARY_INTERVAL = 60_000;
const visibleApps = collection(() => renderApps(latestApps), app => app.profile);
function node(tag, value, className) {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
}
function message(value) { $("#message").textContent = value; }
function account(value) {
  session = value?.authenticated ? value : null;
  $("#account").textContent = session ? `GitHub ID ${session.actor}` : "Not signed in";
  $("#login").hidden = false;
  $("#login").textContent = session ? "Sign in again (refresh authorization)" : "Sign in with GitHub";
  $("#logout").hidden = !session;
  $("#control").hidden = !session;
  $("#welcome").hidden = Boolean(session);
  if (session && focusHeading && currentView().app) { $("#release-heading").focus(); focusHeading = false; }
  if (!session) {
    $("#apps").replaceChildren(); $("#jobs").replaceChildren(); closePreview(); closeRollback();
    selectedActions.clear();
    releaseData.clear();
    lastSummaries = 0;
    renderedApps = null;
    latestApps = [];
    $("#empty").hidden = true;
  }
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    credentials: "same-origin", signal: AbortSignal.timeout(95_000),
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" },
      body: JSON.stringify(body),
    }),
  });
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 262144) throw new Error("Control response is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok) {
    if (response.status === 401) account(null);
    const error = new Error(result.error?.message || "Control request failed.");
    error.code = result.error?.code;
    error.path = path;
    throw error;
  }
  return result;
}
function detail(list, label, value) {
  const row = node("div");
  row.append(node("dt", label), node("dd", value));
  list.append(row);
}
function renderApps(apps) {
  latestApps = apps;
  const healthy = apps.filter(app => app.desired === "online" && app.health === "healthy").length;
  const offline = apps.filter(app => app.desired === "offline").length;
  const paused = apps.filter(app => app.automation === "paused").length;
  $("#health-value").textContent = refreshFailed || operationRunning || (refreshDeferred && !apps.length)
    ? "Unknown" : `${healthy} / ${apps.length}`;
  $("#automation-value").textContent = apps.filter(app => app.automation === "enabled").length;
  $("#maintenance-value").textContent = offline;
  $("#summary").textContent = refreshFailed ? "Status unknown — displayed application details may be stale" :
    refreshDeferred ? (apps.length ? "Infrastructure operation in progress — showing last known application state" :
      "Infrastructure operation in progress — applications appear when it finishes") :
    operationRunning ? "Infrastructure operation in progress — health and status are unknown until it finishes" :
    `${healthy} of ${apps.length} applications healthy · ${offline} offline · ${paused} with updates paused`;
  const visible = visibleApps(apps);
  $("#empty").hidden = !apps.length || visible.length > 0;
  // A failed load changes the card too, though it leaves no data.
  const summaries = visible.map(app => [releaseData.get(app.name)?.data ?? null,
    releaseData.get(app.name)?.error ?? null]);
  const snapshot = JSON.stringify([visible, summaries, refreshFailed, refreshDeferred, operationRunning, busy]);
  if (snapshot === renderedApps) return;
  renderedApps = snapshot;
  for (const name of selectedActions.keys()) {
    if (!apps.some(app => app.name === name)) selectedActions.delete(name);
  }
  $("#apps").replaceChildren();
  for (const app of visible) {
    const card = node("article", undefined, "app-card");
    const heading = node("div", undefined, "card-heading");
    const status = app.desired === "offline" ? "maintenance" : refreshFailed ? "unknown" : app.health;
    const icon = node("span", title(app.name).slice(0, 1), "app-icon");
    icon.setAttribute("aria-hidden", "true");
    heading.append(icon, node("h3", title(app.name)), node("span", status, `badge status-${status}`));
    card.append(heading);
    if (app.url) {
      const link = node("a", new URL(app.url).hostname);
      link.href = app.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    } else {
      card.append(node("p", "Background worker · no web address", "hostname"));
    }
    const list = node("dl");
    detail(list, "Desired state", app.desired === "offline" ? "Offline · maintenance" : "Online");
    detail(list, refreshDeferred ? "Last known health" : "Health", refreshFailed ? "Unknown" : labels[app.health]);
    const profile = app.profile === "fullstack" ? "Fullstack" : app.profile === "frontend" ? "Frontend" :
      app.profile === "worker" ? "Worker" : "Unknown";
    detail(list, "Type", `${profile} (${app.stateful ? "stateful" : "stateless"})`);
    const known = value => refreshFailed ? "Unknown" : `${labels[value]}${refreshDeferred ? " (last known)" : ""}`;
    detail(list, "Status", refreshFailed ? "Unknown (stale)" : known(app.status));
    if (app.version) detail(list, "Version", app.version);
    detail(list, "Revision", app.revision ? app.revision.slice(0, 12) : "Not available");
    detail(list, "Public HTTPS", app.publicHealth === "n/a" ? labels["n/a"] : known(app.publicHealth));
    detail(list, "Container", known(app.containerHealth));
    detail(list, "Deployment", app.deployedAt ? new Date(app.deployedAt).toLocaleString("sv-SE") : "Not available");
    const updates = app.automation === "enabled" && app.updateSource ?
      `Automatic (${app.updateSource})` : labels[app.automation];
    detail(list, "Automatic updates", `${updates}${refreshFailed || refreshDeferred ? " (last known)" : ""}`);
    card.append(list);
    card.append(releaseSummary(app));
    if (app.recoveryRequired) card.append(node("p", "Recovery required: use the host recovery runbook.", "warning"));
    if (app.protected) {
      card.append(node("p", "Protected application: use the reviewed host workflow.", "notice"));
    } else {
      const form = node("form", undefined, "operation-form");
      const select = node("select");
      select.id = `action-${app.name}`;
      select.setAttribute("aria-label", `Operation for ${app.name}`);
      const label = node("label", "Operation");
      label.htmlFor = select.id;
      for (const [action, title] of Object.entries(actions)) {
        const option = node("option", title);
        option.value = action;
        option.disabled = (app.desired === "offline" && ["resume", "restart", "rollback", "update"].includes(action)) ||
          (app.desired === "online" && action === "online");
        select.append(option);
      }
      const chosen = selectedActions.get(app.name);
      select.value = [...select.options].some(option => option.value === chosen && !option.disabled)
        ? chosen : app.desired === "offline" ? "online" : "pause";
      selectedActions.set(app.name, select.value);
      select.addEventListener("change", () => selectedActions.set(app.name, select.value));
      const button = node("button", "Preview operation", "button button-primary");
      button.type = "submit";
      button.disabled = busy || app.recoveryRequired;
      form.append(label, select, button);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        button.disabled = true;
        message("Preparing immutable operation preview…");
        try {
          const result = await api("preview", { app: app.name, action: select.value });
          openConfirmation(result.preview);
          message("");
        } catch (error) { message(error.message); }
        finally {
          busy = false;
          button.disabled = app.recoveryRequired;
          if (session) renderApps(latestApps);
        }
      });
      card.append(form);
    }
    $("#apps").append(card);
  }
  if (!apps.length) {
    $("#apps").append(node("p", refreshFailed ? "Applications unavailable — refresh failed." :
      refreshDeferred ? "Applications appear when the running infrastructure operation finishes." :
      "No registered applications."));
  }
}
const releaseLabels = {
  recorded: "Recorded", outdated: "Outdated", missing: "Missing", pending: "Not yet",
  none: "None", unknown: "Unknown",
};
const releaseBadges = { recorded: "status-healthy", outdated: "status-unknown", missing: "status-unhealthy",
  pending: "", none: "", unknown: "status-unknown" };
const skipTexts = {
  operator: "The next release was made with --skip-backup, so no snapshot was taken.",
  "first-release": "No snapshot was possible when this version was replaced.",
  "no-service": "This version had no backup service yet, so no snapshot was taken.",
  "not-configured": "No pre-release backup was configured when this version was replaced.",
  rollback: "This version was left by a rollback without a backup.",
  unknown: "No snapshot of this version is recorded.",
};
const stepLabels = { validation: "validation", pull: "image pull", backup: "pre-release backup",
  deploy: "deployment", offline: "going offline", restore: "loading the snapshot", online: "going online" };
const when = value => value ? new Date(value).toLocaleString("sv-SE") : "an unknown time";
function size(bytes) {
  if (bytes === null) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}
const releaseName = release => release.version || `Release ${release.release.slice(0, 15)}`;
function currentView() {
  const match = /^#releases\/([a-z][a-z0-9-]{0,39})$/.exec(location.hash);
  return { app: match ? match[1] : null };
}
function route() {
  const { app } = currentView();
  // A preview names its app and release, but a dialog from another view would only confuse.
  if (!busy) { closePreview(); closeRollback(); }
  const changed = $("#release-view").hidden === Boolean(app);
  $("#overview").hidden = Boolean(app);
  $("#release-view").hidden = !app;
  renderedReleases = null;
  if (app) {
    // Before sign-in is confirmed the section is hidden and cannot take focus; account() does it.
    if (changed) focusHeading = true;
    if (focusHeading && !$("#control").hidden) { $("#release-heading").focus(); focusHeading = false; }
    $("#release-app").textContent = title(app);
    $("#release-heading").textContent = `${title(app)} releases`;
    releaseMessage("");
    renderReleases();
    if (session) loadReleases(app, true);
  } else if (session) {
    renderApps(latestApps);
  }
}
function releaseMessage(value) { $("#release-message").textContent = value; }
let releaseSequence = 0;
async function loadReleases(app, force = false) {
  const entry = releaseData.get(app);
  if (!force && entry?.loading) return;
  // Only the newest request for an app may store its answer; an older one finishing later is dropped.
  const sequence = ++releaseSequence;
  releaseData.set(app, { ...entry, loading: sequence });
  let result;
  try {
    result = { data: await api(`apps/${app}/releases`), error: null };
  } catch (error) {
    // A failed reload never leaves old history looking current.
    result = { data: null, error: error.message };
  }
  if (!session || releaseData.get(app)?.loading !== sequence) return;
  releaseData.set(app, { ...result, loadedAt: Date.now() });
  if (currentView().app === app) renderReleases(); else if (session) renderApps(latestApps);
}
async function loadSummaries() {
  if (summariesLoading || !session) return;
  summariesLoading = true;
  lastSummaries = Date.now();
  try {
    for (const app of latestApps) {
      if (!session || currentView().app) break;
      await loadReleases(app.name);
    }
  } finally { summariesLoading = false; }
}
function releaseSummary(app) {
  const box = node("div", undefined, "card-releases");
  box.append(node("p", app.stateful ? "RELEASES AND BACKUPS" : "RELEASES", "eyebrow"));
  const entry = releaseData.get(app.name);
  const data = entry?.data;
  if (!data) {
    box.append(node("p", entry?.error ? "Release history unavailable." : "Release history loading…", "muted"));
  } else {
    const stored = data.releases.filter(release => release.outcome === "success").length;
    box.append(node("p", `${stored} stored version${stored === 1 ? "" : "s"}`));
    if (!data.stateful) {
      box.append(node("p", "No database. You can roll back to any stored version.", "muted"));
    } else if (!data.backup.configured) {
      box.append(node("p", "Database backups not configured: a rollback changes images only.", "muted"));
    } else {
      const older = data.releases.filter(release => release.outcome === "success" && !release.current);
      const usable = older.filter(release => release.snapshot.status === "recorded").length;
      box.append(node("p", `${usable} of ${older.length} older version${older.length === 1 ? " has" : "s have"} a recorded database snapshot`));
      const latest = data.releases.map(release => release.snapshot.takenAt).filter(Boolean).sort().at(-1);
      box.append(node("p", latest ? `Last backup ${when(latest)}` : "No backup taken yet", "muted"));
    }
    const newest = data.releases[0];
    if (newest && newest.outcome === "failed") {
      box.append(node("p", `${releaseName(newest)} stopped at the ${stepLabels[newest.failedStep] || "release"}; the running version kept running.`, "warning"));
    }
  }
  const link = node("a", app.stateful ? "Releases and backups" : "Releases", "button");
  link.href = `#releases/${app.name}`;
  box.append(link);
  return box;
}
function tile(label, value, description) {
  const item = node("div", undefined, "metric");
  item.append(node("span", label, "metric-label"), node("strong", value, "metric-value"),
    node("span", description, "metric-description"));
  return item;
}
function period(release) {
  if (!release.periods.length) return release.createdAt ? `Created ${when(release.createdAt)}` : "Never ran";
  return release.periods.map(({ start, end }) => end ? `${when(start)} – ${when(end)}` :
    `Since ${when(start)}`).join("; ");
}
function snapshotText(data, release) {
  const snapshot = release.snapshot;
  if (!data.stateful) return "No database.";
  const taken = snapshot.takenAt ? `Taken ${when(snapshot.takenAt)}` : "Taken at an unknown time";
  switch (snapshot.status) {
    case "recorded": return `${taken}${snapshot.kind === "pre-rollback" ? " before a rollback" : " just before the next version started"} · ${size(snapshot.size)}` +
      (snapshot.restorable ? "" : " · no restore command recorded (CLI runbook)");
    case "outdated": return `${taken}. This version ran again later, so writes from that period are not in it. It cannot be restored.`;
    case "missing": return "The snapshot file is missing or has the wrong size. It cannot be restored.";
    case "pending": return release.current ? "Taken automatically when the next release starts." : "No usable snapshot.";
    case "unknown": return "Whether this snapshot holds the version's last data cannot be confirmed. It cannot be restored.";
    default: return skipTexts[snapshot.skipReason] || skipTexts.unknown;
  }
}
function actionsAllowed(app, data) {
  if (!app || refreshFailed) return "Application state unknown: refresh failed. Actions return when it succeeds.";
  if (data.protected || app.protected) return "Protected application: use the reviewed host workflow.";
  if (data.busy || operationRunning || refreshDeferred) return "An infrastructure operation is running; actions are unavailable until it finishes.";
  if (app.recoveryRequired) return "Recovery required: use the host recovery runbook.";
  if (app.desired === "offline") return "The application is offline. Bring it online first.";
  return null;
}
let renderedReleases = null;
function renderReleases() {
  const { app: name } = currentView();
  if (!name) return;
  const entry = releaseData.get(name);
  const data = entry?.data;
  const app = latestApps.find(item => item.name === name);
  // Rebuild only when something shown changes, so a focused button survives the refresh.
  const snapshot = JSON.stringify([name, data ?? null, entry?.error ?? null, app ?? null, refreshFailed,
    refreshDeferred, operationRunning, busy, $("#show-failed").checked]);
  if (snapshot === renderedReleases) return;
  renderedReleases = snapshot;
  $("#release-tiles").replaceChildren();
  $("#release-list").replaceChildren();
  $("#release-blocked").hidden = true;
  if (!data) {
    $("#release-list").append(node("li", entry?.error ? `Release history unavailable: ${entry.error}` :
      "Loading release history…", "empty-state"));
    return;
  }
  const releases = data.releases;
  const current = releases.find(release => release.current);
  const snapshots = releases.filter(release => release.snapshot.takenAt)
    .sort((a, b) => Date.parse(b.snapshot.takenAt) - Date.parse(a.snapshot.takenAt));
  const newest = releases[0];
  $("#release-tiles").append(
    tile("RUNNING", current ? releaseName(current) : "None", current ? period(current) : "No current release"),
    data.stateful ? tile("LAST BACKUP", snapshots[0] ? when(snapshots[0].snapshot.takenAt) : "None",
      snapshots[0] ? `${releaseLabels[snapshots[0].snapshot.status]} · of ${releaseName(snapshots[0])} · ${size(snapshots[0].snapshot.size)}` :
        data.backup.configured ? "Taken when the next release starts" : "Backups are not configured") :
      tile("DATABASE", "None", "Stateless application"),
    tile("LAST ATTEMPT", newest ? releaseName(newest) : "None", newest ? (newest.outcome === "failed" ?
      `Failed at the ${stepLabels[newest.failedStep] || "release"}` : newest.outcome === "success" ? "Succeeded" :
      newest.outcome === "incomplete" ? "Incomplete" : "Unknown") : "No releases"),
    tile("BACKUP POLICY", !data.stateful ? "Not applicable" : data.backup.configured ? "Configured" : "Not configured",
      !data.stateful ? "No database" : data.backup.restore ? "Restore available from this panel" :
        data.backup.configured ? "No restore command: CLI runbook only" : "Rollback changes images only"));
  const blocked = actionsAllowed(app, data);
  $("#release-blocked").textContent = blocked || "";
  $("#release-blocked").hidden = !blocked;
  const showFailed = $("#show-failed").checked;
  for (const release of releases) {
    if (!showFailed && release.outcome !== "success" && !release.current) continue;
    const row = node("li", undefined, `release-row${release.current ? " is-current" : ""}${release.outcome === "failed" ? " is-failed" : ""}`);
    const version = node("div");
    version.append(node("span", releaseName(release), "release-version"),
      node("span", release.revision ? `rev ${release.revision.slice(0, 12)}` : release.release, "muted"));
    const host = node("div");
    const state = release.current ? ["Running", "status-healthy"] : release.outcome === "failed" ? ["Attempt failed", "status-failed"] :
      release.outcome === "incomplete" ? ["Incomplete", "status-unknown"] : release.outcome === "unknown" ? ["Unreadable", "status-unknown"] :
      release.previous ? ["Previous", ""] : ["Stored", ""];
    host.append(node("span", state[0], `badge ${state[1]}`), node("span", release.outcome === "failed" ?
      `Stopped at the ${stepLabels[release.failedStep] || "release"} · ${when(release.completedAt)}` : period(release), "muted"));
    const snapshot = node("div", undefined, "snapshot-text");
    if (data.stateful) snapshot.append(node("span", releaseLabels[release.snapshot.status], `badge ${releaseBadges[release.snapshot.status]}`));
    snapshot.append(document.createTextNode(snapshotText(data, release)));
    if (release.lastRestore) {
      const last = release.lastRestore;
      snapshot.append(node("span", last.outcome === "success" ? `Last restore succeeded ${when(last.completedAt)}.` :
        `Last restore ${last.outcome === "failed" ? `failed while ${stepLabels[last.failedStep] || "restoring"}` : "did not finish"} (started ${when(last.startedAt)}).`,
        `muted${last.outcome === "success" ? "" : " warning-text"}`));
    }
    const action = node("div", undefined, "release-action");
    if (release.current) {
      if (data.stateful && release.snapshot.restorable && data.backup.restore) {
        const button = node("button", "Restore database…", "button");
        button.type = "button";
        button.disabled = Boolean(blocked) || busy;
        button.addEventListener("click", () => previewRestore(name));
        action.append(button);
      } else action.append(node("span", "Current version", "muted"));
    } else if (release.outcome === "success") {
      const button = node("button", `Roll back to ${releaseName(release)}…`, "button");
      button.type = "button";
      button.disabled = Boolean(blocked) || busy;
      button.addEventListener("click", () => openRollback(name, data, release));
      action.append(button);
    } else action.append(node("span", "Not a rollback target", "muted"));
    row.append(version, host, snapshot, action);
    $("#release-list").append(row);
  }
  if (!releases.length) $("#release-list").append(node("li", "No stored releases.", "empty-state"));
}
function openConfirmation(preview) {
  const restoring = preview.action === "restore" || preview.options?.restore === true;
  pending = { ...preview, idempotencyKey: crypto.randomUUID(),
    phrase: restoring ? `restore ${preview.app}` : preview.app };
  $("#confirm-title").textContent = preview.action === "rollback" && preview.release ?
    `${restoring ? "Roll back and restore" : "Roll back"}: ${preview.app}` : `${jobActions[preview.action]}: ${preview.app}`;
  $("#effects").textContent = preview.warning;
  $("#target").textContent = `Release: ${preview.version || preview.revision || "current release"}`;
  const details = [];
  if (preview.release) details.push(`Release ID ${preview.release}`);
  if (preview.options?.backup) details.push("The current database is saved before the rollback.");
  if (restoring && preview.snapshot) {
    details.push(`Snapshot from ${when(preview.snapshot.takenAt)} · ${size(preview.snapshot.size)}`);
  }
  $("#confirm-details").replaceChildren(...details.map(value => node("li", value)));
  $("#confirm-label").textContent = restoring ? `Type "restore ${preview.app}" to confirm` :
    "Type the application name to confirm";
  $("#confirm-name").maxLength = restoring ? 48 : 40;
  $("#confirm").textContent = restoring ? "Confirm restore" : "Confirm operation";
  $("#expiry").textContent = `Preview expires ${new Date(preview.expiresAt * 1000).toLocaleString("sv-SE")}. Changes after preview are rejected.`;
  $("#confirm-name").value = "";
  $("#confirm-error").textContent = "";
  $("#confirmation").showModal();
  $("#confirm-name").focus();
}
async function previewRestore(name) {
  if (busy) return;
  busy = true;
  renderReleases();
  releaseMessage("Preparing restore preview…");
  try {
    const result = await api("preview", { app: name, action: "restore" });
    openConfirmation(result.preview);
    releaseMessage("");
  } catch (error) { releaseMessage(error.message); }
  finally { busy = false; renderReleases(); }
}
function openRollback(name, data, release) {
  const current = data.releases.find(item => item.current);
  const skipped = data.releases.filter(item => item.outcome === "success" && !item.current &&
    item.createdAt && release.createdAt && item.createdAt > release.createdAt);
  rollbackTarget = { name, data, release };
  $("#rollback-title").textContent = `Roll back ${title(name)} to ${releaseName(release)}`;
  $("#rollback-summary").textContent = `From ${current ? releaseName(current) : "the running version"}.` +
    (skipped.length ? ` Skips ${skipped.map(releaseName).join(", ")}; ${skipped.length === 1 ? "it stays" : "they stay"} stored.` : "");
  const restorable = data.stateful && data.backup.restore && release.snapshot.restorable;
  $("#rollback-mode").hidden = !data.stateful;
  $("#mode-restore").disabled = !restorable;
  $("#restore-note").textContent = restorable ? `Restore its snapshot from ${when(release.snapshot.takenAt)}.` :
    !data.backup.restore ? "Not available: no restore command is configured." :
    `Not available: the snapshot is ${releaseLabels[release.snapshot.status].toLowerCase()}.`;
  document.querySelector('input[name="rollback-mode"][value="image"]').checked = true;
  $("#backup-row").hidden = !(data.stateful && data.backup.configured);
  $("#rollback-backup").checked = true;
  $("#rollback-ack").checked = false;
  $("#rollback-error").textContent = "";
  updateRollback();
  $("#rollback-dialog").showModal();
}
function updateRollback() {
  if (!rollbackTarget) return;
  const { data, release } = rollbackTarget;
  const restoring = document.querySelector('input[name="rollback-mode"]:checked')?.value === "restore";
  const box = $("#rollback-snapshot");
  box.replaceChildren();
  if (data.stateful) {
    box.append(node("span", releaseLabels[release.snapshot.status], `badge ${releaseBadges[release.snapshot.status]}`),
      document.createTextNode(snapshotText(data, release)));
    box.append(node("p", restoring ? `Restoring discards everything written since ${when(release.snapshot.takenAt)}. The current data is saved first.` :
      "The database is not changed. The older version runs on data and schema written by newer versions.", restoring ? "discard" : "muted"));
  }
  // Without a usable snapshot there is nothing to return to if the old version cannot read the data.
  const needsAck = data.stateful && release.snapshot.status !== "recorded";
  $("#ack-row").hidden = !needsAck;
  $("#ack-text").textContent = `I understand that no usable snapshot of ${releaseName(release)} exists.`;
}
function closeRollback() {
  rollbackTarget = null;
  if ($("#rollback-dialog").open) $("#rollback-dialog").close();
}
for (const input of document.querySelectorAll('input[name="rollback-mode"]')) input.addEventListener("change", updateRollback);
$("#rollback-cancel").addEventListener("click", closeRollback);
$("#rollback-dialog").addEventListener("cancel", event => { if (busy) event.preventDefault(); else rollbackTarget = null; });
$("#rollback-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!rollbackTarget || busy) return;
  const { name, data, release } = rollbackTarget;
  if (!$("#ack-row").hidden && !$("#rollback-ack").checked) {
    $("#rollback-error").textContent = "Confirm that you understand no usable snapshot exists.";
    return;
  }
  const restore = data.stateful && document.querySelector('input[name="rollback-mode"]:checked')?.value === "restore";
  const backup = !$("#backup-row").hidden && $("#rollback-backup").checked;
  busy = true;
  $("#rollback-preview").disabled = $("#rollback-cancel").disabled = true;
  $("#rollback-error").textContent = "Preparing immutable operation preview…";
  try {
    const result = await api("preview", { app: name, action: "rollback", target: release.release,
      ...(backup ? { backup: true } : {}), ...(restore ? { restore: true } : {}) });
    closeRollback();
    openConfirmation(result.preview);
  } catch (error) { $("#rollback-error").textContent = error.message; }
  finally {
    busy = false;
    $("#rollback-preview").disabled = $("#rollback-cancel").disabled = false;
    renderReleases();
  }
});
function historyUnavailable() {
  historyFailed = true;
  $("#jobs .history-failure")?.remove();
  const item = node("li", "Operation history refresh failed; it may be stale. Retrying automatically.", "empty-state history-failure");
  item.setAttribute("role", "status");
  $("#jobs").prepend(item);
}
function renderJobs(jobs) {
  historyFailed = false;
  $("#jobs").replaceChildren();
  for (const job of jobs) {
    const item = node("li", undefined, "job");
    const heading = node("div", undefined, "card-heading");
    heading.append(node("strong", `${job.app} · ${jobActions[job.action]}`),
      node("span", job.status, `badge status-${job.status}`));
    item.append(heading,
      node("p", job.message),
      node("small", `${job.id} · updated ${new Date(job.updatedAt * 1000).toLocaleString("sv-SE")}`));
    $("#jobs").append(item);
  }
  if (!jobs.length) $("#jobs").append(node("li", "No operations yet. Confirmed operations and their progress will appear here.", "empty-state"));
}
function closePreview() {
  pending = null;
  if ($("#confirmation").open) $("#confirmation").close();
}
$("#cancel").addEventListener("click", closePreview);
$("#confirmation").addEventListener("cancel", event => {
  if (busy) event.preventDefault(); else pending = null;
});
$("#confirm-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!pending || busy) return;
  if ($("#confirm-name").value !== pending.phrase) {
    $("#confirm-error").textContent = pending.phrase === pending.app ?
      "Application name does not match." : "Confirmation text does not match.";
    return;
  }
  if (Date.now() >= pending.expiresAt * 1000) {
    $("#confirm-error").textContent = "Preview expired. Cancel and preview again.";
    return;
  }
  busy = true;
  $("#confirm").disabled = $("#cancel").disabled = true;
  try {
    const { job } = await api("submit", { previewId: pending.id, idempotencyKey: pending.idempotencyKey });
    const name = pending.app;
    closePreview();
    message(`Operation ${job.id} accepted. Track progress in history.`);
    if (currentView().app === name) releaseMessage(`Operation ${job.id} accepted. Track progress in operation history.`);
  } catch (error) {
    $("#confirm-error").textContent = `${error.message} Retrying uses the same confirmation key.`;
  } finally {
    busy = false;
    $("#confirm").disabled = $("#cancel").disabled = false;
    await refresh(false);
  }
});
async function refresh(showMessage = true) {
  if (loading || busy) return;
  loading = true;
  $("#refresh").disabled = true;
  try {
    const value = await api("session");
    account(value);
    if (session) {
      const [applications, history] = await Promise.allSettled([api("apps"), api("jobs")]);
      if (!session) return;
      // History and applications fail independently: one must not hide the other.
      if (history.status === "fulfilled") renderJobs(history.value.jobs); else historyUnavailable();
      if (applications.status === "rejected") throw applications.reason;
      refreshFailed = false;
      refreshDeferred = false;
      operationRunning = applications.value.busy === true;
      renderApps(applications.value.apps);
      $("#updated").textContent = `Last refreshed ${new Date().toLocaleString("sv-SE")}` +
        (operationRunning ? " · infrastructure operation in progress" : "");
      const shown = $("#message").textContent;
      if (showMessage || !shown || [refreshFailureMessage, historyFailureMessage].includes(shown)) {
        message(historyFailed ? historyFailureMessage : "");
      }
      const view = currentView();
      if (view.app) loadReleases(view.app);
      else if (Date.now() - lastSummaries >= SUMMARY_INTERVAL) loadSummaries();
    }
  } catch (error) {
    if (error.code === "busy" && error.path === "apps" && session) {
      refreshDeferred = true;
      operationRunning = false;
      renderApps(latestApps);
      const shown = $("#message").textContent;
      if (historyFailed && !shown) message(historyFailureMessage);
      else if (!historyFailed && shown === historyFailureMessage) message("");
      $("#updated").textContent = "Application refresh deferred while an infrastructure operation runs; retrying automatically.";
    } else {
      refreshFailed = true;
      refreshDeferred = false;
      operationRunning = false;
      if (session) renderApps(latestApps);
      renderReleases();
      message(refreshFailureMessage);
      $("#updated").textContent = "State unknown — refresh failed";
    }
  } finally { loading = false; $("#refresh").disabled = false; }
}
$("#refresh").addEventListener("click", () => refresh());
$("#release-refresh").addEventListener("click", () => { const { app } = currentView(); if (app) loadReleases(app, true); });
$("#show-failed").addEventListener("change", () => renderReleases());
window.addEventListener("hashchange", route);
route();
$("#logout").addEventListener("click", async () => {
  if (busy) return;
  try { await api("logout", {}); account(null); message("Signed out."); }
  catch (error) { message(error.message); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
setInterval(() => { if (!document.hidden) refresh(false); }, 5000);
refresh();
