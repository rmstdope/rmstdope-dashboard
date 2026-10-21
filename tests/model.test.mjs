import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSnapshot, isStale, displayHealth, title } from "../web/model.js";

const app = {
  name: "example", url: "https://example.rmstdope.eu", health: "healthy",
  publicHealth: "healthy", containerHealth: "healthy", status: "running",
  version: null, revision: "abcdef123456", deployedAt: null,
  automation: "manual", recoveryRequired: false,
};
const snapshot = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", apps: [app] };

test("rejects unsafe links, malformed health, duplicates and unsupported schema", () => {
  for (const value of [
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, generatedAt: "invalid" },
    { ...snapshot, apps: [app, app] },
    ...[{ url: "javascript:alert(1)" }, { url: "https://external.example" },
      { name: "<script>" }, { health: "fine" }, { version: "<img>" },
      { revision: "not-a-revision" }].map(change => ({ ...snapshot, apps: [{ ...app, ...change }] })),
  ]) assert.throws(() => validateSnapshot(value));
});

test("stale or future snapshots never retain healthy presentation", () => {
  const time = Date.parse(snapshot.generatedAt);
  assert.equal(isStale(snapshot, time + 180_000), false);
  assert.equal(isStale(snapshot, time + 180_001), true);
  assert.equal(isStale(snapshot, time - 30_001), true);
  assert.equal(displayHealth(app, true), "unknown");
  assert.equal(displayHealth(app, false), "healthy");
});

test("accepts all deployed status cases and an empty directory", () => {
  for (const status of ["running", "degraded", "not-deployed", "recovery-required", "unknown"]) {
    validateSnapshot({ ...snapshot, apps: [{ ...app, status }] });
  }
  validateSnapshot({ ...snapshot, apps: [] });
});

test("supports registered aliases and consecutive/trailing hyphens in app names", () => {
  validateSnapshot({ ...snapshot, apps: [{ ...app, name: "foo--bar-", url: "https://alias.rmstdope.eu" }] });
  assert.equal(title("foo--bar-"), "Foo Bar");
});

test("accepts old snapshots and validates optional update source", () => {
  for (const updateSource of [undefined, null, "merge", "tag"]) {
    validateSnapshot({ ...snapshot, apps: [{ ...app, updateSource }] });
  }
  assert.throws(() => validateSnapshot({ ...snapshot, apps: [{ ...app, updateSource: "arbitrary" }] }));
});
