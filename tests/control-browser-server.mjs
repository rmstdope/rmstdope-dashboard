import fs from "node:fs";
import path from "node:path";
import { createControlServer } from "../control/server.mjs";

const directory = path.join(process.cwd(), `.control-browser-${process.pid}`);
fs.mkdirSync(directory, { mode: 0o700 });
const server = createControlServer({
  origin: "https://control.rmstdope.eu", clientId: "test-only", clientSecret: "test-only",
  admins: new Set(["123456"]), storeDir: directory, socket: path.join(directory, "absent.sock"),
});
server.listen(18081, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.closeAllConnections();
  server.close(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
});
