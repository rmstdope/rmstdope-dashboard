import { test, expect } from "@playwright/test";
import { verifyTheme } from "./theme-checks.mjs";

const app = {
  name: "atlantis-hud", url: "https://atlantis-hud.rmstdope.eu", health: "healthy",
  publicHealth: "healthy", containerHealth: "healthy", status: "running", version: "v0.31.0",
  revision: "abcdef123456", deployedAt: "2026-01-01T00:00:00Z",
  automation: "enabled", recoveryRequired: false,
};
const feed = (apps = [app], generatedAt = new Date().toISOString()) =>
  ({ schemaVersion: 1, generatedAt, apps });

test("renders cards, launch links, accessible refresh and mobile layout", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/status.json", route => route.fulfill({ json: feed() }));
  await page.goto("/");
  await expect(page.getByText("1 of 1 applications healthy")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Atlantis HUD" })).toBeVisible();
  await expect(page.getByText("v0.31.0")).toBeVisible();
  const link = page.getByRole("link", { name: "Launch Atlantis HUD (new tab)" });
  await expect(link).toHaveAttribute("href", app.url);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await page.getByRole("button", { name: "Refresh status" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("stale and failed refresh never claim current healthy status", async ({ page }) => {
  await page.route("**/status.json", route => route.fulfill({
    json: feed([app], new Date(Date.now() - 181_000).toISOString()),
  }));
  await page.goto("/");
  await expect(page.getByText("Status unknown - data is not current")).toBeVisible();
  await expect(page.locator(".badge")).toHaveText("Unknown");
  await expect(page.locator("#health-value")).toHaveText("Unknown");
  await page.route("**/status.json", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Status refresh failed.", { exact: false })).toBeVisible();
  await expect(page.locator(".badge")).toHaveText("Unknown");
});

test("maintenance is intentional offline with unknown health", async ({ page }) => {
  await page.route("**/status.json", route => route.fulfill({ json: feed([{ ...app, status: "maintenance" }]) }));
  await page.goto("/");
  await expect(page.getByText("Maintenance (intentionally offline)", { exact: true })).toBeVisible();
  await expect(page.locator(".badge")).toHaveText("Unknown");
  await expect(page.getByText("0 of 1 applications healthy")).toBeVisible();
});

test("unavailable first feed and malformed links render no unsafe launch link", async ({ page }) => {
  await page.route("**/status.json", route => route.fulfill({ status: 404, body: "missing" }));
  await page.goto("/");
  await expect(page.getByText("Status unavailable", { exact: true })).toBeVisible();
  await page.route("**/status.json", route => route.fulfill({
    json: feed([{ ...app, url: "javascript:alert(1)" }]),
  }));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".launch")).toHaveCount(0);
});

test("actual container exposes only intended files and headers", async ({ request }) => {
  const health = await request.get("/healthz");
  expect(health.status()).toBe(200);
  const identity = await request.get("/release.json");
  expect((await identity.json()).revision).toMatch(/^[a-f0-9]{40}$/);
  expect(identity.headers()["cache-control"]).toBe("no-store");
  expect(identity.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  for (const path of ["/missing.js", "/app.json", "/manifest.json", "/.git/config", "/status/"]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test("compact cards distinguish tag and merge automation and label revisions", async ({ page }) => {
  const merge = { ...app, name: "dashboard", url: "https://dashboard.rmstdope.eu",
    version: null, updateSource: "merge" };
  await page.route("**/status.json", route => route.fulfill({
    json: feed([{ ...app, updateSource: "tag" }, merge]),
  }));
  await page.goto("/");
  await expect(page.getByText("Automatic (tag)", { exact: true })).toBeVisible();
  await expect(page.getByText("Automatic (merge)", { exact: true })).toBeVisible();
  const cards = page.locator("article");
  await expect(cards.first().locator(".card-top h2")).toHaveText("Atlantis HUD");
  await expect(cards.first().locator(".card-top .badge")).toHaveText("Healthy");
  await expect(cards.nth(1).locator("dt").filter({ hasText: /^Version$/ })).toHaveCount(0);
  await expect(cards.nth(1).locator("dt").filter({ hasText: /^Revision$/ })).toHaveCount(1);
  await expect(page.locator(".intro, .app-mark")).toHaveCount(0);
});

test("timestamps use Swedish format regardless of browser locale", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: "en-US", timezoneId: "Europe/Stockholm" });
  try {
    const page = await context.newPage();
    await page.route("**/status.json", route => route.fulfill({ json: feed() }));
    await page.goto("/");
    await expect(page.locator("#updated")).toHaveText(
      /^Last collected \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect(page.getByText("2026-01-01 01:00:00", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("shows frontend/fullstack and persistence with an unknown fallback for old feeds", async ({ page }) => {
  const frontend = { ...app, applicationType: "frontend", stateful: false };
  const fullstack = { ...app, name: "dominos", url: "https://dominos.rmstdope.eu",
    applicationType: "fullstack", stateful: true };
  const statelessApi = { ...fullstack, name: "api-example", stateful: false };
  const legacy = { ...app, name: "legacy" };
  await page.route("**/status.json", route => route.fulfill({
    json: feed([frontend, fullstack, statelessApi, legacy]),
  }));
  await page.goto("/");
  const cards = page.locator("article");
  for (const [index, label] of [
    "Frontend (stateless)", "Fullstack (stateful)", "Fullstack (stateless)", "Unknown",
  ].entries()) {
    const row = cards.nth(index).locator("dl > div").filter({
      has: page.locator("dt").filter({ hasText: /^Type$/ }),
    });

    await expect(row.locator("dd")).toHaveText(label);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Precision themes follow system changes and save an explicit preference", async ({ page }) => {
  await page.route("**/status.json", route => route.fulfill({ json: feed() }));
  await page.goto("/");
  await verifyTheme(page);
});

test("filters and search use real classifications without changing platform counts", async ({ page }) => {
  await page.route("**/status.json", route => route.fulfill({ json: feed([
    { ...app, applicationType: "frontend", stateful: false },
    { ...app, name: "dominos", url: "https://dominos.rmstdope.eu", applicationType: "fullstack", stateful: true },
  ]) }));
  await page.goto("/");
  await expect(page.locator("#health-value")).toHaveText("2 / 2");
  await page.getByRole("button", { name: "Fullstack", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Dominos", exact: true })).toBeVisible();
  await expect(page.locator("#health-value")).toHaveText("2 / 2");
  await page.getByRole("searchbox", { name: "Find an application" }).fill("atlantis");
  await expect(page.locator("#empty")).toBeVisible();
  await page.getByRole("button", { name: "All apps", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Find an application" }).clear();
  await expect(page.locator(".card")).toHaveCount(2);
});
