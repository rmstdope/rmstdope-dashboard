# Authorized control service

This is a separate application, **not an extension of the public server**.
`dashboard.rmstdope.eu` remains static/read-only. `control.rmstdope.eu` serves
the control UI and API from one HTTPS origin. Host operations and maintenance
routing live in the companion `rmstdope-infra` implementation.

## Security and authentication

The dependency-free Node 22 server implements GitHub's server-side OAuth
authorization-code flow, browser-bound one-use state (10 minutes), S256 PKCE,
fixed GitHub endpoints, an exact callback URI and an empty scope request.
It never requests repository permissions. Unexpected granted scopes fail
closed. Access tokens exist only during the server-side user lookup and are
never stored, sent to the browser, or logged. The allowlist uses immutable
numeric GitHub IDs, not usernames. Both API and privileged executor must have
the same explicit allowlist; there is no default administrator.

Use a **dedicated OAuth App**, with homepage `https://control.rmstdope.eu` and
authorization callback **`https://control.rmstdope.eu/auth/callback`**.
Require administrator accounts to use a passkey or strong 2FA operationally.
The account picker is requested on every sign-in, but GitHub OAuth does **not**
attest a fresh password, passkey or MFA challenge. The 15-minute recent-login
gate means a newly completed OAuth flow, not verified fresh MFA. Do not
represent it as step-up MFA. See GitHub's
[OAuth documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Sessions are opaque 256-bit random tokens; only their SHA-256 hashes are saved
in a private server-side store. Cookies are host-only `__Host-` cookies with
`Secure; HttpOnly; SameSite=Lax; Path=/`, never localStorage. Sessions expire
after 30 minutes without API activity or eight hours absolutely; polling an open
tab counts as activity. Offline/online/update/restart/rollback require an OAuth
flow completed within 15 minutes, at both preview and confirmation. Sign-in
rotates the previous session; logout revokes it. Removing an administrator from
configuration revokes access after the service restarts with that configuration.

Every POST, including logout, requires exact `Origin`, a session-specific CSRF
header, same-origin Fetch Metadata when supplied, and exactly
`Content-Type: application/json` (no content encoding/chunked or ambiguous type).
Request bodies are limited to 4 KiB; unexpected keys are rejected. The UI cannot
supply an actor, image, path, command, credential or callback destination.
Static assets and API responses are non-cached with restrictive CSP, no framing,
no referrers and no CORS permission. The service does not trust forwarded
identity headers, log requests, expose raw errors, or return executor messages,
image digests or private fields.

## Installation contract (review required; not installation authorization)

Build `Dockerfile.control`; the image is
`ghcr.io/rmstdope/rmstdope-control`, service key `web`, **UID:GID 10001:10001**,
port **8081**. `/healthz` is an internal liveness endpoint and `/release.json`
contains the baked 40-character source revision. Liveness intentionally does not
claim that executor access, OAuth or any managed application is healthy.

Only an explicitly approved operator installs the reviewed companion infra
runtime, provisions DNS/TLS/proxy routing and starts this service:

1. Check that numeric UID/GID **10001 are unused** on the host. Do not silently
   reuse an existing account/group. Provision the dedicated
   `rmstdope-control` socket group with GID 10001 according to the infra runbook.
2. Create `/srv/rmstdope/control-sessions` owned by `10001:10001`, mode **0700**.
   Bind only that directory read-write at `/sessions`. Do not mount `/srv/rmstdope`,
   raw deployment state or host credentials. This is durable authentication state,
   not a disposable anonymous volume.
3. Bind `/run/rmstdope-control` **read-only** at `/run/executor`. The executor
   socket is `executor.sock`, group `rmstdope-control`, mode **0660**, with the
   containing host directory mode **0750**. A read-only directory bind permits
   Unix socket connections and sees socket replacement on executor restart.
   Never mount the Docker socket.
4. Supply these **runtime-only** settings using the reviewed root-protected
   `${SECRETS_DIR}/web.env` mechanism; never commit real values or use build args:

   | Variable | Value |
   | --- | --- |
   | `CONTROL_ORIGIN` | `https://control.rmstdope.eu` (exact origin, no trailing slash) |
   | `GITHUB_CLIENT_ID` | Dedicated OAuth App client ID |
   | `GITHUB_CLIENT_SECRET` | Dedicated OAuth App secret |
   | `ADMIN_GITHUB_IDS` | Explicit comma-separated stable numeric IDs |
   | `SESSION_STORE_DIR` | `/sessions` |
   | `EXECUTOR_SOCKET` | `/run/executor/executor.sock` |

   OAuth credentials belong only to this unprivileged service. Privileged
   deployment/GitHub pull credentials belong only to the infra executor's
   systemd `LoadCredential` configuration. They are never available to the API.
5. Run one API replica with a read-only container root filesystem, all
   capabilities dropped, no-new-privileges, bounded memory/PIDs and only the two
   mounts above. No root, host networking, Docker CLI, deploy secrets or
   writable application directory is needed. Proxy HTTPS from the exact control
   origin to internal port 8081, **preserving Host**, with a response timeout
   above 100 seconds. Do not expose port 8081 publicly. Do not proxy the control
   app under the public dashboard origin. Disable/redact access logging of
   callback query parameters, cookies and authorization headers at the proxy.
6. Fail-closed startup requires every setting and valid existing session JSON.
   Smoke-test unauthorized API denial, allowlisted login, disallowed login,
   CSRF denial, preview/cancel, logout and session revocation before approving
   actual operations. Preserve independent SSH/host recovery access.

The directory stores a small atomically replaced/fsynced `sessions.json`
(0600), bounded login states/sessions and per-session preview bindings. It is
not an external database. All writers use an exclusive directory lock. One
replica only: concurrent CLI writes either acquire the lock or fail/retry, never
overwrite an API change. If the process or host dies **while holding the lock**,
the `.lock` directory is deliberately not automatically broken. Stop the API,
confirm there is no CLI writer, remove only the abandoned
`sessions.json.lock` directory, then restart. Never delete a live lock. Treat
backups as sensitive; do not restore old authentication state to undo revocation.

Session administration runs as UID 10001 against the **same dedicated directory**:

```sh
node control/sessions.mjs list
node control/sessions.mjs revoke NUMERIC_GITHUB_ID
node control/sessions.mjs clear
```

Set `SESSION_STORE_DIR` first (or use `docker exec` in the reviewed container).
`list` prints numeric IDs/timestamps, never cookies/CSRF values. `clear` also
clears pending OAuth states. Retry a busy-store failure. Revocation applies to
subsequent requests; it does not cancel a job already accepted by the executor.
For account compromise, also remove the ID from **both** services and restart
them, clear sessions, and revoke the GitHub OAuth authorization as appropriate.

## API / executor boundary

The trusted API process derives `actor` from the authenticated session, never
from browser input. The root executor independently checks the numeric allowlist
and socket permissions. Actor IDs are audit attribution, not a replacement for
the OS-level trust boundary. Compromise of the API can exercise its allowlisted
control authority; the executor must still enforce app/action protections.

Unix protocol: one newline-terminated JSON request and one newline-terminated
JSON response, at most **256 KiB**, a 90-second socket deadline. No arbitrary
operation or extra request fields are forwarded:

| Browser endpoint | Executor request |
| --- | --- |
| `GET /api/apps` | `{operation:"list",actor}` |
| `POST /api/preview` body `{app,action}` | `{operation:"preview",actor,app,action}` |
| `POST /api/submit` body `{previewId,idempotencyKey}` | `{operation:"submit",actor,previewId,idempotencyKey}` |
| `GET /api/jobs` | `{operation:"jobs",actor}` |
| `GET /api/jobs/:id` | `{operation:"job",actor,id}` |

`GET /api/session` supplies authentication state and a CSRF token for this
session. `GET /auth/login` and `GET /auth/callback` implement OAuth.
`POST /api/logout` accepts only `{}`. There are no other mutation routes.

Actions are **`offline`, `online`, `pause`, `resume`, `update`, `restart`,
`rollback`**. “Update now” is the UI label for wire action `update`.
The executor owns immutable expiring preview IDs, state/release revalidation,
durable jobs, serialized host locking and stable idempotency. The API binds each
preview to its session and first confirmation key; a failed network submission
can be retried with the **same** key. The UI preserves that key while the dialog
is open. If the browser is lost, inspect durable history before creating another
operation. The API never retries submissions automatically.

The executor responds with `{apps}`, `{preview}`, `{job}`, `{jobs}`, or
`{error:{code:"rejected"|"unavailable",message}}`; app and job fields follow the
approved companion contract. Expiry/job timestamps are epoch seconds.
The API validates and projects output; it replaces job messages and action
warnings with fixed safe text and strips actor, images and release internals.
Job states are queued/running/succeeded/failed/interrupted. Unknown or stale
health stays unknown; offline always displays unknown. Neither a pending job
nor a successful liveness request fabricates app health.

Both self-app names and dashboard/control domains are protected. The UI offers
no controls for them. Offline blocks resume/update/restart/rollback in the UI;
the executor is authoritative against tampered/stale clients. Offline preserves
Postgres and establishes maintenance; online verifies the current release and
leaves updates paused. Manual availability/image actions leave updates paused.
Rollback **does not restore the database**, and forward-only migrations may make
an old image unsafe. Recovery-required apps require the host runbook, not a
browser bypass. There are no database operations, secret editing or raw app logs.

## Development and delivery

```sh
npm test
npm run test:control:browser
docker build -f Dockerfile.control --build-arg REVISION="$(git rev-parse HEAD)" -t control:test .
```

Control browser tests start a local production-code server automatically;
`CONTROL_TEST_URL` instead targets a running production image. They mock
authenticated browser API responses, while Node tests exercise real HTTP
authentication/session/CSRF routes, mock OAuth responses, real Unix framing and
the complete API-to-socket confirmation lifecycle. No live OAuth credentials
are needed. CI also tests both production images at desktop/mobile widths.

Only successful **main push** CI publishes the tested control image and the
separate **`control-deployment-manifest`** artifact (`control-deployment.json`,
`{revision,images:{web:"…@sha256:…"}}`). PRs do not publish. The existing public
image and `deployment-manifest` remain separate and unchanged. The control app
has **no automatic self-update registration**: installation/update requires the
reviewed exact digest and separately authorized host workflow. This PR is not
authorization to merge, install, create live OAuth credentials or deploy.
