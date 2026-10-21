# rmstdope-dashboard

Public, read-only application dashboard for `dashboard.rmstdope.eu`.
Application source and image publishing live here; host collection and runtime
deployment definitions live in `rmstdope/rmstdope-infra`.

## Behavior and data

Static HTML/CSS/JavaScript, no runtime frontend dependencies. App cards display
public HTTPS/container health, status, version or short revision, deployment
time, automation enabled/paused/manual and recovery-required indication. Launch
links open in a new tab with noopener/noreferrer.

The host collector publishes an allowlisted schemaVersion=1 JSON snapshot every
minute. The browser requests `/status.json` every 30 seconds; data older than
three minutes or a failed refresh shows **unknown**, never current healthy.
Missing initial data shows unavailable. No deployment controls, secrets, raw
error messages, host metrics, image digests or filesystem paths are exposed.

The web container mounts only the sanitized snapshot directory at `/status`,
read-only. It never mounts the Docker socket or raw deployment state. Caddy
serves a non-cached `/status.json`; missing data returns 404, not fabricated
healthy data. `/healthz` checks the dashboard server independently of the feed,
and `/release.json` identifies the exact dashboard source revision.

The public schema and host installation procedure are documented in
`rmstdope-infra/docs/dashboard.md`. The whole host being unavailable also takes
this dashboard down; it is not an external uptime monitor.

## Development and delivery

```sh
npm ci
npm test
docker build --build-arg REVISION="$(git rev-parse HEAD)" -t dashboard:test .
```

CI exercises Chromium at desktop/mobile widths against the production image,
including stale/failed data, safe links and HTTP cache/security headers. To run
locally, install Chromium with `npx playwright install chromium`, start that
image on `127.0.0.1:18080:8080` with a sanitized status directory mounted
read-only at `/status`, then `npm run test:browser`.

Successful main push CI publishes `ghcr.io/rmstdope/rmstdope-dashboard` and a
`deployment-manifest` Actions artifact containing `deployment.json`. PRs test
but do not publish. Keep the GHCR package private and grant the VPS pull access.
Deployment is separately authorized through `rmstdope-deploy release dashboard
--latest`; there is no automatic production deployment in this workflow.
