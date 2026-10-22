const $ = selector => document.querySelector(selector);
const actions = {
  offline: "Take offline (maintenance)", online: "Bring online",
  pause: "Pause automatic updates", resume: "Resume automatic updates",
  update: "Update now", restart: "Restart HTTP services", rollback: "Rollback application image",
};
let session = null, pending = null, busy = false, loading = false;
const selectedActions = new Map();
let renderedApps = null;
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
  if (!session) {
    $("#apps").replaceChildren(); $("#jobs").replaceChildren(); closePreview();
    selectedActions.clear();
    renderedApps = null;
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
    throw new Error(result.error?.message || "Control request failed.");
  }
  return result;
}
function detail(list, label, value) {
  const row = node("div");
  row.append(node("dt", label), node("dd", value));
  list.append(row);
}
function renderApps(apps) {
  const healthy = apps.filter(app => app.desired === "online" && app.health === "healthy").length;
  const offline = apps.filter(app => app.desired === "offline").length;
  const paused = apps.filter(app => app.automation === "paused").length;
  $("#summary").textContent = `${healthy} of ${apps.length} applications healthy · ${offline} offline · ${paused} with updates paused`;
  const snapshot = JSON.stringify(apps);
  if (snapshot === renderedApps) return;
  renderedApps = snapshot;
  for (const name of selectedActions.keys()) {
    if (!apps.some(app => app.name === name)) selectedActions.delete(name);
  }
  $("#apps").replaceChildren();
  for (const app of apps) {
    const card = node("article", undefined, "app-card");
    const heading = node("div", undefined, "card-heading");
    const status = app.desired === "offline" ? "maintenance" : app.health;
    heading.append(node("h3", app.name), node("span", status, `badge status-${status}`));
    card.append(heading);
    const link = node("a", new URL(app.url).hostname);
    link.href = app.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(link);
    const list = node("dl");
    detail(list, "Desired state", app.desired === "offline" ? "Offline · maintenance" : "Online");
    detail(list, "Health", app.health);
    const profile = app.profile === "fullstack" ? "Fullstack" : app.profile === "frontend" ? "Frontend" : "Unknown";
    detail(list, "Type", `${profile} (${app.stateful ? "stateful" : "stateless"})`);
    detail(list, "Release", app.version || app.revision || "Not deployed");
    detail(list, "Automatic updates", app.automation);
    card.append(list);
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
          pending = { ...result.preview, idempotencyKey: crypto.randomUUID() };
          $("#confirm-title").textContent = `${actions[pending.action]}: ${pending.app}`;
          $("#effects").textContent = pending.warning;
          $("#target").textContent = `Release: ${pending.version || pending.revision || "current release"}`;
          $("#expiry").textContent = `Preview expires ${new Date(pending.expiresAt * 1000).toLocaleString("sv-SE")}. Changes after preview are rejected.`;
          $("#confirm-name").value = "";
          $("#confirm-error").textContent = "";
          $("#confirmation").showModal();
          $("#confirm-name").focus();
          message("");
        } catch (error) { message(error.message); }
        finally { busy = false; button.disabled = app.recoveryRequired; }
      });
      card.append(form);
    }
    $("#apps").append(card);
  }
  if (!apps.length) $("#apps").append(node("p", "No registered applications."));
}
function renderJobs(jobs) {
  $("#jobs").replaceChildren();
  for (const job of jobs) {
    const item = node("li", undefined, "job");
    const heading = node("div", undefined, "card-heading");
    heading.append(node("strong", `${job.app} · ${actions[job.action]}`),
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
  if ($("#confirm-name").value !== pending.app) {
    $("#confirm-error").textContent = "Application name does not match.";
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
    closePreview();
    message(`Operation ${job.id} accepted. Track progress in history.`);
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
      const [applications, history] = await Promise.all([api("apps"), api("jobs")]);
      renderApps(applications.apps);
      renderJobs(history.jobs);
      $("#updated").textContent = `Last refreshed ${new Date().toLocaleString("sv-SE")}`;
      if (showMessage) message("");
    }
  } catch {
    message("Refresh failed. Displayed state may be stale. Operations require a new executor preview.");
    $("#updated").textContent = "State unknown — refresh failed";
  } finally { loading = false; $("#refresh").disabled = false; }
}
$("#refresh").addEventListener("click", () => refresh());
$("#logout").addEventListener("click", async () => {
  if (busy) return;
  try { await api("logout", {}); account(null); message("Signed out."); }
  catch (error) { message(error.message); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
setInterval(() => { if (!document.hidden) refresh(false); }, 5000);
refresh();
