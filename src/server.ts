import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupClientInfo } from './client-info.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ensureAuthenticated, type AuthState } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The license key used to be collected per-user via the mcpb `user_config`
// prompt (manifest -> PWV_LICENSE_KEY env). It's now obtained automatically
// via browser-based login against the same upstream IdP pdf-claude-viewer
// uses (see auth.ts) -- ensureAuthenticated() opens the system browser on
// first run and caches tokens/license in the user's home directory across
// restarts. Kicked off in main() so it doesn't block the MCP handshake; tool
// handlers await the same in-flight promise before using the license.
let authStatePromise: Promise<AuthState> | null = null;
function getAuthState(): Promise<AuthState> {
  if (!authStatePromise) {
    authStatePromise = ensureAuthenticated().catch((err) => {
      // Don't cache a failed login forever -- clear it so the next call (e.g.
      // triggered by the user retrying the tool) starts a fresh attempt
      // instead of replaying the same rejection until the process restarts.
      authStatePromise = null;
      throw err;
    });
  }
  return authStatePromise;
}

// Directories `display_pdf` is allowed to open from. Configured via the mcpb
// `user_config` "Allowed folders" prompt (manifest -> PWV_ALLOWED_DIRS_LIST), or
// the PWV_ALLOWED_DIRS env (OS-path-separator list) for non-mcpb/dev use. When
// neither is set, defaults to the user's common document locations.
// `display_pdf` rejects anything outside these roots, so the model can't coax
// the extension into reading arbitrary files.
function parseAllowedDirsConfig(): string[] {
  // PWV_ALLOWED_DIRS_LIST is built from up to 4 individual directory user_config
  // fields joined with "|". Unset optional fields stay as literal "${user_config.xxx}"
  // -- filter those out. Also accept semicolon/newline/path.delimiter separators for
  // manual PWV_ALLOWED_DIRS env var usage.
  const fromUserConfig = process.env.PWV_ALLOWED_DIRS_LIST?.trim();
  if (fromUserConfig) {
    const entries = fromUserConfig.split(/[|\n;]/).flatMap((s) => s.split(path.delimiter));
    const valid = entries.map((s) => s.trim()).filter((s) => s && !s.includes('${'));
    if (valid.length > 0) return valid;
  }
  if (process.env.PWV_ALLOWED_DIRS) {
    return process.env.PWV_ALLOWED_DIRS.split(path.delimiter);
  }
  return ['Documents', 'Downloads', 'Desktop', 'PDF'].map((d) => path.join(os.homedir(), d));
}

const ALLOWED_DIRS: string[] = parseAllowedDirsConfig()
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return path.resolve(d); // keep configured roots that don't exist yet
    }
  });

/**
 * Resolve a requested path to a real file that is (a) a PDF and (b) located
 * within an allowed root. Returns the canonical absolute path, or an error
 * reason. Resolves symlinks first so a link can't escape the allowlist.
 */
function resolveAllowedPdf(requested: string): { ok: true; absolute: string } | { ok: false; reason: string } {
  const resolved = path.isAbsolute(requested) ? requested : path.resolve(os.homedir(), requested);
  if (!existsSync(resolved)) return { ok: false, reason: `File not found: ${resolved}` };

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch (err) {
    return { ok: false, reason: `Cannot resolve: ${(err as Error).message}` };
  }

  if (path.extname(real).toLowerCase() !== '.pdf') {
    return { ok: false, reason: `Not a PDF file: ${real}` };
  }

  const inAllowed = ALLOWED_DIRS.some((root) => real === root || real.startsWith(root + path.sep));
  if (!inAllowed) {
    const rawEnv = process.env.PWV_ALLOWED_DIRS_LIST;
    const allPwvKeys = Object.keys(process.env).filter(k => k.startsWith('PWV'));
    return {
      ok: false,
      reason: [
        `Path is outside the allowed folders.`,
        `real path: ${real}`,
        `ALLOWED_DIRS: ${JSON.stringify(ALLOWED_DIRS)}`,
        `PWV_ALLOWED_DIRS_LIST: ${JSON.stringify(rawEnv)}`,
        `PWV env keys: ${allPwvKeys.join(', ')}`,
      ].join('\n'),
    };
  }
  return { ok: true, absolute: real };
}

const requireFromHere = createRequire(import.meta.url);
const viewerEntryPath = requireFromHere.resolve('@avanquest/pdf-web-viewer');
const viewerRoot = path.dirname(path.dirname(viewerEntryPath));

const STUB_HTML_PATH = path.join(__dirname, 'mcp-app.html');
const DIAG_HTML_PATH = path.join(__dirname, 'diag.html');

type FileEntry = { fullPath: string; name: string; expiresAt: number; isTemp?: boolean };
const fileTokens = new Map<string, FileEntry>();
const saveBuffers = new Map<string, Buffer[]>();
const TOKEN_TTL_MS = 30 * 60 * 1000;

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of fileTokens) {
    if (entry.expiresAt <= now) {
      if (entry.isTemp) fs.unlink(entry.fullPath).catch(() => {});
      fileTokens.delete(token);
    }
  }
}

function mintToken(fullPath: string, name: string, isTemp = false): string {
  pruneExpired();
  const token = randomUUID();
  fileTokens.set(token, { fullPath, name, expiresAt: Date.now() + TOKEN_TTL_MS, isTemp });
  return token;
}

async function downloadPdfFromUrl(pdfUrl: string): Promise<{ tempPath: string; name: string }> {
  const parsed = new URL(pdfUrl);
  const urlBasename = path.basename(parsed.pathname) || 'document';
  const name = urlBasename.toLowerCase().endsWith('.pdf') ? urlBasename : urlBasename + '.pdf';
  const r = await fetch(pdfUrl, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tempPath = path.join(os.tmpdir(), `pwv-${randomUUID()}.pdf`);
  await fs.writeFile(tempPath, buf);
  return { tempPath, name };
}

// Fixed port so a host-cached copy of the UI resource (with this origin baked in)
// still points at a live server after restarts. Override with PWV_PORT if taken.
const DEFAULT_PORT = Number(process.env.PWV_PORT ?? 41973);

// Secret gating the /xhrmod outbound relay; injected into the UI resource HTML
// so only our iframe can use it. Must stay stable across process restarts --
// Claude Desktop caches the resource HTML and a token that changes on every
// restart would break the relay until the cache clears. Previously derived
// from the (synchronous, static) license key; now that the license comes from
// an async login, it's persisted to its own small file instead.
const PROXY_SECRET_FILE = path.join(os.homedir(), '.avanquest-pdf-mcp', 'proxy-secret');
let PROXY_TOKEN = '';
async function loadOrCreateProxyToken(): Promise<string> {
  try {
    const existing = (await fs.readFile(PROXY_SECRET_FILE, 'utf-8')).trim();
    if (existing) return existing;
  } catch { /* not created yet */ }
  const fresh = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  await fs.mkdir(path.dirname(PROXY_SECRET_FILE), { recursive: true });
  await fs.writeFile(PROXY_SECRET_FILE, fresh, 'utf-8');
  return fresh;
}

// The relay exists solely so the viewer's WASM can validate its license.
// Restrict it to that host so it can't be used as a general localhost proxy.
const RELAY_ALLOWED_HOSTS = new Set(['api-developers.avanquest.com']);

// Verbose request/iframe/proxy tracing is debugging scaffolding; off unless
// PWV_DEBUG is set.
const DEBUG = process.env.PWV_DEBUG === '1';
function debug(msg: string): void {
  if (DEBUG) console.error(msg);
}

async function startAssetServer(): Promise<{ port: number; baseUrl: string }> {
  const app = express();
  app.use(cors());
  if (DEBUG) {
    app.use((req, _res, next) => {
      debug(`[http] ${req.method} ${req.path}`);
      next();
    });
  }

  // The sandbox CSP blocks fetch()/XHR to this origin but allows script
  // imports, so iframe log beacons arrive as dynamic imports with the message
  // in the query string. No-op unless PWV_DEBUG is set.
  app.get('/logmod', (req, res) => {
    debug(`[iframe] ${String(req.query.m ?? '')}`);
    res.type('application/javascript').send('export default 1;');
  });

  // Outbound HTTP relay for the worker's license check (the sandbox blocks
  // all network from the iframe/worker, so the wasm's XHR is shimmed and
  // tunneled here over the script-loading channel). Token-gated, https-only,
  // logged. Two flavors of the same relay:
  //  - /xhrmod   -> ES module (async path, awaited via dynamic import)
  //  - /xhrsync  -> classic script assigning a global (sync path: the worker's
  //    blocking importScripts() returns only after the upstream call is done)
  type RelayResult = {
    error?: string;
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    bodyB64?: string;
  };
  const performRelay = async (query: Record<string, unknown>): Promise<RelayResult> => {
    try {
      const url = String(query.u ?? '');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { error: 'invalid url' };
      }
      // Local asset server (http://127.0.0.1:PORT/) -- serve from filesystem directly.
      // The worker XHR shim relays all requests here including font loads from fontsPath,
      // but those are http: so the https-only check below would block them.
      if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') {
        try {
          const rel = parsed.pathname.replace(/^\//, '');
          let buf: Buffer;
          if (rel.startsWith('public/') || rel.startsWith('ui/')) {
            const abs = path.resolve(viewerRoot, rel);
            if (!abs.startsWith(viewerRoot + path.sep)) return { error: 'path traversal blocked' };
            buf = await fs.readFile(abs);
          } else {
            return { error: `local path not served: ${rel}` };
          }
          return {
            status: 200, statusText: 'OK',
            headers: { 'content-type': 'application/octet-stream' },
            bodyB64: buf.toString('base64'),
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      }
      if (parsed.protocol !== 'https:') return { error: 'https targets only' };
      if (!RELAY_ALLOWED_HOSTS.has(parsed.hostname)) {
        console.error(`[proxy] BLOCKED disallowed host: ${parsed.hostname}`);
        return { error: `host not allowed: ${parsed.hostname}` };
      }
      const method = String(query.m ?? 'GET');
      const headers = JSON.parse(
        Buffer.from(String(query.h ?? ''), 'base64').toString('utf8') || '{}',
      ) as Record<string, string>;
      const bodyB64 = String(query.b ?? '');
      debug(`[proxy] ${method} ${url}`);
      const r = await fetch(url, {
        method,
        headers,
        body: bodyB64 ? Buffer.from(bodyB64, 'base64') : undefined,
        signal: AbortSignal.timeout(20000),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      debug(`[proxy] -> ${r.status} (${buf.length} bytes)`);
      return {
        status: r.status,
        statusText: r.statusText,
        headers: Object.fromEntries(r.headers.entries()),
        bodyB64: buf.toString('base64'),
      };
    } catch (err) {
      console.error(`[proxy] FAILED: ${(err as Error).message}`);
      return { error: (err as Error).message };
    }
  };

  app.get('/xhrmod', async (req, res) => {
    if (req.query.t !== PROXY_TOKEN) {
      res.status(403).send('// forbidden');
      return;
    }
    const payload = await performRelay(req.query as Record<string, unknown>);
    res
      .type('application/javascript')
      .send(`export default "${Buffer.from(JSON.stringify(payload)).toString('base64')}";`);
  });

  app.get('/xhrsync', async (req, res) => {
    if (req.query.t !== PROXY_TOKEN) {
      res.status(403).send('// forbidden');
      return;
    }
    const payload = await performRelay(req.query as Record<string, unknown>);
    res.type('application/javascript').send(`self.__pwv_xhr_result = ${JSON.stringify(payload)};`);
  });

  // Same workaround for binary assets: wrap any served file as an ES module
  // exporting base64, importable where fetch() is forbidden.
  app.get(/^\/mod\/(.+)$/, async (req, res) => {
    const rel = (req.params as unknown as Record<string, string>)[0];
    try {
      let buf: Buffer;
      if (rel.startsWith('file/')) {
        pruneExpired();
        const token = rel.slice('file/'.length);
        const entry = fileTokens.get(token);
        if (!entry) {
          // Cowork mode runs separate server instances: the iframe's instance may not
          // have the token minted by the MCP-side instance. Fall back to the filePath
          // query param if provided (passed by fileFromToken as a safety net).
          const fp = String(req.query.fp ?? '');
          if (!fp) {
            res.type('application/javascript').status(404).send('export default null; // not found or expired');
            return;
          }
          const tmpDir = os.tmpdir();
          const resolved = resolveAllowedPdf(fp);
          const isInTmp = fp.startsWith(tmpDir + path.sep) || fp.startsWith(tmpDir + '/');
          if (!resolved.ok && !isInTmp) {
            res.type('application/javascript').status(403).send(`export default null; // ${resolved.reason}`);
            return;
          }
          const readPath = resolved.ok ? resolved.absolute : fp;
          buf = await fs.readFile(readPath);
        } else {
          buf = await fs.readFile(entry.fullPath);
        }
      } else if (rel.startsWith('ui/') || rel.startsWith('public/')) {
        const abs = path.resolve(viewerRoot, rel);
        if (!abs.startsWith(viewerRoot + path.sep)) {
          res.type('application/javascript').status(403).send('export default null; // forbidden');
          return;
        }
        buf = await fs.readFile(abs);
      } else {
        res.type('application/javascript').status(404).send('export default null; // unknown asset class');
        return;
      }
      res.type('application/javascript').send(`export default "${buf.toString('base64')}";`);
    } catch (err) {
      res.type('application/javascript').status(404).send(`export default null; // ${(err as Error).message}`);
    }
  });

  app.use('/ui', express.static(path.join(viewerRoot, 'ui'), { fallthrough: false }));
  app.use('/public', express.static(path.join(viewerRoot, 'public'), { fallthrough: false }));

  app.get('/file/:token', (req, res) => {
    pruneExpired();
    const entry = fileTokens.get(req.params.token);
    if (!entry) {
      res.status(404).send('not found or expired');
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.name)}"`);
    createReadStream(entry.fullPath).pipe(res);
  });

  const listen = (port: number): Promise<{ port: number; baseUrl: string }> =>
    new Promise((resolve, reject) => {
      const httpServer = app.listen(port, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          resolve({ port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` });
        } else {
          reject(new Error('unexpected listen address'));
        }
      });
      httpServer.on('error', reject);
    });

  try {
    return await listen(DEFAULT_PORT);
  } catch (err) {
    console.error(`asset server: port ${DEFAULT_PORT} unavailable (${(err as Error).message}), falling back to a random port`);
    return listen(0);
  }
}

function renderStub(stub: string, baseUrl: string, license: string): string {
  return stub
    .replaceAll('%%PWV_BASE%%', baseUrl + '/')
    .replaceAll('%%PWV_LICENSE%%', license)
    .replaceAll('%%PWV_PROXY%%', PROXY_TOKEN)
    .replaceAll('%%PWV_DEBUG%%', DEBUG ? 'true' : 'false');
}


// Populated once getAuthState() resolves/rejects, so tool handlers can check
// readiness synchronously instead of blocking on a potentially multi-minute
// browser login. kickOffAuth() re-attaches itself on failure so the next
// checkAuthReady() call (i.e. the user retrying the tool) starts a fresh
// login attempt rather than replaying a stale error forever.
let resolvedAuth: AuthState | null = null;
let authError: Error | null = null;
let authAttemptPending = false;

function kickOffAuth(): void {
  if (authAttemptPending) return;
  authAttemptPending = true;
  console.error('[avanquest-pdf] starting sign-in check...');
  getAuthState().then(
    (state) => {
      authAttemptPending = false;
      resolvedAuth = state;
      authError = null;
      console.error(`[avanquest-pdf] signed in${state.profile?.email ? ' as ' + state.profile.email : ''}`);
    },
    (err) => {
      authAttemptPending = false;
      authError = err as Error;
      console.error(`[avanquest-pdf] sign-in failed: ${(err as Error).stack ?? (err as Error).message}`);
    },
  );
}

function checkAuthReady(): { ready: true; license: string } | { ready: false; message: string } {
  if (resolvedAuth) return { ready: true, license: resolvedAuth.licenseKey };
  if (authError) {
    const message = `Sign-in failed: ${authError.message}. Retrying -- please try the command again in a moment, or check the server logs.`;
    kickOffAuth();
    return { ready: false, message };
  }
  return {
    ready: false,
    message: 'Please check the browser tab that just opened and sign in with your Avanquest account, then try again.',
  };
}

async function main(): Promise<void> {
  PROXY_TOKEN = await loadOrCreateProxyToken();
  // Kicked off in the background (not awaited) so a pending browser login
  // never delays the MCP initialize handshake with Claude Desktop.
  kickOffAuth();

  const { baseUrl } = await startAssetServer();
  const stubTemplate = await fs.readFile(STUB_HTML_PATH, 'utf-8');

  let pkgVersion = '0.0.0';
  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf-8')) as { version?: string };
    pkgVersion = pkgJson.version ?? '0.0.0';
  } catch { /* keep default */ }
  const vSlug = pkgVersion.replace(/\./g, '-');

  const server = new McpServer({
    name: 'avanquest-pdf-mcp-editor',
    version: pkgVersion,
  });

  // Version in the URI busts Claude Desktop's resource cache on each new build.
  const resourceUri = `ui://avanquest-pdf-viewer/mcp-app-v${vSlug}.html`;
  const diagResourceUri = `ui://avanquest-pdf-viewer/diag-v${vSlug}.html`;

  registerAppTool(
    server,
    'display_pdf',
    {
      title: 'Display PDF',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Open a PDF in the embedded Avanquest PDF viewer. Pass either an absolute local path to a .pdf file inside the user\'s document folders, or a URL to a remote PDF. The viewer renders inline in the chat.',
      inputSchema: {
        path: z.string().optional().describe("Absolute path to a PDF file within the user's allowed document folders"),
        url: z.string().optional().describe('URL of a remote PDF to download and open (http or https)'),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ path: requestedPath, url: pdfUrl }) => {
      const auth = checkAuthReady();
      if (!auth.ready) {
        return { content: [{ type: 'text', text: auth.message }], isError: true };
      }

      if (!requestedPath && !pdfUrl) {
        return {
          content: [{ type: 'text', text: 'Provide either path (local file) or url (remote PDF).' }],
          isError: true,
        };
      }

      let absolutePath: string;
      let name: string;
      let isTemp = false;

      if (pdfUrl) {
        try {
          const downloaded = await downloadPdfFromUrl(pdfUrl);
          absolutePath = downloaded.tempPath;
          name = downloaded.name;
          isTemp = true;
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to download PDF from URL: ${(err as Error).message}` }],
            isError: true,
          };
        }
      } else {
        const resolved = resolveAllowedPdf(requestedPath!);
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: resolved.reason }],
            isError: true,
          };
        }
        absolutePath = resolved.absolute;
        name = path.basename(absolutePath);
      }

      const token = mintToken(absolutePath, name, isTemp);
      const fileUrl = `${baseUrl}/file/${token}`;
      _lastDocState = '';
      _pendingDocOpen = true;
      pendingViewerCommand = null;

      return {
        content: [{ type: 'text', text: `Opened ${name} in the viewer.` }],
        structuredContent: { url: fileUrl, name, token, filePath: pdfUrl ?? absolutePath },
      };
    },
  );

  registerAppTool(
    server,
    'save_pdf',
    {
      title: 'Save PDF',
      annotations: { destructiveHint: true },
      description: 'Write edited PDF bytes back to the file system',
      inputSchema: {
        token: z.string(),
        chunk: z.string().describe('base64-encoded bytes'),
        offset: z.number().int().min(0),
        totalSize: z.number().int().min(1),
        savePath: z.string().optional().describe('Override save path; defaults to original file path'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ token, chunk, offset, totalSize, savePath }) => {
      pruneExpired();
      const entry = fileTokens.get(token);
      if (!entry) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'PDF not found or token expired' }) }],
          isError: true,
        };
      }
      const targetPath = savePath?.trim() || entry.fullPath;
      if (!saveBuffers.has(token)) saveBuffers.set(token, []);
      const chunkBuf = Buffer.from(chunk, 'base64');
      saveBuffers.get(token)!.push(chunkBuf);
      const bytesReceived = offset + chunkBuf.length;
      if (bytesReceived >= totalSize) {
        const full = Buffer.concat(saveBuffers.get(token)!);
        saveBuffers.delete(token);
        await fs.writeFile(targetPath, full);
        console.error(`[save_pdf] saved ${full.length} bytes -> ${targetPath}`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ done: true, savedPath: targetPath }) }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ done: false, bytesReceived }) }],
      };
    },
  );

  // Called by the iframe in web contexts (Cowork / claude.ai) where dynamic
  // import('http://...') is blocked as mixed content. Returns the PDF as base64.
  registerAppTool(
    server,
    'read_pdf_bytes_by_token',
    {
      title: 'Read PDF bytes by token',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Internal tool: read PDF bytes for the viewer iframe via the MCP channel (used in web mode where HTTP imports are blocked by mixed-content policy).',
      inputSchema: {
        token: z.string().describe('File token returned by display_pdf'),
        filePath: z.string().optional().describe('Fallback path if token not found (for Cowork multi-instance mode)'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ token, filePath }) => {
      pruneExpired();
      const entry = fileTokens.get(token);
      let readPath: string | null = entry?.fullPath ?? null;
      if (!readPath && filePath) {
        const tmpDir = os.tmpdir();
        const isInTmp = filePath.startsWith(tmpDir + path.sep) || filePath.startsWith(tmpDir + '/');
        const resolved = resolveAllowedPdf(filePath);
        readPath = resolved.ok ? resolved.absolute : (isInTmp ? filePath : null);
      }
      if (!readPath) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'PDF not found or token expired' }) }] };
      }
      try {
        const buf = await fs.readFile(readPath);
        return { content: [{ type: 'text', text: JSON.stringify({ base64: buf.toString('base64') }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }] };
      }
    },
  );

  registerAppTool(
    server,
    'compress_pdf',
    {
      title: 'Compress PDF',
      annotations: { destructiveHint: true },
      description: 'Open a PDF in the viewer and compress it. Accepts path (required), compression (min/low/medium/high/max, default: medium), and optional outputPath. The viewer performs compression using the browser-side PDF engine.',
      inputSchema: {
        path: z.string().describe("Absolute path to a PDF file within the user's allowed document folders"),
        compression: z.enum(['min', 'low', 'medium', 'high', 'max'])
          .optional()
          .describe('Compression level: max=maximum compression (smallest file, lower quality), min=minimum compression (largest file, best quality). Default: medium'),
        outputPath: z.string().optional().describe('Where to save the compressed file. Defaults to original filename with _compressed suffix'),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ path: requestedPath, compression, outputPath }) => {
      const resolved = resolveAllowedPdf(requestedPath);
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: resolved.reason }], isError: true };
      }
      const filePath = resolved.absolute;
      const ext = path.extname(filePath);
      const savePath = outputPath?.trim() || filePath.slice(0, -ext.length) + '_compressed' + ext;
      const name = path.basename(filePath);
      const token = mintToken(filePath, name);
      return {
        content: [{ type: 'text', text: `Opening ${name} for compression (compression: ${compression ?? 'medium'})...` }],
        structuredContent: {
          url: `${baseUrl}/file/${token}`,
          name,
          token,
          filePath,
          command: { type: 'compress_pdf', compression: compression ?? 'medium', outputPath: savePath },
        },
      };
    },
  );

  registerAppTool(
    server,
    'merge_pdf',
    {
      title: 'Merge PDFs',
      annotations: { destructiveHint: true },
      description: 'Open the first PDF in the viewer and merge all listed PDFs into one. Accepts paths (array of absolute PDF paths, min 2) and optional outputPath.',
      inputSchema: {
        paths: z.array(z.string()).min(2).describe('Absolute paths to PDF files to merge, in order'),
        outputPath: z.string().optional().describe('Where to save the merged file. Defaults to <firstName>_merged.pdf next to the first file'),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ paths, outputPath }) => {
      const resolved: string[] = [];
      for (const p of paths) {
        const r = resolveAllowedPdf(p);
        if (!r.ok) return { content: [{ type: 'text', text: r.reason }], isError: true };
        resolved.push(r.absolute);
      }
      const firstPath = resolved[0];
      const ext = path.extname(firstPath);
      const firstName = path.basename(firstPath, ext);
      const savePath = outputPath?.trim() || path.join(path.dirname(firstPath), `${firstName}_merged${ext}`);
      const files = resolved.map((fp) => {
        const name = path.basename(fp);
        return { token: mintToken(fp, name), name };
      });
      return {
        content: [{ type: 'text', text: `Opening ${files[0].name} for merge (${paths.length} files)...` }],
        structuredContent: {
          url: `${baseUrl}/file/${files[0].token}`,
          name: files[0].name,
          token: files[0].token,
          filePath: firstPath,
          command: { type: 'merge_pdf', files, outputPath: savePath },
        },
      };
    },
  );

  registerAppTool(
    server,
    'split_pdf',
    {
      title: 'Split PDF',
      annotations: { destructiveHint: true },
      description: 'Open a PDF in the viewer and split it into multiple files by page ranges or equal chunks.',
      inputSchema: {
        path: z.string().describe("Absolute path to the PDF file to split"),
        ranges: z.array(z.string()).optional().describe('Page ranges for each output file, e.g. ["1-3","4-6","7"]. Supports ranges (1-3), comma lists (1,3,5), or single pages (2).'),
        pagesPerFile: z.number().int().min(1).optional().describe('Split into equal chunks of N pages each. Alternative to ranges.'),
        outputDir: z.string().optional().describe('Directory for output files. Defaults to same directory as the input file.'),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ path: requestedPath, ranges, pagesPerFile, outputDir }) => {
      if (!ranges && !pagesPerFile) {
        return { content: [{ type: 'text', text: 'Provide either ranges (e.g. ["1-3","4-6"]) or pagesPerFile (e.g. 2)' }], isError: true };
      }
      const resolved = resolveAllowedPdf(requestedPath);
      if (!resolved.ok) return { content: [{ type: 'text', text: resolved.reason }], isError: true };
      const filePath = resolved.absolute;
      const ext = path.extname(filePath);
      const baseName = path.basename(filePath, ext);
      const outDir = outputDir?.trim() || path.dirname(filePath);
      const name = path.basename(filePath);
      const token = mintToken(filePath, name);
      return {
        content: [{ type: 'text', text: `Opening ${name} for split...` }],
        structuredContent: {
          url: `${baseUrl}/file/${token}`,
          name,
          token,
          filePath,
          command: { type: 'split_pdf', ranges, pagesPerFile, outputDir: outDir, baseName },
        },
      };
    },
  );

  let pendingViewerCommand: Record<string, unknown> | null = null;
  let pendingSearchResult: { count: number; pages: number[] } | null = null;
  let pendingViewerResult: { type: string; data: unknown } | null = null;
  let _pendingDocOpen = false;

  // Tracks last-known document state injected by mcp-app.ts via report_viewer_result.
  // Appended to every viewer tool response so Claude always knows pageCount after each op.
  let _lastDocState = '';
  function docNote(): string { return _lastDocState ? ` [${_lastDocState}]` : ''; }

  type TR = { content: [{ type: 'text'; text: string }]; isError?: true };
  const ok  = (text: string): TR => ({ content: [{ type: 'text' as const, text }] });
  const nok = (text: string): TR => ({ content: [{ type: 'text' as const, text }], isError: true });

  async function pollViewerResult<T>(
    command: Record<string, unknown>,
    resultType: string,
    timeoutMs: number,
    handler: (data: T) => TR,
  ): Promise<TR> {
    pendingViewerResult = null;
    pendingViewerCommand = command;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 300));
      if (pendingViewerResult !== null) {
        const pr = pendingViewerResult as { type: string; data: unknown };
        if (pr.type !== resultType) continue;
        pendingViewerResult = null;
        const result = handler(pr.data as T);
        if (!result.isError && result.content[0]) {
          result.content[0] = { type: 'text' as const, text: result.content[0].text + docNote() };
        }
        return result;
      }
    }
    pendingViewerCommand = null;
    return nok('Timed out -- make sure a PDF is open in the viewer.');
  }

  server.registerTool(
    'search_in_pdf',
    {
      title: 'Search in PDF',
      annotations: { readOnlyHint: true },
      description: 'Search for text in the currently open PDF. Highlights all matches in the viewer and returns the total match count and 1-based page numbers where matches were found. The returned page numbers can be used directly in tools that accept a "page" parameter.',
      inputSchema: {
        query: z.string().describe('Text to search for'),
        caseSensitive: z.boolean().optional().describe('Case-sensitive search (default: false)'),
        wholeWord: z.boolean().optional().describe('Match whole words only (default: false)'),
      },
    },
    async ({ query, caseSensitive, wholeWord }) => {
      if (!query.trim()) {
        return { content: [{ type: 'text' as const, text: 'Search query must not be empty.' }], isError: true };
      }
      pendingSearchResult = null;
      pendingViewerCommand = {
        type: 'search_text',
        query,
        caseSensitive: caseSensitive ?? false,
        wholeWord: wholeWord ?? false,
      };
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 500));
        if (pendingSearchResult !== null) {
          const sr = pendingSearchResult as { count: number; pages: number[] };
          pendingSearchResult = null;
          if (sr.count === 0) {
            return { content: [{ type: 'text' as const, text: `No matches found for "${query}".` + docNote() }] };
          }
          const pageList = sr.pages.join(', ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${sr.count} match${sr.count === 1 ? '' : 'es'} for "${query}" on page${sr.pages.length === 1 ? '' : 's'} ${pageList}. All matches are highlighted in the viewer.`,
              },
            ],
          };
        }
      }
      pendingViewerCommand = null;
      return {
        content: [{ type: 'text' as const, text: 'Search timed out -- make sure a PDF is open in the viewer.' }],
        isError: true,
      };
    },
  );

  server.registerTool(
    'navigate_search_result',
    {
      title: 'Navigate Search Result',
      annotations: { readOnlyHint: true },
      description: 'Navigate to the next or previous search result in the currently open PDF viewer. Requires search_in_pdf to have been called first.',
      inputSchema: {
        direction: z.enum(['next', 'prev']).describe('Navigate to next or previous match'),
      },
    },
    async ({ direction }) => {
      pendingViewerCommand = { type: 'navigate_search', direction };
      return {
        content: [{ type: 'text' as const, text: `Navigating to ${direction} search result.` }],
      };
    },
  );

  server.registerTool(
    'rotate_pages',
    {
      title: 'Rotate Pages',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Rotate pages in the currently open PDF viewer. Use pages for specific 1-based page numbers (e.g. [1,3]), or omit to rotate all pages. Angle: 90, 180, or 270.',
      inputSchema: {
        angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).describe('Rotation angle in degrees (90, 180, or 270)'),
        pages: z.array(z.number().int().min(1)).optional().describe('1-based page numbers to rotate. Omit to rotate all pages.'),
      },
    },
    async ({ angle, pages }) => {
      pendingViewerCommand = { type: 'rotate_pages', angle, pages: pages ?? null };
      return {
        content: [{ type: 'text' as const, text: `Rotating ${pages ? `pages ${pages.join(',')}` : 'all pages'} by ${angle}Â°` }],
      };
    },
  );

  server.registerTool(
    'add_annotation',
    {
      title: 'Add Annotation',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Add a NEW shape annotation to the PDF. Use only for creating new annotations. To change color/opacity of an existing annotation, use update_annotation instead -- never delete and re-add just to change a property. Supported shapes: oval, rectangle, rhombus, line, arrow. Position and size are percentages of page dimensions (0--100).',
      inputSchema: {
        shape: z.enum(['oval', 'rectangle', 'rhombus', 'line', 'arrow']).describe('Shape type to draw'),
        page: z.number().int().min(1).describe('1-based page number to draw on'),
        x: z.number().min(0).max(99).describe('Left edge as % of page width (0=left, 100=right)'),
        y: z.number().min(0).max(99).describe('Top edge as % of page height (0=top, 100=bottom)'),
        width: z.number().min(1).max(100).describe('Width as % of page width'),
        height: z.number().min(1).max(100).describe('Height as % of page height'),
        color: z.string().optional().describe('Stroke color in hex, e.g. "#FF0000". Default: red'),
        fillColor: z.string().optional().describe('Fill color in hex, e.g. "#FFFF00". Optional.'),
        borderWidth: z.number().int().min(1).max(20).optional().describe('Stroke width in points. Default: 2'),
      },
    },
    async ({ shape, page, x, y, width, height, color, fillColor, borderWidth }) => {
      pendingViewerCommand = {
        type: 'add_annotation', shape, page, x, y, width, height,
        color: color ?? null, fillColor: fillColor ?? null, borderWidth: borderWidth ?? null,
      };
      return {
        content: [{ type: 'text' as const, text: `Adding ${shape} on page ${page} at (${x}%, ${y}%) size ${width}%Ã--${height}%` }],
      };
    },
  );

  server.registerTool(
    'circle_text',
    {
      title: 'Circle Text',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Find all occurrences of a word or phrase in the currently open PDF and draw a shape around each one. If the user has not specified shape or color -- ask them before calling: "Ð§ÐµÐ¼ Ð¾Ð±Ð²Ð¾Ð´Ð¸Ð¼ -- Ð¿Ñ€ÑÐ¼Ð¾ÑƒÐ³Ð¾Ð»ÑŒÐ½Ð¸ÐºÐ¾Ð¼ Ð¸Ð»Ð¸ Ð¾Ð²Ð°Ð»Ð¾Ð¼? ÐšÐ°ÐºÐ¾Ð¹ Ñ†Ð²ÐµÑ‚? ÐÐ° Ð²ÑÐµÑ... ÑÑ‚Ñ€Ð°Ð½Ð¸Ñ†Ð°Ñ... Ð¸Ð»Ð¸ Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð½Ð° Ð¾Ð´Ð½Ð¾Ð¹?" Available shapes: rectangle (default) or oval. Colors: any hex value, e.g. red=#FF0000, blue=#0000FF, green=#00AA00.',
      inputSchema: {
        text: z.string().min(1).describe('Text to search for and circle (case-insensitive)'),
        page: z.number().int().min(1).optional().describe('Limit to a specific 1-based page number. Omit to circle on all pages.'),
        shape: z.enum(['rectangle', 'oval']).optional().describe('Shape to draw: rectangle (default) or oval'),
        color: z.string().optional().describe('Stroke color in hex: "#FF0000"=red (default), "#0000FF"=blue, "#00AA00"=green, "#FF6600"=orange'),
        border_width: z.number().int().min(1).max(20).optional().describe('Border thickness in points: 1=thin, 2=normal (default), 3-5=thick'),
        padding: z.number().min(0).max(20).optional().describe('Extra space around the text in points. Default: 2'),
      },
    },
    async ({ text, page, shape, color, border_width, padding }) =>
      pollViewerResult<{ count: number; error?: string }>(
        { type: 'circle_text', text, page: page ?? null, shape: shape ?? 'rectangle', color: color ?? null, border_width: border_width ?? null, padding: padding ?? null },
        'circle_text',
        15_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          if (d.count === 0) return ok(`No occurrences of "${text}" found.`);
          const where = page ? ` on page ${page}` : '';
          return ok(`Circled ${d.count} occurrence(s) of "${text}"${where}.`);
        },
      ),
  );

  server.registerTool(
    'get_selection_info',
    {
      title: 'Get Selection Info',
      annotations: { readOnlyHint: true },
      description: 'Read information about the currently selected text in the PDF viewer: the selected text content and its font attributes (family, size, style, colors). Use this before format_selected_text to see what is selected.',
      inputSchema: {},
    },
    async () =>
      pollViewerResult<{ hasSelection: boolean; text?: string; fontAttributes?: Record<string, unknown>; error?: string }>(
        { type: 'get_selection_info' },
        'get_selection_info',
        5_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          if (!d.hasSelection) return ok('No text is currently selected in the viewer.');
          const font = d.fontAttributes as Record<string, unknown> | null;
          const styleNames: Record<number, string> = { 0: 'regular', 1: 'italic', 2: 'bold', 3: 'bold-italic' };
          const parts: string[] = [];
          if (font) {
            if (font['F']) parts.push(`font: ${font['F']}`);
            if (font['S']) parts.push(`size: ${font['S']}pt`);
            if (typeof font['s'] === 'number') parts.push(`style: ${styleNames[font['s'] as number] ?? font['s']}`);
            if (font['C']) parts.push(`color: ${font['C']}`);
            if (font['HL']) parts.push(`highlight: ${font['HL']}`);
            if (font['UL']) parts.push(`underline: ${font['UL']}`);
            if (font['SO']) parts.push(`strikeout: ${font['SO']}`);
          }
          const fontStr = parts.length ? ` [${parts.join(', ')}]` : '';
          return ok(`Selected: "${d.text}"${fontStr}`);
        },
      ),
  );

  server.registerTool(
    'format_selected_text',
    {
      title: 'Format Selected Text',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Apply font formatting to the currently selected text in the PDF viewer. The user must first select text manually in the viewer (by dragging the mouse over text while search is active). Call get_selection_info first to confirm what is selected.',
      inputSchema: {
        font_family: z.string().optional().describe('Font family name, e.g. "Helvetica", "Arial", "Times New Roman"'),
        font_size: z.number().min(1).max(500).optional().describe('Font size in points, e.g. 12'),
        font_style: z.enum(['regular', 'italic', 'bold', 'bold_italic']).optional().describe('Font style'),
        text_color: z.string().optional().describe('Text color in hex: "#FF0000"=red, "#000000"=black. Prefix #FF for full opacity.'),
        highlight_color: z.string().optional().describe('Highlight/background color in hex. Use "#00000000" to remove.'),
        underline_color: z.string().optional().describe('Underline color in hex. Use "#00000000" to remove.'),
        strikeout_color: z.string().optional().describe('Strikeout color in hex. Use "#00000000" to remove.'),
      },
    },
    async ({ font_family, font_size, font_style, text_color, highlight_color, underline_color, strikeout_color }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'format_selected_text', font_family, font_size, font_style, text_color, highlight_color, underline_color, strikeout_color },
        'format_selected_text',
        8_000,
        (d) => {
          if (!d.success) return nok(d.error ?? 'Failed to format selection');
          return ok('Selected text formatted successfully.');
        },
      ),
  );

  server.registerTool(
    'reset_selection',
    {
      title: 'Reset Selection',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Clear the current text selection in the PDF viewer (remove the blue highlight from selected text). Call this after get_selection_info or format_selected_text when the selection is no longer needed.',
      inputSchema: {},
    },
    async () =>
      pollViewerResult<{ success: boolean }>(
        { type: 'reset_selection' },
        'reset_selection',
        3_000,
        () => ok('Text selection cleared.'),
      ),
  );

  server.registerTool(
    'insert_blank_page',
    {
      title: 'Insert Blank Page',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Insert a blank page into the currently open PDF. Use after_page: 0 to insert before the first page (new page 1), after_page: N to insert after page N, or omit after_page to append at the end.',
      inputSchema: {
        after_page: z.number().int().min(0).optional()
          .describe('1-based page number to insert after. Use 0 to insert as the first page. Omit to append at the end.'),
      },
    },
    async ({ after_page }) => {
      pendingViewerCommand = { type: 'insert_blank_page', after_page: after_page ?? null };
      const where = after_page === 0 ? 'as first page'
        : after_page == null ? 'at the end'
        : `after page ${after_page}`;
      return {
        content: [{ type: 'text' as const, text: `Inserting blank page ${where}...` }],
      };
    },
  );

  server.registerTool(
    'add_image_to_page',
    {
      title: 'Add Image to Page',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Insert an image onto a specific page of the currently open PDF. Use image_svg for any generated/drawn image (SVG XML string -- preferred for Claude-generated graphics, no file needed). Use image_url to download from the internet, or image_path for a local file. Position (x, y) is the bottom-left corner as % of page dimensions (0--100); width is % of page width. Omit position/size to center at 50% page width.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number to add the image to'),
        image_svg: z.string().optional().describe('SVG XML string to render as an image. Preferred for Claude-generated graphics -- pass the full SVG markup directly, no file or base64 needed.'),
        image_url: z.string().optional().describe('URL of a remote image to download (PNG or JPEG)'),
        image_path: z.string().optional().describe('Absolute path to a local image file (PNG or JPEG)'),
        x: z.number().min(0).max(100).optional().describe('Left edge of image as % of page width (0=left edge). Omit to center horizontally.'),
        y: z.number().min(0).max(100).optional().describe('Bottom edge of image as % of page height (0=bottom). Omit to center vertically.'),
        width: z.number().min(1).max(100).optional().describe('Image width as % of page width. Omit to use 50% of page width maintaining aspect ratio.'),
      },
    },
    async ({ page, image_svg, image_path, image_url, x, y, width }) => {
      if (!image_svg && !image_path && !image_url) {
        return { content: [{ type: 'text' as const, text: 'Provide image_svg, image_url, or image_path.' }], isError: true };
      }
      let bytes: Buffer;
      let ext: string;
      if (image_svg) {
        bytes = Buffer.from(image_svg, 'utf-8');
        ext = '.svg';
      } else if (image_url) {
        try {
          const r = await fetch(image_url, { signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
          bytes = Buffer.from(await r.arrayBuffer());
          ext = path.extname(new URL(image_url).pathname) || '.png';
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to download image: ${(err as Error).message}` }], isError: true };
        }
      } else {
        try {
          bytes = await fs.readFile(image_path!);
          ext = path.extname(image_path!) || '.png';
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Failed to read image: ${(err as Error).message}` }], isError: true };
        }
      }
      const tmpPath = path.join(os.tmpdir(), `pwv-img-${randomUUID()}${ext}`);
      await fs.writeFile(tmpPath, bytes);
      const token = mintToken(tmpPath, `image${ext}`, true);
      pendingViewerCommand = { type: 'add_image_to_page', page, token, x: x ?? null, y: y ?? null, width: width ?? null };
      return {
        content: [{ type: 'text' as const, text: `Adding image to page ${page}...` }],
      };
    },
  );

  server.registerTool(
    'close_document',
    {
      title: 'Close Document',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Close the currently open document in the PDF viewer.',
    },
    async () => {
      pendingViewerCommand = { type: 'close_document' };
      return { content: [{ type: 'text' as const, text: 'Closing document.' }] };
    },
  );

  server.registerTool(
    'get_view_state',
    {
      title: 'Get View State',
      annotations: { readOnlyHint: true },
      description: 'Return current viewing state. Returns: page (1-based current page number), pageCount (total pages), document title, and file path. IMPORTANT: the returned "page" is a 1-based page number -- use it directly in other tools that accept a "page" parameter.',
    },
    async () =>
      pollViewerResult<{ page: number; pageCount: number; title: string; filePath: string }>(
        { type: 'get_view_state' },
        'view_state',
        10_000,
        (d) => ok(`Page ${d.page} of ${d.pageCount}. Title: "${d.title}". File: ${d.filePath || '(unknown)'}`),
      ),
  );

  server.registerTool(
    'set_view_state',
    {
      title: 'Set View State',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Navigate to a specific page in the currently open PDF document.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number to navigate to'),
      },
    },
    async ({ page }) => {
      pendingViewerCommand = { type: 'set_view_state', page };
      return { content: [{ type: 'text' as const, text: `Navigating to page ${page}.` + docNote() }] };
    },
  );

  server.registerTool(
    'read_document_information',
    {
      title: 'Read Document Information',
      annotations: { readOnlyHint: true },
      description: 'Read metadata of the currently open PDF: page count, title, author, creator, producer, creation and modification dates, file size in bytes, and status flags (isSigned, isModified, isReadOnly).',
    },
    async () =>
      pollViewerResult<Record<string, unknown>>(
        { type: 'read_document_info' },
        'document_info',
        10_000,
        (d) => {
          const lines = Object.entries(d)
            .filter(([, v]) => v !== '' && v !== null && v !== undefined)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
          return ok(lines || 'No metadata available.');
        },
      ),
  );

  server.registerTool(
    'read_page_info',
    {
      title: 'Read Page Info',
      annotations: { readOnlyHint: true },
      description: 'Read width, height (in PDF points), and rotation for a specific page in the currently open document.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number'),
      },
    },
    async ({ page }) =>
      pollViewerResult<{ page: number; width: number; height: number; rotation: number; error?: string }>(
        { type: 'read_page_info', page },
        'page_info',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Page ${d.page}: ${d.width} × ${d.height} pt, rotation ${d.rotation}°`);
        },
      ),
  );

  server.registerTool(
    'delete_annotation',
    {
      title: 'Delete Annotation',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Delete an annotation from the currently open PDF by page and annotation index. Use read_annotations to list annotations and their indices first.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number containing the annotation'),
        annotIndex: z.number().int().min(0).describe('0-based annotation index on that page'),
      },
    },
    async ({ page, annotIndex }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_annotation', page, annotIndex },
        'delete_annotation',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Annotation ${annotIndex} on page ${page} deleted.`);
        },
      ),
  );

  server.registerTool(
    'update_annotation',
    {
      title: 'Update Annotation',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Modify properties of an existing annotation IN PLACE (stroke color, fill color, opacity, or text content for FreeText annotations). This changes the annotation directly -- do NOT delete and re-add. Use read_annotations first to get the annotIndex.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number containing the annotation'),
        annotIndex: z.number().int().min(0).describe('0-based annotation index from read_annotations'),
        color: z.string().optional().describe('Stroke color in hex, e.g. "#FF0000"'),
        fillColor: z.string().optional().describe('Fill/interior color in hex, e.g. "#FFFF00"'),
        opacity: z.number().min(0).max(1).optional().describe('Opacity from 0 (transparent) to 1 (opaque)'),
        text: z.string().optional().describe('Text content (only for FreeText annotations)'),
      },
    },
    async ({ page, annotIndex, color, fillColor, opacity, text }) => {
      if (!color && !fillColor && opacity === undefined && text === undefined) {
        return nok('Provide at least one property to change: color, fillColor, opacity, or text.');
      }
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'update_annotation', page, annotIndex, color: color ?? null, fillColor: fillColor ?? null, opacity: opacity ?? null, text: text ?? null },
        'update_annotation',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Annotation ${annotIndex} on page ${page} updated.`);
        },
      );
    },
  );

  server.registerTool(
    'read_annotations',
    {
      title: 'Read Annotations',
      annotations: { readOnlyHint: true },
      description: 'List all annotations on a page (or the whole document). Returns index, type, position, color and comment for each annotation. Use the returned index with delete_annotation.',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('1-based page number. Omit to read all pages.'),
      },
    },
    async ({ page }) =>
      pollViewerResult<{ annotations?: any[]; error?: string }>(
        { type: 'read_annotations', page: page ?? null },
        'read_annotations',
        20_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const list = d.annotations ?? [];
          if (list.length === 0) return ok('No annotations found.');
          const lines = list.map((a) =>
            `Page ${a.page}, index ${a.index}: ${a.type}` +
            (a.color ? `, color ${a.color}` : '') +
            (a.content ? `, comment: "${a.content}"` : '') +
            (a.rect ? `, rect [${a.rect.left?.toFixed(1)}, ${a.rect.top?.toFixed(1)}, ${a.rect.right?.toFixed(1)}, ${a.rect.bottom?.toFixed(1)}]` : '')
          );
          return ok(lines.join('\n'));
        },
      ),
  );

  server.registerTool(
    'get_page_image',
    {
      title: 'Get Page Image',
      annotations: { readOnlyHint: true },
      description: 'Render a page of the currently open PDF as a PNG image. Returns the image so it can be visually inspected.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number to render'),
        zoom: z.number().min(0.1).max(2).optional().describe('Zoom factor (default: 0.5). Use 1.0 for higher resolution.'),
      },
    },
    async ({ page, zoom }) => {
      pendingViewerResult = null;
      pendingViewerCommand = { type: 'get_page_image', page, zoom: zoom ?? 0.5 };
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 300));
        if (pendingViewerResult !== null) {
          const pr = pendingViewerResult as { type: string; data: unknown };
          if (pr.type !== 'get_page_image') continue;
          const d = pr.data as { base64?: string; error?: string };
          pendingViewerResult = null;
          if (d.error) return { content: [{ type: 'text' as const, text: `Error: ${d.error}` }], isError: true };
          return {
            content: [{
              type: 'image' as const,
              data: d.base64 ?? '',
              mimeType: 'image/png',
            }],
          };
        }
      }
      pendingViewerCommand = null;
      return { content: [{ type: 'text' as const, text: 'Timed out -- make sure a PDF is open in the viewer.' }], isError: true };
    },
  );

  server.registerTool(
    'read_text',
    {
      title: 'Read Text',
      annotations: { readOnlyHint: true },
      description: 'Extract all text content from the currently open PDF document as a plain string.',
    },
    async () =>
      pollViewerResult<{ text?: string; error?: string }>(
        { type: 'read_text' },
        'read_text',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(d.text ?? '');
        },
      ),
  );

  server.registerTool(
    'replace_text',
    {
      title: 'Replace Text',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Find and replace text in the content of the currently open PDF. Searches all text blocks across the specified page (or all pages) and replaces occurrences. Works on native PDF text content, not annotations. Use update_annotation with a text parameter for FreeText annotation text.',
      inputSchema: {
        searchText: z.string().describe('Text to find'),
        replaceWith: z.string().describe('Replacement text'),
        page: z.number().int().min(1).optional().describe('Limit to this 1-based page number. Omit to search all pages.'),
        replaceAll: z.boolean().optional().describe('Replace all occurrences (default: false -- replace only first match)'),
        caseSensitive: z.boolean().optional().describe('Case-sensitive match (default: true)'),
      },
    },
    async ({ searchText, replaceWith, page, replaceAll, caseSensitive }) => {
      if (!searchText) {
        return nok('searchText must not be empty.');
      }
      return pollViewerResult<{ count?: number; error?: string }>(
        { type: 'replace_text', searchText, replaceWith, page: page ?? null, replaceAll: replaceAll ?? false, caseSensitive: caseSensitive ?? true },
        'replace_text',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const n = d.count ?? 0;
          if (n === 0) return ok(`No occurrences of "${searchText}" found.`);
          return ok(`Replaced ${n} occurrence${n === 1 ? '' : 's'} of "${searchText}" with "${replaceWith}".`);
        },
      );
    },
  );

  server.registerTool(
    'read_bookmarks',
    {
      title: 'Read Bookmarks',
      annotations: { readOnlyHint: true },
      description: 'Return all bookmarks (table of contents) from the currently open PDF as a flat list with title, page number and nesting path.',
    },
    async () =>
      pollViewerResult<{ bookmarks?: { path: number[]; title: string; page: number }[]; error?: string }>(
        { type: 'read_bookmarks' },
        'read_bookmarks',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const list = d.bookmarks ?? [];
          if (list.length === 0) return ok('No bookmarks in this document.');
          const lines = list.map((b) => `${'  '.repeat(b.path.length - 1)}[${b.path.join(',')}] "${b.title}" -> page ${b.page}`);
          return ok(lines.join('\n'));
        },
      ),
  );

  server.registerTool(
    'add_bookmark',
    {
      title: 'Add Bookmark',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Add a bookmark (outline entry) to the currently open PDF pointing to a specific page.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number the bookmark should point to'),
        title: z.string().optional().describe('Bookmark label. Defaults to "Page N" if omitted.'),
        parentPath: z.array(z.number().int().min(0)).optional().describe('Path of 0-based indices to the parent bookmark for nesting, e.g. [0] to nest under the first bookmark. Omit for a top-level bookmark.'),
      },
    },
    async ({ page, title, parentPath }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'add_bookmark', page, title: title ?? null, parentPath: parentPath ?? [] },
        'add_bookmark',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Bookmark "${title ?? `Page ${page}`}" added pointing to page ${page}.`);
        },
      ),
  );

  server.registerTool(
    'delete_bookmark',
    {
      title: 'Delete Bookmark',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Delete a bookmark by its tree path. Use read_document_information to see the bookmarks tree first. Path is an array of 0-based indices, e.g. [0] for the first bookmark, [0,1] for the second child of the first bookmark.',
      inputSchema: {
        path: z.array(z.number().int().min(0)).min(1).describe('0-based path to the bookmark, e.g. [0] or [1,2]'),
      },
    },
    async ({ path }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_bookmark', path },
        'delete_bookmark',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Bookmark at path [${path.join(',')}] deleted.`);
        },
      ),
  );

  server.registerTool(
    'delete_all_bookmarks',
    {
      title: 'Delete All Bookmarks',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Remove all bookmarks (outline/table of contents) from the currently open PDF.',
    },
    async () =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_all_bookmarks' },
        'delete_all_bookmarks',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('All bookmarks deleted.');
        },
      ),
  );

  server.registerTool(
    'extract_images',
    {
      title: 'Extract Images',
      annotations: { destructiveHint: true },
      description: 'Extract all raster images embedded in the currently open PDF and save them as a ZIP archive. Returns the path to the saved ZIP file.',
      inputSchema: {
        outputPath: z.string().optional().describe('Where to save the ZIP file. Default: Downloads/extracted_images.zip'),
        pages: z.array(z.number().int().min(1)).optional().describe('1-based page numbers to extract from. Omit to extract from all pages.'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
      },
    },
    async ({ outputPath, pages, format }) => {
      const defaultDir = path.join(os.homedir(), 'Downloads');
      const savePath = outputPath?.trim() || path.join(defaultDir, 'extracted_images.zip');
      return pollViewerResult<{ success: boolean; path?: string; count?: number; error?: string }>(
        { type: 'extract_images', outputPath: savePath, pages: pages ?? null, format: format ?? 'png' },
        'extract_images',
        60_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Extracted ${d.count ?? 0} image(s) -> ${d.path}`);
        },
      );
    },
  );

  server.registerTool(
    'export_comments',
    {
      title: 'Export Comments',
      annotations: { destructiveHint: true },
      description: 'Export all comments and annotations from the currently open PDF as an FDF file.',
      inputSchema: {
        outputPath: z.string().optional().describe('Where to save the .fdf file. Default: Downloads/comments.fdf'),
      },
    },
    async ({ outputPath }) => {
      const defaultDir = path.join(os.homedir(), 'Downloads');
      const savePath = outputPath?.trim() || path.join(defaultDir, 'comments.fdf');
      return pollViewerResult<{ success: boolean; path?: string; error?: string }>(
        { type: 'export_comments', outputPath: savePath },
        'export_comments',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Comments exported -> ${d.path}`);
        },
      );
    },
  );

  server.registerTool(
    'resize_pages',
    {
      title: 'Resize Pages',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Change the page dimensions (canvas size) of one or more pages in the currently open PDF. Use a named preset (A4, A3, A5, Letter, Legal, Tabloid) or specify custom width/height in PDF points (1 pt = 1/72 inch). Does not scale content -- just changes the media box.',
      inputSchema: {
        preset: z.enum(['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid']).optional()
          .describe('Named page size preset. Ignored if width/height are provided.'),
        width: z.number().min(1).optional().describe('Page width in PDF points (72 pt = 1 inch). A4 = 595, Letter = 612.'),
        height: z.number().min(1).optional().describe('Page height in PDF points. A4 = 842, Letter = 792.'),
        pages: z.array(z.number().int().min(1)).optional().describe('1-based page numbers to resize. Omit to resize all pages.'),
      },
    },
    async ({ preset, width, height, pages }) => {
      const PRESETS: Record<string, [number, number]> = {
        A3: [842, 1191], A4: [595, 842], A5: [420, 595],
        Letter: [612, 792], Legal: [612, 1008], Tabloid: [792, 1224],
      };
      let w = width;
      let h = height;
      if ((!w || !h) && preset) {
        [w, h] = PRESETS[preset];
      }
      if (!w || !h) {
        return nok('Provide either a preset (A4, Letter, ...) or both width and height in PDF points.');
      }
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'resize_pages', width: w, height: h, pages: pages ?? null },
        'resize_pages',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const label = preset ?? `${w}×${h} pt`;
          const who = pages ? `page${pages.length === 1 ? '' : 's'} ${pages.join(',')}` : 'all pages';
          return ok(`Resized ${who} to ${label}.`);
        },
      );
    },
  );

  server.registerTool(
    'delete_pages',
    {
      title: 'Delete Pages',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Delete one or more pages from the currently open PDF. Provide 1-based page numbers.',
      inputSchema: {
        pages: z.array(z.number().int().min(1)).min(1).describe('1-based page numbers to delete'),
      },
    },
    async ({ pages }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_pages', pages },
        'delete_pages',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Deleted page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}.`);
        },
      ),
  );

  server.registerTool(
    'move_pages',
    {
      title: 'Move Pages',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Move pages to a different position in the currently open PDF. Use afterPage: 0 to move pages to the beginning.',
      inputSchema: {
        pages: z.array(z.number().int().min(1)).min(1).describe('1-based page numbers to move'),
        afterPage: z.number().int().min(0).describe('Insert after this 1-based page number. Use 0 to move to the beginning.'),
      },
    },
    async ({ pages, afterPage }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'move_pages', pages, afterPage },
        'move_pages',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const where = afterPage === 0 ? 'the beginning' : `page ${afterPage}`;
          return ok(`Moved page${pages.length === 1 ? '' : 's'} ${pages.join(', ')} to after ${where}.`);
        },
      ),
  );

  server.registerTool(
    'duplicate_pages',
    {
      title: 'Duplicate Pages',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Duplicate pages and insert the copies at a specified position in the currently open PDF.',
      inputSchema: {
        pages: z.array(z.number().int().min(1)).min(1).describe('1-based page numbers to duplicate'),
        afterPage: z.number().int().min(0).optional().describe('Insert copies after this 1-based page number. Use 0 to insert at the beginning. Omit to append at the end.'),
      },
    },
    async ({ pages, afterPage }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'duplicate_pages', pages, afterPage: afterPage ?? null },
        'duplicate_pages',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Duplicated page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}.`);
        },
      ),
  );

  server.registerTool(
    'reverse_pages',
    {
      title: 'Reverse Pages',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Reverse the page order of the currently open PDF. Omit pages to reverse the entire document.',
      inputSchema: {
        pages: z.array(z.number().int().min(1)).optional().describe('1-based page numbers to reverse among themselves. Omit to reverse all pages.'),
      },
    },
    async ({ pages }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'reverse_pages', pages: pages ?? null },
        'reverse_pages',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Page order reversed${pages ? ` for pages ${pages.join(', ')}` : ''}.`);
        },
      ),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Undo the last action in the currently open PDF document.',
    },
    async () =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'undo' },
        'undo',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Undo successful.');
        },
      ),
  );

  server.registerTool(
    'redo',
    {
      title: 'Redo',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Redo the last undone action in the currently open PDF document.',
    },
    async () =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'redo' },
        'redo',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Redo successful.');
        },
      ),
  );

  server.registerTool(
    'update_document_properties',
    {
      title: 'Update Document Properties',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Change metadata properties (title, author, subject, keywords) of the currently open PDF. Only the fields you provide will be updated.',
      inputSchema: {
        title: z.string().optional().describe('Document title'),
        author: z.string().optional().describe('Document author'),
        subject: z.string().optional().describe('Document subject'),
        keywords: z.string().optional().describe('Document keywords (comma-separated)'),
      },
    },
    async ({ title, author, subject, keywords }) => {
      if (title === undefined && author === undefined && subject === undefined && keywords === undefined) {
        return nok('Provide at least one property to update: title, author, subject, or keywords.');
      }
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'update_document_properties', title: title ?? null, author: author ?? null, subject: subject ?? null, keywords: keywords ?? null },
        'update_document_properties',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const changed = [
            title !== undefined ? `title="${title}"` : null,
            author !== undefined ? `author="${author}"` : null,
            subject !== undefined ? `subject="${subject}"` : null,
            keywords !== undefined ? `keywords="${keywords}"` : null,
          ].filter(Boolean).join(', ');
          return ok(`Document properties updated: ${changed}.`);
        },
      );
    },
  );

  server.registerTool(
    'read_form_fields',
    {
      title: 'Read Form Fields',
      annotations: { readOnlyHint: true },
      description: 'List all fillable form fields (AcroForm) in the currently open PDF with their names, types, current values, and available options.',
      inputSchema: {},
    },
    async () =>
      pollViewerResult<{ success: boolean; fields?: unknown[]; error?: string }>(
        { type: 'read_form_fields' },
        'read_form_fields',
        10_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          const fields = d.fields ?? [];
          if (fields.length === 0) return ok('No form fields found in this document.');
          return ok(JSON.stringify(fields, null, 2));
        },
      ),
  );

  server.registerTool(
    'update_form_field',
    {
      title: 'Update Form Field',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Set the value of a fillable form field in the currently open PDF. Use read_form_fields first to get the exact field_name. For checkboxes use "Yes"/"Off", for radio buttons use the button\'s on-value, for dropdowns use one of the available options.',
      inputSchema: {
        field_name: z.string().describe('Exact field name from read_form_fields'),
        value: z.string().describe('New value to set'),
      },
    },
    async ({ field_name, value }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'update_form_field', field_name, value },
        'update_form_field',
        10_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          return ok(`Field "${field_name}" updated to "${value}".`);
        },
      ),
  );

  server.registerTool(
    'read_page_text_blocks',
    {
      title: 'Read Page Text Blocks',
      annotations: { readOnlyHint: true },
      description: 'List all text blocks on a page with their 0-based block index and full text content. Use this before format_text or delete_text_blocks to discover block indices. Page parameter is 1-based.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number'),
      },
    },
    async ({ page }) =>
      pollViewerResult<{ success: boolean; blocks?: unknown[]; error?: string }>(
        { type: 'read_page_text_blocks', page },
        'read_page_text_blocks',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          const blocks = d.blocks ?? [];
          if (blocks.length === 0) return ok('No text blocks found on this page.');
          return ok(JSON.stringify(blocks, null, 2));
        },
      ),
  );

  server.registerTool(
    'format_text',
    {
      title: 'Format Text',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Apply font formatting to a text fragment in the currently open PDF. Finds the text on the page and applies the specified formatting. Use read_page_text_blocks first if the text is not found (PDF text may have unexpected spacing).',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number'),
        text: z.string().describe('Exact text fragment to find and format'),
        occurrence: z.number().int().min(1).optional().describe('Which occurrence to format (default: 1). Ignored when all_occurrences is true.'),
        all_occurrences: z.boolean().optional().describe('Format ALL occurrences of the text on the page at once (default: false)'),
        font_size: z.number().positive().optional().describe('Font size in points (e.g. 14)'),
        font_family: z.string().optional().describe('Font family name (e.g. "Arial", "Times New Roman")'),
        font_style: z.enum(['regular', 'bold', 'italic', 'bold_italic']).optional().describe('Font style'),
        underline: z.boolean().optional().describe('true to add black underline, false to remove underline'),
        underline_color: z.string().optional().describe('Underline color as hex (e.g. "#0000FF" for blue). Sets underline independently from text color. Use "#00000000" to remove.'),
        strikeout: z.boolean().optional().describe('true to add black strikethrough, false to remove'),
        strikeout_color: z.string().optional().describe('Strikethrough color as hex (e.g. "#FF0000" for red). Use "#00000000" to remove.'),
        text_color: z.string().optional().describe('Text color as hex string, e.g. "#FF0000" for red'),
        highlight_color: z.string().optional().describe('Highlight background color as hex, e.g. "#FFFF00" for yellow. Use "#00000000" to remove.'),
      },
    },
    async ({ page, text, occurrence, all_occurrences, font_size, font_family, font_style, underline, underline_color, strikeout, strikeout_color, text_color, highlight_color }) => {
      if (font_size === undefined && font_family === undefined && font_style === undefined &&
          underline === undefined && underline_color === undefined && strikeout === undefined && strikeout_color === undefined &&
          text_color === undefined && highlight_color === undefined) {
        return nok('Provide at least one formatting option.');
      }
      return pollViewerResult<{ success: boolean; applied?: number; error?: string }>(
        { type: 'format_text', page, text, occurrence: occurrence ?? 1, all_occurrences, font_size, font_family, font_style, underline, underline_color, strikeout, strikeout_color, text_color, highlight_color },
        'format_text',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          const applied: string[] = [];
          if (font_size !== undefined) applied.push(`size=${font_size}pt`);
          if (font_family !== undefined) applied.push(`family="${font_family}"`);
          if (font_style !== undefined) applied.push(`style=${font_style}`);
          if (underline !== undefined) applied.push(`underline=${underline}`);
          if (strikeout !== undefined) applied.push(`strikeout=${strikeout}`);
          if (text_color !== undefined) applied.push(`color=${text_color}`);
          if (highlight_color !== undefined) applied.push(`highlight=${highlight_color}`);
          const count = d.applied ?? 1;
          return ok(`Formatted ${count} occurrence${count > 1 ? 's' : ''} of "${text}" on page ${page}: ${applied.join(', ')}.`);
        },
      );
    },
  );

  server.registerTool(
    'add_text_to_page',
    {
      title: 'Add Text to Page',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Add a plain text label to a page in the currently open PDF. Position and size are percentages of page dimensions. Use this to add labels, headers, or descriptions before adding form fields below them.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number'),
        text: z.string().describe('Text content to display'),
        x: z.number().min(0).max(100).describe('Left position as % of page width'),
        y: z.number().min(0).max(100).describe('Top position as % of page height'),
        width: z.number().min(0).max(100).describe('Width as % of page width'),
        height: z.number().min(0).max(100).describe('Height as % of page height'),
        font_size: z.number().positive().optional().describe('Font size in points (default 11)'),
      },
    },
    async ({ page, text, x, y, width, height, font_size }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'add_text_to_page', page, text, x, y, width, height, font_size },
        'add_text_to_page',
        10_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          return ok(`Text added to page ${page}.`);
        },
      ),
  );

  server.registerTool(
    'add_form_field',
    {
      title: 'Add Form Field',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Add a fillable form field (AcroForm widget) to a page in the currently open PDF. Position and size are percentages of page dimensions (0--100). Use x=0, width=100 to span the full page width.',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number'),
        field_type: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'listbox', 'button']).describe('Field type'),
        x: z.number().min(0).max(100).describe('Left position as % of page width'),
        y: z.number().min(0).max(100).describe('Top position as % of page height'),
        width: z.number().min(0).max(100).describe('Width as % of page width (use 100 for full-width)'),
        height: z.number().min(0).max(100).describe('Height as % of page height'),
        label: z.string().optional().describe('Caption / label text shown on the field'),
        default_value: z.string().optional().describe('Initial field value'),
        options: z.array(z.string()).optional().describe('Choice options for dropdown/listbox fields'),
        bg_color: z.string().optional().describe('Background color hex e.g. #FFFFFF'),
        border_color: z.string().optional().describe('Border color hex e.g. #000000'),
      },
    },
    async ({ page, field_type, x, y, width, height, label, default_value, options, bg_color, border_color }) =>
      pollViewerResult<{ success: boolean; field_name?: string | null; error?: string }>(
        { type: 'add_form_field', page, field_type, x, y, width, height, label: label ?? null, default_value: default_value ?? null, options: options ?? null, bg_color: bg_color ?? null, border_color: border_color ?? null },
        'add_form_field',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          return ok(`Form field added to page ${page}${d.field_name ? ` (field name: "${d.field_name}")` : ''}.`);
        },
      ),
  );

  server.registerTool(
    'apply_redactions',
    {
      title: 'Apply Redactions',
      annotations: { destructiveHint: true },
      description: 'Permanently burn all existing redaction annotations (already marked areas) into the page content of the currently open PDF. To redact by text content, use search_and_redact instead. This action cannot be undone.',
    },
    async () =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'apply_redactions' },
        'apply_redactions',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Redactions applied permanently.');
        },
      ),
  );

  server.registerTool(
    'delete_bates_numbering',
    {
      title: 'Delete Bates Numbering',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Remove all Bates numbering from the currently open PDF.',
    },
    async () =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_bates_numbering' },
        'delete_bates_numbering',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Bates numbering removed.');
        },
      ),
  );

  server.registerTool(
    'delete_watermark',
    {
      title: 'Delete Watermark',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Remove watermarks from the specified page range of the currently open PDF.',
      inputSchema: {
        range: z.array(z.string()).describe('Page range strings, e.g. ["all"] or ["1-3","5"].'),
      },
    },
    async ({ range }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_watermark', range },
        'delete_watermark',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Watermark removed.');
        },
      ),
  );

  server.registerTool(
    'delete_header',
    {
      title: 'Delete Header/Footer',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Remove headers and footers from the specified page range of the currently open PDF.',
      inputSchema: {
        range: z.array(z.string()).describe('Page range strings, e.g. ["all"] or ["1-3","5"].'),
      },
    },
    async ({ range }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_header', range },
        'delete_header',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Headers/footers removed.');
        },
      ),
  );

  server.registerTool(
    'delete_page_number',
    {
      title: 'Delete Page Numbers',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Remove page numbers from the currently open PDF. Omit both range and pages to remove from all pages.',
      inputSchema: {
        range: z.array(z.string()).optional().describe('Page range strings, e.g. ["all"] or ["1-3","5"]. Omit to target all pages.'),
        pages: z.array(z.number().int().min(1)).optional().describe('Specific 1-based page numbers to target. Omit to use range.'),
      },
    },
    async ({ range, pages }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_page_number', range: range ?? null, pages: pages ?? null },
        'delete_page_number',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Page numbers removed.');
        },
      ),
  );

  server.registerTool(
    'delete_text_blocks',
    {
      title: 'Delete Text Blocks',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Delete one or more editable text blocks from a page in the currently open PDF. Use read_page_text_blocks first to get 0-based block indices. Page is 1-based (same as all other tools).',
      inputSchema: {
        page: z.number().int().min(1).describe('1-based page number (same as all other tools).'),
        block_indices: z.array(z.number().int().min(0)).min(1).describe('0-based block indices to delete -- use read_page_text_blocks to get them.'),
      },
    },
    async ({ page, block_indices }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_text_blocks', pageIndex: page - 1, blockIndices: block_indices },
        'delete_text_blocks',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Deleted ${block_indices.length} text block(s) from page ${page}.`);
        },
      ),
  );

  server.registerTool(
    'convert_to_images',
    {
      title: 'Convert PDF to Images',
      annotations: { destructiveHint: true },
      description: 'Convert all pages of the currently open PDF to PNG images and save them as a ZIP archive.',
      inputSchema: {
        dpi: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional()
          .describe('Resolution scale: 1 = 96 DPI (default), 2 = 192 DPI, 3 = 288 DPI.'),
        output_path: z.string().optional()
          .describe('Absolute path for the output ZIP file. Defaults to Downloads/document_images.zip.'),
      },
    },
    async ({ dpi, output_path }) => {
      const defaultDir = path.join(os.homedir(), 'Downloads');
      const savePath = output_path?.trim() || path.join(defaultDir, 'document_images.zip');
      return pollViewerResult<{ success: boolean; path?: string; error?: string }>(
        { type: 'convert_to_images', dpi: dpi ?? null, outputPath: savePath },
        'convert_to_images',
        60_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Images saved to: ${d.path}`);
        },
      );
    },
  );

  server.registerTool(
    'extract_pages',
    {
      title: 'Extract Pages',
      annotations: { destructiveHint: true },
      description: 'Extract specific pages from the currently open PDF and save them as a new PDF file.',
      inputSchema: {
        range: z.array(z.string()).min(1).describe('1-based page ranges to extract, e.g. ["1-3","5","7-9"].'),
        output_path: z.string().optional()
          .describe('Absolute output path for the extracted PDF. Defaults to Downloads/extracted_pages.pdf.'),
        file_name: z.string().optional()
          .describe('Filename override for the extracted PDF (without directory). Ignored when output_path is set.'),
      },
    },
    async ({ range, output_path, file_name }) => {
      const defaultDir = path.join(os.homedir(), 'Downloads');
      const savePath = output_path?.trim() || path.join(defaultDir, file_name?.trim() || 'extracted_pages.pdf');
      return pollViewerResult<{ success: boolean; path?: string; error?: string }>(
        { type: 'extract_pages', Range: range, outputPath: savePath },
        'extract_pages',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Pages extracted to: ${d.path}`);
        },
      );
    },
  );

  server.registerTool(
    'save_as',
    {
      title: 'Save As',
      annotations: { destructiveHint: true },
      description:
        'Save the currently open PDF to a new file path without closing it. ' +
        'Use this when the user wants to save a copy under a different name or location. ' +
        'Provide either output_path (full absolute path) or file_name (just the filename — saved next to the original).',
      inputSchema: {
        output_path: z.string().optional()
          .describe('Full absolute path for the new file, e.g. C:\\Users\\me\\Desktop\\report_v2.pdf'),
        file_name: z.string().optional()
          .describe('Filename only (e.g. "Test_test.pdf") — the file is saved in the same folder as the original. Ignored when output_path is set.'),
      },
    },
    async ({ output_path, file_name }) => {
      return pollViewerResult<{ success: boolean; path?: string; error?: string }>(
        { type: 'save_as', outputPath: output_path?.trim() || null, fileName: file_name?.trim() || null },
        'save_as',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Saved as: ${d.path}`);
        },
      );
    },
  );

  server.registerTool(
    'set_security_permissions',
    {
      title: 'Set Security Permissions',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Set password protection and access permissions on the currently open PDF. ' +
        'Passwords: user_password = required to open the document; owner_password = required to change permissions. ' +
        'Permissions (all default to true/allowed): allow_printing, allow_copying, allow_editing, allow_annotations, allow_forms. ' +
        'Encryption: RC4-40, RC4-128, AES-128, AES-256 (default AES-256). ' +
        'Examples: ' +
        '"make PDF read-only" -> allow_editing=false, allow_annotations=false, allow_forms=false; ' +
        '"password protect" -> user_password="secret"; ' +
        '"restrict all except viewing" -> allow_printing=false, allow_copying=false, allow_editing=false, allow_annotations=false, allow_forms=false; ' +
        '"owner password only" -> owner_password="admin", allow_editing=false.',
      inputSchema: {
        user_password: z.string().optional()
          .describe('Password required to open the document. Omit or pass empty string to remove.'),
        owner_password: z.string().optional()
          .describe('Owner (permissions) password. Required to restrict what others can do with the document.'),
        encryption: z.enum(['RC4-40', 'RC4-128', 'AES-128', 'AES-256']).optional()
          .describe('Encryption algorithm. RC4-40 and RC4-128 are legacy; prefer AES-128 or AES-256 (default).'),
        allow_printing: z.boolean().optional()
          .describe('Allow printing the document (default: true). Set false to disable printing entirely.'),
        allow_copying: z.boolean().optional()
          .describe('Allow copying text and images (default: true). Set false to prevent copy-paste.'),
        allow_editing: z.boolean().optional()
          .describe('Allow editing page content (default: true). Set false to make content read-only.'),
        allow_annotations: z.boolean().optional()
          .describe('Allow adding or editing annotations and comments (default: true).'),
        allow_forms: z.boolean().optional()
          .describe('Allow filling form fields (default: true). Set false to lock all form fields.'),
        perm_flags: z.number().int().optional()
          .describe('Advanced: raw PDF permission-flags bitmask (overrides all allow_* options). Bits: 0x04=print, 0x08=edit, 0x10=copy, 0x20=annotations, 0x100=forms, 0x800=high-res print.'),
      },
    },
    async ({ user_password, owner_password, encryption, allow_printing, allow_copying, allow_editing, allow_annotations, allow_forms, perm_flags }) => {
      const cryptMethodMap: Record<string, number> = { 'RC4-40': 0, 'RC4-128': 1, 'AES-128': 2, 'AES-256': 3 };
      const cryptMethod = cryptMethodMap[encryption ?? 'AES-256'] ?? 3;

      let permFlagsValue: number;
      if (perm_flags !== undefined) {
        permFlagsValue = perm_flags;
      } else {
        let flags = 0xfffff0c0;
        flags &= ~(0x04 | 0x800);
        flags &= ~0x08;
        flags &= ~(0x10 | 0x200);
        flags &= ~0x20;
        flags &= ~0x100;
        if (allow_printing   !== false) flags |= 0x04 | 0x800;
        if (allow_editing    !== false) flags |= 0x08;
        if (allow_copying    !== false) flags |= 0x10 | 0x200;
        if (allow_annotations !== false) flags |= 0x20;
        if (allow_forms      !== false) flags |= 0x100;
        permFlagsValue = flags;
      }

      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'set_security_permissions', userPassword: user_password ?? '', ownerPassword: owner_password ?? '', cryptMethod, permFlags: permFlagsValue },
        'set_security_permissions',
        15_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Security permissions updated. Save the document to apply changes.');
        },
      );
    },
  );

  server.registerTool(
    'search_and_redact',
    {
      title: 'Search and Redact',
      annotations: { destructiveHint: true },
      description: 'Find all occurrences of the specified text in the currently open PDF, mark them as redaction annotations, and permanently apply the redactions. Use this to remove sensitive information by its text content.',
      inputSchema: {
        text: z.string().describe('Text to search for and redact.'),
        case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false).'),
        whole_word: z.boolean().optional().describe('Match whole words only (default: false).'),
      },
    },
    async ({ text, case_sensitive, whole_word }) =>
      pollViewerResult<{ success: boolean; count?: number; error?: string }>(
        { type: 'search_and_redact', text, caseSensitive: case_sensitive ?? false, wholeWord: whole_word ?? false },
        'search_and_redact',
        60_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          if (d.count === 0) return ok(`No occurrences of "${text}" found in the document.`);
          return ok(`Redacted ${d.count} occurrence(s) of "${text}" permanently.`);
        },
      ),
  );

  server.registerTool(
    'insert_page_number',
    {
      title: 'Insert Page Number',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Add page numbers to the currently open PDF. All parameters are optional -- omit any to use defaults. ' +
        'FORMAT: "%1%" = plain number (1, 2, 3...); "-%1%-" = dash-wrapped (-1-, -2-); "Page %1%" = prefixed (Page 1); ' +
        '"%1% of %2%" = current of total (1 of 10); "%1%/%2%" = fraction (1/10); "Page %1% of %2%" = full (Page 1 of 10). ' +
        'POSITION: "top-left", "top-center", "top-right", "bottom-left", "bottom-center" (default), "bottom-right". ' +
        'FONT: font_family (e.g. "Arial", "Times New Roman", "Courier", default "Arial"), font_size in pt (default 12), font_color hex (default "#000000"). ' +
        'RANGE: ["all"] or specific ranges like ["1-3","5","7-9"]. Omit = all pages. ' +
        'START: start_number sets the first displayed number (default 1 -- use e.g. 5 to start from "5"). ' +
        'Examples: "add page numbers" -> all defaults; ' +
        '"page X of Y centered at bottom in red" -> format="%1% of %2%", position="bottom-center", font_color="#FF0000"; ' +
        '"Page 1 top-right, Arial 10pt, pages 2-5 only" -> format="Page %1%", position="top-right", font_family="Arial", font_size=10, range=["2-5"]; ' +
        '"start numbering from 3" -> start_number=3.',
      inputSchema: {
        format: z.string().optional().describe(
          'Page number format string. ' +
          'Options: "%1%" (plain: 1, 2, 3...), "-%1%-" (dash: -1-, -2-), "Page %1%" (Page 1, Page 2), ' +
          '"%1% of %2%" (1 of 10), "%1%/%2%" (1/10), "Page %1% of %2%" (Page 1 of 10). ' +
          'Default: "%1%".'
        ),
        position: z.string().optional().describe(
          'Where to place the page number on the page. ' +
          'Options: "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right". ' +
          'Default: "bottom-center".'
        ),
        font_family: z.string().optional().describe(
          'Font family name. Examples: "Arial", "Times New Roman", "Courier", "Helvetica", "Georgia". Default: "Arial".'
        ),
        font_size: z.number().optional().describe('Font size in points. Common values: 8, 10, 12, 14. Default: 12.'),
        font_color: z.string().optional().describe('Font color as hex string. Examples: "#000000" (black), "#FF0000" (red), "#0000FF" (blue), "#808080" (gray). Default: "#000000".'),
        range: z.array(z.string()).optional().describe(
          'Page ranges to add numbers to. Examples: ["all"] (all pages), ["1-5"] (first 5), ["1-3","7","10-12"]. Omit = all pages.'
        ),
        start_number: z.number().int().min(1).optional().describe(
          'The number displayed on the first numbered page. Default: 1. Use e.g. 5 if the document continues from a previous file.'
        ),
      },
    },
    async ({ format, position, font_family, font_size, font_color, range, start_number }) => {
      const positionMap: Record<string, number> = {
        'top-center': 0, 'top-right': 1, 'bottom-right': 3,
        'bottom-center': 4, 'bottom-left': 5, 'top-left': 7,
      };
      const positionValue = position ? (positionMap[position] ?? 4) : 4;
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'insert_page_number', fontFamily: font_family ?? 'Arial', fontSize: font_size ?? 12, fontColor: font_color ?? '#000000', format: format ?? '%1%', position: positionValue, range: range ?? null, startNumber: start_number ?? 1 },
        'insert_page_number',
        15_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok('Page numbers inserted successfully.');
        },
      );
    },
  );

  registerAppTool(
    server,
    'get_viewer_command',
    {
      title: 'Get Viewer Command',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Poll for a pending viewer command (rotate, annotate, etc.)',
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async () => {
      if (_pendingDocOpen) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ command: null }) }] };
      }
      const cmd = pendingViewerCommand;
      pendingViewerCommand = null;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ command: cmd }) }],
      };
    },
  );

  registerAppTool(
    server,
    'report_viewer_result',
    {
      title: 'Report Viewer Result',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Report a result from the viewer to the server (internal)',
      inputSchema: {
        type: z.string(),
        count: z.number().int().min(0).optional(),
        pages: z.array(z.number().int().min(1)).optional(),
        json: z.string().optional(),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ type, count, pages, json }) => {
      if (type === 'doc_opened') {
        _pendingDocOpen = false;
      } else if (type === 'search') {
        pendingSearchResult = { count: count ?? 0, pages: pages ?? [] };
      } else if (json !== undefined) {
        try {
          const parsed = JSON.parse(json);
          if (parsed._pageCount != null) {
            const cp = parsed._currentPage != null ? `page ${parsed._currentPage} of ` : '';
            _lastDocState = `${cp}${parsed._pageCount} pages`;
          }
          pendingViewerResult = { type, data: parsed };
        } catch {
          pendingViewerResult = { type, data: json };
        }
      }
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );

  // Diagnostics tool: only registered with PWV_DEBUG, since it exists purely to
  // probe sandbox capabilities while developing the extension.
  if (DEBUG) {
    const diagTemplate = await fs.readFile(DIAG_HTML_PATH, 'utf-8');
    registerAppTool(
      server,
      'pwv_diag',
      {
        title: 'PWV Diagnostics',
        annotations: { readOnlyHint: false, destructiveHint: false },
        description:
          'Render a diagnostics panel that tests what the MCP Apps sandbox allows (workers, wasm, localhost network). For debugging the PDF viewer extension.',
        inputSchema: {},
        _meta: { ui: { resourceUri: diagResourceUri } },
      },
      async () => {
        debug('[diag] tool called');
        return {
          content: [{ type: 'text', text: 'Diagnostics panel opened. Results render inside the widget.' }],
          structuredContent: { started: true },
        };
      },
    );

    registerAppResource(
      server,
      'PWV Diagnostics',
      diagResourceUri,
      {
        description: 'Sandbox capability diagnostics for the Avanquest PDF viewer extension.',
        _meta: { ui: { csp: { resourceDomains: [baseUrl], connectDomains: [baseUrl] } } },
      },
      async () => {
        debug('[diag] resource read');
        return {
          contents: [
            {
              uri: diagResourceUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: renderStub(diagTemplate, baseUrl, (await getAuthState()).licenseKey),
              _meta: { ui: { csp: { resourceDomains: [baseUrl], connectDomains: [baseUrl] } } },
            },
          ],
        };
      },
    );
  }

  registerAppResource(
    server,
    'Avanquest PDF Viewer',
    resourceUri,
    {
      description: 'Interactive PDF viewer powered by @avanquest/pdf-web-viewer.',
      _meta: {
        ui: {
          csp: {
            resourceDomains: [baseUrl],
            connectDomains: [baseUrl],
          },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: renderStub(stubTemplate, baseUrl, (await getAuthState()).licenseKey),
          _meta: {
            ui: {
              csp: {
                resourceDomains: [baseUrl],
                connectDomains: [baseUrl],
              },
            },
          },
        },
      ],
    }),
  );

  setupClientInfo(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('avanquest-pdf-mcp-editor fatal:', err);
  process.exit(1);
});
