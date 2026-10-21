import { test, expect } from "@playwright/test";

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
  await page.route("**/status.json", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Status refresh failed.", { exact: false })).toBeVisible();
  await expect(page.locator(".badge")).toHaveText("Unknown");
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
