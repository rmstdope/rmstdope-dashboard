import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const token = () => randomBytes(32).toString("base64url");
export const hash = value => createHash("sha256").update(value).digest("hex");
export const IDLE = 30 * 60_000;
export const MAX_AGE = 8 * 60 * 60_000;
export const RECENT = 15 * 60_000;

// One API process owns this directory. Every operation rereads the atomically
// replaced file so offline CLI revocation takes effect on the next request.
export class Store {
  constructor(directory, now = Date.now) {
    this.file = path.join(directory, "sessions.json");
    this.now = now;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) this.write({ sessions: {}, states: {} });
    this.read();
  }
  read() {
    const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!value || typeof value.sessions !== "object" || !value.sessions ||
        typeof value.states !== "object" || !value.states) throw new Error("Invalid session store");
    return value;
  }
  write(value) {
    const pending = `${this.file}.pending`;
    const fd = fs.openSync(pending, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(pending, this.file);
    const directory = fs.openSync(path.dirname(this.file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  change(fn) {
    const lock = `${this.file}.lock`;
    fs.mkdirSync(lock, { mode: 0o700 });
    try {
    const data = this.read();
    const now = this.now();
    for (const [key, session] of Object.entries(data.sessions)) {
      if (now - session.lastSeen >= IDLE || now - session.createdAt >= MAX_AGE) delete data.sessions[key];
    }
    for (const [key, state] of Object.entries(data.states)) {
      if (now >= state.expiresAt) delete data.states[key];
    }
    const result = fn(data);
    this.write(data);
    return result;
    } finally { fs.rmdirSync(lock); }
  }
  startOAuth() {
    const state = token(), binding = token(), verifier = token();
    this.change(data => {
      // Bound abandoned login attempts without retaining authorization codes.
      const keys = Object.keys(data.states);
      if (keys.length >= 1000) delete data.states[keys[0]];
      data.states[hash(state)] = { binding: hash(binding), verifier, expiresAt: this.now() + 600_000 };
    });
    return { state, binding, verifier };
  }
  finishOAuth(state, binding) {
    return this.change(data => {
      const key = hash(state);
      const entry = data.states[key];
      delete data.states[key];
      return entry && entry.binding === hash(binding) ? entry : null;
    });
  }
  create(actor, oldToken) {
    const id = token();
    this.change(data => {
      if (oldToken) delete data.sessions[hash(oldToken)];
      if (Object.keys(data.sessions).length >= 1000) throw new Error("Session capacity reached");
      data.sessions[hash(id)] = {
        actor, csrf: token(), createdAt: this.now(), lastSeen: this.now(), previews: {},
      };
    });
    return id;
  }
  session(id, admins) {
    if (!id) return null;
    return this.change(data => {
      const session = data.sessions[hash(id)];
      if (!session || !admins.has(session.actor)) {
        delete data.sessions[hash(id)];
        return null;
      }
      session.lastSeen = this.now();
      return session;
    });
  }
  update(id, fn) {
    return this.change(data => {
      const session = data.sessions[hash(id)];
      if (!session) throw new Error("Session expired");
      return fn(session);
    });
  }
  revoke(id) { this.change(data => { delete data.sessions[hash(id)]; }); }
}
