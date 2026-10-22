"""Disposable real executor fixture; no Docker, credentials or production state."""
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys
import threading

infra = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()
sys.path[:0] = [str(infra / "src"), str(infra / "tests")]
from rmstdope_deploy import config, control, poller, worker
from test_deploy import application

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
            elif operation == "stop":
                break
            else:
                raise AssertionError("Unknown fixture command")
            print(json.dumps({"ack": operation}), flush=True)
    finally:
        server.shutdown()
        thread.join()
