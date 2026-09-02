// Cross-instance shared state for the command/result channel between MCP tools
// and the viewer widget.
//
// In Claude Desktop a single server process handles both the model's tool calls
// and the widget iframe's callServerTool requests, so plain module-level
// variables were enough. Cowork mode breaks that assumption: the host runs
// SEPARATE server instances — the instance that receives the model's tool call
// (which enqueues a viewer command) is not the instance the widget polls via
// get_viewer_command. A command parked in one process's memory is invisible to
// the other, so every viewer-bound tool timed out with "make sure a PDF is open
// in the viewer" even though the document was open and healthy.
//
// Both instances always run on the same machine as the same user, so the fix is
// to keep this state on disk (same approach as fullscreen-granted-tokens.json)
// instead of in process memory. Files are tiny JSON documents in
// ~/.avanquest-pdf-viewer/ipc/, written atomically (tmp + rename) and read with
// a parse-failure fallback, so a torn read just retries on the next poll tick.
// Single-process mode goes through the same code path — disk is the only store.
//
// Known limitation (unchanged from the in-memory design, where the state was
// already global per server process shared by all conversations): concurrent
// sessions share one channel, so two documents being edited simultaneously can
// interleave commands. Timestamps + TTLs below keep a crashed session's
// leftover files from being mistaken for live traffic.
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const IPC_DIR = path.join(os.homedir(), '.avanquest-pdf-viewer', 'ipc');
const SAVE_DIR = path.join(IPC_DIR, 'saves');

// A command/result older than this is a leftover from a dead session, not live
// traffic — every live consumer polls sub-second while its own call timeout
// (max 30s across the tools) is still running.
const CHANNEL_TTL_MS = 60_000;
// Mirrors DOC_OPEN_GRACE_CAP_MS semantics in server.ts: a doc-open marker that
// was never cleared (widget died mid-open) must not suppress command delivery
// forever.
const DOC_OPEN_TTL_MS = 30_000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
// Orphaned save chunks (export abandoned mid-save, e.g. tab closed) must not
// accumulate forever -- real exports finish in seconds, so this is generous.
const SAVE_BUFFER_TTL_MS = 10 * 60 * 1000;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(path.join(IPC_DIR, file), 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(IPC_DIR, { recursive: true });
    const target = path.join(IPC_DIR, file);
    const tmp = target + `.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf-8');
    try {
      renameSync(tmp, target);
    } catch {
      // Windows can refuse to rename over a file another process holds open at
      // this exact moment. A direct write risks a torn read instead — which the
      // reader's JSON.parse catch turns into a retry on its next poll tick.
      writeFileSync(target, JSON.stringify(value), 'utf-8');
      try { unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
    }
  } catch { /* best-effort: a dropped write surfaces as a poll timeout, not a crash */ }
}

function removeFile(file: string): void {
  try {
    unlinkSync(path.join(IPC_DIR, file));
  } catch { /* already gone */ }
}

function isFresh(ts: number, ttl: number): boolean {
  return Date.now() - ts <= ttl;
}

// ── viewer command (MCP instance -> widget instance) ────────────────────────

export type ViewerCommand = Record<string, unknown>;

export function setViewerCommand(cmd: ViewerCommand | null): void {
  if (cmd === null) removeFile('command.json');
  else writeJson('command.json', { ts: Date.now(), command: cmd });
}

/** Read-and-consume: the widget's poller takes each command exactly once. */
export function takeViewerCommand(): ViewerCommand | null {
  const v = readJson<{ ts: number; command: ViewerCommand }>('command.json');
  if (!v) return null;
  removeFile('command.json');
  return isFresh(v.ts, CHANNEL_TTL_MS) ? v.command : null;
}

// ── viewer result (widget instance -> MCP instance) ─────────────────────────

export type ViewerResult = { type: string; data: unknown };

export function setViewerResult(r: ViewerResult | null): void {
  if (r === null) removeFile('result.json');
  else writeJson('result.json', { ts: Date.now(), ...r });
}

/**
 * Peek without consuming: pollViewerResult() must leave a result whose type it
 * is not waiting for in place (matching the old in-memory `continue` behavior).
 */
export function peekViewerResult(): ViewerResult | null {
  const v = readJson<{ ts: number; type: string; data: unknown }>('result.json');
  if (!v || !isFresh(v.ts, CHANNEL_TTL_MS)) return null;
  return { type: v.type, data: v.data };
}

export function clearViewerResult(): void {
  removeFile('result.json');
}

// ── search result (widget instance -> MCP instance) ─────────────────────────

export type SearchResult = { count: number; pages: number[] };

export function setSearchResult(r: SearchResult | null): void {
  if (r === null) removeFile('search-result.json');
  else writeJson('search-result.json', { ts: Date.now(), ...r });
}

export function takeSearchResult(): SearchResult | null {
  const v = readJson<{ ts: number; count: number; pages: number[] }>('search-result.json');
  if (!v) return null;
  removeFile('search-result.json');
  return isFresh(v.ts, CHANNEL_TTL_MS) ? { count: v.count, pages: v.pages } : null;
}

// ── document-open marker ─────────────────────────────────────────────────────
// Set by display_pdf (MCP instance), cleared by the widget's doc_opened report
// (widget instance). Suppresses command delivery and pauses tool timeouts while
// the viewer is still bootstrapping the document.

export function setDocOpenPending(pending: boolean): void {
  if (pending) writeJson('doc-open.json', { ts: Date.now() });
  else removeFile('doc-open.json');
}

export function isDocOpenPending(): boolean {
  const v = readJson<{ ts: number }>('doc-open.json');
  return v !== null && isFresh(v.ts, DOC_OPEN_TTL_MS);
}

// ── pending open target (get_pending_open fallback) ─────────────────────────

export type OpenTarget = {
  url: string;
  name: string;
  token: string;
  filePath: string;
  command?: Record<string, unknown>;
};

export function setOpenTarget(t: OpenTarget): void {
  writeJson('open-target.json', t);
}

export function getOpenTarget(): OpenTarget | null {
  return readJson<OpenTarget>('open-target.json');
}

// ── docNote inputs (widget instance -> MCP instance) ────────────────────────

export type DocState = { lastDocState: string; lastWorkingFile: string };

export function getDocState(): DocState {
  return readJson<DocState>('doc-state.json') ?? { lastDocState: '', lastWorkingFile: '' };
}

export function updateDocState(patch: Partial<DocState>): void {
  writeJson('doc-state.json', { ...getDocState(), ...patch });
}

export function resetDocState(): void {
  writeJson('doc-state.json', { lastDocState: '', lastWorkingFile: '' });
}

// ── file tokens ──────────────────────────────────────────────────────────────
// Minted by the MCP instance (display_pdf & co), resolved by BOTH instances:
// the widget instance looks tokens up in read_pdf_bytes_by_token / save_pdf and
// the HTTP /file/:token and /mod/file/ routes. Keeping the map on disk is what
// lets a token minted in one process resolve in the other (previously only
// partially worked around via the filePath fallback in read_pdf_bytes_by_token).

export type FileEntry = { fullPath: string; name: string; expiresAt: number; isTemp?: boolean };

type TokenMap = Record<string, FileEntry>;

function loadTokens(): TokenMap {
  return readJson<TokenMap>('tokens.json') ?? {};
}

function pruneTokenMap(tokens: TokenMap): boolean {
  const now = Date.now();
  let changed = false;
  for (const [token, entry] of Object.entries(tokens)) {
    if (entry.expiresAt <= now) {
      if (entry.isTemp) fs.unlink(entry.fullPath).catch(() => {});
      delete tokens[token];
      changed = true;
    }
  }
  return changed;
}

export function pruneExpiredTokens(): void {
  const tokens = loadTokens();
  if (pruneTokenMap(tokens)) writeJson('tokens.json', tokens);
}

export function mintToken(fullPath: string, name: string, isTemp = false): string {
  const tokens = loadTokens();
  pruneTokenMap(tokens);
  const token = randomUUID();
  tokens[token] = { fullPath, name, expiresAt: Date.now() + TOKEN_TTL_MS, isTemp };
  writeJson('tokens.json', tokens);
  return token;
}

export function getFileToken(token: string): FileEntry | null {
  const entry = loadTokens()[token];
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

// A document left open (and polled) for longer than TOKEN_TTL_MS
// had its file token expire out from under it even with zero real idle time
// -- save_pdf then failed with "token expired", but the widget never checked
// that response (see the saveChunked fix), so the user saw "Saved!" for a
// file that was never written. Fixed on two sides: saveChunked now surfaces
// the error, and this renews the token while get_viewer_command's ~800ms
// poller (startViewerCommandPoller) keeps ticking -- i.e. for as long as the
// document is actually open, not just "recently minted". Only rewrites
// tokens.json once the token is past its half-life, not on every poll tick.
export function touchFileToken(token: string): void {
  const tokens = loadTokens();
  const entry = tokens[token];
  if (!entry || entry.expiresAt - Date.now() > TOKEN_TTL_MS / 2) return;
  entry.expiresAt = Date.now() + TOKEN_TTL_MS;
  writeJson('tokens.json', tokens);
}

// ── save_pdf chunk buffers ───────────────────────────────────────
// Chunks of one save_pdf upload used to accumulate in a process-local
// Map<string, Buffer[]>, on the (false, in Cowork mode) assumption that they
// all arrive at the same server instance. When a later chunk lands in a
// different instance, that instance's map never saw the earlier chunks, yet
// the completion check (derived purely from the client-supplied offset)
// still passed -- so the server wrote and reported success on a
// truncated/wrong buffer. Same cross-instance problem as the command/token
// channels above; same fix: keep the partial upload on disk under
// saves/<hash>.part, keyed by a hash of the bufferKey (the raw key can
// contain ':', invalid in Windows filenames).
//
// Each chunk is written at its explicit byte offset (not appended) so the
// result doesn't depend on chunks arriving in order, and a retried chunk call
// overwrites the same bytes instead of duplicating them.

function saveBufferFileName(bufferKey: string): string {
  return createHash('sha256').update(bufferKey).digest('hex') + '.part';
}

export function getSaveBufferPath(bufferKey: string): string {
  return path.join(SAVE_DIR, saveBufferFileName(bufferKey));
}

export async function writeSaveChunk(bufferKey: string, offset: number, chunk: Buffer): Promise<void> {
  await fs.mkdir(SAVE_DIR, { recursive: true });
  // No O_APPEND: a fd opened in append mode ignores the explicit position
  // passed to write() and always writes at EOF, which would break positional
  // writes at `offset`.
  const handle = await fs.open(getSaveBufferPath(bufferKey), fsConstants.O_CREAT | fsConstants.O_WRONLY);
  try {
    await handle.write(chunk, 0, chunk.length, offset);
  } finally {
    await handle.close();
  }
}

export async function getSaveBufferSize(bufferKey: string): Promise<number> {
  try {
    const st = await fs.stat(getSaveBufferPath(bufferKey));
    return st.size;
  } catch {
    return 0;
  }
}

export async function removeSaveBuffer(bufferKey: string): Promise<void> {
  await fs.unlink(getSaveBufferPath(bufferKey)).catch(() => {});
}

export async function pruneStaleSaveBuffers(): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(SAVE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(entries.map(async (e) => {
    if (!e.isFile()) return;
    const full = path.join(SAVE_DIR, e.name);
    try {
      const st = await fs.stat(full);
      if (now - st.mtimeMs > SAVE_BUFFER_TTL_MS) await fs.unlink(full);
    } catch { /* raced with a concurrent finalize/cleanup -- next sweep gets it */ }
  }));
}
