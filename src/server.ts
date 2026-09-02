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
import { createReadStream, existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
// Cowork mode runs separate server instances for the model's tool calls and the
// widget iframe's callServerTool requests, so everything the two sides exchange
// (viewer commands/results, doc-open marker, open target, file tokens) lives on
// disk rather than in process memory. See shared-state.ts.
import * as shared from './shared-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The license key is collected per-user via the mcpb `user_config` prompt
// (manifest -> PWV_LICENSE_KEY env). NO key is committed to source or shipped in
// the bundle. For local `npm start`, export PWV_LICENSE_KEY. An unsubstituted
// `${user_config...}` placeholder (host left it literal when unset) is ignored.
const envLicense = process.env.PWV_LICENSE_KEY?.trim();
const LICENSE_KEY = envLicense && !envLicense.includes('${') ? envLicense : '';
if (!LICENSE_KEY) {
  console.error('[avanquest-pdf] No license key configured (set PWV_LICENSE_KEY). The viewer will report a licensing error.');
}

// Directories `display_pdf` is allowed to open from. Configured via the mcpb
// `user_config` "Allowed PDF folders" prompt -- a `type: "directory", multiple:
// true` field, passed through as its own `--allowed-dirs` argv entry (manifest
// -> mcp_config.args), or the PWV_ALLOWED_DIRS env (OS-path-separator list) for
// non-mcpb/dev use. When neither is set, defaults to the user's common
// document locations. `display_pdf` rejects anything outside these roots, so
// the model can't coax the extension into reading arbitrary files.
//
// A `multiple: true` user_config value can only be expanded by
// @anthropic-ai/mcpb when it is substituted as its own standalone `args` array
// entry -- each selected folder becomes a separate argv string after
// --allowed-dirs (see that package's replaceVariables: array-context
// substitution spreads an array value in place, string-context substitution
// explicitly refuses to interpolate an array and warns instead). Passing a
// multi-select field through `env` (the previous approach here) silently
// leaves the raw "${user_config...}" placeholder in place -- that was the
// underlying bug the last attempt at multi-folder support ran into.
function parseAllowedDirsConfig(): string[] {
  const flagIndex = process.argv.indexOf('--allowed-dirs');
  if (flagIndex !== -1) {
    const values: string[] = [];
    for (let i = flagIndex + 1; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg.startsWith('--')) break; // next flag -- stop collecting
      values.push(arg);
    }
    // An unconfigured field resolves to zero argv entries; an unresolved
    // template placeholder (shouldn't happen, but defensive) is filtered too.
    const valid = values.map((s) => s.trim()).filter((s) => s && !s.includes('${'));
    if (valid.length > 0) return valid;
  }
  // Manual dev/non-mcpb override: OS-path-separator-joined list.
  if (process.env.PWV_ALLOWED_DIRS) {
    return process.env.PWV_ALLOWED_DIRS.split(path.delimiter);
  }
  return ['Downloads', 'Documents', 'Desktop', 'PDF'].map((d) => path.join(os.homedir(), d));
}

// Neither Node's fs/path nor Claude Desktop's directory-picker UI expand a
// leading "~" -- it's a shell convention, not something either side resolves
// on our behalf. Expand it ourselves so a manually-typed "~/Downloads" (or
// one that slips through from a manifest default some Claude Desktop version
// does honor) still resolves to a real, usable folder.
function expandHome(d: string): string {
  if (d === '~') return os.homedir();
  if (d.startsWith('~/') || d.startsWith('~\\')) return path.join(os.homedir(), d.slice(2));
  return d;
}

const ALLOWED_DIRS: string[] = parseAllowedDirsConfig()
  .map((d) => expandHome(d.trim()))
  .filter(Boolean)
  .map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return path.resolve(d); // keep configured roots that don't exist yet
    }
  });

// "the first valid folder can be used as the default PDF folder" --
// the folder the various export/save tools below suggest when the caller
// doesn't specify an explicit output path.
const DEFAULT_PDF_DIR: string = ALLOWED_DIRS[0] ?? path.join(os.homedir(), 'Downloads');

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
    return {
      ok: false,
      reason: [
        `Path is outside the allowed folders.`,
        `real path: ${real}`,
        `ALLOWED_DIRS: ${JSON.stringify(ALLOWED_DIRS)}`,
        `argv: ${JSON.stringify(process.argv)}`,
      ].join('\n'),
    };
  }
  return { ok: true, absolute: real };
}

const requireFromHere = createRequire(import.meta.url);
const viewerEntryPath = requireFromHere.resolve('@avanquest/pdf-web-viewer');
const viewerRoot = path.dirname(path.dirname(viewerEntryPath));

let workerManifestPromise: Promise<Record<string, string>> | null = null;
// Resolves the stable pdfworker.{js,wasm,data} aliases to the package's actual
// content-hashed filenames (e.g. pdfworker-3fbbfcb6.js). The package no longer ships
// a physical pwv-workers/manifest.json for this; instead it embeds the same
// name->hash map as an escaped JSON string literal inside sdk/index.js at build time
// — the exact data its own public `resolveWorkerPath()` reads internally (verified:
// resolveWorkerPath() returns the identical hashed filename with no manifest.json on
// disk). Match on the semantic "pdfworker.<ext>" keys, not minifier-assigned variable
// names, so this keeps working across vendor re-bundles.
function getWorkerManifest(): Promise<Record<string, string>> {
  if (!workerManifestPromise) {
    workerManifestPromise = (async () => {
      const sdkPath = path.join(viewerRoot, 'sdk', 'index.js');
      const raw = await fs.readFile(sdkPath, 'utf8');
      const m = /"(\{\\"pdfworker\.(?:js|wasm|data)\\"[\s\S]*?\\"\})"/.exec(raw);
      if (!m) throw new Error('worker asset manifest not found in sdk bundle');
      return JSON.parse(m[1].replace(/\\"/g, '"')) as Record<string, string>;
    })();
  }
  return workerManifestPromise;
}

const STUB_HTML_PATH = path.join(__dirname, 'mcp-app.html');
const DIAG_HTML_PATH = path.join(__dirname, 'diag.html');

// File tokens live in shared-state.ts (disk-backed) so a token minted by the
// MCP-side instance resolves in the widget-side instance in Cowork mode.
//
// save_pdf's chunk buffer is disk-backed too (shared.writeSaveChunk
// et al.) for the same reason -- Cowork can service two chunks of one upload
// from different processes, so a process-local buffer silently lost chunks it
// never saw while still reporting success. See shared-state.ts.
//
// Keyed by a per-export saveId (minted client-side per saveChunked()
// call), NOT by the long-lived file token. The widget can trigger overlapping
// exports for the same document (auto-save-on-command, the debounced
// isModified auto-save, and manual Save/Save As/Export all reuse the same
// token) -- keying by token let two concurrent exports' chunks land in one
// shared buffer, so whichever finished first would produce a mix of both
// payloads into a truncated/corrupt file. saveId gives each export its own
// buffer so concurrent exports can never interleave.

// Even with per-export buffers, two complete exports finishing
// around the same time can still race on the final fs.writeFile to the same
// path -- Node's default 'w' flag truncates on open, so a second writer's
// open() can truncate the file out from under a first writer that is still
// mid-write, corrupting the result. Serialize writes per target path so a
// second save waits for the first to finish instead of colliding with it.
const pathWriteQueues = new Map<string, Promise<void>>();
function serializeWrite(targetPath: string, write: () => Promise<void>): Promise<void> {
  const prior = pathWriteQueues.get(targetPath) ?? Promise.resolve();
  const next = prior.then(write, write).finally(() => {
    if (pathWriteQueues.get(targetPath) === next) pathWriteQueues.delete(targetPath);
  });
  pathWriteQueues.set(targetPath, next);
  return next;
}

// Appended to edit-tool descriptions so the model doesn't paraphrase away the
// save-location note docNote() attaches to the response text — observed in
// practice: Claude reliably relayed a concrete "saved to <path>" note, but
// silently dropped the more abstract "a working copy will be created" note
// on a document's very first edit, treating it as internal plumbing rather
// than something to tell the user.
const RELAY_SAVE_NOTE_INSTRUCTION = ' IMPORTANT: the response includes a bracketed note about where this change was saved (or that a working copy will be created) -- always relay that note to the user, even if it says a working copy is about to be created rather than a concrete path.';

// The viewer's WASM engine hard-rejects any color string that doesn't start
// with '#' (the "Color string should start with '#'" toast) — and until
// the annotation tools forwarded whatever the model sent and even
// reported success. Models do occasionally pass CSS color names ("green") or
// bare hex ("00FF00") despite the hex examples in every description, so
// normalize those into engine-accepted "#RRGGBB" instead of failing, and
// reject anything else with a message the model can act on.
// Same tolerance for booleans and numbers (see normalizeColor below): the
// cowork agent (and other MCP clients we don't control) sends numbers and
// booleans as JSON strings often enough that strict z.number()/z.boolean()
// schemas rejected whole tool calls with -32602 before any handler ran. All
// numeric params use z.coerce.number() (accepts "5"), and boolean params use
// this union (accepts "true"/"false"). The SDK serializes the input side of
// transforms to JSON Schema (io: 'input'), so the advertised schema stays a
// clean boolean|enum hint.
const zBool = z.union([
  z.boolean(),
  z.enum(['true', 'false', 'True', 'False']).transform((v) => v.toLowerCase() === 'true'),
]);

// Shape names get the same treatment: "нарисуй квадрат" makes a model send
// shape: "square" even though the enum says "rectangle". Widen the schema to
// union([enum, string]) (the enum hint survives in the advertised JSON Schema)
// and map the common synonyms here; anything unknown gets an actionable error.
const SHAPE_SYNONYMS: Record<string, string> = {
  square: 'rectangle', box: 'rectangle', rect: 'rectangle',
  circle: 'oval', ellipse: 'oval', round: 'oval',
  diamond: 'rhombus',
};

function normalizeShape(value: string, allowed: readonly string[]): string | null {
  const s = value.trim().toLowerCase();
  const mapped = SHAPE_SYNONYMS[s] ?? s;
  return allowed.includes(mapped) ? mapped : null;
}

// The range descriptions document ["all"] and models do
// send it — but the engine's range parser only understands numeric forms
// ("1-3", "5") and treats "all" as an empty range ("'pages' is an empty
// range"). Strip "all"-style entries here; a null result tells the widget to
// expand to the document's full 1-N range (only the widget knows the page
// count — the server never has the document open).
function normalizeRangeList(range: string[] | undefined | null): string[] | null {
  if (!range) return null;
  const cleaned = range
    .map((r) => String(r).trim())
    .filter((r) => r && !['all', 'all pages', '*'].includes(r.toLowerCase()));
  return cleaned.length > 0 ? cleaned : null;
}

const CSS_COLOR_NAMES: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#00AA00',
  lime: '#00FF00', blue: '#0000FF', yellow: '#FFFF00', orange: '#FF6600',
  purple: '#800080', violet: '#8A2BE2', pink: '#FFC0CB', brown: '#A52A2A',
  gray: '#808080', grey: '#808080', cyan: '#00FFFF', magenta: '#FF00FF',
  gold: '#FFD700', silver: '#C0C0C0', navy: '#000080', teal: '#008080',
  maroon: '#800000', olive: '#808000',
};

function normalizeColor(value: string): string | null {
  const s = value.trim();
  const named = CSS_COLOR_NAMES[s.toLowerCase()];
  if (named) return named;
  const hex = (s.startsWith('#') ? s : '#' + s).toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(hex)) {
    return '#' + [...hex.slice(1)].map((c) => c + c).join('');
  }
  // 8 hex digits = #AARRGGBB, used by the format tools ("#00000000" removes
  // a highlight/underline/strikeout) — pass through untouched.
  if (/^#([0-9A-F]{6}|[0-9A-F]{8})$/.test(hex)) return hex;
  return null;
}

/**
 * Normalize every color-valued argument of a tool call at once. Returns the
 * normalized map, or an error string naming the offending parameter for the
 * tool to hand back to the model.
 */
function normalizeColors<T extends Record<string, string | undefined>>(
  inputs: T,
): { ok: true; colors: T } | { ok: false; error: string } {
  const out: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(inputs)) {
    if (raw === undefined) continue;
    const normalized = normalizeColor(raw);
    if (!normalized) {
      return { ok: false, error: `Invalid ${key} "${raw}" -- use a hex color like "#00AA00" ("#RRGGBB", or "#AARRGGBB" with alpha).` };
    }
    out[key] = normalized;
  }
  return { ok: true, colors: out as T };
}

const pruneExpired = shared.pruneExpiredTokens;
const mintToken = shared.mintToken;

// Persisted across Claude Desktop restarts (see fullscreenGrantedTokens above).
// Capped so the file can't grow unbounded over months of use — oldest entries
// are dropped first once past the cap.
const FULLSCREEN_STATE_PATH = path.join(os.homedir(), '.avanquest-pdf-viewer', 'fullscreen-granted-tokens.json');
const FULLSCREEN_STATE_MAX = 500;

function loadFullscreenGrantedTokens(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(FULLSCREEN_STATE_PATH, 'utf-8')) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((v) => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveFullscreenGrantedTokens(tokens: Set<string>): void {
  try {
    mkdirSync(path.dirname(FULLSCREEN_STATE_PATH), { recursive: true });
    const arr = Array.from(tokens);
    const trimmed = arr.length > FULLSCREEN_STATE_MAX ? arr.slice(arr.length - FULLSCREEN_STATE_MAX) : arr;
    writeFileSync(FULLSCREEN_STATE_PATH, JSON.stringify(trimmed), 'utf-8');
  } catch { /* non-fatal — worst case, next restart re-grants fullscreen once */ }
}

// Same remount problem as fullscreen arbitration above, but for
// file-writing commands (compress_pdf/merge_pdf/split_pdf) instead of the
// display mode. A widget's ontoolresult re-fires with the same open target —
// carrying the same command — on every remount (scrolling back into view,
// reopening a chat much later), and mcp-app.ts used to just run the command
// again each time, silently overwriting the output file. Each such command is
// now tagged with a unique opId when minted (see compress_pdf/merge_pdf/
// split_pdf below); the widget claims it here before running, exactly once per
// opId — every later claim for the same opId (a remount) is denied and the
// widget only re-displays the document, without repeating the write.
const EXECUTED_OPS_STATE_PATH = path.join(os.homedir(), '.avanquest-pdf-viewer', 'executed-operations.json');
const EXECUTED_OPS_STATE_MAX = 500;

// opId -> the output file it was expected to produce (empty string if the
// command has no single output path, e.g. split_pdf). Recording the path lets
// claim_operation re-allow a remount if that file is later gone from disk
// (user deleted the compressed/merged output) instead of forever refusing to
// recreate it just because this opId ran once before.
type ExecutedOps = Record<string, string>;

function loadExecutedOps(): ExecutedOps {
  try {
    const parsed = JSON.parse(readFileSync(EXECUTED_OPS_STATE_PATH, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ExecutedOps;
    return {};
  } catch {
    return {};
  }
}

function saveExecutedOps(ops: ExecutedOps): void {
  try {
    mkdirSync(path.dirname(EXECUTED_OPS_STATE_PATH), { recursive: true });
    const entries = Object.entries(ops);
    const trimmed = entries.length > EXECUTED_OPS_STATE_MAX ? entries.slice(entries.length - EXECUTED_OPS_STATE_MAX) : entries;
    writeFileSync(EXECUTED_OPS_STATE_PATH, JSON.stringify(Object.fromEntries(trimmed)), 'utf-8');
  } catch { /* non-fatal — worst case, a remount repeats the write once more */ }
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
// so only our iframe can use it. Derived from the license key so it stays
// stable across process restarts -- Claude Desktop caches the resource HTML and
// a random token would break the relay after every restart until cache clears.
const PROXY_TOKEN = createHash('sha256')
  .update('pwv-proxy-' + (LICENSE_KEY || 'no-license'))
  .digest('hex')
  .slice(0, 32);

// The relay exists solely so the viewer's WASM can validate its license.
// Restrict it to that host so it can't be used as a general localhost proxy.
const RELAY_ALLOWED_HOSTS = new Set(['api-developers.avanquest.com']);

// Verbose request/iframe/proxy tracing is debugging scaffolding; off unless
// PWV_DEBUG is set.
const DEBUG = process.env.PWV_DEBUG === '1' || process.env.PWV_DEBUG === 'true';
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

  // A non-2xx status here makes the browser's dynamic import()
  // fail as a bare network error ("Failed to fetch dynamically imported
  // module") *before* it ever reads the response body -- so every reason we
  // used to embed as a JS comment (token expired, file deleted, forbidden
  // path, ...) never actually reached the client. Always answer 200 and
  // carry the failure as a real export instead, so callers can branch on
  // `mod.error`/`mod.code` and show something better than a raw TypeError.
  function sendModError(res: import('express').Response, message: string, code?: string): void {
    res.type('application/javascript').status(200).send(
      `export default null; export const error = ${JSON.stringify(message)}; export const code = ${JSON.stringify(code ?? null)};`,
    );
  }

  // Same workaround for binary assets: wrap any served file as an ES module
  // exporting base64, importable where fetch() is forbidden.
  app.get(/^\/mod\/(.+)$/, async (req, res) => {
    const rel = (req.params as unknown as Record<string, string>)[0];
    try {
      let buf: Buffer;
      if (rel.startsWith('file/')) {
        pruneExpired();
        const token = rel.slice('file/'.length);
        const entry = shared.getFileToken(token);
        if (!entry) {
          // Cowork mode runs separate server instances: the iframe's instance may not
          // have the token minted by the MCP-side instance. Fall back to the filePath
          // query param if provided (passed by fileFromToken as a safety net).
          const fp = String(req.query.fp ?? '');
          if (!fp) {
            sendModError(res, 'not found or expired', 'file_not_found');
            return;
          }
          const tmpDir = os.tmpdir();
          const resolved = resolveAllowedPdf(fp);
          const isInTmp = fp.startsWith(tmpDir + path.sep) || fp.startsWith(tmpDir + '/');
          if (!resolved.ok && !isInTmp) {
            sendModError(res, resolved.reason, 'forbidden');
            return;
          }
          const readPath = resolved.ok ? resolved.absolute : fp;
          try {
            buf = await fs.readFile(readPath);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_not_found' : undefined;
            sendModError(res, (err as Error).message, code);
            return;
          }
        } else {
          try {
            buf = await fs.readFile(entry.fullPath);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_not_found' : undefined;
            sendModError(res, (err as Error).message, code);
            return;
          }
        }
      } else if (rel.startsWith('ui/') || rel.startsWith('public/')) {
        const abs = path.resolve(viewerRoot, rel);
        if (!abs.startsWith(viewerRoot + path.sep)) {
          sendModError(res, 'forbidden');
          return;
        }
        try {
          buf = await fs.readFile(abs);
        } catch (err) {
          const aliasMatch = /^pdfworker\.(js|wasm|data)$/.exec(path.basename(abs));
          if (!aliasMatch) throw err;
          const manifest = await getWorkerManifest();
          const real = manifest[`pdfworker.${aliasMatch[1]}`];
          if (!real) throw err;
          buf = await fs.readFile(path.join(path.dirname(abs), real));
        }
      } else {
        sendModError(res, 'unknown asset class');
        return;
      }
      res.type('application/javascript').send(`export default "${buf.toString('base64')}";`);
    } catch (err) {
      sendModError(res, (err as Error).message);
    }
  });

  app.use('/ui', express.static(path.join(viewerRoot, 'ui'), { fallthrough: false }));
  app.use('/public', express.static(path.join(viewerRoot, 'public'), { fallthrough: false }));

  app.get('/file/:token', (req, res) => {
    pruneExpired();
    const entry = shared.getFileToken(req.params.token);
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


async function main(): Promise<void> {
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

  // Every host we've observed strips `structuredContent` from the tool-result
  // notification the widget iframe receives on `ontoolresult` (confirmed via
  // debug logging: structuredContent is always absent, even on a fresh live
  // open). Without it, the widget fell back to `get_pending_open`, a single
  // server-process-wide "last opened" pointer — which is wrong for a widget
  // being remounted later (scrolled back into view, or a past chat reopened),
  // since some OTHER conversation may have opened a different document since.
  // The one channel that reliably survives to the widget, unique per call, is
  // the tool result's own `content` array — so we carry the open target there
  // too, as a second content block marked `audience: ['user']` (not meant for
  // the model to read/repeat). `structuredContent`/`get_pending_open` remain
  // as fallbacks for hosts where this new block might not arrive either.
  function openTargetContentBlock(structured: Record<string, unknown>): { type: 'text'; text: string; annotations: { audience: ['user'] } } {
    return {
      type: 'text' as const,
      text: JSON.stringify({ open: structured }),
      annotations: { audience: ['user'] },
    };
  }

  registerAppTool(
    server,
    'display_pdf',
    {
      title: 'Display PDF',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Open a PDF in the embedded Avanquest PDF editor. Pass either an absolute local path to a .pdf file inside the user\'s document folders, or a URL to a remote PDF. The viewer renders inline in the chat.',
      inputSchema: {
        path: z.string().optional().describe("Absolute path to a PDF file within the user's allowed document folders"),
        url: z.string().optional().describe('URL of a remote PDF to download and open (http or https)'),
      },
      // outputSchema used to be declared here (structuredContent forwarding to
      // the app iframe on older Claude Desktop) but was dropped because
      // it's what makes the SDK stamp a JSON Schema `$schema` dialect the newer
      // Cowork validator rejects outright at attach time (see PR
      // modelcontextprotocol/typescript-sdk#2653), and ontoolresult's own
      // debug logging confirms structuredContent never actually arrives there
      // regardless — parseOpenTargetFromContent's content-block channel (see
      // openTargetContentBlock below) is what widgets have really relied on.
      _meta: { ui: { resourceUri } },
    },
    async ({ path: requestedPath, url: pdfUrl }) => {
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
      shared.resetDocState();
      shared.setDocOpenPending(true);
      shared.setViewerCommand(null);

      const structured = { url: fileUrl, name, token, filePath: pdfUrl ?? absolutePath };
      shared.setOpenTarget(structured);
      return {
        content: [
          { type: 'text', text: `Opened ${name} in the editor.` },
          openTargetContentBlock(structured),
        ],
        structuredContent: structured,
      };
    },
  );

  // Renewing the token on every get_viewer_command poll (below)
  // only helps while the widget is actually polling. A document left open
  // through a long background/inactive stretch (throttled iframe, laptop
  // sleep, or just genuinely not touched for a while) can still outlive
  // TOKEN_TTL_MS with no poll ever landing to renew it -- confirmed by QA
  // still hitting "token expired" after that fix. The widget always knows
  // the real filesystem path of its own open document (_currentFilePath),
  // independent of whatever happened to the server-side token, so let it
  // self-heal: mint a fresh token for that same (still-open, still-valid)
  // file on demand instead of only ever erroring out. Same path validation
  // as display_pdf (resolveAllowedPdf) -- this doesn't touch the viewer or
  // re-open anything, just re-establishes a token save_pdf can use.
  registerAppTool(
    server,
    'refresh_file_token',
    {
      title: 'Refresh File Token',
      annotations: { readOnlyHint: true, destructiveHint: false },
      description: 'Internal: mint a fresh file token for an already-open local PDF whose token expired.',
      inputSchema: {
        filePath: z.string(),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ filePath }) => {
      const resolved = resolveAllowedPdf(filePath);
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: resolved.reason }) }], isError: true };
      }
      const token = mintToken(resolved.absolute, path.basename(resolved.absolute));
      return { content: [{ type: 'text', text: JSON.stringify({ token }) }] };
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
        offset: z.coerce.number().int().min(0),
        totalSize: z.coerce.number().int().min(1),
        savePath: z.string().optional().describe('Override save path; defaults to original file path'),
        saveId: z.string().optional().describe('Unique id for this export, distinguishing it from other concurrent exports of the same document'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ token, chunk, offset, totalSize, savePath, saveId }) => {
      pruneExpired();
      await shared.pruneStaleSaveBuffers();
      const entry = shared.getFileToken(token);
      if (!entry) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'PDF not found or token expired' }) }],
          isError: true,
        };
      }
      const targetPath = savePath?.trim() || entry.fullPath;
      // Fall back to token for older widget builds that don't send saveId yet
      // -- worse (no interleaving protection) but never worse than before.
      const bufferKey = saveId || token;
      const chunkBuf = Buffer.from(chunk, 'base64');
      await shared.writeSaveChunk(bufferKey, offset, chunkBuf);
      const bytesReceived = offset + chunkBuf.length;
      if (bytesReceived >= totalSize) {
        // Confirm what's actually durable on disk for this saveId --
        // earlier chunks may have been written by a different process
        // instance (Cowork), so this call's own offset can't prove it.
        const persistedSize = await shared.getSaveBufferSize(bufferKey);
        if (persistedSize < totalSize) {
          console.error(`[save_pdf] incomplete buffer for ${bufferKey}: persisted ${persistedSize} of ${totalSize} bytes`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Save incomplete: only ${persistedSize} of ${totalSize} bytes were durably received` }) }],
            isError: true,
          };
        }
        const tempPath = shared.getSaveBufferPath(bufferKey);
        await serializeWrite(targetPath, () => fs.copyFile(tempPath, targetPath));
        await shared.removeSaveBuffer(bufferKey);
        debug(`[save_pdf] saved ${persistedSize} bytes -> ${targetPath}`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ done: true, savedPath: targetPath }) }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ done: false, bytesReceived }) }],
      };
    },
  );

  // The widget iframe's sandbox CSP blocks fetch() to arbitrary
  // origins (see mcp-app.ts's beacon() comment -- it can't even fetch() its
  // own local server, only this server's own process can make outbound
  // network calls). So the OCR round trip to Avanquest's online API has to
  // happen HERE, not in the widget: the widget uploads the extracted PDF in
  // chunks (mirroring save_pdf's disk-backed buffer, reusing the same
  // shared-state.ts helpers), this server does the actual
  // start/poll/download against the documented public contract
  // (developers.avanquest.com/api-reference/getting-started), and hands the
  // result back to the widget as a file token (the same mechanism
  // read_pdf_bytes_by_token/fileFromToken already use).
  const OCR_API_TOOLS_URL = 'https://api-developers.avanquest.com';

  registerAppTool(
    server,
    'ocr_upload_chunk',
    {
      title: 'OCR Upload Chunk',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Internal: upload one chunk of a PDF to be OCR\'d.',
      inputSchema: {
        ocrId: z.string(),
        chunk: z.string().describe('base64-encoded bytes'),
        offset: z.coerce.number().int().min(0),
        totalSize: z.coerce.number().int().min(1),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ ocrId, chunk, offset, totalSize }) => {
      await shared.writeSaveChunk(ocrId, offset, Buffer.from(chunk, 'base64'));
      const persistedSize = await shared.getSaveBufferSize(ocrId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ done: persistedSize >= totalSize }) }],
      };
    },
  );

  registerAppTool(
    server,
    'ocr_run',
    {
      title: 'OCR Run',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Internal: run OCR (via the Avanquest online API) on a PDF already uploaded via ocr_upload_chunk, and return a file token for the result.',
      inputSchema: {
        ocrId: z.string(),
        totalSize: z.coerce.number().int().min(1),
        pages: z.string().optional().describe('Comma-separated 1-based page numbers, as built by the SDK\'s own buildFormData'),
        password: z.string().optional(),
        language: z.string().optional(),
        deskew: zBool,
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ ocrId, totalSize, pages, password, language, deskew }) => {
      try {
        const persistedSize = await shared.getSaveBufferSize(ocrId);
        if (persistedSize < totalSize) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `incomplete upload: only ${persistedSize} of ${totalSize} bytes were received` }) }],
            isError: true,
          };
        }
        const fileBytes = await fs.readFile(shared.getSaveBufferPath(ocrId));
        await shared.removeSaveBuffer(ocrId);

        const formData = new FormData();
        formData.append('file', new Blob([fileBytes], { type: 'application/pdf' }), 'document.pdf');
        if (pages) formData.append('pages', pages);
        if (password) formData.append('password', password);
        if (language) formData.append('language', language);
        formData.append('deskew', deskew ? 'true' : 'false');

        const startRes = await fetch(`${OCR_API_TOOLS_URL}/ocr/v1`, {
          method: 'POST',
          headers: { 'X-API-KEY': LICENSE_KEY },
          body: formData,
        });
        if (startRes.status !== 202) {
          const bodyText = await startRes.text().catch(() => '');
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `OCR start failed: HTTP ${startRes.status} ${bodyText}` }) }],
            isError: true,
          };
        }
        const { id } = (await startRes.json()) as { id: string };

        // Stay comfortably under read_text's 120s outer timeout, which also
        // has to cover the upload/download steps around this poll loop.
        const deadline = Date.now() + 95_000;
        let status = 'pending';
        let statusError: { message?: string } | undefined;
        while (Date.now() < deadline) {
          const statusRes = await fetch(`${OCR_API_TOOLS_URL}/operation/v1/${id}/status`, {
            headers: { 'X-API-KEY': LICENSE_KEY },
          });
          if (!statusRes.ok) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: `OCR status check failed: HTTP ${statusRes.status}` }) }],
              isError: true,
            };
          }
          const s = (await statusRes.json()) as { status: string; progress?: number; error?: { message?: string } };
          status = s.status;
          if (status === 'completed') break;
          if (status === 'failed') { statusError = s.error; break; }
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
        if (status !== 'completed') {
          const reason = statusError?.message ?? (status === 'failed' ? 'unknown error' : `timed out (last status: ${status})`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `OCR failed: ${reason}` }) }],
            isError: true,
          };
        }

        const downloadRes = await fetch(`${OCR_API_TOOLS_URL}/operation/v1/${id}/download`, {
          headers: { 'X-API-KEY': LICENSE_KEY },
        });
        if (!downloadRes.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `OCR download failed: HTTP ${downloadRes.status}` }) }],
            isError: true,
          };
        }
        const ab = await downloadRes.arrayBuffer();
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'avanquest-ocr-'));
        const tmpPath = path.join(tmpDir, 'ocr-result.pdf');
        await fs.writeFile(tmpPath, Buffer.from(ab));
        const token = shared.mintToken(tmpPath, 'ocr-result.pdf', true);
        return { content: [{ type: 'text', text: JSON.stringify({ token }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
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
      const entry = shared.getFileToken(token);
      let readPath: string | null = entry?.fullPath ?? null;
      if (!readPath && filePath) {
        const tmpDir = os.tmpdir();
        const isInTmp = filePath.startsWith(tmpDir + path.sep) || filePath.startsWith(tmpDir + '/');
        const resolved = resolveAllowedPdf(filePath);
        readPath = resolved.ok ? resolved.absolute : (isInTmp ? filePath : null);
      }
      if (!readPath) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'PDF not found or token expired', code: 'file_not_found' }) }] };
      }
      try {
        const buf = await fs.readFile(readPath);
        return { content: [{ type: 'text', text: JSON.stringify({ base64: buf.toString('base64') }) }] };
      } catch (err) {
        // Tag ENOENT so the widget can show a friendly "file no
        // longer exists" message instead of the raw fs error.
        const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_not_found' : undefined;
        return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message, code }) }] };
      }
    },
  );

  registerAppTool(
    server,
    'compress_pdf',
    {
      title: 'Compress PDF',
      annotations: { destructiveHint: true },
      description: 'Open a PDF in the editor and compress it. Accepts path (required), compression (min/low/medium/high/max, default: medium), and optional outputPath. The editor performs compression using the browser-side PDF engine. This call returns immediately once compression starts, before it finishes — call get_last_operation_result afterward for the confirmed before/after size.',
      inputSchema: {
        path: z.string().describe("Absolute path to a PDF file within the user's allowed document folders"),
        compression: z.enum(['min', 'low', 'medium', 'high', 'max'])
          .optional()
          .describe('Compression level: max=maximum compression (smallest file, lower quality), min=minimum compression (largest file, best quality). Default: medium'),
        outputPath: z.string().optional().describe('Where to save the compressed file. Defaults to original filename with _compressed suffix'),
      },
      // No outputSchema — see the note on display_pdf above.
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
      const structured = {
        url: `${baseUrl}/file/${token}`,
        name,
        token,
        filePath,
        command: { type: 'compress_pdf', compression: compression ?? 'medium', outputPath: savePath, opId: randomUUID() },
      };
      debug(`[compress_pdf] minted opId=${structured.command.opId} token=${token} outputPath=${savePath}`);
      // Unlike display_pdf, this tool never flagged a doc-open as
      // pending — so a read-only tool (e.g. read_document_information) called
      // around the same time could race past get_viewer_command's pending-open
      // guard and run against whatever document was active before this open,
      // instead of waiting for the switch this call is about to trigger.
      shared.setDocOpenPending(true);
      shared.setViewerCommand(null);
      shared.setOpenTarget(structured);
      return {
        content: [
          { type: 'text', text: `Opening ${name} for compression (compression: ${compression ?? 'medium'})...` },
          openTargetContentBlock(structured),
        ],
        structuredContent: structured,
      };
    },
  );

  registerAppTool(
    server,
    'merge_pdf',
    {
      title: 'Merge PDFs',
      annotations: { destructiveHint: true },
      description: 'Open the first PDF in the editor and merge all listed PDFs into one. Accepts paths (array of absolute PDF paths, min 2) and optional outputPath. This call returns immediately once the merge starts, before it finishes — call get_last_operation_result afterward for the confirmed total page count.',
      inputSchema: {
        paths: z.array(z.string()).min(2).describe('Absolute paths to PDF files to merge, in order'),
        outputPath: z.string().optional().describe('Where to save the merged file. Defaults to <firstName>_merged.pdf next to the first file'),
      },
      // No outputSchema — see the note on display_pdf above.
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
      const structured = {
        url: `${baseUrl}/file/${files[0].token}`,
        name: files[0].name,
        token: files[0].token,
        filePath: firstPath,
        command: { type: 'merge_pdf', files, outputPath: savePath, opId: randomUUID() },
      };
      debug(`[merge_pdf] minted opId=${structured.command.opId} outputPath=${savePath}`);
      // See compress_pdf above — flag the open as pending so a
      // concurrent read-only tool call can't race ahead of the switch.
      shared.setDocOpenPending(true);
      shared.setViewerCommand(null);
      shared.setOpenTarget(structured);
      return {
        content: [
          { type: 'text', text: `Opening ${files[0].name} for merge (${paths.length} files)...` },
          openTargetContentBlock(structured),
        ],
        structuredContent: structured,
      };
    },
  );

  registerAppTool(
    server,
    'split_pdf',
    {
      title: 'Split PDF',
      annotations: { destructiveHint: true },
      description: 'Open a PDF in the editor and split it into multiple files by page ranges or equal chunks. This call returns immediately once the split starts, before it finishes — call get_last_operation_result afterward for the confirmed actual source page count and output files.',
      inputSchema: {
        path: z.string().describe("Absolute path to the PDF file to split"),
        ranges: z.array(z.string()).optional().describe('Page ranges for each output file, e.g. ["1-3","4-6","7"]. Supports ranges (1-3), comma lists (1,3,5), or single pages (2).'),
        pagesPerFile: z.coerce.number().int().min(1).optional().describe('Split into equal chunks of N pages each. Alternative to ranges.'),
        outputDir: z.string().optional().describe('Directory for output files. Defaults to same directory as the input file.'),
      },
      // No outputSchema — see the note on display_pdf above.
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
      const structured = {
        url: `${baseUrl}/file/${token}`,
        name,
        token,
        filePath,
        command: { type: 'split_pdf', ranges, pagesPerFile, outputDir: outDir, baseName, opId: randomUUID() },
      };
      debug(`[split_pdf] minted opId=${structured.command.opId} outputDir=${outDir}`);
      // See compress_pdf above — flag the open as pending so a
      // concurrent read-only tool call can't race ahead of the switch. This
      // is the exact gap that let read_document_information report the
      // PREVIOUS document's metadata while a split_pdf-triggered open to a
      // different file was still in flight.
      shared.setDocOpenPending(true);
      shared.setViewerCommand(null);
      shared.setOpenTarget(structured);
      return {
        content: [
          { type: 'text', text: `Opening ${name} for split...` },
          openTargetContentBlock(structured),
        ],
        structuredContent: structured,
      };
    },
  );

  // The viewer command/result channel, the doc-open marker, the last open
  // target (get_pending_open fallback for hosts that strip structuredContent —
  // Claude Desktop <=1.20186), and the docNote inputs (_lastDocState /
  // _lastWorkingFile) all live in shared-state.ts now: in Cowork mode
  // the model's tool calls and the widget's callServerTool requests are served
  // by SEPARATE server processes, so in-memory variables never crossed over and
  // every viewer-bound tool timed out.
  // Mirrors mcp-app.ts's MUTATING_COMMAND_TYPES — the report_viewer_result
  // `type` values that represent an actual document edit (as opposed to a
  // read, like get_view_state or read_annotations, which also round-trip
  // through report_viewer_result but never touch _lastWorkingFile). Used so
  // docNote() only ever mentions saving/working-copy behavior for edits.
  const MUTATING_RESULT_TYPES = new Set([
    'rotate_pages', 'insert_blank_page', 'add_image_to_page', 'add_annotation', 'circle_text',
    'update_annotation', 'delete_annotation', 'replace_text', 'add_bookmark', 'delete_bookmark',
    'delete_all_bookmarks', 'resize_pages', 'delete_pages', 'move_pages', 'duplicate_pages',
    'reverse_pages', 'undo', 'redo', 'update_document_properties', 'update_form_field',
    'apply_redactions', 'delete_bates_numbering', 'delete_watermark', 'delete_header',
    'delete_page_number', 'insert_page_number', 'delete_text_blocks', 'set_security_permissions',
    'search_and_redact', 'format_text', 'add_text_to_page', 'add_form_field', 'format_selected_text',
  ]);
  // These produce a standalone new file whose own response text
  // already states the real outcome (including, for extract_pages, the
  // actual extracted page count) — appending the *currently open* viewer
  // document's page-count note here doesn't just add noise, it's actively
  // wrong (it describes a different document than the one just produced).
  const SKIP_DOC_NOTE_RESULT_TYPES = new Set(['extract_pages']);

  function docNote(isEdit = false): string {
    // The very first edit in a document's lifetime fires before the
    // debounced auto-save (mcp-app.ts) has ever completed once, so there's
    // no working-copy path to report yet — say so anyway instead of silently
    // omitting any save-related note, so Claude/the user aren't left
    // wondering whether the change was persisted at all.
    const { lastDocState, lastWorkingFile } = shared.getDocState();
    const savedNote = lastWorkingFile
      ? `saved to ${lastWorkingFile}`
      : (isEdit ? 'a working copy of this file will be created and used for all further edits' : '');
    const parts = [lastDocState, savedNote].filter(Boolean);
    return parts.length ? ` [${parts.join(' — ')}]` : '';
  }

  // Fullscreen arbitration across sibling widget iframes. Each display_pdf/etc.
  // widget renders in its own iframe on its own ephemeral sandbox origin, so
  // BroadcastChannel/localStorage cannot coordinate between them — this server
  // process is the only thing all widgets in a conversation actually share.
  // A widget's iframe re-fires ontoolresult on every remount, not just on a
  // genuinely new tool call — scrolling it back into view or reopening a past
  // chat much later remounts it the same way, at an arbitrary later time. So
  // arbitration is keyed on the document's token rather than on timing: the
  // first widget to claim a given token gets fullscreen; every later claim for
  // that same token (any remount) is denied and stays inline with its manual
  // expand button.
  //
  // This Set must survive across Claude Desktop restarts, not just within one
  // server process's lifetime — otherwise every restart forgets which tokens
  // were already granted, and every widget still open in chat history goes
  // fullscreen again on the next remount. Persisted to a small JSON file.
  // (The granted-token set is re-read from disk inside claim_fullscreen on
  // every call — a startup-time cache would go stale across the sibling
  // server instances Cowork mode runs.)

  type TR = { content: [{ type: 'text'; text: string }]; isError?: true };
  const ok  = (text: string): TR => ({ content: [{ type: 'text' as const, text }] });
  const nok = (text: string): TR => ({ content: [{ type: 'text' as const, text }], isError: true });

  // Hard ceiling on how long pollViewerResult will wait out an in-progress
  // document open (see below) before giving up on it entirely and letting
  // the normal per-call timeout run its course anyway. Kept modest (not,
  // say, 30s+) on purpose: if the widget never connects at all (e.g. a host
  // that doesn't render ui:// resources, or a genuinely stuck/failed editor
  // init that somehow still didn't clear _pendingDocOpen), every affected
  // tool call pays this in full before even starting its own timeout —
  // better to fail in ~15s than ~40s when nothing is ever going to arrive.
  const DOC_OPEN_GRACE_CAP_MS = 15_000;

  async function pollViewerResult<T>(
    command: Record<string, unknown>,
    resultType: string,
    timeoutMs: number,
    handler: (data: T) => TR,
  ): Promise<TR> {
    shared.setViewerResult(null);
    shared.setViewerCommand(command);
    // display_pdf returns as soon as a token is minted, well before the
    // widget has even fetched file bytes, let alone finished PdfEditor()
    // bootstrap (dynamic import, license check, WASM, doc load) — which can
    // itself take a while on a cold start. Without this, a fast follow-up
    // tool call's own timeoutMs clock ran concurrently with that bootstrap
    // and could expire before the document ever finished opening, even
    // though nothing was actually wrong — reported as a false "Timed out"
    // for a document that genuinely was mid-open. Wait the open out first
    // (capped, so a truly stuck open doesn't hang forever) so this call's
    // own timeout budget only starts counting once there's an actual
    // document to poll against.
    if (shared.isDocOpenPending()) {
      const openDeadline = Date.now() + DOC_OPEN_GRACE_CAP_MS;
      while (shared.isDocOpenPending() && Date.now() < openDeadline) {
        await new Promise<void>((r) => setTimeout(r, 300));
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 300));
      const pr = shared.peekViewerResult();
      if (pr !== null) {
        if (pr.type !== resultType) continue;
        shared.clearViewerResult();
        const result = handler(pr.data as T);
        if (!result.isError && result.content[0] && !SKIP_DOC_NOTE_RESULT_TYPES.has(resultType)) {
          result.content[0] = { type: 'text' as const, text: result.content[0].text + docNote(MUTATING_RESULT_TYPES.has(resultType)) };
        }
        return result;
      }
    }
    shared.setViewerCommand(null);
    return nok('Timed out -- make sure a PDF is open in the editor.');
  }

  server.registerTool(
    'search_in_pdf',
    {
      title: 'Search in PDF',
      annotations: { readOnlyHint: true },
      description: 'Search for text in the currently open PDF. Highlights all matches in the editor and returns the total match count and 1-based page numbers where matches were found. The returned page numbers can be used directly in tools that accept a "page" parameter.',
      inputSchema: {
        query: z.string().describe('Text to search for'),
        caseSensitive: zBool.optional().describe('Case-sensitive search (default: false)'),
        wholeWord: zBool.optional().describe('Match whole words only (default: false)'),
      },
    },
    async ({ query, caseSensitive, wholeWord }) => {
      if (!query.trim()) {
        return { content: [{ type: 'text' as const, text: 'Search query must not be empty.' }], isError: true };
      }
      shared.setSearchResult(null);
      shared.setViewerCommand({
        type: 'search_text',
        query,
        caseSensitive: caseSensitive ?? false,
        wholeWord: wholeWord ?? false,
      });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 500));
        const sr = shared.takeSearchResult();
        if (sr !== null) {
          if (sr.count === 0) {
            return { content: [{ type: 'text' as const, text: `No matches found for "${query}".` + docNote() }] };
          }
          const pageList = sr.pages.join(', ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${sr.count} match${sr.count === 1 ? '' : 'es'} for "${query}" on page${sr.pages.length === 1 ? '' : 's'} ${pageList}. All matches are highlighted in the editor.`,
              },
            ],
          };
        }
      }
      shared.setViewerCommand(null);
      return {
        content: [{ type: 'text' as const, text: 'Search timed out -- make sure a PDF is open in the editor.' }],
        isError: true,
      };
    },
  );

  server.registerTool(
    'navigate_search_result',
    {
      title: 'Navigate Search Result',
      annotations: { readOnlyHint: true },
      description: 'Navigate to the next or previous search result in the currently open PDF editor. Requires search_in_pdf to have been called first.',
      inputSchema: {
        direction: z.enum(['next', 'prev']).describe('Navigate to next or previous match'),
      },
    },
    async ({ direction }) => {
      shared.setViewerCommand({ type: 'navigate_search', direction });
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
      description: 'Rotate pages in the currently open PDF editor. Use pages for specific 1-based page numbers (e.g. [1,3]), or omit to rotate all pages. Angle: 90, 180, or 270 degrees clockwise (negative values rotate counter-clockwise).' + RELAY_SAVE_NOTE_INSTRUCTION,
      inputSchema: {
        // Was z.union([z.literal(90), ...]) — models routinely send "90" as a
        // string or -90 for counter-clockwise, and strict literal validation
        // rejected the whole call at the SDK layer ("Invalid input at angle")
        // before the handler could help. Accept anything number-ish and
        // normalize below, answering with an actionable error when it really
        // isn't a right-angle rotation.
        angle: z.union([z.coerce.number(), z.string()]).describe('Rotation angle in degrees: 90, 180, or 270 (clockwise). Negative rotates counter-clockwise (-90 == 270).'),
        pages: z.array(z.coerce.number().int().min(1)).optional().describe('1-based page numbers to rotate. Omit to rotate all pages.'),
      },
    },
    async ({ angle, pages }) => {
      const parsed = typeof angle === 'string' ? Number(angle.trim()) : angle;
      const normalized = Number.isFinite(parsed) ? ((parsed % 360) + 360) % 360 : NaN;
      if (normalized !== 90 && normalized !== 180 && normalized !== 270) {
        return nok(`Invalid angle ${JSON.stringify(angle)} -- use 90, 180, or 270 (or a negative multiple of 90 for counter-clockwise).`);
      }
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'rotate_pages', angle: normalized, pages: pages ?? null },
        'rotate_pages',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error ?? 'failed to rotate pages'}`);
          return ok(`Rotated ${pages ? `pages ${pages.join(',')}` : 'all pages'} by ${normalized}°`);
        },
      );
    },
  );

  server.registerTool(
    'add_annotation',
    {
      title: 'Add Annotation',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Add a NEW shape annotation to the PDF. Use only for creating new annotations. To change color/opacity of an existing annotation, use update_annotation instead -- never delete and re-add just to change a property. Supported shapes: oval, rectangle, rhombus, line, arrow. Position and size are percentages of page dimensions (0--100).' + RELAY_SAVE_NOTE_INSTRUCTION,
      inputSchema: {
        shape: z.union([z.enum(['oval', 'rectangle', 'rhombus', 'line', 'arrow']), z.string()]).describe('Shape type to draw: oval, rectangle, rhombus, line, or arrow'),
        page: z.coerce.number().int().min(1).describe('1-based page number to draw on'),
        x: z.coerce.number().min(0).max(99).describe('Left edge as % of page width (0=left, 100=right)'),
        y: z.coerce.number().min(0).max(99).describe('Top edge as % of page height (0=top, 100=bottom)'),
        width: z.coerce.number().min(1).max(100).describe('Width as % of page width'),
        height: z.coerce.number().min(1).max(100).describe('Height as % of page height'),
        color: z.string().optional().describe('Stroke color in hex, e.g. "#FF0000". Default: red'),
        fillColor: z.string().optional().describe('Fill color in hex, e.g. "#FFFF00". Optional.'),
        borderWidth: z.coerce.number().int().min(1).max(20).optional().describe('Stroke width in points. Default: 2'),
      },
    },
    async ({ shape, page, x, y, width, height, color, fillColor, borderWidth }) => {
      const normalizedShape = normalizeShape(shape, ['oval', 'rectangle', 'rhombus', 'line', 'arrow']);
      if (!normalizedShape) return nok(`Unknown shape "${shape}" -- use oval, rectangle, rhombus, line, or arrow.`);
      const nc = normalizeColors({ color, fillColor });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ success: boolean; error?: string }>(
        {
          type: 'add_annotation', shape: normalizedShape, page, x, y, width, height,
          color: nc.colors.color ?? null, fillColor: nc.colors.fillColor ?? null, borderWidth: borderWidth ?? null,
        },
        'add_annotation',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error ?? 'failed to add annotation'}`);
          return ok(`Added ${normalizedShape} on page ${page} at (${x}%, ${y}%) size ${width}%×${height}%`);
        },
      );
    },
  );

  server.registerTool(
    'circle_text',
    {
      title: 'Circle Text',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Find all occurrences of a word or phrase in the currently open PDF and draw a shape around each one. If the user has not specified shape or color, ask them before calling. Available shapes: rectangle (default) or oval. Colors: any hex value, e.g. red=#FF0000, blue=#0000FF, green=#00AA00.',
      inputSchema: {
        text: z.string().min(1).describe('Text to search for and circle (case-insensitive)'),
        page: z.coerce.number().int().min(1).optional().describe('Limit to a specific 1-based page number. Omit to circle on all pages.'),
        shape: z.union([z.enum(['rectangle', 'oval']), z.string()]).optional().describe('Shape to draw: rectangle (default) or oval'),
        color: z.string().optional().describe('Stroke color in hex: "#FF0000"=red (default), "#0000FF"=blue, "#00AA00"=green, "#FF6600"=orange'),
        border_width: z.coerce.number().int().min(1).max(20).optional().describe('Border thickness in points: 1=thin, 2=normal (default), 3-5=thick'),
        padding: z.coerce.number().min(0).max(20).optional().describe('Extra space around the text in points. Default: 2'),
      },
    },
    async ({ text, page, shape, color, border_width, padding }) => {
      const normalizedShape = shape === undefined ? 'rectangle' : normalizeShape(shape, ['rectangle', 'oval']);
      if (!normalizedShape) return nok(`Unknown shape "${shape}" -- use rectangle or oval.`);
      const nc = normalizeColors({ color });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ count: number; error?: string }>(
        { type: 'circle_text', text, page: page ?? null, shape: normalizedShape, color: nc.colors.color ?? null, border_width: border_width ?? null, padding: padding ?? null },
        'circle_text',
        15_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          if (d.count === 0) return ok(`No occurrences of "${text}" found.`);
          const where = page ? ` on page ${page}` : '';
          return ok(`Circled ${d.count} occurrence(s) of "${text}"${where}.`);
        },
      );
    },
  );

  server.registerTool(
    'get_selection_info',
    {
      title: 'Get Selection Info',
      annotations: { readOnlyHint: true },
      description: 'Read information about the currently selected text in the PDF editor: the selected text content and its font attributes (family, size, style, colors). Use this before format_selected_text to see what is selected.',
      inputSchema: {},
    },
    async () =>
      pollViewerResult<{ hasSelection: boolean; text?: string; fontAttributes?: Record<string, unknown>; error?: string }>(
        { type: 'get_selection_info' },
        'get_selection_info',
        5_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          if (!d.hasSelection) return ok('No text is currently selected in the editor.');
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
      description: 'Apply font formatting to the currently selected text in the PDF editor. The user must first select text manually in the editor (by dragging the mouse over text while search is active). Call get_selection_info first to confirm what is selected.',
      inputSchema: {
        font_family: z.string().optional().describe('Font family name, e.g. "Helvetica", "Arial", "Times New Roman"'),
        font_size: z.coerce.number().min(1).max(500).optional().describe('Font size in points, e.g. 12'),
        font_style: z.enum(['regular', 'italic', 'bold', 'bold_italic']).optional().describe('Font style'),
        text_color: z.string().optional().describe('Text color in hex: "#FF0000"=red, "#000000"=black. Prefix #FF for full opacity.'),
        highlight_color: z.string().optional().describe('Highlight/background color in hex. Use "#00000000" to remove.'),
        underline_color: z.string().optional().describe('Underline color in hex. Use "#00000000" to remove.'),
        strikeout_color: z.string().optional().describe('Strikeout color in hex. Use "#00000000" to remove.'),
      },
    },
    async ({ font_family, font_size, font_style, text_color, highlight_color, underline_color, strikeout_color }) => {
      const nc = normalizeColors({ text_color, highlight_color, underline_color, strikeout_color });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'format_selected_text', font_family, font_size, font_style, ...nc.colors },
        'format_selected_text',
        8_000,
        (d) => {
          if (!d.success) return nok(d.error ?? 'Failed to format selection');
          return ok('Selected text formatted successfully.');
        },
      );
    },
  );

  server.registerTool(
    'reset_selection',
    {
      title: 'Reset Selection',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Clear the current text selection in the PDF editor (remove the blue highlight from selected text). Call this after get_selection_info or format_selected_text when the selection is no longer needed.',
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
      description: 'Insert a blank page into the currently open PDF. Use after_page: 0 to insert before the first page (new page 1), after_page: N to insert after page N, or omit after_page to append at the end.' + RELAY_SAVE_NOTE_INSTRUCTION,
      inputSchema: {
        after_page: z.coerce.number().int().min(0).optional()
          .describe('1-based page number to insert after. Use 0 to insert as the first page. Omit to append at the end.'),
      },
    },
    async ({ after_page }) => {
      const where = after_page === 0 ? 'as first page'
        : after_page == null ? 'at the end'
        : `after page ${after_page}`;
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'insert_blank_page', after_page: after_page ?? null },
        'insert_blank_page',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error ?? 'failed to insert page'}`);
          return ok(`Inserted blank page ${where}.`);
        },
      );
    },
  );

  server.registerTool(
    'add_image_to_page',
    {
      title: 'Add Image to Page',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Insert an image onto a specific page of the currently open PDF. Use image_svg for any generated/drawn image (SVG XML string -- preferred for Claude-generated graphics, no file needed). Use image_url to download from the internet, or image_path for a local file. Position (x, y) is the bottom-left corner as % of page dimensions (0--100); width is % of page width. Omit position/size to center at 50% page width.' + RELAY_SAVE_NOTE_INSTRUCTION,
      inputSchema: {
        page: z.coerce.number().int().min(1).describe('1-based page number to add the image to'),
        image_svg: z.string().optional().describe('SVG XML string to render as an image. Preferred for Claude-generated graphics -- pass the full SVG markup directly, no file or base64 needed.'),
        image_url: z.string().optional().describe('URL of a remote image to download (PNG or JPEG)'),
        image_path: z.string().optional().describe('Absolute path to a local image file (PNG or JPEG)'),
        x: z.coerce.number().min(0).max(100).optional().describe('Left edge of image as % of page width (0=left edge). Omit to center horizontally.'),
        y: z.coerce.number().min(0).max(100).optional().describe('Bottom edge of image as % of page height (0=bottom). Omit to center vertically.'),
        width: z.coerce.number().min(1).max(100).optional().describe('Image width as % of page width. Omit to use 50% of page width maintaining aspect ratio.'),
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
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'add_image_to_page', page, token, x: x ?? null, y: y ?? null, width: width ?? null },
        'add_image_to_page',
        // Image decode + engine insert can be slow for big images — give it
        // more headroom than the simpler edits.
        30_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error ?? 'failed to add image'}`);
          return ok(`Image added to page ${page}.`);
        },
      );
    },
  );

  server.registerTool(
    'close_document',
    {
      title: 'Close Document',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Close the currently open document in the PDF editor.',
    },
    async () => {
      shared.setViewerCommand({ type: 'close_document' });
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
      pollViewerResult<{ page: number; pageCount: number; title: string; filePath: string; error?: string }>(
        { type: 'get_view_state' },
        'view_state',
        10_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          return ok(`Page ${d.page} of ${d.pageCount}. Title: "${d.title}". File: ${d.filePath || '(unknown)'}`);
        },
      ),
  );

  server.registerTool(
    'set_view_state',
    {
      title: 'Set View State',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Navigate to a specific page in the currently open PDF document.',
      inputSchema: {
        page: z.coerce.number().int().min(1).describe('1-based page number to navigate to'),
      },
    },
    async ({ page }) => {
      shared.setViewerCommand({ type: 'set_view_state', page });
      return { content: [{ type: 'text' as const, text: `Navigating to page ${page}.` + docNote() }] };
    },
  );

  server.registerTool(
    'read_document_information',
    {
      title: 'Read Document Information',
      annotations: { readOnlyHint: true },
      description: 'Read metadata of the CURRENTLY OPEN PDF (returned as fileName/filePath, so check those match the file you actually care about): page count, title, author, creator, producer, creation and modification dates, file size in bytes, and status flags (isSigned, isModified, isReadOnly). This does NOT accept a path — if the file you want info about is not already open (e.g. before planning split_pdf ranges for a file you have not opened yet), call display_pdf/split_pdf/etc. on it FIRST, then call this. Calling this before opening the target file returns a DIFFERENT document\'s metadata, not an error.',
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
        page: z.coerce.number().int().min(1).describe('1-based page number'),
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
        page: z.coerce.number().int().min(1).describe('1-based page number containing the annotation'),
        annotIndex: z.coerce.number().int().min(0).describe('0-based annotation index on that page'),
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
        page: z.coerce.number().int().min(1).describe('1-based page number containing the annotation'),
        annotIndex: z.coerce.number().int().min(0).describe('0-based annotation index from read_annotations'),
        color: z.string().optional().describe('Stroke color in hex, e.g. "#FF0000"'),
        fillColor: z.string().optional().describe('Fill/interior color in hex, e.g. "#FFFF00"'),
        opacity: z.coerce.number().min(0).max(1).optional().describe('Opacity from 0 (transparent) to 1 (opaque)'),
        text: z.string().optional().describe('Text content (only for FreeText annotations)'),
      },
    },
    async ({ page, annotIndex, color, fillColor, opacity, text }) => {
      if (!color && !fillColor && opacity === undefined && text === undefined) {
        return nok('Provide at least one property to change: color, fillColor, opacity, or text.');
      }
      const nc = normalizeColors({ color, fillColor });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'update_annotation', page, annotIndex, color: nc.colors.color ?? null, fillColor: nc.colors.fillColor ?? null, opacity: opacity ?? null, text: text ?? null },
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
        page: z.coerce.number().int().min(1).optional().describe('1-based page number. Omit to read all pages.'),
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
        page: z.coerce.number().int().min(1).describe('1-based page number to render'),
        zoom: z.coerce.number().min(0.1).max(2).optional().describe('Zoom factor (default: 0.5). Use 1.0 for higher resolution.'),
      },
    },
    async ({ page, zoom }) => {
      shared.setViewerResult(null);
      shared.setViewerCommand({ type: 'get_page_image', page, zoom: zoom ?? 0.5 });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 300));
        const pr = shared.peekViewerResult();
        if (pr !== null) {
          if (pr.type !== 'get_page_image') continue;
          const d = pr.data as { base64?: string; error?: string };
          shared.clearViewerResult();
          if (d.error) return { content: [{ type: 'text' as const, text: `Error: ${d.error}` }], isError: true };
          return {
            content: [
              { type: 'text' as const, text: `Page ${page} rendered as PNG.` },
              {
                type: 'image' as const,
                data: d.base64 ?? '',
                mimeType: 'image/png',
              },
            ],
          };
        }
      }
      shared.setViewerCommand(null);
      return { content: [{ type: 'text' as const, text: 'Timed out -- make sure a PDF is open in the editor.' }], isError: true };
    },
  );

  server.registerTool(
    'read_text',
    {
      title: 'Read Text',
      annotations: { readOnlyHint: true },
      description: 'Extract all text content from the currently open PDF document as a plain string. Pages with no extractable text layer (scanned/image-only pages) are automatically OCR\'d -- their text in the result is prefixed with "[OCR]" since recognition accuracy is lower than a real text layer. OCR requires network access to the Avanquest online API and can take significantly longer than plain extraction.',
      inputSchema: {
        pages: z.array(z.coerce.number().int().min(1)).optional().describe('1-based page numbers to read. Omit to read the whole document.'),
      },
    },
    async ({ pages }) =>
      // OCR of scanned pages is an async upload/poll/download round
      // trip to Avanquest's online API (see mcp-app.ts's createApiOperationClient)
      // -- can genuinely take well over the old 30s ceiling, which is what
      // produced the generic "make sure a PDF is open" timeout this ticket
      // reported instead of a real result or a descriptive OCR error.
      pollViewerResult<{ text?: string; error?: string }>(
        { type: 'read_text', pages: pages ?? null },
        'read_text',
        120_000,
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
        page: z.coerce.number().int().min(1).optional().describe('Limit to this 1-based page number. Omit to search all pages.'),
        replaceAll: zBool.optional().describe('Replace all occurrences (default: false -- replace only first match)'),
        caseSensitive: zBool.optional().describe('Case-sensitive match (default: true)'),
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
        page: z.coerce.number().int().min(1).describe('1-based page number the bookmark should point to'),
        title: z.string().optional().describe('Bookmark label. Defaults to "Page N" if omitted.'),
        parentPath: z.array(z.coerce.number().int().min(0)).optional().describe('Path of 0-based indices to the parent bookmark for nesting, e.g. [0] to nest under the first bookmark. Omit for a top-level bookmark.'),
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
        path: z.array(z.coerce.number().int().min(0)).min(1).describe('0-based path to the bookmark, e.g. [0] or [1,2]'),
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
        outputPath: z.string().optional().describe('Where to save the ZIP file. Defaults to the configured default PDF folder (extracted_images.zip).'),
        pages: z.array(z.coerce.number().int().min(1)).optional().describe('1-based page numbers to extract from. Omit to extract from all pages.'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
      },
    },
    async ({ outputPath, pages, format }) => {
      const defaultDir = DEFAULT_PDF_DIR;
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
        outputPath: z.string().optional().describe('Where to save the .fdf file. Defaults to the configured default PDF folder (comments.fdf).'),
      },
    },
    async ({ outputPath }) => {
      const defaultDir = DEFAULT_PDF_DIR;
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
        width: z.coerce.number().min(1).optional().describe('Page width in PDF points (72 pt = 1 inch). A4 = 595, Letter = 612.'),
        height: z.coerce.number().min(1).optional().describe('Page height in PDF points. A4 = 842, Letter = 792.'),
        pages: z.array(z.coerce.number().int().min(1)).optional().describe('1-based page numbers to resize. Omit to resize all pages.'),
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
        pages: z.array(z.coerce.number().int().min(1)).min(1).describe('1-based page numbers to delete'),
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
        pages: z.array(z.coerce.number().int().min(1)).min(1).describe('1-based page numbers to move'),
        afterPage: z.coerce.number().int().min(0).describe('Insert after this 1-based page number. Use 0 to move to the beginning.'),
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
        pages: z.array(z.coerce.number().int().min(1)).min(1).describe('1-based page numbers to duplicate'),
        afterPage: z.coerce.number().int().min(0).optional().describe('Insert copies after this 1-based page number. Use 0 to insert at the beginning. Omit to append at the end.'),
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
        pages: z.array(z.coerce.number().int().min(1)).optional().describe('1-based page numbers to reverse among themselves. Omit to reverse all pages.'),
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
      description: 'List all fillable form fields (AcroForm) in the currently open PDF: names, types, current values, checkbox/radio checked state, checkbox on_value, radio-group option values (in selectable order), and dropdown options (name and export value).',
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
      description: 'Set the value of a fillable form field in the currently open PDF. Call read_form_fields first to get the exact field_name and options. Checkboxes: pass "yes"/"true"/"1" to check (the correct on-value is resolved automatically) or "no"/"false"/"off" to uncheck. Radio groups: pass one of the option values listed in read_form_fields OR a 1-based index ("2" selects the second option). Dropdowns/listboxes: pass an option name or value. Text fields: the literal text. The result reports the value actually applied and fails clearly if the engine did not accept it.',
      inputSchema: {
        field_name: z.string().describe('Exact field name from read_form_fields'),
        value: z.string().describe('New value. Checkbox: yes/no. Radio: an option value or 1-based index. Dropdown: an option name/value. Text: the literal text.'),
      },
    },
    async ({ field_name, value }) =>
      pollViewerResult<{ success: boolean; error?: string; applied_value?: string }>(
        { type: 'update_form_field', field_name, value },
        'update_form_field',
        10_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          const applied = d.applied_value ?? value;
          return ok(`Field "${field_name}" set to "${applied}".`);
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
        page: z.coerce.number().int().min(1).describe('1-based page number'),
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
        page: z.coerce.number().int().min(1).describe('1-based page number'),
        text: z.string().describe('Exact text fragment to find and format'),
        occurrence: z.coerce.number().int().min(1).optional().describe('Which occurrence to format (default: 1). Ignored when all_occurrences is true.'),
        all_occurrences: zBool.optional().describe('Format ALL occurrences of the text on the page at once (default: false)'),
        font_size: z.coerce.number().positive().optional().describe('Font size in points (e.g. 14)'),
        font_family: z.string().optional().describe('Font family name (e.g. "Arial", "Times New Roman")'),
        font_style: z.enum(['regular', 'bold', 'italic', 'bold_italic']).optional().describe('Font style'),
        underline: zBool.optional().describe('true to add black underline, false to remove underline'),
        underline_color: z.string().optional().describe('Underline color as hex (e.g. "#0000FF" for blue). Sets underline independently from text color. Use "#00000000" to remove.'),
        strikeout: zBool.optional().describe('true to add black strikethrough, false to remove'),
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
      const nc = normalizeColors({ underline_color, strikeout_color, text_color, highlight_color });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ success: boolean; applied?: number; error?: string }>(
        { type: 'format_text', page, text, occurrence: occurrence ?? 1, all_occurrences, font_size, font_family, font_style, underline, strikeout, ...nc.colors },
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
        page: z.coerce.number().int().min(1).describe('1-based page number'),
        text: z.string().describe('Text content to display'),
        x: z.coerce.number().min(0).max(100).describe('Left position as % of page width'),
        y: z.coerce.number().min(0).max(100).describe('Top position as % of page height'),
        width: z.coerce.number().min(0).max(100).describe('Width as % of page width'),
        height: z.coerce.number().min(0).max(100).describe('Height as % of page height'),
        font_size: z.coerce.number().positive().optional().describe('Font size in points (default 11)'),
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
      description: 'Add a fillable form field (AcroForm widget) to a page in the currently open PDF. Position and size are percentages of page dimensions (0--100). Use x=0, width=100 to span the full page width. Pass `field_name` to request the internal field name (used by update_form_field/read_form_fields) directly; if omitted, or if the engine does not honor it, one is auto-assigned (e.g. "Text1") -- check the response for the actual name applied. `label` only controls the visible caption text. For `listbox`, size `height` to the number of `options`: about 4--5% of page height per visible option, so the box does not end up mostly empty or so cramped that options overlap.',
      inputSchema: {
        page: z.coerce.number().int().min(1).describe('1-based page number'),
        field_type: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'listbox', 'button']).describe('Field type'),
        x: z.coerce.number().min(0).max(100).describe('Left position as % of page width'),
        y: z.coerce.number().min(0).max(100).describe('Top position as % of page height'),
        width: z.coerce.number().min(0).max(100).describe('Width as % of page width (use 100 for full-width)'),
        height: z.coerce.number().min(0).max(100).describe('Height as % of page height'),
        label: z.string().optional().describe('Caption / label text shown on the field. This is NOT the internal field name -- pass field_name for that.'),
        field_name: z.string().optional().describe('Requested internal field name. Must be unique within the document; the call fails with the list of existing names if it collides. Not guaranteed to be honored by the engine -- always use the field_name in the response for update_form_field/read_form_fields.'),
        default_value: z.string().optional().describe('Initial field value'),
        options: z.array(z.string()).optional().describe('Choice options for dropdown/listbox fields'),
        bg_color: z.string().optional().describe('Background color hex e.g. #FFFFFF'),
        border_color: z.string().optional().describe('Border color hex e.g. #000000'),
      },
    },
    async ({ page, field_type, x, y, width, height, label, field_name, default_value, options, bg_color, border_color }) => {
      const nc = normalizeColors({ bg_color, border_color });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ success: boolean; field_name?: string | null; error?: string }>(
        { type: 'add_form_field', page, field_type, x, y, width, height, label: label ?? null, field_name: field_name ?? null, default_value: default_value ?? null, options: options ?? null, bg_color: nc.colors.bg_color ?? null, border_color: nc.colors.border_color ?? null },
        'add_form_field',
        15_000,
        (d) => {
          if (!d.success) return nok(`Error: ${d.error}`);
          const nameNote = field_name && d.field_name !== field_name
            ? ` Note: requested name "${field_name}" was not applied by the engine -- use "${d.field_name}" for update_form_field/read_form_fields.`
            : '';
          return ok(`Form field added to page ${page}${d.field_name ? ` (field name: "${d.field_name}")` : ''}.${nameNote}`);
        },
      );
    },
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
        { type: 'delete_watermark', range: normalizeRangeList(range) },
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
        { type: 'delete_header', range: normalizeRangeList(range) },
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
        pages: z.array(z.coerce.number().int().min(1)).optional().describe('Specific 1-based page numbers to target. Omit to use range.'),
      },
    },
    async ({ range, pages }) =>
      pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'delete_page_number', range: normalizeRangeList(range), pages: pages ?? null },
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
        page: z.coerce.number().int().min(1).describe('1-based page number (same as all other tools).'),
        block_indices: z.array(z.coerce.number().int().min(0)).min(1).describe('0-based block indices to delete -- use read_page_text_blocks to get them.'),
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
          .describe('Absolute path for the output ZIP file. Defaults to the configured default PDF folder (document_images.zip).'),
      },
    },
    async ({ dpi, output_path }) => {
      const defaultDir = DEFAULT_PDF_DIR;
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
          .describe('Absolute output path for the extracted PDF. Defaults to the configured default PDF folder (extracted_pages.pdf).'),
        file_name: z.string().optional()
          .describe('Filename override for the extracted PDF (without directory). Ignored when output_path is set.'),
      },
    },
    async ({ range, output_path, file_name }) => {
      const defaultDir = DEFAULT_PDF_DIR;
      const savePath = output_path?.trim() || path.join(defaultDir, file_name?.trim() || 'extracted_pages.pdf');
      return pollViewerResult<{ success: boolean; path?: string; extractedPageCount?: number; error?: string }>(
        { type: 'extract_pages', Range: normalizeRangeList(range), outputPath: savePath },
        'extract_pages',
        30_000,
        (d) => {
          if (d.error) return nok(`Error: ${d.error}`);
          const suffix = typeof d.extractedPageCount === 'number'
            ? ` [${d.extractedPageCount} page${d.extractedPageCount !== 1 ? 's' : ''}]`
            : '';
          return ok(`Pages extracted to: ${d.path}${suffix}`);
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
        allow_printing: zBool.optional()
          .describe('Allow printing the document (default: true). Set false to disable printing entirely.'),
        allow_copying: zBool.optional()
          .describe('Allow copying text and images (default: true). Set false to prevent copy-paste.'),
        allow_editing: zBool.optional()
          .describe('Allow editing page content (default: true). Set false to make content read-only.'),
        allow_annotations: zBool.optional()
          .describe('Allow adding or editing annotations and comments (default: true).'),
        allow_forms: zBool.optional()
          .describe('Allow filling form fields (default: true). Set false to lock all form fields.'),
        perm_flags: z.coerce.number().int().optional()
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
        case_sensitive: zBool.optional().describe('Case-sensitive search (default: false).'),
        whole_word: zBool.optional().describe('Match whole words only (default: false).'),
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
        font_size: z.coerce.number().optional().describe('Font size in points. Common values: 8, 10, 12, 14. Default: 12.'),
        font_color: z.string().optional().describe('Font color as hex string. Examples: "#000000" (black), "#FF0000" (red), "#0000FF" (blue), "#808080" (gray). Default: "#000000".'),
        range: z.array(z.string()).optional().describe(
          'Page ranges to add numbers to. Examples: ["all"] (all pages), ["1-5"] (first 5), ["1-3","7","10-12"]. Omit = all pages.'
        ),
        start_number: z.coerce.number().int().min(1).optional().describe(
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
      const nc = normalizeColors({ font_color });
      if (!nc.ok) return nok(nc.error);
      return pollViewerResult<{ success: boolean; error?: string }>(
        { type: 'insert_page_number', fontFamily: font_family ?? 'Arial', fontSize: font_size ?? 12, fontColor: nc.colors.font_color ?? '#000000', format: format ?? '%1%', position: positionValue, range: normalizeRangeList(range), startNumber: start_number ?? 1 },
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
    'get_pending_open',
    {
      title: 'Get Pending Open',
      annotations: { readOnlyHint: true },
      description: 'Internal: return the last PDF open target (url/token/name/command) for the app iframe. Fallback for hosts that strip structuredContent from tool-result notifications.',
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ open: shared.getOpenTarget() }) }],
      };
    },
  );

  registerAppTool(
    server,
    'claim_fullscreen',
    {
      title: 'Claim Fullscreen',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Internal: arbitrate whether a widget iframe is allowed to auto-enter fullscreen. Grants once per document token; later claims for the same token (a remount from scrolling or reopening the chat) are denied.',
      inputSchema: { token: z.string().optional() },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ token }) => {
      const key = token ?? '';
      // Re-read from disk on every claim instead of trusting the Set loaded at
      // startup: in Cowork mode sibling server instances each have their own
      // process, so a grant recorded by one instance must be visible to the
      // others (same cross-instance issue as shared-state.ts).
      const granted = loadFullscreenGrantedTokens();
      const allow = !granted.has(key);
      if (allow) {
        granted.add(key);
        saveFullscreenGrantedTokens(granted);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ allow }) }],
      };
    },
  );

  registerAppTool(
    server,
    'claim_operation',
    {
      title: 'Claim Operation',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Internal: arbitrate whether a widget iframe is allowed to run a file-writing command (compress_pdf/merge_pdf/split_pdf). Grants once per opId; later claims for the same opId (a remount from scrolling or reopening the chat) are denied so the output file is not silently overwritten again — unless that output file is no longer on disk (e.g. the user deleted it), in which case the operation is allowed to run again to recreate it.',
      inputSchema: { opId: z.string().optional(), outputPath: z.string().optional() },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ opId, outputPath }) => {
      // No opId (older cached widget build predating this tool, or a command
      // that never carried one) — fail open rather than silently skip a
      // legitimate first run.
      if (!opId) {
        console.error('[claim_operation] no opId in request — failing open (allow=true)');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ allow: true }) }] };
      }
      const executed = loadExecutedOps();
      const priorPath = executed[opId];
      // Never claimed before -> allow. Claimed before but we don't know its
      // output path (e.g. split_pdf, multiple files) -> deny, same as before.
      // Claimed before with a known output path -> allow again only if that
      // file is now missing from disk.
      const allow = priorPath === undefined || (priorPath !== '' && !existsSync(priorPath));
      debug(`[claim_operation] opId=${opId} priorPath=${priorPath ?? '(none)'} allow=${allow} (${Object.keys(executed).length} executed opIds on file)`);
      if (allow) {
        executed[opId] = outputPath ?? priorPath ?? '';
        saveExecutedOps(executed);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ allow }) }],
      };
    },
  );

  registerAppTool(
    server,
    'get_viewer_command',
    {
      title: 'Get Viewer Command',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Poll for a pending viewer command (rotate, annotate, etc.)',
      inputSchema: { token: z.string().optional() },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ token }) => {
      if (shared.isDocOpenPending()) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ command: null }) }] };
      }
      // Renew THIS widget's own file token on every poll, BEFORE the
      // "latest document" gate below -- an earlier chat turn's widget (see
      // the comment on that gate) is still a legitimately open document
      // that must keep being able to save even though it no longer wins
      // command routing. Gating this on "latest" too (as an earlier version
      // of this fix did) left every non-latest-but-still-open document's
      // token to expire after TOKEN_TTL_MS regardless of it still being
      // actively polled, reproducing the exact "save fails after ~30 min"
      // bug for any document other than the most recently opened one.
      if (token) shared.touchFileToken(token);
      // Earlier chat turns' display_pdf/split_pdf/etc. renders leave
      // their widget iframe mounted (scrolled out of view, not destroyed), and
      // each one independently polls this same shared command channel — with
      // no check here, whichever stale widget's poller tick won the race
      // answered with ITS OWN long-since-irrelevant document, observed as
      // read_document_info's answer flipping between several previously
      // opened files within seconds. Only the widget matching the most
      // recently minted open target is the current one; every other caller —
      // including ones with no token at all, from a widget build that
      // predates this check — must get nothing.
      const latest = shared.getOpenTarget();
      if (!token || (latest?.token && latest.token !== token)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ command: null }) }] };
      }
      const cmd = shared.takeViewerCommand();
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
        count: z.coerce.number().int().min(0).optional(),
        pages: z.array(z.coerce.number().int().min(1)).optional(),
        json: z.string().optional(),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] as const } },
    },
    async ({ type, count, pages, json }) => {
      if (type === 'doc_opened') {
        shared.setDocOpenPending(false);
      } else if (type === 'search') {
        shared.setSearchResult({ count: count ?? 0, pages: pages ?? [] });
      } else if (type === 'auto_save') {
        // A side-channel note from the isModified-driven safety-net
        // save (mcp-app.ts's watchDocumentModifications) — not a poll target
        // for any pending tool call, so it must bypass pendingViewerResult:
        // overwriting that here could clobber a same-tick result some other
        // in-flight pollViewerResult() is still waiting to see.
        try {
          const parsed = json ? JSON.parse(json) : null;
          if (parsed?.path) shared.updateDocState({ lastWorkingFile: parsed.path });
        } catch { /* ignore malformed note */ }
      } else if (json !== undefined) {
        try {
          const parsed = JSON.parse(json);
          if (parsed._pageCount != null) {
            const cp = parsed._currentPage != null ? `page ${parsed._currentPage} of ` : '';
            shared.updateDocState({ lastDocState: `${cp}${parsed._pageCount} pages` });
          }
          if (parsed._workingFile) shared.updateDocState({ lastWorkingFile: parsed._workingFile });
          shared.setViewerResult({ type, data: parsed });
        } catch {
          shared.setViewerResult({ type, data: json });
        }
      }
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );

  // split_pdf/merge_pdf/compress_pdf must return immediately to
  // deliver the open target to the widget (ontoolresult only fires once the
  // host has actually delivered that response) — so their own tool response
  // can't carry the real outcome; the operation is still running when they
  // return. Without a reliable way to learn what actually happened, the model
  // was left to guess, and observably reused a stale answer from an earlier,
  // unrelated read_document_information call instead. This tool waits for the
  // widget's actual completion report and returns the confirmed result.
  server.registerTool(
    'get_last_operation_result',
    {
      title: 'Get Last Operation Result',
      annotations: { readOnlyHint: true },
      description: 'Get the confirmed outcome of the most recent split_pdf, merge_pdf, or compress_pdf call. Those tools return immediately once the operation starts (before it finishes) — call this afterward to learn the actual result (real source page count and output files for split, real merged page count for merge, real before/after size for compress) instead of assuming or repeating an earlier answer.',
    },
    async () => {
      if (shared.isDocOpenPending()) {
        const openDeadline = Date.now() + DOC_OPEN_GRACE_CAP_MS;
        while (shared.isDocOpenPending() && Date.now() < openDeadline) {
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const pr = shared.peekViewerResult();
        if (pr && (pr.type === 'split_done' || pr.type === 'merge_done' || pr.type === 'compress_done')) {
          shared.clearViewerResult();
          const d = pr.data as Record<string, any>;
          if (!d.success) {
            return { content: [{ type: 'text' as const, text: `Operation failed: ${d.error ?? 'unknown error'}` }], isError: true };
          }
          if (pr.type === 'split_done') {
            const fileList = ((d.files ?? []) as Array<{ path: string; pages: number }>)
              .map((f) => `${f.path} [${f.pages} page${f.pages !== 1 ? 's' : ''}]`)
              .join('\n');
            return { content: [{ type: 'text' as const, text: `Split ${d.sourcePages} source page(s) into ${d.files?.length ?? 0} file(s):\n${fileList}` }] };
          }
          if (pr.type === 'merge_done') {
            return { content: [{ type: 'text' as const, text: `Merged ${d.fileCount} file(s) into ${d.outputPath} — ${d.totalPages} total page(s).` }] };
          }
          const pct = d.originalSize ? Math.round((1 - d.compressedSize / d.originalSize) * 100) : 0;
          return { content: [{ type: 'text' as const, text: `Compressed ${d.outputPath}: ${d.originalSize} -> ${d.compressedSize} bytes (${pct}% reduction).` }] };
        }
        await new Promise<void>((r) => setTimeout(r, 300));
      }
      return {
        content: [{ type: 'text' as const, text: 'No pending split_pdf/merge_pdf/compress_pdf result found — either none is currently running, or its result already completed and was consumed by an earlier call to this tool.' }],
        isError: true,
      };
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
          'Render a diagnostics panel that tests what the MCP Apps sandbox allows (workers, wasm, localhost network). For debugging the PDF editor extension.',
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
        description: 'Sandbox capability diagnostics for the Avanquest PDF editor extension.',
        _meta: { ui: { csp: { resourceDomains: [baseUrl], connectDomains: [baseUrl] } } },
      },
      async () => {
        debug('[diag] resource read');
        return {
          contents: [
            {
              uri: diagResourceUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: renderStub(diagTemplate, baseUrl, LICENSE_KEY),
              _meta: { ui: { csp: { resourceDomains: [baseUrl], connectDomains: [baseUrl] } } },
            },
          ],
        };
      },
    );
  }

  registerAppResource(
    server,
    'Avanquest PDF Editor',
    resourceUri,
    {
      description: 'Interactive PDF editor powered by @avanquest/pdf-web-viewer.',
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
          text: renderStub(stubTemplate, baseUrl, LICENSE_KEY),
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
