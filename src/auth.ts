import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// Login flow adapted from pdf-claude-viewer's oauth-shared.ts / server.http.ts
// (exchangeUpstreamCode, /auth/callback). That project brokers a full OAuth
// 2.1 + DCR dance because IT is the OAuth provider for an external client
// (claude.ai). Here there is no external OAuth client -- Claude Desktop talks
// to us over stdio -- so we only need the inner leg: PKCE login against the
// same upstream IdP, a local HTTP callback, and a token file surviving
// process restarts (Claude Desktop relaunches this process on every session).

export const AUTH_AUTHORITY = 'https://stage-auth.developers.avanquest.com';
export const AUTH_CLIENT_ID = 'dev-portal';
export const AUTH_SCOPE = 'openid profile dev-portal-api offline_access IdentityServerApi';

// Reuses the same port/path pdf-claude-viewer's dev-portal IdP client already
// allowlists for localhost callbacks (see oauth-shared.ts) -- avoids needing a
// separate redirect_uri registered with the IdP for this app.
const AUTH_PORT = Number(process.env.PWV_AUTH_PORT ?? 8787);
export const AUTH_REDIRECT_URI = process.env.PWV_AUTH_REDIRECT_URI?.trim() || `http://localhost:${AUTH_PORT}/auth/callback`;

// TEMPORARY: the per-user "get my license keys" API lookup (technology-portal's
// LicenseManagement service) is parked for now -- login only needs to
// authenticate the user, not resolve their entitlement yet. A fixed license
// key is used until that lookup is wired back in. Override via PWV_LICENSE_KEY.
const HARDCODED_LICENSE_KEY = 'lk-v1.qTxApz4_7OcnK3H6nFyfAdhzO-7DqampqQ';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const TOKEN_FILE = path.join(os.homedir(), '.avanquest-pdf-mcp', 'auth.json');

export type AuthProfile = { firstName?: string; lastName?: string; email?: string };

type TokenFile = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  profile?: AuthProfile;
  licenseKey: string;
  licenseFetchedAt: number;
};

export type AuthState = { accessToken: string; licenseKey: string; profile?: AuthProfile };

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Must survive process restarts: the temporary local server that receives
// the IdP's redirect lives only for the duration of one login attempt, but
// the *signing key* used to validate that redirect's `state` param used to be
// a fresh randomBytes(32) per process (see git history) -- if Claude Desktop
// relaunched this process (extension reinstall/update, crash-relaunch) while
// a login was in flight in the browser, the new process couldn't verify a
// state signed by the old process's key, and the callback failed with
// "invalid or expired login link" even though the user had just signed in
// correctly. Persisting the key to disk (same directory as the token file)
// fixes that.
const STATE_KEY_FILE = path.join(os.homedir(), '.avanquest-pdf-mcp', 'state-signing-key');
let stateSigningKeyPromise: Promise<Buffer> | null = null;
async function getStateSigningKey(): Promise<Buffer> {
  if (!stateSigningKeyPromise) {
    stateSigningKeyPromise = (async () => {
      try {
        const hex = (await fs.readFile(STATE_KEY_FILE, 'utf-8')).trim();
        if (hex) return Buffer.from(hex, 'hex');
      } catch { /* not created yet */ }
      const fresh = randomBytes(32);
      await fs.mkdir(path.dirname(STATE_KEY_FILE), { recursive: true });
      await fs.writeFile(STATE_KEY_FILE, fresh.toString('hex'), 'utf-8');
      return fresh;
    })();
  }
  return stateSigningKeyPromise;
}

async function signState(payload: Record<string, unknown>): Promise<string> {
  const key = await getStateSigningKey();
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

async function verifyState(token: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) {
    console.error('[auth] state param missing body or signature part');
    return null;
  }
  const key = await getStateSigningKey();
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.error('[auth] state signature mismatch (stale signing key or tampered param)');
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch (err) {
    console.error(`[auth] state payload JSON parse failed: ${(err as Error).message}`);
    return null;
  }
}

type OidcConfig = { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string };
let oidcConfigCache: OidcConfig | null = null;
async function fetchOidcConfig(): Promise<OidcConfig> {
  if (oidcConfigCache) return oidcConfigCache;
  const r = await fetch(`${AUTH_AUTHORITY}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status} ${r.statusText}`);
  oidcConfigCache = (await r.json()) as OidcConfig;
  return oidcConfigCache;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'win32'
    ? `start "" "${url}"`
    : platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, (err) => {
    if (err) console.error(`[auth] failed to open browser automatically: ${err.message}. Open this URL manually: ${url}`);
  });
}

async function loadTokenFile(): Promise<TokenFile | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf-8');
    return JSON.parse(raw) as TokenFile;
  } catch {
    return null;
  }
}

async function saveTokenFile(data: TokenFile): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await fs.chmod(TOKEN_FILE, 0o600);
  } catch {
    // no-op on platforms without POSIX permission bits (e.g. Windows)
  }
}

async function exchangeCode(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; profile: AuthProfile }> {
  console.error(`[auth] exchanging authorization code for tokens (POST ${AUTH_AUTHORITY} token endpoint)`);
  const cfg = await fetchOidcConfig();
  const tokenRes = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: AUTH_REDIRECT_URI,
      client_id: AUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number };

  let profile: AuthProfile = {};
  if (cfg.userinfo_endpoint) {
    try {
      const userinfoRes = await fetch(cfg.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
      if (userinfoRes.ok) {
        const info = (await userinfoRes.json()) as Record<string, unknown>;
        const nameParts = String(info.name ?? '').split(' ');
        profile = {
          firstName: (info.given_name as string | undefined) ?? nameParts[0],
          lastName: (info.family_name as string | undefined) ?? nameParts.slice(1).join(' '),
          email: info.email as string | undefined,
        };
      }
    } catch (err) {
      console.error(`[auth] userinfo lookup failed (non-fatal): ${(err as Error).message}`);
    }
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    profile,
  };
}

async function refreshTokens(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
  const cfg = await fetchOidcConfig();
  const tokenRes = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: AUTH_CLIENT_ID,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token refresh failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

async function runLoginFlow(): Promise<AuthState> {
  const cfg = await fetchOidcConfig();
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = await signState({ codeVerifier, iat: Date.now() });

  const authorizeUrl = new URL(cfg.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', AUTH_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', AUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', AUTH_SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const redirectUrl = new URL(AUTH_REDIRECT_URI);
  const callbackPort = Number(redirectUrl.port || 80);
  const callbackPath = redirectUrl.pathname;

  console.error(`[auth] not signed in -- opening browser for login: ${authorizeUrl.toString()}`);

  return new Promise<AuthState>((resolve, reject) => {
    const app = express();
    let settled = false;
    let httpServer: import('node:http').Server;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      httpServer.close();
      reject(new Error('login timed out -- please try again'));
    }, LOGIN_TIMEOUT_MS);

    app.get(callbackPath, (req, res) => {
      void (async () => {
        const { code, state: returnedState, error, error_description: errorDescription } = req.query as Record<string, string>;
        console.error(`[auth] callback hit: hasCode=${!!code} hasState=${!!returnedState} error=${error ?? ''}`);
        const payload = returnedState ? await verifyState(returnedState) : null;
        if (error || !payload || typeof payload.codeVerifier !== 'string') {
          res.status(400).send(renderCallbackPage(false, errorDescription || error || 'invalid or expired login link'));
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            httpServer.close();
            reject(new Error(errorDescription || error || 'login failed'));
          }
          return;
        }
        try {
          const { accessToken, refreshToken, expiresAt, profile } = await exchangeCode(String(code), payload.codeVerifier as string);
          const licenseKey = HARDCODED_LICENSE_KEY;
          await saveTokenFile({ accessToken, refreshToken, expiresAt, profile, licenseKey, licenseFetchedAt: Date.now() });
          res.send(renderCallbackPage(true));
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            httpServer.close();
            resolve({ accessToken, licenseKey, profile });
          }
        } catch (err) {
          res.status(500).send(renderCallbackPage(false, (err as Error).message));
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            httpServer.close();
            reject(err as Error);
          }
        }
      })();
    });

    httpServer = app.listen(callbackPort, '127.0.0.1', () => {
      openBrowser(authorizeUrl.toString());
    });
    httpServer.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function renderCallbackPage(success: boolean, message?: string): string {
  const title = success ? 'Signed in' : 'Sign-in failed';
  const body = success
    ? 'You are signed in. You can close this tab and return to Claude Desktop.'
    : `Sign-in failed: ${message ?? 'unknown error'}. You can close this tab and try again.`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family:system-ui;padding:2rem;text-align:center;">` +
    `<h2>${title}</h2><p>${body}</p></body></html>`;
}

let inFlight: Promise<AuthState> | null = null;

// Dev-only escape hatch: if PWV_LICENSE_KEY is set, skip the login flow
// entirely (matches the old behavior). Not exposed via manifest.json anymore.
function devLicenseOverride(): string | null {
  const env = process.env.PWV_LICENSE_KEY?.trim();
  return env && !env.includes('${') ? env : null;
}

export async function ensureAuthenticated(): Promise<AuthState> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const devLicense = devLicenseOverride();
    if (devLicense) {
      console.error('[auth] PWV_LICENSE_KEY set -- skipping login flow (dev override)');
      return { accessToken: '', licenseKey: devLicense };
    }

    const stored = await loadTokenFile();
    if (stored && stored.expiresAt > Date.now() + 30_000) {
      console.error(`[auth] using cached token from ${TOKEN_FILE} (expires ${new Date(stored.expiresAt).toISOString()})`);
      return { accessToken: stored.accessToken, licenseKey: stored.licenseKey, profile: stored.profile };
    }

    if (stored?.refreshToken) {
      console.error('[auth] cached token expired -- attempting silent refresh');
      try {
        const refreshed = await refreshTokens(stored.refreshToken);
        const licenseKey = stored.licenseKey || HARDCODED_LICENSE_KEY;
        await saveTokenFile({ ...refreshed, profile: stored.profile, licenseKey, licenseFetchedAt: Date.now() });
        console.error('[auth] silent refresh succeeded');
        return { accessToken: refreshed.accessToken, licenseKey, profile: stored.profile };
      } catch (err) {
        console.error(`[auth] silent refresh failed, falling back to interactive login: ${(err as Error).message}`);
      }
    } else {
      console.error(`[auth] no cached token found at ${TOKEN_FILE} -- starting interactive login`);
    }

    return runLoginFlow();
  })();

  try {
    return await inFlight;
  } catch (err) {
    // Allow a subsequent tool call to retry the login instead of being stuck
    // on a permanently rejected promise.
    inFlight = null;
    throw err;
  }
}
