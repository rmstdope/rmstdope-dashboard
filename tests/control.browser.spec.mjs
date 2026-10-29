import { test, expect } from "@playwright/test";
import { verifyTheme } from "./theme-checks.mjs";

const upstream = process.env.CONTROL_TEST_URL || "http://127.0.0.1:18081";
const app = {
  name: "example", url: "https://example.rmstdope.eu", profile: "fullstack", stateful: true,
  desired: "online", health: "unknown", revision: "a".repeat(40), version: "v1.2.3",
  automation: "paused", recoveryRequired: false, protected: false, status: "unknown",
  publicHealth: "unknown", containerHealth: "unknown", deployedAt: null, updateSource: "merge",
};
const signedIn = { authenticated: true, actor: "123456", csrf: "test-csrf", recent: true };
const job = {
  id: "b".repeat(32), app: "example", action: "rollback", status: "queued",
  createdAt: 1800000000, updatedAt: 1800000000, message: "Waiting for the executor.",
};
async function setup(page, options = {}) {
  const submits = [], previews = [], errors = [];
  let appRequests = 0;
  let authenticated = options.authenticated !== false;
  let submitCount = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://control.rmstdope.eu/**", async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) {
      const response = await route.fetch({
        url: `${upstream}${url.pathname}`, headers: { Host: "control.rmstdope.eu" },
      });
      return route.fulfill({ response });
    }
    const json = value => route.fulfill({ json: value });
    if (url.pathname === "/api/session") return json(authenticated ? signedIn : { authenticated: false });
    if (url.pathname === "/api/logout") { authenticated = false; return json({ ok: true }); }
    if (url.pathname === "/api/apps") {
      appRequests++;
      return json({ apps: typeof options.apps === "function" ? options.apps() : options.apps || [app, {
        ...app, name: "control", protected: true,
      }] });
    }
    if (url.pathname === "/api/jobs") return json({ jobs: options.jobs ? options.jobs() : [] });
    if (url.pathname === "/api/preview") {
      const request = route.request().postDataJSON();
      previews.push(request);
      if (options.beforePreview) await options.beforePreview();
      if (options.previewFailure) return route.fulfill({
        status: 503, json: { error: { message: "Preview temporarily unavailable." } },
      });
      return json({ preview: {
        id: "c".repeat(32), ...request, expiresAt: Math.floor(Date.now() / 1000) + 120,
        revision: app.revision, version: app.version,
        warning: "The database is NOT rolled back. Automatic updates remain paused.",
      } });
    }
    if (url.pathname === "/api/submit") {
      submits.push(route.request().postDataJSON());
      submitCount++;
      if (options.failFirstSubmit && submitCount === 1) return route.fulfill({
        status: 503, json: { error: { message: "Executor temporarily unavailable." } },
      });
      return json({ job });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/");
  return { submits, previews, errors, appRequests: () => appRequests };
}

test("signed-out control has explicit GitHub sign-in and no operation controls", async ({ page }) => {
  const { errors } = await setup(page, { authenticated: false });
  await expect(page.getByText("Not signed in", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute("href", "/auth/login");
  for (const name of ["Sign in with GitHub", "Public dashboard"]) {
    const link = page.getByRole("link", { name, exact: true });
    const style = await link.evaluate(node => {
      const css = getComputedStyle(node);
      return { display: css.display, height: node.getBoundingClientRect().height,
        decoration: css.textDecorationLine };
    });
    expect(["flex", "inline-flex"]).toContain(style.display);
    expect(style.height).toBeGreaterThanOrEqual(44);
    expect(style.decoration).toBe("none");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Preview operation" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("selected actions survive scheduled and changed-state refreshes and reach the preview unchanged", async ({ page }) => {
  await page.clock.install();
  let current = { ...app };
  const result = await setup(page, { apps: () => [current] });
  const select = page.getByRole("combobox", { name: "Operation for example" });
  await expect(select).toHaveValue("pause");
  await select.selectOption("update");
  await select.focus();
  const previous = result.appRequests();
  await page.clock.runFor(5100);
  await expect.poll(result.appRequests).toBeGreaterThan(previous);
  await expect(select).toHaveValue("update");
  await expect(select).toBeFocused();

  current = { ...current, health: "healthy" };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".status-healthy")).toBeVisible();
  await expect(select).toHaveValue("update");
  for (const action of ["update", "restart", "rollback", "resume", "offline", "pause"]) {
    await select.selectOption(action);
    await page.getByRole("button", { name: "Preview operation" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(result.previews.at(-1)).toEqual({ app: "example", action });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  current = { ...current, desired: "offline" };
  await select.selectOption("restart");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(select).toHaveValue("online");
  await page.getByRole("button", { name: "Preview operation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(result.previews.at(-1)).toEqual({ app: "example", action: "online" });
  expect(result.submits).toHaveLength(0);
  expect(result.errors).toEqual([]);
});

test("typed confirmation, database warning, protected self apps and sign out", async ({ page }) => {
  const { submits, errors } = await setup(page);
  await expect(page.getByText("GitHub ID 123456")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview operation" })).toHaveCount(1);
  await page.getByRole("combobox", { name: "Operation for example" }).selectOption("rollback");
  await page.getByRole("button", { name: "Preview operation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#effects")).toContainText("database is NOT rolled back");
  await page.getByLabel("Type the application name to confirm").fill("wrong");
  await page.getByRole("button", { name: "Confirm operation" }).click();
  await expect(page.getByText("Application name does not match.")).toBeVisible();
  expect(submits).toHaveLength(0);
  await page.getByLabel("Type the application name to confirm").fill("example");
  await page.getByRole("button", { name: "Confirm operation" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("accepted");
  expect(submits).toHaveLength(1);
  expect(Object.keys(submits[0]).sort()).toEqual(["idempotencyKey", "previewId"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Not signed in", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview operation" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("submission retry retains idempotency key and preview without another operation", async ({ page }) => {
  const { submits } = await setup(page, { failFirstSubmit: true });
  await page.getByRole("button", { name: "Preview operation" }).click();
  await page.getByLabel("Type the application name to confirm").fill("example");
  await page.getByRole("button", { name: "Confirm operation" }).click();
  await expect(page.locator("#confirm-error")).toContainText("Retrying uses the same confirmation key");
  await page.getByRole("button", { name: "Confirm operation" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(submits).toHaveLength(2);
  expect(submits[0]).toEqual(submits[1]);
});

test("offline blocks unsafe actions and history shows queued then completed progress", async ({ page }) => {
  let done = false;
  await setup(page, {
    apps: [{ ...app, desired: "offline" }],
    jobs: () => [{ ...job, status: done ? "succeeded" : "queued",
      message: done ? "Operation completed." : "Waiting for the executor." }],
  });
  await expect(page.getByText("Offline · maintenance", { exact: true })).toBeVisible();
  for (const action of ["resume", "update", "restart", "rollback"]) {
    await expect(page.locator(`option[value="${action}"]`)).toBeDisabled();
  }
  await expect(page.locator("#jobs")).toContainText("queued");
  done = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#jobs")).toContainText("succeeded");
  await expect(page.locator("#updated")).toHaveText(/^Last refreshed \d{4}-\d{2}-\d{2} /);
});

test("untrusted messages and app data remain text, not markup", async ({ page }) => {
  await setup(page, {
    apps: [{ ...app, profile: "<img src=x onerror=alert(1)>" }],
    jobs: () => [{ ...job, message: "<img src=x onerror=alert(1)>" }],
  });
  await expect(page.locator("#jobs")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("img")).toHaveCount(0);
});

test("actual server is unprivileged surface with safe headers and no session/state files", async ({ request }) => {
  const health = await request.get(`${upstream}/healthz`);
  expect(health.status()).toBe(200);
  const headers = { Host: "control.rmstdope.eu" };
  const html = await request.get(`${upstream}/`, { headers });
  expect(html.status()).toBe(200);
  expect(html.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(html.headers()["cache-control"]).toBe("no-store");
  for (const route of ["/.git/config", "/sessions.json", "/server.mjs", "/api/apps"]) {
    expect((await request.get(`${upstream}${route}`, { headers })).status()).toBe(route === "/api/apps" ? 401 : 404);
  }
});

test("control uses the shared system-aware, persisted light and dark themes", async ({ page }) => {
  await setup(page);
  await verifyTheme(page);
});

test("filtering and searching preserve chosen actions without filtering overview counts", async ({ page }) => {
  const { previews } = await setup(page);
  const select = page.getByRole("combobox", { name: "Operation for example" });
  await expect(page.locator("#automation-value")).toHaveText("0");
  await select.selectOption("restart");
  await page.getByRole("button", { name: "Frontend", exact: true }).click();
  await expect(page.locator("#empty")).toBeVisible();
  await page.getByRole("button", { name: "Fullstack", exact: true }).click();
  await expect(select).toHaveValue("restart");
  await page.getByRole("searchbox", { name: "Find an application" }).fill("missing");
  await expect(page.locator("#empty")).toBeVisible();
  await page.getByRole("searchbox", { name: "Find an application" }).clear();
  await expect(select).toHaveValue("restart");
  await page.getByRole("button", { name: "Preview operation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(previews.at(-1)).toEqual({ app: "example", action: "restart" });
});

test("application cards show the same details as the public dashboard", async ({ page }) => {
  const deployedAt = "2026-10-29T10:44:53.000Z";
  await setup(page, { apps: [{ ...app, health: "unhealthy", status: "degraded", publicHealth: "healthy",
    containerHealth: "unhealthy", deployedAt, automation: "enabled", updateSource: "tag" }] });
  const card = page.locator(".app-card").first();
  const row = label => card.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");
  await expect(row("Type")).toHaveText("Fullstack (stateful)");
  await expect(row("Status")).toHaveText("Degraded");
  await expect(row("Version")).toHaveText("v1.2.3");
  await expect(row("Revision")).toHaveText("a".repeat(12));
  await expect(row("Public HTTPS")).toHaveText("Healthy");
  await expect(row("Container")).toHaveText("Unhealthy");
  await expect(row("Deployment")).toHaveText(await page.evaluate(value => new Date(value).toLocaleString("sv-SE"), deployedAt));
  await expect(row("Automatic updates")).toHaveText("Automatic (tag)");
  await expect(card.getByRole("link", { name: "example.rmstdope.eu" })).toHaveAttribute("target", "_blank");
  await page.route("**/api/apps", route => route.fulfill({ status: 503, json: {} }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row("Status")).toHaveText("Unknown (stale)");
  await expect(row("Public HTTPS")).toHaveText("Unknown");
  await expect(row("Container")).toHaveText("Unknown");
  await expect(row("Automatic updates")).toHaveText("Automatic (tag) (last known)");
});

test("failed refresh makes overview health and application badges unknown", async ({ page }) => {
  await setup(page, { apps: [{ ...app, health: "healthy" }] });
  await expect(page.locator("#health-value")).toHaveText("1 / 1");
  await page.route("**/api/apps", route => route.fulfill({ status: 503, json: {} }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#health-value")).toHaveText("Unknown");
  await expect(page.locator(".status-healthy")).toHaveCount(0);
  await expect(page.locator("#message")).toContainText("may be stale");
});

for (const action of ["offline", "online"]) {
  test(`${action} keeps last known app state and updates history while the executor is busy`, async ({ page }) => {
    await page.clock.install();
    let current = { ...app, health: "healthy", desired: action === "online" ? "offline" : "online" };
    let status = "running";
    const { submits, errors } = await setup(page, {
      apps: () => [current, { ...app, name: "other", health: "healthy" }],
      jobs: () => [{ ...job, action, status }],
    });
    const target = page.locator(".app-card").filter({ has: page.getByRole("heading", { name: "Example", exact: true }) });
    const other = page.locator(".app-card").filter({ has: page.getByRole("heading", { name: "Other", exact: true }) });
    await expect(other.locator(".status-healthy")).toBeVisible();
    await target.getByRole("combobox").selectOption(action);
    await target.getByRole("button", { name: "Preview operation" }).click();
    const lockBusy = route => route.fulfill({
      status: 409, json: { error: { code: "busy", message: "Another operation is in progress." } },
    });
    await page.route("**/api/apps", lockBusy);
    await page.getByLabel("Type the application name to confirm").fill("example");
    await page.getByRole("button", { name: "Confirm operation" }).click();
    await expect(page.locator("#updated")).toContainText("refresh deferred");
    await expect(page.locator("#message")).toContainText("accepted");
    await expect(page.locator("#summary")).toContainText("last known application state");
    await expect(other.locator(".status-healthy")).toBeVisible();
    await expect(other.locator("dt").filter({ hasText: "Last known health" })).toBeVisible();
    await expect(page.locator("#jobs")).toContainText("running");
    status = "succeeded";
    await page.clock.runFor(5100);
    await expect(page.locator("#jobs")).toContainText("succeeded");
    await expect(page.locator("#message")).not.toContainText("Refresh failed");

    current = { ...current, desired: action === "offline" ? "offline" : "online" };
    await page.unroute("**/api/apps", lockBusy);
    await page.clock.runFor(5000);
    await expect(page.locator("#updated")).toHaveText(/^Last refreshed /);
    await expect(page.locator("#summary")).not.toContainText("last known");
    await expect(target.locator(action === "offline" ? ".status-maintenance" : ".status-healthy")).toBeVisible();
    await expect(other.locator(".status-healthy")).toBeVisible();
    expect(submits).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test("busy executor does not hide genuine refresh or history failures", async ({ page }) => {
  await page.clock.install();
  await setup(page, { apps: [{ ...app, health: "healthy" }] });
  await expect(page.locator("#health-value")).toHaveText("1 / 1");
  const unavailable = route => route.fulfill({
    status: 503, json: { error: { code: "unavailable" } },
  });
  await page.route("**/api/apps", unavailable);
  await page.clock.runFor(5100);
  await expect(page.locator("#health-value")).toHaveText("Unknown");
  await page.unroute("**/api/apps", unavailable);
  await page.route("**/api/apps", route => route.fulfill({
    status: 409, json: { error: { code: "busy" } },
  }));
  await page.clock.runFor(5000);
  await expect(page.locator("#updated")).toContainText("refresh deferred");
  await expect(page.locator("#health-value")).toHaveText("Unknown");
  await expect(page.locator("#message")).toContainText("Refresh failed");
  await page.route("**/api/jobs", unavailable);
  await page.clock.runFor(5000);
  await expect(page.locator("#updated")).toContainText("refresh failed");
  await expect(page.locator("#message")).toContainText("Refresh failed");
});

test("scheduled refresh clears a recovered failure without clearing operation feedback", async ({ page }) => {
  await page.clock.install();
  await setup(page, { apps: [{ ...app, health: "healthy" }], previewFailure: true });
  await expect(page.locator("#health-value")).toHaveText("1 / 1");
  const failRefresh = route => route.fulfill({ status: 503, json: {} });
  await page.route("**/api/apps", failRefresh);
  await page.clock.runFor(5100);
  await expect(page.locator("#message")).toContainText("may be stale");
  await expect(page.locator("#health-value")).toHaveText("Unknown");

  await page.unroute("**/api/apps", failRefresh);
  await page.clock.runFor(5000);
  await expect(page.locator("#health-value")).toHaveText("1 / 1");
  await expect(page.locator(".status-healthy")).toBeVisible();
  await expect(page.locator("#updated")).toHaveText(/^Last refreshed /);
  await expect(page.locator("#message")).toBeEmpty();

  await page.getByRole("button", { name: "Preview operation" }).click();
  await expect(page.locator("#message")).toHaveText("Preview temporarily unavailable.");
  await page.clock.runFor(5000);
  await expect(page.locator("#message")).toHaveText("Preview temporarily unavailable.");
});

test("recovery preserves operation feedback that replaced the refresh warning", async ({ page }) => {
  await page.clock.install();
  await setup(page, { apps: [app], previewFailure: true });
  await expect(page.locator("#health-value")).toHaveText("0 / 1");
  const failRefresh = route => route.fulfill({ status: 503, json: {} });
  await page.route("**/api/apps", failRefresh);
  await page.clock.runFor(5100);
  await expect(page.locator("#message")).toContainText("may be stale");
  await page.getByRole("button", { name: "Preview operation" }).click();
  await expect(page.locator("#message")).toHaveText("Preview temporarily unavailable.");

  await page.unroute("**/api/apps", failRefresh);
  await page.clock.runFor(5000);
  await expect(page.locator("#health-value")).toHaveText("0 / 1");
  await expect(page.locator("#message")).toHaveText("Preview temporarily unavailable.");
});

for (const previewFailure of [false, true]) {
  test(`filtering during a ${previewFailure ? "failed" : "successful"} preview restores current operation buttons`, async ({ page }) => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const { previews, errors } = await setup(page, {
      beforePreview: () => waiting, previewFailure,
      apps: [app, { ...app, name: "recovery", recoveryRequired: true }],
    });
    const example = page.locator(".app-card").filter({ has: page.getByRole("heading", { name: "Example", exact: true }) });
    const recovery = page.locator(".app-card").filter({ has: page.getByRole("heading", { name: "Recovery", exact: true }) });
    await example.getByRole("combobox").selectOption("restart");
    await example.getByRole("button", { name: "Preview operation" }).click();
    await expect.poll(() => previews.length).toBe(1);
    await page.getByRole("button", { name: "Frontend", exact: true }).click();
    await page.getByRole("button", { name: "Fullstack", exact: true }).click();
    await expect(example.getByRole("button")).toBeDisabled();
    release();
    if (previewFailure) {
      await expect(page.locator("#message")).toContainText("Preview temporarily unavailable.");
    } else {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(example.getByRole("button")).toBeEnabled();
    await expect(recovery.getByRole("button")).toBeDisabled();
    await expect(example.getByRole("combobox")).toHaveValue("restart");
    await example.getByRole("button").click();
    await expect.poll(() => previews.length).toBe(2);
    expect(previews.at(-1)).toEqual({ app: "example", action: "restart" });
    expect(errors).toEqual([]);
  });
}
