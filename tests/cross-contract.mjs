import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { Store } from "../control/store.mjs";
import { createControlServer, rejectionReasons } from "../control/server.mjs";
import { execute } from "../control/executor.mjs";
import { validateSnapshot } from "../web/model.js";

const infra = process.env.INFRA_CHECKOUT;
if (!infra || !fs.existsSync(path.join(infra, "src/rmstdope_deploy/control.py"))) {
  throw new Error("Set INFRA_CHECKOUT to the reviewed rmstdope-infra checkout");
}
const executorSource = fs.readFileSync(path.join(infra, "src/rmstdope_deploy/control.py"), "utf8");
for (const reason of rejectionReasons.keys()) {
  assert.ok(executorSource.includes(JSON.stringify(reason)), `Executor no longer rejects with: ${reason}`);
}
const dir = path.join(process.cwd(), `contract-test-${process.pid}`);
fs.mkdirSync(dir, { mode: 0o700 });
const python = spawn(process.env.PYTHON || "python3",
  ["-u", "tests/fixtures/python-executor.py", infra, dir], { stdio: ["pipe", "pipe", "inherit"] });
const exited = once(python, "exit");
const lines = createInterface({ input: python.stdout });
const replies = lines[Symbol.asyncIterator]();
const next = async () => {
  const result = await replies.next();
  assert.equal(result.done, false, "Python executor fixture exited unexpectedly");
  return JSON.parse(result.value);
};
const command = async value => { python.stdin.write(`${value}\n`); return next(); };
let server;
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("Integration HTTP timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
}
try {
  assert.equal((await next()).ready, true);
  const store = new Store(path.join(dir, "sessions"));
  const id = store.create("123");
  const session = store.session(id, new Set(["123"]));
  server = createControlServer({
    origin: "https://control.rmstdope.eu", admins: new Set(["123"]),
    clientId: "unused", clientSecret: "unused", storeDir: path.join(dir, "sessions"),
    socket: path.join(dir, "s"),
  }, { store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function api(endpoint, body, expected = 200) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const result = await request(`${url}/api/${endpoint}`, {
      method: encoded ? "POST" : "GET",
      headers: { Host: "control.rmstdope.eu", Cookie: `__Host-control-session=${id}`,
        ...(encoded ? { Origin: "https://control.rmstdope.eu",
          "Content-Length": Buffer.byteLength(encoded),
          "Content-Type": "application/json", "X-CSRF-Token": session.csrf } : {}) },
      body: encoded,
    });
    assert.equal(result.status, expected, JSON.stringify(result));
    return result.json;
  }
  const list = await api("apps");
  assert.equal(list.apps[0].revision, "a".repeat(40));
  assert.equal(list.apps[0].profile, "frontend");
  assert.ok(["running", "degraded", "unknown"].includes(list.apps[0].status));
  assert.ok(["healthy", "unhealthy", "unknown"].includes(list.apps[0].publicHealth));
  assert.ok(["healthy", "unhealthy", "unknown"].includes(list.apps[0].containerHealth));
  assert.ok(Number.isFinite(Date.parse(list.apps[0].deployedAt)));
  const headless = list.apps.find(entry => entry.name === "oracle");
  assert.equal(headless.url, null);
  assert.equal(headless.profile, "worker");
  assert.equal(headless.publicHealth, "n/a");
  assert.equal(headless.status, "not-deployed");
  const history = await api("apps/example/releases");
  assert.deepEqual(history.releases.map(entry => [entry.release, entry.current, entry.previous]), [
    ["20260101T000000-aaaaaaaa", true, false], ["20251201T000000-99999999", false, true]]);
  assert.equal(history.releases[1].outcome, "success");
  assert.equal(history.releases[1].snapshot.status, "none");
  assert.deepEqual(history.backup, { configured: false, restore: false });
  const rollback = (await api("preview", { app: "example", action: "rollback",
    target: "20251201T000000-99999999" })).preview;
  assert.equal(rollback.release, "20251201T000000-99999999");
  assert.deepEqual(rollback.options, { backup: false, restore: false });
  assert.equal(rollback.revision, "9".repeat(40));
  const absent = await api("preview", { app: "example", action: "rollback",
    target: "20990101T000000-abcdef12" }, 409);
  assert.equal(absent.error.message, "That release is no longer stored. Refresh the release history.");
  const unrestorable = await api("preview", { app: "example", action: "rollback",
    target: "20251201T000000-99999999", restore: true }, 409);
  assert.equal(unrestorable.error.message, "That release has no snapshot that can be restored. Refresh the release history.");
  const noBackup = await api("preview", { app: "example", action: "rollback",
    target: "20251201T000000-99999999", backup: true }, 409);
  assert.equal(noBackup.error.message, "No pre-release backup is configured for this application.");
  const { preview } = await api("preview", { app: "example", action: "pause" });
  assert.equal(typeof preview.expiresAt, "number");
  assert.equal(Number.isInteger(preview.expiresAt), false);
  const body = { previewId: preview.id, idempotencyKey: "cross-boundary-123456" };
  const { job } = await api("submit", body, 202);
  assert.equal(job.status, "queued");
  assert.equal(Number.isInteger(job.createdAt), false);
  assert.equal((await api("submit", body, 202)).job.id, job.id);
  const direct = await execute(path.join(dir, "s"), { operation: "job", actor: "123", id: job.id });
  assert.equal(direct.job.actor, "123");
  assert.equal(Object.hasOwn(job, "actor"), false);
  await command("execute");
  assert.equal((await api(`jobs/${job.id}`)).job.status, "succeeded");
  assert.equal((await api("jobs")).jobs[0].status, "succeeded");
  const rejection = await execute(path.join(dir, "s"), { operation: "list", actor: "999" });
  assert.deepEqual(Object.keys(rejection.error).sort(), ["code", "message"]);
  assert.equal(rejection.error.code, "rejected");
  const extra = await execute(path.join(dir, "s"), { operation: "list", actor: "123", command: "ignored" });
  assert.equal(extra.error.code, "rejected");
  await api("preview", { app: "example", action: "pause", actor: "999" }, 400);
  const { snapshot } = await command("worker");
  validateSnapshot(snapshot);
  const feedWorker = snapshot.apps.find(entry => entry.name === "oracle");
  assert.deepEqual([feedWorker.url, feedWorker.applicationType, feedWorker.publicHealth, feedWorker.health,
    feedWorker.status], [null, "worker", "n/a", "healthy", "running"]);
  const deployedWorker = (await api("apps")).apps.find(entry => entry.name === "oracle");
  assert.deepEqual([deployedWorker.url, deployedWorker.publicHealth, deployedWorker.health,
    deployedWorker.status], [null, "n/a", "healthy", "running"]);
  await command("offline");
  const offline = await api("apps");
  assert.equal(offline.apps[0].desired, "offline");
  assert.equal(offline.apps[0].revision, "a".repeat(12));
  assert.equal(offline.apps[0].health, "unknown");
  console.log("PASS real Node API → Python Executor/Server: list, release history, rollback target and option rejections, fractional preview/job timestamps, submit/idempotency, session actor audit, executed pause, job/history, rejection shape, spoof denial, offline short revision, headless worker without link, real collector feed and deployed worker health");
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (python.exitCode === null) python.stdin.end("stop\n");
  await exited;
  fs.rmSync(dir, { recursive: true, force: true });
}
