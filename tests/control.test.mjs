import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { configuration } from "../control/config.mjs";
import { Store, IDLE, MAX_AGE, RECENT } from "../control/store.mjs";
import { authenticate, authorizationURL } from "../control/oauth.mjs";
import { createControlServer } from "../control/server.mjs";
import { execute, LIMIT, cleanApp, cleanJob, cleanPreview } from "../control/executor.mjs";

let counter = 0;
const actor = "123456";
const origin = "https://control.rmstdope.eu";
const previewId = "a".repeat(32), jobId = "b".repeat(32);
const app = {
  name: "example", url: "https://example.rmstdope.eu", profile: "fullstack", stateful: true,
  desired: "online", revision: "c".repeat(40), version: "v1.2.3", automation: "paused",
  pauseReason: "/private/path secret", recoveryRequired: false, protected: false, health: "unknown",
};
function directory(t) {
  const dir = path.join(process.cwd(), `.ctl-test-${process.pid}-${++counter}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t, overrides = {}) {
  let time = 1_800_000_000_000;
  const now = () => time;
  const store = new Store(directory(t), now);
  const config = {
    origin, admins: new Set([actor]), clientId: "client", clientSecret: "secret",
    socket: "/unused", storeDir: path.dirname(store.file),
    trustedProxyIPs: new Set(overrides.trustedProxyIPs || []),
  };
  const calls = [];
  const executor = async request => {
    calls.push(request);
    if (overrides.execute) return overrides.execute(request);
    if (request.operation === "list") return { apps: [app, { ...app, name: "dashboard", protected: false }] };
    if (request.operation === "preview") return { preview: {
      id: previewId, app: request.app, action: request.action, revision: app.revision,
      version: app.version, expiresAt: now() / 1000 + 120.125,
      images: { web: "secret-digest" }, warning: "private executor detail", currentRelease: "release",
    } };
    const job = { id: jobId, app: app.name, action: "rollback", status: "queued",
      createdAt: now() / 1000 + 0.125, updatedAt: now() / 1000 + 0.25,
      message: "private raw stderr", revision: app.revision, actor, private: "secret" };
    if (request.operation === "jobs") return { jobs: [job] };
    return { job };
  };
  const server = createControlServer(config, {
    store, now, execute: executor,
    authenticate: overrides.authenticate || (async () => actor),
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const id = store.create(actor), session = store.session(id, config.admins);
  async function request(route, { method = "GET", body, auth = true, headers = {} } = {}) {
    const data = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: server.address().port, path: route, method,
        headers: {
          Host: new URL(origin).host,
          ...(auth ? { Cookie: `__Host-control-session=${id}` } : {}),
          ...(method === "POST" ? { Origin: origin, "X-CSRF-Token": session.csrf,
            "Content-Type": "application/json" } : {}),
          ...(data !== null ? { "Content-Length": Buffer.byteLength(data) } : {}), ...headers,
        },
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try { json = JSON.parse(text); } catch { /* HTML assets are not JSON. */ }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      });
      req.on("error", reject);
      req.end(data);
    });
  }
  return { request, store, id, session, calls, config, now, advance: ms => { time += ms; } };
}

test("configuration fails closed without explicit admins, secrets and HTTPS canonical origin", () => {
  const env = {
    CONTROL_ORIGIN: origin, ADMIN_GITHUB_IDS: actor, GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret", SESSION_STORE_DIR: "/sessions", EXECUTOR_SOCKET: "/executor.sock",
  };
  assert.equal(configuration(env).admins.has(actor), true);
  for (const change of [
    { ADMIN_GITHUB_IDS: "" }, { ADMIN_GITHUB_IDS: "octocat" }, { ADMIN_GITHUB_IDS: "0" },
    { GITHUB_CLIENT_SECRET: "" }, { CONTROL_ORIGIN: "http://control.rmstdope.eu" },
    { CONTROL_ORIGIN: `${origin}/path` }, { CONTROL_ORIGIN: `${origin}/` },
    { EXECUTOR_SOCKET: "relative" },
    { TRUSTED_PROXY_IPS: "*" }, { TRUSTED_PROXY_IPS: "172.16.0.0/12" },
  ]) assert.throws(() => configuration({ ...env, ...change }));
});

test("opaque hashed sessions persist, expire idle/absolute, revoke and enforce changed allowlist", t => {
  let now = 1_800_000_000_000;
  const dir = directory(t), store = new Store(dir, () => now);
  const id = store.create(actor), admins = new Set([actor]);
  assert.equal(fs.readFileSync(store.file, "utf8").includes(id), false);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(new Store(dir, () => now).session(id, admins).actor, actor);
  now += IDLE;
  assert.equal(store.session(id, admins), null);
  const second = store.create(actor);
  for (let step = 0; step < 16; step++) {
    now += IDLE - 1;
    if (step < 15) assert.ok(store.session(second, admins));
  }
  now += 16;
  assert.equal(store.session(second, admins), null);
  const third = store.create(actor);
  assert.equal(store.session(third, new Set()), null);
  const fourth = store.create(actor);
  store.revoke(fourth);
  assert.equal(store.session(fourth, admins), null);
  assert.equal(MAX_AGE, 8 * 3600_000);
});

test("CLI revocation is persistent and never prints bearer tokens or CSRF", t => {
  const dir = directory(t), store = new Store(dir);
  const id = store.create(actor);
  const run = (...args) => spawnSync(process.execPath, ["control/sessions.mjs", ...args], {
    cwd: process.cwd(), env: { ...process.env, SESSION_STORE_DIR: dir }, encoding: "utf8",
  });
  const listing = run("list");
  assert.equal(listing.status, 0);
  assert.equal(JSON.parse(listing.stdout)[0].actor, actor);
  assert.equal(listing.stdout.includes(id), false);
  assert.equal(listing.stdout.includes("csrf"), false);
  assert.equal(run("revoke", actor).status, 0);
  assert.equal(store.session(id, new Set([actor])), null);
  assert.equal(run("clear").status, 0);
});

test("OAuth state is bound to browser, one-use, persisted and expires", t => {
  let now = Date.now();
  const store = new Store(directory(t), () => now);
  const attempt = store.startOAuth();
  assert.equal(store.finishOAuth(attempt.state, "wrong"), null);
  assert.equal(store.finishOAuth(attempt.state, attempt.binding), null);
  const valid = store.startOAuth();
  assert.equal(new Store(path.dirname(store.file), () => now).finishOAuth(valid.state, valid.binding).verifier, valid.verifier);
  const expired = store.startOAuth();
  now += 600_000;
  assert.equal(store.finishOAuth(expired.state, expired.binding), null);
});

test("OAuth uses fixed endpoints, PKCE, empty scopes and stable numeric identity", async () => {
  const config = { origin, clientId: "id", clientSecret: "secret", admins: new Set([actor]) };
  const url = new URL(authorizationURL(config, { state: "state", verifier: "verifier" }));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("scope"), "");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  const calls = [];
  const mock = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return Response.json(endpoint.includes("access_token") ?
      { access_token: "private-token", token_type: "bearer", scope: "" } :
      { id: Number(actor), login: "untrusted-name" });
  };
  assert.equal(await authenticate(config, "code", "verifier", mock), actor);
  assert.equal(calls[0].endpoint, "https://github.com/login/oauth/access_token");
  assert.equal(calls[0].options.body.get("code_verifier"), "verifier");
  assert.equal(calls[0].options.body.get("redirect_uri"), `${origin}/auth/callback`);
  assert.equal(calls[1].endpoint, "https://api.github.com/user");
  assert.ok(calls.every(call => call.options.redirect === "error"));
  await assert.rejects(authenticate({ ...config, admins: new Set(["999"]) }, "code", "verifier", mock));
  await assert.rejects(authenticate(config, "code", "verifier", async () =>
    Response.json({ access_token: "token", token_type: "bearer", scope: "repo" })));
  await assert.rejects(authenticate(config, "code", "verifier", async () =>
    new Response("x".repeat(65537))));
  await assert.rejects(authenticate(config, "code", "verifier", async () =>
    Response.json({}, { status: 500 })));
});

test("OAuth callback rejects forged/replayed state and rotates host-only secure session", async t => {
  const f = await fixture(t);
  const login = await f.request("/auth/login", { auth: false });
  assert.equal(login.status, 303);
  const state = new URL(login.headers.location).searchParams.get("state");
  const binding = login.headers["set-cookie"][0].split(";")[0];
  assert.match(binding, /^__Host-control-oauth=/);
  const callback = `/auth/callback?state=${state}&code=test-code`;
  assert.equal((await f.request(callback, { auth: false })).status, 400);
  const response = await f.request(callback, { headers: {
    Cookie: `${binding}; __Host-control-session=${f.id}`,
  } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "/");
  const sessionCookie = response.headers["set-cookie"][0];
  assert.match(sessionCookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$/);
  assert.equal(sessionCookie.includes("Domain"), false);
  assert.equal(f.store.session(f.id, f.config.admins), null);
  assert.equal((await f.request(callback, { headers: { Cookie: binding } })).status, 400);
  assert.equal((await f.request("/auth/login?next=https://evil.example")).status, 404);
});

test("login rate limit isolates clients only through explicitly trusted proxy and ignores browser forwarding headers", async t => {
  const direct = await fixture(t);
  for (let index = 0; index < 10; index++) {
    assert.equal((await direct.request("/auth/login", { auth: false, headers: {
      "X-Forwarded-For": `192.0.2.${index + 1}`, "X-Control-Client-IP": `192.0.2.${index + 1}`,
    } })).status, 303);
  }
  assert.equal((await direct.request("/auth/login", { auth: false,
    headers: { "X-Forwarded-For": "198.51.100.1" },
  })).status, 429);
  const proxied = await fixture(t, { trustedProxyIPs: ["127.0.0.1"] });
  assert.equal((await proxied.request("/auth/login", { auth: false })).status, 400);
  assert.equal((await proxied.request("/auth/login", { auth: false,
    headers: { "X-Control-Client-IP": "192.0.2.1, 192.0.2.2" },
  })).status, 400);
  const request = ip => proxied.request("/auth/login", { auth: false,
    headers: { "X-Control-Client-IP": ip },
  });
  for (let index = 0; index < 10; index++) assert.equal((await request("192.0.2.1")).status, 303);
  assert.equal((await request("192.0.2.1")).status, 429);
  assert.equal((await request("192.0.2.2")).status, 303);
  for (let index = 0; index < 289; index++) {
    assert.equal((await request(`198.51.${Math.floor(index / 250)}.${index % 250 + 1}`)).status, 303);
  }
  assert.equal((await request("203.0.113.1")).status, 429);
  proxied.advance(60_000);
  assert.equal((await request("192.0.2.1")).status, 303);
});

test("API never accepts browser actor, paths, shell or image references; all writes require exact Origin and CSRF", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/apps", { auth: false })).status, 401);
  assert.deepEqual((await f.request("/api/session", { auth: false })).json, { authenticated: false });
  for (const headers of [
    { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: `${origin}/` },
    { "X-CSRF-Token": "bad" }, { "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal((await f.request("/api/preview", {
      method: "POST", body: { app: "example", action: "pause" }, headers,
    })).status, 403);
  }
  for (const contentType of ["text/plain", "application/json; charset=utf-8", "application/json, text/plain"]) {
    assert.equal((await f.request("/api/preview", { method: "POST",
      body: { app: "example", action: "pause" }, headers: { "Content-Type": contentType },
    })).status, 415);
  }
  for (const extra of [{ actor: "999" }, { path: "/etc" }, { images: {} }, { command: "stop" }]) {
    assert.equal((await f.request("/api/preview", { method: "POST",
      body: { app: "example", action: "pause", ...extra },
    })).status, 400);
  }
  assert.equal((await f.request("/api/preview", { method: "POST", body: "{bad" })).status, 400);
  assert.equal((await f.request("/api/preview", { method: "POST", body: "x".repeat(4097) })).status, 413);
  assert.equal((await f.request("/api/preview", { method: "POST",
    body: { app: "../example", action: "pause" },
  })).status, 400);
  assert.equal((await f.request("/api/preview", { method: "GET" })).status, 404);
  assert.equal((await f.request("/api/apps", { headers: { Host: "evil.example" } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test("previews are immutable, session-bound, protected and recent authorization gates both stages", async t => {
  const f = await fixture(t);
  const preview = await f.request("/api/preview", { method: "POST", body: { app: "example", action: "rollback" } });
  assert.equal(preview.status, 200);
  assert.match(preview.json.preview.warning, /database is NOT rolled back/);
  assert.equal(preview.text.includes("secret-digest"), false);
  assert.equal(preview.text.includes("private executor"), false);
  assert.deepEqual(f.calls[1], { operation: "preview", actor, app: "example", action: "rollback" });
  const body = { previewId, idempotencyKey: "same-key-1234567890" };
  assert.equal((await f.request("/api/submit", { method: "POST", body })).status, 202);
  assert.equal((await f.request("/api/submit", { method: "POST", body })).status, 202);
  assert.equal((await f.request("/api/submit", { method: "POST",
    body: { ...body, idempotencyKey: "different-key-12345678" },
  })).status, 409);
  assert.equal((await f.request("/api/preview", { method: "POST",
    body: { app: "dashboard", action: "offline" },
  })).status, 403);
  f.advance(RECENT);
  assert.equal((await f.request("/api/preview", { method: "POST",
    body: { app: "example", action: "offline" },
  })).json.error.code, "reauth_required");
  const current = f.store.read();
  const key = Object.keys(current.sessions)[0];
  current.sessions[key].previews[previewId].expiresAt = Math.floor(f.now() / 1000) + 60;
  f.store.write(current);
  assert.equal((await f.request("/api/submit", { method: "POST", body })).json.error.code, "reauth_required");
  assert.equal((await f.request("/api/preview", { method: "POST",
    body: { app: "example", action: "pause" },
  })).status, 200);
});

test("confirmation from another session or expired preview never reaches executor", async t => {
  const f = await fixture(t);
  await f.request("/api/preview", { method: "POST", body: { app: "example", action: "rollback" } });
  const second = f.store.create(actor), session = f.store.session(second, f.config.admins);
  const body = { previewId, idempotencyKey: "same-key-1234567890" };
  assert.equal((await f.request("/api/submit", { method: "POST", body, headers: {
    Cookie: `__Host-control-session=${second}`, "X-CSRF-Token": session.csrf,
  } })).status, 409);
  f.advance(121_000);
  assert.equal((await f.request("/api/submit", { method: "POST", body })).status, 409);
  assert.equal(f.calls.filter(call => call.operation === "submit").length, 0);
});

test("output is allowlisted, no raw errors leak, logout revokes and assets have strict security headers", async t => {
  const f = await fixture(t);
  const apps = await f.request("/api/apps");
  assert.equal(apps.status, 200);
  assert.equal(apps.json.apps[1].protected, true);
  assert.equal(apps.text.includes("/private/path"), false);
  const jobs = await f.request("/api/jobs");
  assert.equal(jobs.text.includes("raw stderr"), false);
  assert.equal(jobs.text.includes("secret"), false);
  assert.equal((await f.request(`/api/jobs/${jobId}`)).json.job.id, jobId);
  const html = await f.request("/");
  assert.equal(html.status, 200);
  assert.match(html.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(html.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(html.headers["cache-control"], "no-store");
  for (const route of ["/.git/config", "/sessions.json", "/server.mjs", "/api/apps?actor=999", "/missing"]) {
    assert.equal((await f.request(route)).status, 404);
  }
  assert.equal((await f.request("/api/logout", { method: "POST", body: {}, headers: { Origin: "https://evil.example" } })).status, 403);
  const logout = await f.request("/api/logout", { method: "POST", body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await f.request("/api/apps")).status, 401);
  const broken = await fixture(t, { execute: async () => { throw new Error("SECRET_TOKEN /private/path"); } });
  const error = await broken.request("/api/apps");
  assert.equal(error.status, 503);
  assert.equal(error.text.includes("SECRET_TOKEN"), false);
});

test("executor errors are mapped to fixed messages, malformed and unsafe output fails closed", async t => {
  const rejected = await fixture(t, { execute: async () => ({
    error: { code: "rejected", message: "SECRET_TOKEN /private/path" },
  }) });
  const result = await rejected.request("/api/apps");
  assert.equal(result.status, 409);
  assert.equal(result.text.includes("SECRET_TOKEN"), false);
  const malformed = await fixture(t, { execute: async () => ({ apps: [{ ...app, url: "javascript:alert(1)" }] }) });
  assert.equal((await malformed.request("/api/apps")).status, 503);
  assert.equal(cleanApp({ ...app, desired: "offline", health: "healthy" }).health, "unknown");
  assert.throws(() => cleanJob({ id: jobId, app: "example", action: "shell" }));
});

test("Python fractional epoch seconds and offline truncated revisions are accepted without weakening bounds", () => {
  assert.equal(cleanApp({ ...app, desired: "offline", revision: "a".repeat(12) }).revision, "a".repeat(12));
  const job = { id: jobId, app: "example", action: "pause", status: "queued",
    createdAt: 1800000000.123, updatedAt: 1800000000.456, revision: app.revision };
  assert.equal(cleanJob(job).createdAt, job.createdAt);
  const preview = { id: previewId, app: "example", action: "pause",
    expiresAt: 1800000300.789, revision: app.revision, version: null };
  assert.equal(cleanPreview(preview, "example", "pause", 1800000000000).expiresAt, preview.expiresAt);
  for (const invalid of [NaN, Infinity, -1, "1800000000", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cleanJob({ ...job, createdAt: invalid }));
    assert.throws(() => cleanPreview({ ...preview, expiresAt: invalid }, "example", "pause", 1800000000000));
  }
});

test("real Unix socket contract handles split lines and rejects oversized, invalid, incomplete replies", async t => {
  const dir = directory(t), socketPath = path.join(dir, "s");
  let reply = "valid";
  const requests = [];
  const server = net.createServer(socket => {
    let input = "";
    socket.on("error", () => {});
    socket.on("data", data => {
      input += data;
      if (!input.endsWith("\n")) return;
      requests.push(JSON.parse(input));
      if (reply === "valid") {
        socket.write('{"apps":');
        setImmediate(() => socket.end("[]}\n"));
      } else if (reply === "large") socket.end("x".repeat(LIMIT + 1));
      else if (reply === "incomplete") socket.end("{}");
      else socket.end("bad\n");
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = { operation: "list", actor };
  assert.deepEqual(await execute(socketPath, request), { apps: [] });
  assert.deepEqual(requests[0], request);
  for (reply of ["large", "incomplete", "invalid"]) await assert.rejects(execute(socketPath, request));
});

test("HTTP API to real Unix executor mock preserves exact framing, keys and actor for the entire confirmation lifecycle", async t => {
  const dir = directory(t), socketPath = path.join(dir, "s");
  const received = [];
  let selectedAction;
  const server = net.createServer(socket => {
    socket.on("error", () => {});
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input);
      received.push(request);
      let result;
      if (request.operation === "list") {
        assert.deepEqual(Object.keys(request).sort(), ["actor", "operation"]);
        result = { apps: [app] };
      } else if (request.operation === "preview") {
        assert.deepEqual(Object.keys(request).sort(), ["action", "actor", "app", "operation"]);
        selectedAction = request.action;
        result = { preview: { id: previewId, app: app.name, action: selectedAction,
          revision: app.revision, version: app.version, expiresAt: 1800000120,
          currentRelease: "release", images: { web: "secret-digest" }, warning: "safe" } };
      } else {
        const job = { id: jobId, app: app.name, actor, action: selectedAction,
          createdAt: 1800000000, updatedAt: 1800000000, status: "queued",
          revision: app.revision, message: "Queued" };
        if (request.operation === "submit") {
          assert.deepEqual(Object.keys(request).sort(), ["actor", "idempotencyKey", "operation", "previewId"]);
        } else if (request.operation === "job") {
          assert.deepEqual(Object.keys(request).sort(), ["actor", "id", "operation"]);
        } else assert.deepEqual(Object.keys(request).sort(), ["actor", "operation"]);
        result = request.operation === "jobs" ? { jobs: [job] } : { job };
      }
      assert.equal(request.actor, actor);
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, { execute: request => execute(socketPath, request) });
  assert.equal((await f.request("/api/apps")).status, 200);
  assert.equal((await f.request("/api/preview", {
    method: "POST", body: { app: "example", action: "update" },
  })).status, 200);
  assert.equal((await f.request("/api/submit", {
    method: "POST", body: { previewId, idempotencyKey: "contract-test-123456" },
  })).status, 202);
  assert.equal((await f.request("/api/jobs")).status, 200);
  assert.equal((await f.request(`/api/jobs/${jobId}`)).status, 200);
  assert.deepEqual(received.map(request => request.operation), ["list", "list", "preview", "submit", "jobs", "job"]);
});
