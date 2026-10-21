# Purpose and boundaries

Build a lightweight public, read-only dashboard for rmstdope.eu applications.
Use static HTML, CSS and JavaScript served by Caddy; avoid unnecessary runtime
dependencies. Host collection and deployment definitions belong in the sibling
rmstdope-infra repository, not in this application.

Consume only its sanitized public snapshot. Never mount the Docker socket,
credentials or raw host state. Never add deployment controls or expose raw
errors, paths, image digests or host metrics. App links open in a new tab.
Show stale/unknown data explicitly; missing data must not look healthy.

Use immutable published container images, focused tests and reviewed PRs.
Do not merge implementation PRs or deploy without explicit authorization.
Keep browser code accessible, responsive and safe for untrusted snapshot values.
