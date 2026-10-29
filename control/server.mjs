import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { configuration } from "./config.mjs";
import { Store, RECENT } from "./store.mjs";
import { authorizationURL, authenticate, ISSUER } from "./oauth.mjs";
import {
  execute, ACTIONS, FRESH_ACTIONS, protectedName, appName,
  cleanApp, cleanJob, cleanPreview,
} from "./executor.mjs";

const SESSION = "__Host-control-session", OAUTH = "__Host-control-oauth";
const assets = new Map([
  ["/", ["./web/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["./web/app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["./web/style.css", "text/css; charset=utf-8"]],
  ["/precision.css", ["../web/precision.css", "text/css; charset=utf-8"]],
  ["/theme.js", ["../web/theme.js", "text/javascript; charset=utf-8"]],
  ["/collection.js", ["../web/collection.js", "text/javascript; charset=utf-8"]],
]);
const headers = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
};
class Failure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new Failure(status, code, message); };
const cookie = (name, value, seconds) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (result[name] !== undefined) fail(400, "invalid_request", "Duplicate cookie.");
    result[name] = rest.join("=");
  }
  return result;
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function exactKeys(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) {
    fail(400, "invalid_request", "Unexpected request fields.");
  }
}
async function bodyJSON(req) {
  if (req.headers["content-type"] !== "application/json" ||
      req.headers["content-encoding"] || req.headers["transfer-encoding"]) {
    fail(415, "invalid_content_type", "Use an unencoded application/json request.");
  }
  if (Number(req.headers["content-length"]) > 4096) fail(413, "request_too_large", "Request is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) fail(413, "request_too_large", "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail(400, "invalid_request", "Invalid JSON request."); }
}
const executorErrors = {
  rejected: [409, "Operation rejected. Refresh and preview again; offline, protected or recovery-required apps cannot perform this operation."],
  unavailable: [503, "Executor is temporarily unavailable."],
  conflict: [409, "Application changed. Refresh and preview again."],
  stale_preview: [409, "Preview is no longer current. Preview again."],
  preview_expired: [409, "Preview expired. Preview again."],
  recovery_required: [409, "Manual host recovery is required."],
  offline: [409, "Application is intentionally offline."],
  protected: [403, "This application is protected."],
  not_found: [404, "Application, job or release not found."],
  busy: [409, "Another operation is in progress."],
  invalid_request: [400, "The executor rejected this request."],
};
// Exact executor rejection reasons mapped to fixed text; anything else stays generic.
const rejectionReasons = new Map([
  ["Application is not enrolled", "Application is not enrolled for automatic updates. Enroll and baseline it with the CLI."],
  ["Automation drift needs CLI reconciliation", "Deployed release, definitions or tooling differ from the automatic update baseline. Reconcile with the CLI before resuming."],
  ["Interrupted attempt needs CLI recovery", "An interrupted automatic update needs CLI recovery."],
  ["Application is not in maintenance", "Application is not in maintenance."],
  ["Application is already up to date", "Application is already up to date."],
  ["No previous release exists", "No previous release exists."],
  ["Action is unavailable for this application", "This action is unavailable for this application."],
  ["Unknown application", "Application not found."],
  ["Operation queue is full", "Operation queue is full. Try again after queued operations finish."],
  ["Preview expired; preview again", "Preview expired. Preview again."],
  ["Preview already submitted", "Preview was already submitted. Check history."],
]);

export function createControlServer(config, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const store = dependencies.store || new Store(config.storeDir, now);
  const executor = dependencies.execute || (request => execute(config.socket, request));
  const oauth = dependencies.authenticate || ((code, verifier) => authenticate(config, code, verifier));
  const reportOAuthFailure = dependencies.reportOAuthFailure ||
    (reason => console.warn(`OAuth callback rejected: ${reason}`));
  const staticAssets = new Map([...assets].map(([route, [name, type]]) => [
    route, [fs.readFileSync(new URL(name, import.meta.url)), type],
  ]));
  let release = { revision: null };
  try {
    const value = JSON.parse(fs.readFileSync(new URL("../release.json", import.meta.url), "utf8"));
    if (/^[a-f0-9]{40}$/.test(value.revision)) release = { revision: value.revision };
  } catch { /* Local development has no built image identity. */ }
  let oauthActive = 0;
  const loginAttempts = [];
  const clientLogins = new Map();
  const address = value => value?.startsWith("::ffff:") ? value.slice(7) : value;
  function limitLogin(req) {
    let client = address(req.socket.remoteAddress);
    const trusted = config.trustedProxyIPs || new Set();
    if (trusted.has(req.socket.remoteAddress) || trusted.has(client)) {
      const forwarded = req.headers["x-control-client-ip"];
      if (typeof forwarded !== "string" || !isIP(forwarded)) {
        fail(400, "invalid_proxy_client", "Trusted proxy must supply one valid client IP.");
      }
      client = address(forwarded);
    }
    const cutoff = now() - 60_000;
    while (loginAttempts.length && loginAttempts[0] <= cutoff) loginAttempts.shift();
    for (const [key, attempts] of clientLogins) {
      while (attempts.length && attempts[0] <= cutoff) attempts.shift();
      if (!attempts.length) clientLogins.delete(key);
    }
    const attempts = clientLogins.get(client) || [];
    if (attempts.length >= 10 || loginAttempts.length >= 300 || clientLogins.size >= 1000) {
      fail(429, "rate_limited", "Try signing in again in a minute.");
    }
    attempts.push(now());
    clientLogins.set(client, attempts);
    loginAttempts.push(now());
  }
  async function call(request) {
    const result = await executor(request);
    if (result.error) {
      const known = Object.hasOwn(executorErrors, result.error.code);
      const [status, message] = known ? executorErrors[result.error.code] : [502, "Executor could not complete the request."];
      const reason = result.error.code === "rejected" && rejectionReasons.get(result.error.message);
      fail(status, known ? result.error.code : "executor_error", reason || message);
    }
    return result;
  }
  const server = http.createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    res.setTimeout(100_000, () => res.destroy());
    const send = (status, body, extra = {}) => {
      const output = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8",
        "Content-Length": output.length, ...extra });
      res.end(output);
    };
    const redirect = (url, setCookies) => send(303, {}, { Location: url, "Set-Cookie": setCookies });
    try {
      if (req.url.length > 2048) fail(414, "invalid_request", "URL is too long.");
      const url = new URL(req.url, config.origin);
      if (url.origin !== config.origin) fail(400, "invalid_request", "Invalid request target.");
      if (req.method === "GET" && url.pathname === "/healthz" && !url.search) {
        return send(200, { status: "ok" });
      }
      if (req.headers.host !== new URL(config.origin).host) fail(400, "invalid_host", "Invalid host.");
      if (req.method === "GET" && url.pathname === "/release.json" && !url.search) return send(200, release);
      if (req.method === "GET" && staticAssets.has(url.pathname) && !url.search) {
        const [content, type] = staticAssets.get(url.pathname);
        return send(200, content, { "Content-Type": type });
      }
      const jar = cookies(req);
      const sessionId = jar[SESSION];
      if (sessionId && !/^[a-zA-Z0-9_-]{43}$/.test(sessionId)) fail(401, "unauthorized", "Sign in again.");
      if (req.method === "GET" && url.pathname === "/auth/login" && !url.search) {
        limitLogin(req);
        const attempt = store.startOAuth();
        return redirect(authorizationURL(config, attempt), [cookie(OAUTH, attempt.binding, 600)]);
      }
      if (req.method === "GET" && url.pathname === "/auth/callback") {
        const state = url.searchParams.get("state"), code = url.searchParams.get("code");
        const invalid = Object.entries({
          state_format: !state || !/^[a-zA-Z0-9_-]{43}$/.test(state),
          binding_cookie: !jar[OAUTH] || !/^[a-zA-Z0-9_-]{43}$/.test(jar[OAUTH]),
          parameter_count: url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.getAll("code").length !== 1,
          code_format: !code || !/^[a-zA-Z0-9_.-]{1,256}$/.test(code),
          issuer: url.searchParams.has("iss") && (
            url.searchParams.getAll("iss").length !== 1 || url.searchParams.get("iss") !== ISSUER),
          unexpected_parameters: [...url.searchParams.keys()].some(key => !["state", "code", "iss"].includes(key)),
        }).filter(([, rejected]) => rejected).map(([reason]) => reason);
        if (invalid.length) {
          reportOAuthFailure(invalid.join(","));
          fail(400, "oauth_failed", "Sign-in failed. Start a new sign-in.");
        }
        const attempt = store.finishOAuth(state, jar[OAUTH]);
        if (!attempt) fail(400, "oauth_failed", "Sign-in expired or invalid. Start again.");
        if (oauthActive >= 5) fail(429, "rate_limited", "Try signing in again shortly.");
        let actor;
        oauthActive++;
        try { actor = await oauth(code, attempt.verifier); }
        catch { fail(403, "oauth_failed", "Sign-in failed or this account is not authorized."); }
        finally { oauthActive--; }
        if (!config.admins.has(actor)) fail(403, "unauthorized", "Account is not authorized.");
        const id = store.create(actor, sessionId);
        return redirect("/", [cookie(SESSION, id, 8 * 3600), cookie(OAUTH, "", 0)]);
      }
      if (!url.pathname.startsWith("/api/") || url.search) fail(404, "not_found", "Not found.");
      const session = store.session(sessionId, config.admins);
      if (req.method === "GET" && url.pathname === "/api/session") {
        return send(200, session ? {
          authenticated: true, actor: session.actor, csrf: session.csrf,
          recent: now() - session.createdAt < RECENT,
        } : { authenticated: false });
      }
      if (!session) fail(401, "unauthorized", "Sign in to use the control panel.");
      if (!["GET", "POST"].includes(req.method)) fail(405, "method_not_allowed", "Method not allowed.");
      if (req.method === "POST") {
        if (req.headers.origin !== config.origin ||
            (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") ||
            !equal(req.headers["x-csrf-token"], session.csrf)) {
          fail(403, "csrf", "Request origin or CSRF token was rejected.");
        }
        const body = await bodyJSON(req);
        if (url.pathname === "/api/logout") {
          exactKeys(body, []);
          store.revoke(sessionId);
          return send(200, { ok: true }, { "Set-Cookie": cookie(SESSION, "", 0) });
        }
        if (url.pathname === "/api/preview") {
          exactKeys(body, ["app", "action"]);
          if (!appName(body.app) || !ACTIONS.includes(body.action)) fail(400, "invalid_request", "Unknown application or action.");
          if (protectedName(body.app)) fail(403, "protected", "This application is protected.");
          if (FRESH_ACTIONS.includes(body.action) && now() - session.createdAt >= RECENT) {
            fail(403, "reauth_required", "Sign in again before this operation.");
          }
          const list = await call({ operation: "list", actor: session.actor });
          if (!Array.isArray(list.apps) || list.apps.length > 100) throw new Error("Invalid executor list");
          const app = list.apps.map(cleanApp).find(app => app.name === body.app);
          if (!app) fail(404, "not_found", "Application not found.");
          if (app.protected) fail(403, "protected", "This application is protected.");
          const result = await call({ operation: "preview", actor: session.actor, app: body.app, action: body.action });
          const preview = cleanPreview(result.preview, body.app, body.action, now());
          store.update(sessionId, entry => {
            for (const [id, value] of Object.entries(entry.previews)) {
              if (value.expiresAt * 1000 <= now()) delete entry.previews[id];
            }
            if (Object.keys(entry.previews).length >= 20) fail(429, "preview_limit", "Too many open previews.");
            entry.previews[preview.id] = preview;
          });
          return send(200, { preview });
        }
        if (url.pathname === "/api/submit") {
          exactKeys(body, ["previewId", "idempotencyKey"]);
          if (!/^[a-f0-9]{32}$/.test(body.previewId) || !/^[a-zA-Z0-9-]{16,80}$/.test(body.idempotencyKey)) {
            fail(400, "invalid_request", "Invalid confirmation identifiers.");
          }
          const preview = store.update(sessionId, entry => {
            const value = entry.previews[body.previewId];
            if (!value || value.expiresAt * 1000 <= now()) fail(409, "stale_preview", "Preview expired. Preview again.");
            if (FRESH_ACTIONS.includes(value.action) && now() - entry.createdAt >= RECENT) {
              fail(403, "reauth_required", "Sign in again before this operation.");
            }
            if (value.idempotencyKey && value.idempotencyKey !== body.idempotencyKey) {
              fail(409, "conflict", "Retry this confirmation with its original idempotency key.");
            }
            value.idempotencyKey = body.idempotencyKey;
            return value;
          });
          const result = await call({ operation: "submit", actor: session.actor,
            previewId: body.previewId, idempotencyKey: body.idempotencyKey });
          const job = cleanJob(result.job);
          if (job.app !== preview.app || job.action !== preview.action) throw new Error("Mismatched job");
          return send(202, { job });
        }
      } else {
        if (url.pathname === "/api/apps") {
          const result = await call({ operation: "list", actor: session.actor });
          if (!Array.isArray(result.apps) || result.apps.length > 100) throw new Error("Invalid executor list");
          return send(200, { apps: result.apps.map(cleanApp) });
        }
        if (url.pathname === "/api/jobs") {
          const result = await call({ operation: "jobs", actor: session.actor });
          if (!Array.isArray(result.jobs) || result.jobs.length > 200) throw new Error("Invalid job list");
          return send(200, { jobs: result.jobs.map(cleanJob) });
        }
        const match = /^\/api\/jobs\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
        if (match) {
          const result = await call({ operation: "job", actor: session.actor, id: match[1] });
          const job = cleanJob(result.job);
          if (job.id !== match[1]) throw new Error("Mismatched job");
          return send(200, { job });
        }
      }
      fail(404, "not_found", "Not found.");
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const known = error instanceof Failure;
      send(known ? error.status : 503, { error: {
        code: known ? error.code : "service_unavailable",
        message: known ? error.message : "Control service is temporarily unavailable.",
      } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 100;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const server = createControlServer(configuration());
    server.listen(8081, "0.0.0.0", () => console.log("Control server listening on 8081"));
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
  } catch {
    console.error("Control server could not start. Check protected runtime configuration and session storage.");
    process.exitCode = 1;
  }
}
