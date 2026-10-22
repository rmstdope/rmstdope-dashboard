import { hash } from "./store.mjs";

export const ISSUER = "https://github.com/login/oauth";
const AUTHORIZE = `${ISSUER}/authorize`;
const TOKEN = `${ISSUER}/access_token`;
const USER = "https://api.github.com/user";

export function authorizationURL(config, attempt) {
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: `${config.origin}/auth/callback`,
    state: attempt.state, scope: "", code_challenge_method: "S256",
    code_challenge: Buffer.from(hash(attempt.verifier), "hex").toString("base64url"),
    allow_signup: "false", prompt: "select_account",
  });
  return url.href;
}

async function boundedJSON(response) {
  if (!response.ok) throw new Error("OAuth provider unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) throw new Error("OAuth response limit");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}

export async function authenticate(config, code, verifier, fetcher = fetch) {
  const tokens = await boundedJSON(await fetcher(TOKEN, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret, code,
      redirect_uri: `${config.origin}/auth/callback`, code_verifier: verifier,
    }),
  }));
  if (tokens.error || typeof tokens.access_token !== "string" || tokens.access_token.length > 2048 ||
      tokens.token_type?.toLowerCase() !== "bearer" || (tokens.scope && tokens.scope !== "")) {
    throw new Error("Invalid OAuth grant");
  }
  const user = await boundedJSON(await fetcher(USER, {
    redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tokens.access_token}`,
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rmstdope-control" },
  }));
  if (!Number.isSafeInteger(user.id) || user.id < 1 || !config.admins.has(String(user.id))) {
    throw new Error("Account not authorized");
  }
  return String(user.id);
}
