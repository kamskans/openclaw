/**
 * MiniMax OAuth (PKCE S256 + RFC 8628 device flow) — Mission Control custom.
 *
 * MiniMax's coding/token plan supports browser sign-in ("MiniMax Global — OAuth").
 * pi-ai ships no MiniMax provider, so we register this object into pi-ai's OAuth
 * registry (fork oauth.ts + desktop auth.ts) exactly like the Kimi provider.
 *
 * Endpoints + client_id + scopes verified from mmx-cli (dist/mmx.mjs):
 *   device code POST account.minimax.io/oauth2/device/code   (PKCE, state, scope)
 *   token/poll/refresh POST account.minimax.io/oauth2/token   (poll by user_code)
 * After auth the access token is a Bearer against https://api.minimax.io/anthropic
 * (the base the desktop's `minimax` provider already uses), so only the CREDENTIAL
 * changes (oauth vs api_key), not the provider config.
 *
 * KEEP IN SYNC with desktop/src/oauthProviders.ts (separate process/bundle).
 */
import { createHash, randomBytes } from "node:crypto";

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";

const OAUTH_HOST = (process.env.MINIMAX_OAUTH_HOST || "https://account.minimax.io").replace(/\/+$/, "");
const CLIENT_ID = "659cf4c1-615c-45f6-a5f6-4bf15eb476e5";
const SCOPES = "openid profile coding_plan";
const DEVICE_URL = `${OAUTH_HOST}/oauth2/device/code`;
const TOKEN_URL = `${OAUTH_HOST}/oauth2/token`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function postForm(
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON error body; status drives the message */
  }
  return { status: res.status, data };
}

function expiresToMs(raw: unknown): number {
  if (typeof raw === "number") {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n > 1e12 ? n : n * 1000;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now() + 3_600_000;
}

function toCreds(data: Record<string, unknown>, prevRefresh?: string): OAuthCredentials {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  if (!access) {
    throw new Error("MiniMax returned no access token.");
  }
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : (prevRefresh ?? "");
  return { access, refresh, expires: expiresToMs(data.expires_at ?? data.expires_in) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export const minimaxOAuthProvider: OAuthProviderInterface = {
  id: "minimax",
  name: "MiniMax",
  usesCallbackServer: false,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { signal } = callbacks;
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const start = await postForm(
      DEVICE_URL,
      {
        client_id: CLIENT_ID,
        scope: SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      },
      signal,
    );
    const userCode = typeof start.data.user_code === "string" ? start.data.user_code : "";
    if (start.status !== 200 || !userCode) {
      throw new Error(`MiniMax device authorization failed (HTTP ${start.status}).`);
    }
    if (typeof start.data.state === "string" && start.data.state && start.data.state !== state) {
      throw new Error("MiniMax OAuth state mismatch — aborting for safety.");
    }
    const verifyUri = typeof start.data.verification_uri === "string" ? start.data.verification_uri : "";
    const verifyComplete =
      typeof start.data.verification_uri_complete === "string" ? start.data.verification_uri_complete : "";
    // MiniMax's device/code returns `expired_in` — an ABSOLUTE epoch-ms deadline
    // (mmx-cli compares Date.now() < expired_in), not a duration.
    const rawExp = Number(start.data.expired_in ?? start.data.expires_in);
    const expiresAt =
      Number.isFinite(rawExp) && rawExp > 1e12
        ? rawExp
        : Date.now() + (Number.isFinite(rawExp) && rawExp > 0 ? rawExp : 300) * 1000;
    // MiniMax returns `interval` in MILLISECONDS (e.g. 3000), unlike RFC 8628's
    // seconds — treat a large value as already-ms, then clamp to a sane 2–15s.
    const ivRaw = Number(start.data.interval) || 5;
    const waitMs = Math.min(Math.max(ivRaw >= 1000 ? ivRaw : ivRaw * 1000, 2000), 15_000);

    callbacks.onAuth({
      url: verifyComplete || verifyUri,
      instructions: `Go to ${verifyUri || "the MiniMax page"} and enter code: ${userCode}`,
    });
    callbacks.onProgress?.("Waiting for you to approve the sign-in in your browser…");

    while (Date.now() < expiresAt) {
      if (signal?.aborted) {
        throw new Error("MiniMax sign-in cancelled.");
      }
      await sleep(waitMs, signal);
      const poll = await postForm(
        TOKEN_URL,
        { grant_type: DEVICE_GRANT, client_id: CLIENT_ID, user_code: userCode, code_verifier: codeVerifier },
        signal,
      );
      // MiniMax signals progress with a `status` field ("pending"/"success") at
      // HTTP 200 — NOT the RFC 8628 `error: authorization_pending`. A non-200 is
      // fatal; a token present means done; anything else means keep polling.
      if (poll.status !== 200) {
        throw new Error(`MiniMax device-code authorization failed (HTTP ${poll.status}).`);
      }
      if (typeof poll.data.access_token === "string" && poll.data.access_token) {
        return toCreds(poll.data);
      }
      // {status:"pending"} (or similar) → keep polling until the code expires.
    }
    throw new Error("MiniMax sign-in timed out. Please try again.");
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const refresh = typeof credentials.refresh === "string" ? credentials.refresh : "";
    if (!refresh) {
      throw new Error("No MiniMax refresh token available.");
    }
    const r = await postForm(TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    });
    if (r.status !== 200 || typeof r.data.access_token !== "string") {
      throw new Error(`MiniMax token refresh failed (HTTP ${r.status}).`);
    }
    return toCreds(r.data, refresh);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return typeof credentials.access === "string" ? credentials.access : "";
  },
};
