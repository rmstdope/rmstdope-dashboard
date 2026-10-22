import { validateSnapshot, isStale, displayHealth, applicationTypeLabel, title } from "./model.js";
import { collection } from "./collection.js";

let snapshot = null;
let failed = false;
let loading = false;
const labels = {
  healthy: "Healthy", unhealthy: "Unhealthy", unknown: "Unknown",
  running: "Running", degraded: "Degraded", "not-deployed": "Not deployed",
  "recovery-required": "Recovery required", enabled: "Automatic",
  paused: "Paused", manual: "Manual", maintenance: "Maintenance (intentionally offline)",
};
const apps = document.querySelector("#apps");
const summary = document.querySelector("#summary");
const updated = document.querySelector("#updated");
const notice = document.querySelector("#notice");
const refresh = document.querySelector("#refresh");
const visibleApps = collection(render, app => app.applicationType);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detail(list, label, value) {
  const row = element("div");
  row.append(element("dt", "", label), element("dd", "", value));
  list.append(row);
}

function render() {
  if (!snapshot) {
    summary.textContent = failed ? "Status unavailable" : "Loading application status...";
    notice.hidden = !failed;
    notice.textContent = "The status feed could not be loaded. No health information is available yet.";
    return;
  }
  const stale = failed || isStale(snapshot);
  const healthy = snapshot.apps.filter(app => displayHealth(app, stale) === "healthy").length;
  document.querySelector("#health-value").textContent = stale ? "Unknown" : `${healthy} / ${snapshot.apps.length}`;
  document.querySelector("#health-description").textContent = stale ? "Current health is not available" : "Applications currently healthy";
  const automatic = snapshot.apps.filter(app => app.automation === "enabled").length;
  document.querySelector("#automation-value").textContent = String(automatic);
  document.querySelector("#automation-description").textContent = stale ? "Automatic update policies (last known)" : "Applications with automatic updates";
  const latest = snapshot.apps.filter(app => app.deployedAt).sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt))[0];
  document.querySelector("#deployment-value").textContent = latest ? title(latest.name) : "Not available";
  document.querySelector("#deployment-description").textContent = latest
    ? `Recorded ${new Date(latest.deployedAt).toLocaleString("sv-SE")}${stale ? " (last known)" : ""}` : "No recorded deployment timestamp";
  summary.textContent = stale ? "Status unknown - data is not current" :
    `${healthy} of ${snapshot.apps.length} applications healthy`;
  updated.textContent = `Last collected ${new Date(snapshot.generatedAt).toLocaleString("sv-SE")}`;
  notice.hidden = !stale;
  notice.textContent = failed ?
    "Status refresh failed. Showing the last snapshot; current health is unknown." :
    "The collector has not published a current snapshot. Displayed deployment details may be out of date.";
  apps.replaceChildren();
  if (!snapshot.apps.length) {
    apps.append(element("p", "notice", "No applications are registered."));
  }
  const visible = visibleApps(snapshot.apps);
  document.querySelector("#empty").hidden = !snapshot.apps.length || visible.length > 0;
  for (const app of visible) {
    const health = displayHealth(app, stale);
    const card = element("article", "card");
    const top = element("div", "card-top");
    const badge = element("span", `badge ${health}`, labels[health]);
    const icon = element("span", "app-icon", title(app.name).slice(0, 1));
    icon.setAttribute("aria-hidden", "true");
    top.append(icon, element("h2", "", title(app.name)), badge);
    card.append(top,
      element("p", "hostname", new URL(app.url).hostname));
    if (app.recoveryRequired) card.append(element("p", "warning", "Recovery required"));
    const details = element("dl");
    detail(details, "Type", applicationTypeLabel(app));
    detail(details, "Status", stale ? "Unknown (stale)" : labels[app.status]);
    if (app.version) detail(details, "Version", app.version);
    detail(details, "Revision", app.revision || "Not available");
    detail(details, "Public HTTPS", stale || app.status === "maintenance" ? "Unknown" : labels[app.publicHealth]);
    detail(details, "Container", stale || app.status === "maintenance" ? "Unknown" : labels[app.containerHealth]);
    detail(details, "Deployment", app.deployedAt ? new Date(app.deployedAt).toLocaleString("sv-SE") : "Not available");
    const updates = app.automation === "enabled" && app.updateSource ?
      `Automatic (${app.updateSource})` : labels[app.automation];
    detail(details, "Updates", `${updates}${stale ? " (last known)" : ""}`);
    const link = element("a", "launch button", "Launch application ↗");
    link.href = app.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Launch ${title(app.name)} (new tab)`);
    card.append(details, link);
    apps.append(card);
  }
}

async function load() {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  try {
    const response = await fetch("/status.json", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 262144) throw new Error("Status response too large");
    snapshot = validateSnapshot(JSON.parse(text));
    failed = false;
  } catch (error) {
    console.error("Status refresh failed:", error);
    failed = true;
  } finally {
    loading = false;
    refresh.disabled = false;
    render();
  }
}

refresh.addEventListener("click", load);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(load, 30_000);
setInterval(render, 5_000);
load();
