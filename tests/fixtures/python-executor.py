"""Disposable real executor fixture; no Docker, credentials or production state."""
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys
import threading

infra = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()
sys.path[:0] = [str(infra / "src"), str(infra / "tests")]
from unittest.mock import patch
from rmstdope_deploy import config, control, dashboard, poller, registry, worker
from test_deploy import application
from test_worker import headless

root = repo / "host"
(root / "infrastructure/config/routes").mkdir(parents=True)
(root / "infrastructure/config/Caddyfile").write_text("import routes/*.caddy\n")
app = application() | {"deployment": {
    "repository": "owner/example", "workflow": "ci.yml", "branch": "main"}}
directory = repo / "apps/example"
directory.mkdir(parents=True)
compose, route = config.scaffold(app)
files = {"app.json": json.dumps(app), "compose.json": compose, "route.caddy": route}
for name, value in files.items():
    (directory / name).write_text(value)
settings = {"repo": str(repo), "root": str(root), "email": "ci@example.com",
            "apps": ["example"], "commit": "c" * 40, "sender": "ci@example.com",
            "recipient": "ci@example.com", "sendmail": "/usr/sbin/sendmail"}
config_path = repo / "poll.json"
worker.save_json(config_path, settings)
host = worker.Host({"root": str(root), "email": "ci@example.com", "app": "example"})
release = "20260101T000000-aaaaaaaa"
release_dir = host.release_dir("example", release)
release_dir.mkdir(parents=True)
for name, value in files.items():
    (release_dir / name).write_text(value)
manifest = {"revision": "a" * 40,
            "images": {"web": "ghcr.io/rmstdope/example@sha256:" + "a" * 64},
            "configuration_sha256": worker.configuration_hash(files), "outcome": "success"}
worker.save_json(release_dir / "manifest.json", manifest)
worker.save_json(host.app_root("example") / "state.json", {"current": release, "previous": None})
with redirect_stdout(sys.stderr):
    poller.baseline(settings, app)
# A registered, not yet deployed headless worker: no domain, route or public check.
worker_app, worker_files = headless()
with patch.object(worker.Host, "validate_compose"):
    registry.register(repo, root, worker_app, worker_files)
executor = control.Executor(config_path, repo / "jobs.sqlite", ["123"])
with control.Server(str(repo / "s"), control.Handler) as server:
    server.executor = executor
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    print(json.dumps({"ready": True}), flush=True)
    try:
        for line in sys.stdin:
            operation = line.strip()
            if operation == "execute":
                with redirect_stdout(sys.stderr):
                    assert executor.execute_one()
            elif operation == "offline":
                worker.save_json(host.app_root("example") / "maintenance.json",
                                 {"desired": "offline", "phase": "complete"})
            elif operation == "worker":
                # Deploy the worker, then publish the real collector feed with healthy containers.
                worker_release = "20260102T000000-bbbbbbbb"
                worker_dir = host.release_dir("oracle", worker_release)
                worker_dir.mkdir(parents=True)
                for name, value in worker_files.items():
                    (worker_dir / name).write_text(value)
                worker.save_json(worker_dir / "manifest.json", {
                    "revision": "d" * 40,
                    "images": {"worker": "ghcr.io/rmstdope/oracle-worker@sha256:" + "d" * 64},
                    "configuration_sha256": worker.configuration_hash(worker_files),
                    "outcome": "success", "completed": 1767312000.0})
                worker.save_json(host.app_root("oracle") / "state.json",
                                 {"current": worker_release, "previous": None})
                with redirect_stdout(sys.stderr), patch.object(
                        dashboard, "container_health", return_value="healthy"), patch.object(
                        dashboard, "public_health", return_value="healthy"):
                    feed = dashboard.collect(repo, root)
                dashboard.publish(root / "dashboard-public", feed)
                print(json.dumps({"ack": operation, "snapshot": feed}), flush=True)
                continue
            elif operation == "stop":
                break
            else:
                raise AssertionError("Unknown fixture command")
            print(json.dumps({"ack": operation}), flush=True)
    finally:
        server.shutdown()
        thread.join()
