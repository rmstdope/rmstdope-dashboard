import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "control.browser.spec.mjs",
  use: { baseURL: "https://control.rmstdope.eu", channel: process.env.PLAYWRIGHT_CHANNEL },
  webServer: process.env.CONTROL_TEST_URL ? undefined : {
    command: "node tests/control-browser-server.mjs",
    url: "http://127.0.0.1:18081/healthz",
    reuseExistingServer: false,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
