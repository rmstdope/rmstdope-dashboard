import { Store } from "./store.mjs";

const [operation, actor] = process.argv.slice(2);
if (!process.env.SESSION_STORE_DIR || !["list", "revoke", "clear"].includes(operation) ||
    (operation === "revoke" && !/^[1-9]\d{0,19}$/.test(actor || ""))) {
  console.error("Set SESSION_STORE_DIR; use sessions.mjs list | revoke NUMERIC_ID | clear");
  process.exitCode = 1;
} else {
  try {
    const store = new Store(process.env.SESSION_STORE_DIR);
    const result = store.change(data => {
      if (operation === "list") return Object.values(data.sessions).map(({ actor, createdAt, lastSeen }) =>
        ({ actor, createdAt, lastSeen }));
      for (const [key, session] of Object.entries(data.sessions)) {
        if (operation === "clear" || session.actor === actor) delete data.sessions[key];
      }
      if (operation === "clear") data.states = {};
      return { ok: true };
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error("Session store unavailable or busy. Retry; never edit an active store.");
    process.exitCode = 1;
  }
}
