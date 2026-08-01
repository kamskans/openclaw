/**
 * Kimi Code OAuth (RFC 8628 device flow) — Mission Control custom provider.
 *
 * Kimi's coding subscription supports device-code sign-in (the Kimi Code CLI's
 * `/login` → "Kimi Code (OAuth)" option). We register this object with pi-ai's
 * OAuth registry (see the side-effect registration at the top of oauth.ts, and
 * the desktop's auth.ts) so the onboarding can offer "Sign in with Kimi" and the
 * gateway can refresh the token — exactly like the built-in ChatGPT/Gemini
 * providers, but hand-rolled because pi-ai has no Kimi provider.
 *
 * Endpoints + client_id verified from @moonshot-ai/kimi-code (dist/main.mjs):
 *   - device auth: POST auth.kimi.com/api/oauth/device_authorization
 *   - token/poll/refresh: POST auth.kimi.com/api/oauth/token
 * After auth the access token is a Bearer against https://api.kimi.com/coding/
 * (the same base the desktop's `kimi` provider already uses with a pasted key),
 * so only the CREDENTIAL changes (oauth vs api_key), not the provider config.
 *
 * Deliberately pi-ai-free: it exports a plain object implementing pi-ai's
 * OAuthProviderInterface (types only), so the desktop and gateway each register
 * it into their OWN pi-ai registry singleton without a shared-module concern.
 */
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";

const OAUTH_HOST = (
  process.env.KIMI_CODE_OAUTH_HOST ||
  process.env.KIMI_OAUTH_HOST ||
  "https://auth.kimi.com"
).replace(/\/+$/, "");
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_URL = `${OAUTH_HOST}/api/oauth/device_authorization`;
const TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`;
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
    /* non-JSON error body; leave {} and let the status drive the message */
  }
  return { status: res.status, data };
}

function toCreds(data: Record<string, unknown>, prevRefresh?: string): OAuthCredentials {
  const access = typeof data.access_token === "string" ? data.access_token : "";
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token : (prevRefresh ?? "");
  if (!access) {
    throw new Error("Kimi returned no access token.");
  }
  const expiresIn = Number(data.expires_in);
  // `expires` is epoch-ms — refreshOAuthTokenWithLock compares it to Date.now().
  const expires =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : Date.now() + 3_600_000;
  return { access, refresh, expires };
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

export const kimiOAuthProvider: OAuthProviderInterface = {
  id: "kimi",
  name: "Kimi Code",
  // Device-code flow: no local callback server, the code is shown to the user.
  usesCallbackServer: false,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { signal } = callbacks;
    const start = await postForm(DEVICE_URL, { client_id: CLIENT_ID }, signal);
    const deviceCode = typeof start.data.device_code === "string" ? start.data.device_code : "";
    if (start.status !== 200 || !deviceCode) {
      throw new Error(`Kimi device authorization failed (HTTP ${start.status}).`);
    }
    const userCode = typeof start.data.user_code === "string" ? start.data.user_code : "";
    const verifyUri =
      typeof start.data.verification_uri === "string" ? start.data.verification_uri : "";
    const verifyComplete =
      typeof start.data.verification_uri_complete === "string"
        ? start.data.verification_uri_complete
        : "";
    const expiresAt = Date.now() + (Number(start.data.expires_in) || 600) * 1000;
    let waitMs = Math.max(2, Number(start.data.interval) || 5) * 1000;

    callbacks.onAuth({
      url: verifyComplete || verifyUri,
      instructions: userCode
        ? `Go to ${verifyUri || "the Kimi page"} and enter code: ${userCode}`
        : undefined,
    });
    callbacks.onProgress?.("Waiting for you to approve the sign-in in your browser…");

    while (Date.now() < expiresAt) {
      if (signal?.aborted) {
        throw new Error("Kimi sign-in cancelled.");
      }
      await sleep(waitMs, signal);
      const poll = await postForm(
        TOKEN_URL,
        { client_id: CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_GRANT },
        signal,
      );
      if (poll.status === 200 && typeof poll.data.access_token === "string") {
        return toCreds(poll.data);
      }
      const err = typeof poll.data.error === "string" ? poll.data.error : "";
      if (err === "authorization_pending") {
        continue;
      }
      if (err === "slow_down") {
        waitMs += 5_000;
        continue;
      }
      if (err === "expired_token") {
        throw new Error("The Kimi sign-in code expired. Please try again.");
      }
      if (err === "access_denied") {
        throw new Error("Kimi sign-in was denied.");
      }
      throw new Error(`Kimi sign-in failed: ${err || `HTTP ${poll.status}`}.`);
    }
    throw new Error("Kimi sign-in timed out. Please try again.");
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const refresh = typeof credentials.refresh === "string" ? credentials.refresh : "";
    if (!refresh) {
      throw new Error("No Kimi refresh token available.");
    }
    const r = await postForm(TOKEN_URL, {
      client_id: CLIENT_ID,
      refresh_token: refresh,
      grant_type: "refresh_token",
    });
    if (r.status !== 200 || typeof r.data.access_token !== "string") {
      throw new Error(`Kimi token refresh failed (HTTP ${r.status}).`);
    }
    return toCreds(r.data, refresh);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return typeof credentials.access === "string" ? credentials.access : "";
  },
};
