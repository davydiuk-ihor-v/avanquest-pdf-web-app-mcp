import { App } from '@modelcontextprotocol/ext-apps';
import { detectPlatform, isDesktop, isWeb } from './env.js';

const DEBUG_UI = false;

declare global {
  interface Window {
    PWV_CONFIG: { base: string; license: string; proxy: string };
  }
}

type ViewerResult = {
  ui?: {
    pdfWebElement?: {
      destroy?: () => void;
      documentView?: { openFile: (file: File) => Promise<unknown> };
    };
  };
};

const statusEl = document.getElementById('status')!;
const viewerEl = document.getElementById('viewer')!;
// Covers the vendor's own brief "no document open" home screen
// while the first PdfEditor() mount is still loading -- see initEditor().
const viewerMaskEl = document.getElementById('viewer-mask')!;
const { base, license, proxy } = window.PWV_CONFIG;

// Mirrors every boot stage / error to the asset server, which prints it to
// stderr so it lands in Claude Desktop's main.log — our only window into the
// iframe. The sandbox CSP blocks fetch() to this origin but allows script
// imports, so the message travels as a dynamic import's query string.
let beaconSeq = 0;
function beacon(msg: string): void {
  try {
    void import(
      /* @vite-ignore */ `${base}logmod?s=${beaconSeq++}&m=${encodeURIComponent(msg)}`
    ).catch(() => {});
  } catch {
    /* ignore */
  }
}

// Binary transport over the same import channel: the server wraps any asset
// as `export default "<base64>"`.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadBytes(rel: string): Promise<Uint8Array> {
  // The server always answers 200 here (see sendModError in
  // server.ts) so this import() itself can't fail as a bare network error
  // anymore -- a missing/expired file surfaces as `mod.default === null`
  // with `error`/`code` we can act on, instead of a raw TypeError.
  const mod = (await import(/* @vite-ignore */ `${base}mod/${rel}`)) as { default: string | null; error?: string; code?: string | null };
  if (!mod.default) {
    const err = new Error(mod.error || `asset not found: ${rel}`);
    if (mod.code) (err as Error & { code?: string }).code = mod.code;
    throw err;
  }
  return b64ToBytes(mod.default);
}

// The viewer fetches fonts/i18n/manifests from the asset server at runtime;
// reroute any same-origin fetch through the import channel so those work too.
const MIME_BY_EXT: Record<string, string> = {
  json: 'application/json',
  css: 'text/css',
  js: 'application/javascript',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};
const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(base)) {
    const pathname = new URL(url).pathname.replace(/^\//, '');
    const bytes = await loadBytes(pathname);
    const ext = pathname.split('.').pop() ?? '';
    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream' },
    });
  }
  return nativeFetch(input, init);
}) as typeof window.fetch;

let _statusHideTimer: ReturnType<typeof setTimeout> | undefined;
function show(msg: string, isError = false): void {
  if (!isError && !DEBUG_UI) { beacon(msg); return; }
  if (_statusHideTimer !== undefined) { clearTimeout(_statusHideTimer); _statusHideTimer = undefined; }
  statusEl.style.display = 'block';
  statusEl.classList.toggle('status-error', isError);
  statusEl.textContent = msg;
  beacon(isError ? `ERROR: ${msg}` : msg);
  // Auto-dismiss error toasts so they don't linger on screen forever. Success
  // messages are hidden by their own handlers (and aren't shown in production).
  if (isError) {
    _statusHideTimer = setTimeout(() => { statusEl.style.display = 'none'; _statusHideTimer = undefined; }, 6000);
  }
}

// Dedicated, higher-contrast toast for every flow that writes bytes
// to disk via saveChunked() (Save, Save As, Extract Images/Pages, Export
// Comments, Convert to Images, Split, Merge, Compress). Kept separate from
// #status/show() above — that element is a plain text node shared by ~140
// unrelated call sites, so it stays untouched; this one owns its own icon,
// optional file-path line, and optional progress bar.
const saveToastEl = document.getElementById('save-toast')!;
const saveToastIconEl = document.getElementById('save-toast-icon')!;
const saveToastTextEl = document.getElementById('save-toast-text')!;
const saveToastPathEl = document.getElementById('save-toast-path')!;
const saveToastProgressTrackEl = document.getElementById('save-toast-progress-track') as HTMLElement;
const saveToastProgressBarEl = document.getElementById('save-toast-progress-bar') as HTMLElement;

const SAVE_TOAST_ICONS: Record<'success' | 'error', string> = {
  success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
};

let _saveToastHideTimer: ReturnType<typeof setTimeout> | undefined;

function renderSaveToast(state: 'progress' | 'success' | 'error', text: string, opts?: { path?: string; percent?: number }): void {
  if (_saveToastHideTimer !== undefined) { clearTimeout(_saveToastHideTimer); _saveToastHideTimer = undefined; }
  saveToastEl.style.display = 'flex';
  saveToastEl.dataset.state = state;
  saveToastIconEl.innerHTML = state === 'progress' ? '' : SAVE_TOAST_ICONS[state];
  saveToastTextEl.textContent = text;
  if (opts?.path) {
    saveToastPathEl.style.display = 'block';
    saveToastPathEl.textContent = opts.path;
    saveToastPathEl.title = opts.path;
  } else {
    saveToastPathEl.style.display = 'none';
    saveToastPathEl.textContent = '';
    saveToastPathEl.removeAttribute('title');
  }
  if (typeof opts?.percent === 'number') {
    saveToastProgressTrackEl.style.display = 'block';
    saveToastProgressBarEl.style.width = `${Math.max(0, Math.min(100, opts.percent))}%`;
  } else {
    saveToastProgressTrackEl.style.display = 'none';
  }
}

function showSaveProgress(label: string, percent?: number): void {
  const text = typeof percent === 'number' ? `${label}… ${Math.round(percent)}%` : `${label}…`;
  renderSaveToast('progress', text, { percent });
}

function showSaveSuccess(text: string, path?: string): void {
  renderSaveToast('success', text, { path });
  beacon(text + (path ? ` (${path})` : ''));
  _saveToastHideTimer = setTimeout(() => { saveToastEl.style.display = 'none'; _saveToastHideTimer = undefined; }, 4000);
}

function showSaveError(text: string): void {
  renderSaveToast('error', text);
  beacon(`ERROR: ${text}`);
  _saveToastHideTimer = setTimeout(() => { saveToastEl.style.display = 'none'; _saveToastHideTimer = undefined; }, 6000);
}

beacon(`boot: js running, location=${location.href}, base=${base}, license=${license ? 'set' : 'MISSING'}`);

// Clipboard API is blocked by the sandbox permissions policy. Patch writeText
// to fall back to the legacy execCommand so copy/paste works in the viewer.
try {
  const _origClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    get: () => ({
      writeText: async (text: string) => {
        try {
          await _origClipboard.writeText(text);
        } catch {
          const el = document.createElement('textarea');
          el.value = text;
          el.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
          document.body.appendChild(el);
          el.select();
          document.execCommand('copy');
          document.body.removeChild(el);
        }
      },
      readText: () => _origClipboard.readText(),
      read: () => _origClipboard.read(),
      write: (d: ClipboardItems) => _origClipboard.write(d),
    }),
  });
} catch {
  /* ignore if property is non-configurable */
}

// Known-benign vendor teardown race: the in-viewer merge dialog's onDestroy
// removes a document whose worker entry was already disposed when the merged
// result replaced it — closeFile() then throws "Web Worker not found." from
// deep inside the vendor bundle with nothing above it to catch. The merge
// itself completes fine; surfacing this as a full-width error overlay is pure
// noise, so log it via beacon and swallow. Errors this suppresses are by
// definition UNHANDLED leftovers — any operation that genuinely fails on a
// missing worker still reports through its own catch/report path.
function isBenignVendorError(msg: string): boolean {
  return msg.includes('Clipboard') || msg.includes('clipboard')
    || msg.includes('Web Worker not found')
    // Standard browser behavior, not a bug: fires whenever a ResizeObserver
    // callback itself changes layout enough to need another observation
    // pass in the same frame (e.g. the page thumbnail grid reflowing after
    // its own resize). Harmless and unrelated to any operation's outcome.
    || msg.includes('ResizeObserver loop completed with undelivered notifications')
    // Thrown whenever an edit command (Draw, Add text, etc.) hits
    // an owner-password restriction. The vendor's own UI already shows the
    // correct password dialog for this via a separate
    // documentView.ownerPasswordDialogShow() subscription -- this is not a
    // real failure to surface, just noise racing ahead of that dialog. Two
    // different messages observed for this same case depending on the call
    // path: the SDK's own PdfEditorAccessDeniedError ("Owner password is
    // required to perform this operation") and, for annotation-creating
    // commands (createAnnotation -> worker checkError), a message baked into
    // the compiled WASM worker itself ("This action is not allowed by the
    // document's security settings.") -- keep both since either can occur.
    || msg.includes('Owner password is required to perform this operation')
    || msg.includes("This action is not allowed by the document's security settings");
}

// Some document-open failures are well-understood, expected
// limitations (not real bugs) with no vendor-provided fallback UI (unlike
// the owner-password dialog) -- show a friendly replacement instead of the
// raw technical message/stack. XFA (dynamic/static PDF forms) is a genuinely
// unsupported format: the SDK's own Document wrapper constructor throws a
// plain `Error("XFA is not supported.")` synchronously inside its async
// openDocument() (used by both initialDocument and openDocument/openFile),
// so it surfaces as a rejected open promise with no dialog of its own.
function friendlyOpenErrorMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('XFA is not supported')) {
    return 'This PDF uses XFA forms, which this editor does not support. Please use a PDF that doesn\'t rely on XFA forms.';
  }
  return null;
}

// The open failure propagates through several layers (initEditor -> openPdf
// -> ontoolresult's own .catch), each of which used to independently format
// and show(`... failed: ${err.message}\n${err.stack}`) -- once the first
// layer swaps in a friendly message, a plain re-throw still carries an
// Error whose OWN .stack always starts with "Error: <message>", so any
// later layer's "raw" formatting duplicates the friendly text and appends
// stack frames regardless of how clean the message itself is. Mark
// friendly errors explicitly so every layer can tell them apart from a
// genuine technical failure and just show the clean message as-is.
function throwFriendlyOpenError(message: string): never {
  const err = new Error(message);
  (err as Error & { isFriendlyOpenError?: true }).isFriendlyOpenError = true;
  throw err;
}
function isFriendlyOpenError(err: unknown): err is Error {
  return err instanceof Error && (err as Error & { isFriendlyOpenError?: true }).isFriendlyOpenError === true;
}

window.addEventListener('error', (e) => {
  if (isBenignVendorError(e.message ?? '')) { beacon(`suppressed window.error: ${e.message}`); return; }
  show(`window.error: ${e.message}\n${e.filename}:${e.lineno}:${e.colno}`, true);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (isBenignVendorError(msg)) { beacon(`suppressed unhandledrejection: ${msg}`); e.preventDefault(); return; }
  const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack}` : String(e.reason);
  show(`unhandledrejection: ${reason}`, true);
});

// The sandbox document origin (claudemcpcontent.com) differs from the asset
// server, and browsers forbid constructing a Worker from a cross-origin URL.
// Worker-side network may also be restricted, so the page fetches everything
// (worker JS, wasm, data pack — names resolved via manifest.json) and injects
// it into a blob-bootstrapped worker over postMessage. Messages the viewer
// sends before the payload arrives are queued and replayed.
const WORKER_BOOTSTRAP = `
var queued = [];
function report(msg) {
  try { self.postMessage({ __pwv_log__: String(msg) }); } catch (e) {}
}
self.addEventListener('error', function (e) { report('error: ' + (e.message || e)); });
self.addEventListener('unhandledrejection', function (e) {
  report('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason));
});

// XHR shim: the sandbox blocks all worker network, so requests (the wasm's
// license check) are relayed out-of-band. Async requests go to the page over
// postMessage; synchronous ones use blocking importScripts() against the
// asset server's /xhrsync endpoint, which performs the upstream call before
// responding with a script that assigns the result to a global.
var BOOT = null;
var xhrSeq = 0;
var xhrPending = {};
function b64FromBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return btoa(unescape(encodeURIComponent(body)));
  var bytes = body.buffer ? new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength) : new Uint8Array(body);
  var bin = '';
  for (var i = 0; i < bytes.length; i += 65536) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 65536));
  return btoa(bin);
}
function b64ToBuf(b64) {
  var bin = atob(b64 || '');
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function XHRShim() {
  this._headers = {};
  this.readyState = 0;
  this.status = 0;
  this.statusText = '';
  this.response = null;
  this.responseText = '';
  this.responseType = '';
  this.withCredentials = false;
}
XHRShim.prototype.open = function (method, url, async_) {
  this._method = method;
  this._url = String(url);
  this._sync = async_ === false;
  this.readyState = 1;
};
XHRShim.prototype.setRequestHeader = function (k, v) { this._headers[k] = String(v); };
XHRShim.prototype.getAllResponseHeaders = function () { return this._resHeaders || ''; };
XHRShim.prototype.getResponseHeader = function (k) {
  var m = (this._resHeaders || '').match(new RegExp('^' + k + ': (.*)$', 'mi'));
  return m ? m[1] : null;
};
XHRShim.prototype.abort = function () {};
XHRShim.prototype.addEventListener = function (t, fn) { this['on' + t] = fn; };
XHRShim.prototype._finish = function (r) {
  if (!r || r.error) {
    report('XHR shim: relay error for ' + this._url + ': ' + (r && r.error));
    this.status = 0;
    this.readyState = 4;
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.onerror) this.onerror(new Event('error'));
    return;
  }
  this.status = r.status;
  this.statusText = r.statusText || '';
  var hdrs = '';
  if (r.headers) { for (var k in r.headers) hdrs += k + ': ' + r.headers[k] + '\\r\\n'; }
  this._resHeaders = hdrs;
  var buf = r.body !== undefined ? r.body : b64ToBuf(r.bodyB64);
  if (this.responseType === 'arraybuffer') {
    this.response = buf;
  } else {
    this.responseText = new TextDecoder().decode(buf || new ArrayBuffer(0));
    this.response = this.responseText;
  }
  this.readyState = 4;
  if (this.onreadystatechange) this.onreadystatechange();
  if (this.onload) this.onload();
};
XHRShim.prototype.send = function (body) {
  if (this._sync) {
    if (!BOOT) throw new Error('sync XHR before bootstrap payload arrived');
    report('XHR shim (sync): ' + this._method + ' ' + this._url);
    var q =
      't=' + encodeURIComponent(BOOT.token) + '&s=' + (++xhrSeq) +
      '&u=' + encodeURIComponent(this._url) + '&m=' + encodeURIComponent(this._method) +
      '&h=' + encodeURIComponent(btoa(JSON.stringify(this._headers))) +
      '&b=' + encodeURIComponent(b64FromBody(body));
    self.__pwv_xhr_result = null;
    try {
      importScripts(BOOT.base + 'xhrsync?' + q);
    } catch (err) {
      report('XHR shim (sync): importScripts relay failed: ' + err);
      this._finish({ error: String(err) });
      return;
    }
    var r = self.__pwv_xhr_result;
    report('XHR shim (sync): -> ' + (r && (r.status || r.error)));
    this._finish(r);
    return;
  }
  var id = ++xhrSeq;
  xhrPending[id] = this;
  var payload = { id: id, method: this._method, url: this._url, headers: this._headers, responseType: this.responseType };
  var transfer = [];
  if (body != null) {
    if (typeof body === 'string') {
      payload.bodyText = body;
    } else {
      var buf = body.buffer ? body.buffer.slice(body.byteOffset || 0, (body.byteOffset || 0) + body.byteLength) : body;
      payload.bodyBuf = buf;
      transfer.push(buf);
    }
  }
  report('XHR shim: ' + this._method + ' ' + this._url);
  self.postMessage({ __pwv_xhr__: payload }, transfer);
};
self.XMLHttpRequest = XHRShim;
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || !d.__pwv_xhr_res__) return;
  var r = d.__pwv_xhr_res__;
  var x = xhrPending[r.id];
  if (!x) return;
  delete xhrPending[r.id];
  x._finish(r);
});

self.onmessage = function (e) {
  var d = e.data;
  if (d && d.__pwv_boot__) {
    self.onmessage = null;
    BOOT = { base: d.base, token: d.token };
    self.Module = {
      locateFile: function (p) { return d.dir + p; },
      getPreloadedPackage: function () { return d.pkg; },
      onRuntimeInitialized: function () { report('runtime initialized'); },
      onAbort: function (w) { report('ABORT: ' + w); },
      printErr: function (t) { report('stderr: ' + t); }
    };
    if (d.wasmModule) {
      self.Module.instantiateWasm = function (imports, cb) {
        WebAssembly.instantiate(d.wasmModule, imports).then(
          function (inst) { report('wasm instantiated from precompiled module'); cb(inst, d.wasmModule); },
          function (err) { report('instantiateWasm FAILED: ' + err); }
        );
        return {};
      };
    } else {
      self.Module.wasmBinary = d.wasm;
    }
    try {
      importScripts(URL.createObjectURL(new Blob([d.code], { type: 'text/javascript' })));
      report('worker script imported');
    } catch (err) {
      report('importScripts failed: ' + err);
      throw err;
    }
    // Shield the real script's handler from our control messages.
    var real = self.onmessage;
    if (real) {
      self.onmessage = function (ev) {
        var dd = ev.data;
        if (dd && (dd.__pwv_xhr_res__ || dd.__pwv_boot__)) return;
        return real.call(self, ev);
      };
    }
    for (var i = 0; i < queued.length; i++) {
      self.dispatchEvent(new MessageEvent('message', { data: queued[i] }));
    }
    queued = null;
  } else if (queued) {
    queued.push(d);
  }
};
`;

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 65536) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 65536));
  }
  return btoa(bin);
}

type XhrRelayRequest = {
  id: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBuf?: ArrayBuffer;
};

let xhrRelaySeq = 0;
async function relayXhr(worker: Worker, req: XhrRelayRequest): Promise<void> {
  try {
    const bodyB64 = req.bodyBuf
      ? bytesToB64(new Uint8Array(req.bodyBuf))
      : req.bodyText
        ? bytesToB64(new TextEncoder().encode(req.bodyText))
        : '';
    const q =
      `t=${encodeURIComponent(proxy)}&s=${xhrRelaySeq++}` +
      `&u=${encodeURIComponent(req.url)}&m=${encodeURIComponent(req.method)}` +
      `&h=${encodeURIComponent(btoa(JSON.stringify(req.headers ?? {})))}` +
      `&b=${encodeURIComponent(bodyB64)}`;
    const mod = (await import(/* @vite-ignore */ `${base}xhrmod?${q}`)) as { default: string };
    const res = JSON.parse(atob(mod.default)) as {
      error?: string;
      status?: number;
      statusText?: string;
      headers?: Record<string, string>;
      bodyB64?: string;
    };
    if (res.error) throw new Error(res.error);
    const body = b64ToBytes(res.bodyB64 ?? '').buffer as ArrayBuffer;
    worker.postMessage(
      {
        __pwv_xhr_res__: {
          id: req.id,
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          body,
        },
      },
      [body],
    );
  } catch (err) {
    beacon(`xhr relay failed for ${req.url}: ${(err as Error).message}`);
    worker.postMessage({ __pwv_xhr_res__: { id: req.id, error: (err as Error).message } });
  }
}

async function bootstrapWorker(worker: Worker, dir: string): Promise<void> {
  worker.addEventListener('message', (e) => {
    const d = (e as MessageEvent).data as
      | { __pwv_log__?: string; __pwv_xhr__?: XhrRelayRequest }
      | undefined;
    if (d?.__pwv_log__) beacon(`[worker] ${d.__pwv_log__}`);
    if (d?.__pwv_xhr__) void relayXhr(worker, d.__pwv_xhr__);
  });
  try {
    // dir is an absolute URL on the asset server; the /mod/ channel wants the
    // server-relative path (e.g. "public/pwv-workers/"). We request the
    // stable, unhashed alias names — the server resolves each to whatever
    // hashed pdfworker-<hash>.{js,wasm,data} file the installed package
    // actually ships (see the /mod/ route in server.ts), so this needs no
    // update when the package's asset hashes change.
    const rel = new URL(dir).pathname.replace(/^\//, '');
    const jsFile = 'pdfworker.js';
    const wasmFile = 'pdfworker.wasm';
    const dataFile = 'pdfworker.data';
    beacon(`worker bootstrap: loading ${jsFile}, ${wasmFile}, ${dataFile} from /mod/${rel}`);
    const [codeBytes, pkgBytes, wasmBytes] = await Promise.all([
      loadBytes(rel + jsFile),
      loadBytes(rel + dataFile),
      loadBytes(rel + wasmFile),
    ]);
    const code = new TextDecoder().decode(codeBytes);
    const pkg = pkgBytes.buffer as ArrayBuffer;
    // Compile the wasm on the page if possible — the worker context may not be
    // allowed to compile at all; a precompiled Module is structured-clonable.
    let wasmModule: WebAssembly.Module | undefined;
    let wasm: ArrayBuffer | undefined;
    try {
      wasmModule = await WebAssembly.compile(wasmBytes.buffer as ArrayBuffer);
      beacon('worker bootstrap: wasm compiled on page');
    } catch (err) {
      beacon(`worker bootstrap: page wasm compile failed (${(err as Error).message}); passing raw bytes`);
      wasm = wasmBytes.buffer as ArrayBuffer;
    }
    worker.postMessage(
      { __pwv_boot__: true, dir, base, token: proxy, code, pkg, wasmModule, wasm },
      wasm ? [wasm, pkg] : [pkg],
    );
    beacon('worker bootstrap: payload posted');
  } catch (err) {
    beacon(`worker bootstrap FAILED: ${(err as Error).message}`);
    show(`worker bootstrap failed: ${(err as Error).message}`, true);
  }
}

const NativeWorker = window.Worker;
(window as { Worker: unknown }).Worker = class extends NativeWorker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    const raw = String(scriptURL);
    if (!/^https?:/i.test(raw) || new URL(raw).origin === location.origin) {
      super(scriptURL, options);
      return;
    }
    // The viewer may append legacy versioned filenames onto the resolved path
    // (e.g. ".../pdfworker-<hash>.jspdfworker.js?v=..."), so cut at the first
    // "pdfworker" — the bootstrap resolves real filenames from manifest.json.
    const idx = raw.indexOf('pdfworker');
    const dir = idx >= 0 ? raw.slice(0, idx) : raw.slice(0, raw.lastIndexOf('/') + 1);
    super(URL.createObjectURL(new Blob([WORKER_BOOTSTRAP], { type: 'text/javascript' })), options);
    void bootstrapWorker(this, dir);
  }
};

const app = new App(
  { name: 'Avanquest PDF Editor', version: '0.4.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
);
// Command types that mutate the document — after any of these
// reports success, we auto-save the single persistent working copy (see
// autoSaveWorkingCopy below) and stamp its path onto the same report rather
// than touching each of these ~30 handlers individually.
const MUTATING_COMMAND_TYPES = new Set([
  'rotate_pages', 'insert_blank_page', 'add_image_to_page', 'add_annotation', 'circle_text',
  'update_annotation', 'delete_annotation', 'replace_text', 'add_bookmark', 'delete_bookmark',
  'delete_all_bookmarks', 'resize_pages', 'delete_pages', 'move_pages', 'duplicate_pages',
  'reverse_pages', 'undo', 'redo', 'update_document_properties', 'update_form_field',
  'apply_redactions', 'delete_bates_numbering', 'delete_watermark', 'delete_header',
  'delete_page_number', 'insert_page_number', 'delete_text_blocks', 'set_security_permissions',
  'search_and_redact', 'format_text', 'add_text_to_page', 'add_form_field', 'format_selected_text',
]);

// Intercept report_viewer_result to automatically inject current doc state (_pageCount, _currentPage)
// and, for mutating commands, the working-copy path (_workingFile). This gives the server
// fresh page count and save location after every operation so Claude doesn't work with stale state.
{
  const _orig = (app as any).callServerTool.bind(app);
  (app as any).callServerTool = async (params: { name: string; arguments: Record<string, unknown> }) => {
    if (params.name === 'report_viewer_result') {
      try {
        const doc = (activeDocumentView() as any)?.getDocument?.();
        const pages = doc?.getPages?.() as unknown[] | undefined;
        let parsed: any = null;
        if (typeof params.arguments.json === 'string') {
          try { parsed = JSON.parse(params.arguments.json as string); } catch { /* leave null, nothing to augment */ }
        }
        if (parsed) {
          if (pages) {
            parsed._pageCount = pages.length;
            const idx = (activeDocumentView() as any)?.getCurrentPageIndex?.();
            if (typeof idx === 'number') parsed._currentPage = idx + 1;
          }
          const reportType = params.arguments.type as string | undefined;
          if (reportType && MUTATING_COMMAND_TYPES.has(reportType) && parsed.success !== false) {
            const savedPath = await autoSaveWorkingCopy();
            if (savedPath) parsed._workingFile = savedPath;
          }
          params = { ...params, arguments: { ...params.arguments, json: JSON.stringify(parsed) } };
        }
      } catch { /* non-fatal — send original if state unavailable */ }
    }
    return _orig(params);
  };
}

const ICON_EXPAND = `<svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const ICON_SHRINK = `<svg viewBox="0 0 24 24"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;

const fullscreenBtn = document.getElementById('fullscreen-btn') as HTMLButtonElement;
let _currentMode = 'inline';

// Resolves when the current openPdf() call completes (including page-load wait).
// Command poller awaits this before dispatching so stale document state is never read.
let _openingDocument: Promise<void> | null = null;

// Tool handlers used to read a module-level cache variable
// holding "the active document", set once on open and refreshed defensively
// before each command. Any gap in that refresh logic — a remount, a race, a
// command path nobody thought to add a refresh to — let a handler run against
// a stale document. The SDK itself already tracks which document is active
// (getActiveDocumentViewElement()); there is no reason to keep our own copy
// that can drift from it. Every handler calls this instead of reading a
// cached variable, so there is nothing to go stale.
function activeDocumentView(): any {
  return _pdfWebService?.getActiveDocumentViewElement?.()?.documentView ?? null;
}

// This host (Claude Desktop) runs on both Windows and macOS, and
// _currentFilePath reflects whatever OS opened the document ('\'-delimited
// on Windows, '/' on macOS/Linux) -- joining with a hardcoded separator
// produces a mixed-separator path on whichever platform doesn't match it.
// Infer the separator from `dir` itself instead of assuming one.
function joinDirAndName(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}
let _pdfWebService: any = null;
// Headless document loader (result.sdk.openDocument) for opening an
// OCR result File without touching the visible viewer/tabs -- see handleReadText.
let _pdfSdk: any = null;

// Resolved by the global documentOpened$ subscription when a new document finishes loading.
let _resolveDocOpen: (() => void) | null = null;

let _searchRanges: any[] = [];
let _searchRects: (any | null)[] = []; // pre-computed PDF-coord bounding rects per range
let _searchIndex = 0;
let _searchDocumentView: any = null;
// Locked fullscreen height: set once on first fullscreen entry, never shrunk.
// After page rotation the host may re-fire hostcontextchanged with smaller dims
// (landscape page is shorter); we ignore those shrinks while in fullscreen.
let _lockedFullscreenH = 0;
// hostcontextchanged fires more than once per transition, and later firings
// often omit safeAreaInsets entirely (ctx.safeAreaInsets === undefined) even
// though an earlier firing in the very same transition had real values. Cache
// the last known insets so a later insets-less event doesn't reset our
// applied height back to the full (unsafe) container size.
let _lastKnownSafeAreaInsets: { top?: number; right?: number; bottom?: number; left?: number } | null = null;

function updateFullscreenBtn(mode: string) {
  _currentMode = mode;
  const isFs = mode === 'fullscreen';
  fullscreenBtn.innerHTML = isFs ? ICON_SHRINK : ICON_EXPAND;
  fullscreenBtn.title = isFs ? 'Collapse' : 'Expand';
}

fullscreenBtn.addEventListener('click', async () => {
  const next = _currentMode === 'fullscreen' ? 'inline' : 'fullscreen';
  if (next === 'inline') _lockedFullscreenH = 0; // reset lock on manual collapse
  try {
    const result = await (app as any).requestDisplayMode({ mode: next });
    updateFullscreenBtn(result?.mode ?? next);
  } catch (_) {}
});

let _lastFullH = 0;
// Whether the vendor viewer currently has one of its own modal dialogs open
// (detected heuristically below — see detectModalOpen). We only reserve the
// safe-area space (and make body a containing block for fixed descendants)
// while a modal is actually showing; the rest of the time we use the full
// height, so no permanent blank strip is left at the bottom of the widget.
let _modalOpen = false;

function applyContainerHeight(ctx: any) {
  const ctxMode = ctx?.displayMode;
  // Guard: once locked into fullscreen, ignore spurious 'inline' signals from
  // hostcontextchanged (Claude Desktop fires these during tool operations).
  // Only respect inline when user explicitly collapses (_lockedFullscreenH reset then).
  const mode = (_lockedFullscreenH > 0 && ctxMode === 'inline')
    ? 'fullscreen'
    : (ctxMode ?? _currentMode);
  const dims = ctx?.containerDimensions;
  let h: number;
  if (mode === 'fullscreen') {
    if (dims) {
      const fixedH = typeof dims.height === 'number' ? dims.height
        : typeof dims.maxHeight === 'number' ? dims.maxHeight
        : null;
      const candidate = fixedH ?? Math.round(window.screen.availHeight * 0.85);
      // Lock in the largest fullscreen height seen; never shrink due to rotation.
      _lockedFullscreenH = Math.max(_lockedFullscreenH, candidate);
    }
    h = _lockedFullscreenH || Math.round(window.screen.availHeight * 0.85);
  } else {
    h = Math.round(window.screen.availHeight * 0.70);
  }
  if (ctx?.safeAreaInsets) _lastKnownSafeAreaInsets = ctx.safeAreaInsets;
  _lastFullH = h;
  applyHeightForModalState();
}

// Host UI (e.g. the floating chat input box) can float over the top/bottom
// edge of our iframe without our content knowing — safeAreaInsets tells us
// how much of each edge to leave clear. `position: fixed` elements (like the
// vendor viewer's own modal dialogs) always measure themselves against the
// true browser viewport regardless of any height we set on html/body, so we
// only shrink our applied height — and make body the containing block for
// fixed descendants via `transform`, per the CSS spec — WHILE a modal is
// actually open. The rest of the time we use the real full height so no
// permanent blank strip appears.
function applyHeightForModalState(): void {
  const insets = _lastKnownSafeAreaInsets;
  let h = _lastFullH;
  const reserveSafeArea = _modalOpen && !!insets;
  if (reserveSafeArea && insets) {
    const top = typeof insets.top === 'number' ? insets.top : 0;
    const bottom = typeof insets.bottom === 'number' ? insets.bottom : 0;
    h = Math.max(0, h - top - bottom);
  }
  document.documentElement.style.height = `${h}px`;
  document.body.style.height = `${h}px`;
  viewerEl.style.height = `${h}px`;
  document.body.style.transform = reserveSafeArea ? 'translateZ(0)' : '';
  // The area we just carved out (window.innerHeight - h) isn't part of any
  // element's box anymore, but the browser still paints the root element's
  // background across the whole canvas/viewport regardless of its own box
  // height — so colouring <html> to match the dialog's own dimmed backdrop
  // makes that reserved strip blend in instead of showing as a stark white
  // gap. Reset to the page's normal (transparent) background otherwise.
  document.documentElement.style.background = reserveSafeArea ? 'rgba(0, 0, 0, 0.5)' : '';
}

// The vendor viewer mounts as web components (custom elements like
// <document-viewer-wrapper>) with Shadow DOM, so a plain
// document.body.getElementsByTagName('*') traversal never reaches its modal
// dialogs — they live inside a shadowRoot. Walk both light and shadow trees.
function collectAllElements(root: Element | ShadowRoot, out: Element[]): void {
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    out.push(el);
    if (el.shadowRoot) collectAllElements(el.shadowRoot, out);
    collectAllElements(el, out);
  }
}

// The vendor's own header-top row (search/view-options/zoom/user-profile
// cluster — id="pwv-header-top", right-aligned children under
// id="pwv-header-top-right") sits flush against the right edge of its Shadow
// DOM host, leaving no room for our Expand/Collapse button without
// overlapping it. `result.ui.pdfWebElement` (see initEditor) is a
// real custom element mounted with an OPEN shadow root, so we can reach
// straight into it via `.shadowRoot` right after mount instead of polling the
// whole document for a class name. Pad #pwv-header-top so its right-aligned
// content shifts left, then dock our button in the freed space (see
// #fullscreen-btn's `right` offset in mcp-app.html).
//
// Below a 1024px container width the vendor's own `@container` query hides
// #pwv-header-top entirely and #pwv-header-bottom becomes the sole visible
// row, with its own right-aligned group (#pwv-header-bottom-right: the
// relocated search/zoom cluster, the Download button, and — conditionally —
// the translate/e-sign action containers) packed flush against the true
// right edge via `justify-content: flex-end`. Padding the *last* child
// (tried #pwv-header-bottom-mobile-tools first) only adds a gap between it
// and its next sibling — flex-end packs the group as a unit against the
// container's edge regardless, so whichever child ends up last (Download,
// normally) still sits under our button. #pwv-header-bottom itself has the
// same padding/space-between shape as #pwv-header-top, so pad it the same
// way to shift the whole group left at once.
//
// The search panel (.pwv-search-wrapper, opened via the loop/search icon) is
// yet a third, independent case: it's `position: absolute; right: 0.375rem`,
// floating on top of the header row rather than laid out inside it, so it
// ignores both paddings above and its own Close button ends up under ours.
// At container widths <=1024px the vendor's own CSS drops its `max-width`
// cap and pins `right: 0` for an edge-to-edge bar, so widening `right` alone
// would push the whole bar past the left edge — `width` must shrink by the
// same amount to compensate. In the normal (wide) case `max-width` already
// caps the rendered width well below 100%, so the `width` override there is
// a no-op and only `right` matters.
//
// Idempotent via the id check, so safe to call again if the viewer ever
// remounts its shadow root.
function ensureTopBarGap(root: ShadowRoot): void {
  const GAP_STYLE_ID = 'pwv-topbar-gap-style';
  if (root.getElementById(GAP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = GAP_STYLE_ID;
  style.textContent =
    '#pwv-header-top { padding-right: 3.5rem !important; box-sizing: border-box !important; }' +
    '#pwv-header-bottom { padding-right: 3.5rem !important; box-sizing: border-box !important; }' +
    '.pwv-search-wrapper { right: 3rem !important; width: calc(100% - 3rem) !important; }';
  root.appendChild(style);
}

// Heuristic modal detector: we have no documented open/close API from the
// vendor viewer, so watch for a `position: fixed`/`absolute` descendant large
// enough to be a dialog backdrop (its own modals cover most of the viewport)
// appearing or disappearing, and toggle the safe-area reservation accordingly.
function detectModalOpen(): boolean {
  const minW = window.innerWidth * 0.5;
  const minH = window.innerHeight * 0.5;
  const all: Element[] = [];
  collectAllElements(document.body, all);
  for (const el of all) {
    if (el === viewerEl || el === statusEl || el === fullscreenBtn) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < minW || rect.height < minH) continue;
    const pos = window.getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'absolute') return true;
  }
  return false;
}

let _modalCheckScheduled = false;
function scheduleModalCheck(): void {
  if (_modalCheckScheduled) return;
  _modalCheckScheduled = true;
  requestAnimationFrame(() => {
    _modalCheckScheduled = false;
    const open = detectModalOpen();
    if (open !== _modalOpen) {
      _modalOpen = open;
      applyHeightForModalState();
    }
  });
}

new MutationObserver(scheduleModalCheck).observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['style', 'class'],
});
// MutationObserver does not cross shadow DOM boundaries, and the vendor
// viewer's modals live inside a shadowRoot, so opening/closing one may never
// produce a mutation this observer can see. Poll as a reliable fallback —
// cheap enough at this interval for a bounded DOM+shadow-DOM walk.
setInterval(scheduleModalCheck, 120);
// Re-check right after any click (capture phase, so it still fires even if
// the vendor's own Cancel/Apply/close handler stops propagation) — closing a
// dialog is almost always a click, and reacting to it directly feels far
// snappier than waiting for the next poll tick.
document.addEventListener('pointerup', scheduleModalCheck, true);

// While locked into fullscreen, the host sometimes sends a brief spurious
// 'inline' blip during ordinary tool operations that reverts to 'fullscreen'
// again almost immediately — the pre-existing guard below ignores those.
// But clicking the widget's own close ("X") button ALSO sends a genuine,
// sustained 'inline' with no onteardown call, which looks identical to the
// spurious case at the instant it arrives. A guard that ignores it forever
// would leave the widget stuck applying the old locked (large) fullscreen
// height even after closing via "X". Debounce instead: if 'inline' doesn't
// get superseded by a 'fullscreen' signal shortly, treat it as real and
// unlock.
let _inlineConfirmTimer: ReturnType<typeof setTimeout> | undefined;

app.addEventListener('hostcontextchanged', (ctx: any) => {
  const ctxMode = ctx?.displayMode;
  if (ctxMode === 'inline' && _lockedFullscreenH > 0 && _inlineConfirmTimer === undefined) {
    _inlineConfirmTimer = setTimeout(() => {
      _inlineConfirmTimer = undefined;
      _lockedFullscreenH = 0;
      updateFullscreenBtn('inline');
      applyContainerHeight({ displayMode: 'inline' });
    }, 500);
  } else if (ctxMode === 'fullscreen' && _inlineConfirmTimer !== undefined) {
    clearTimeout(_inlineConfirmTimer);
    _inlineConfirmTimer = undefined;
  }
  applyContainerHeight(ctx);
  if (ctx?.displayMode && !(_lockedFullscreenH > 0 && ctx.displayMode === 'inline')) {
    updateFullscreenBtn(ctx.displayMode);
  }
});

// Defensive cleanup for hosts that do send a real ui/resource-teardown
// request before unmounting the widget. Clicking this widget's own close
// ("X") button in Claude Desktop does NOT trigger this at all -- that case
// is fixed by the hostcontextchanged handler above instead. Kept here
// regardless, in case some other host path does invoke it.
app.onteardown = async () => {
  _modalOpen = false;
  document.body.style.transform = '';
  document.documentElement.style.background = '';
  _lockedFullscreenH = 0;
  try {
    const result = await (app as any).requestDisplayMode({ mode: 'inline' });
    updateFullscreenBtn(result?.mode ?? 'inline');
  } catch (_) {}
  return {};
};

const CHUNK_SIZE = 256 * 1024;

let _currentToken = '';
let _currentFilePath = '';

function showSaveDialog(defaultPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:20000;display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;border:1px solid #555;border-radius:8px;padding:20px;width:520px;max-width:90vw;font-family:monospace;color:#ccc';
    // Generic label: this dialog is shared by every export kind (PDF Download,
    // extracted images, split/compress output, etc.), not just the PDF itself.
    box.innerHTML = `<div style="margin-bottom:12px;font-size:14px;color:#fff">Save file as</div>`;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultPath;
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#2d2d2d;border:1px solid #555;border-radius:4px;padding:8px;color:#fff;font-family:monospace;font-size:12px;margin-bottom:14px';

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:6px 14px;background:#333;border:1px solid #555;border-radius:4px;color:#ccc;cursor:pointer';

    const save = document.createElement('button');
    save.textContent = 'Save';
    save.style.cssText = 'padding:6px 14px;background:#0066cc;border:1px solid #0088ff;border-radius:4px;color:#fff;cursor:pointer';

    cancel.onclick = () => { document.body.removeChild(overlay); resolve(null); };
    save.onclick = () => { document.body.removeChild(overlay); resolve(input.value.trim() || null); };

    btns.append(cancel, save);
    box.append(input, btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

async function saveFileBytes(bytes: Uint8Array, defaultPath: string): Promise<void> {
  const savePath = await showSaveDialog(defaultPath);
  if (!savePath) return;
  try {
    await saveChunked(bytes, savePath, 'Saving PDF');
    showSaveSuccess('PDF saved successfully', savePath);
  } catch (err) {
    showSaveError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let editorReady: Promise<ViewerResult> | null = null;

// The vendor's own document-open handling reads the PDF's embedded
// /PageLayout viewer preference (Catalog entry) and, if present, re-applies
// it via setLayout() one tick after open (a deferred setTimeout(...,0) in its
// document-viewer-wrapper) -- silently overriding our own setLayout below.
// PDFs saved with /PageLayout /SinglePage (common alongside bookmarks/
// outlines from some authoring tools) land back in single-page/no-scroll
// mode this way. Guard against that for a short window right after open,
// the same pattern as the zoom-fit race above; stop once it's passed so a
// later, genuine user choice to switch to single-page isn't fought.
const LAYOUT_FIX_WINDOW_MS = 5_000;
const LAYOUT_FIX_POLL_MS = 200;
let _layoutFixInterval: ReturnType<typeof setInterval> | null = null;

function applyDefaultViewSettings(docVm: any): void {
  // A new document replaces whichever one the previous subscription was
  // guarding — stop it so it doesn't keep correcting a stale docVm.
  if (_layoutFixInterval) clearInterval(_layoutFixInterval);
  watchDocumentModifications(docVm);

  // 'continuous' = single-page view WITH scrolling in the vendor's view-mode
  // map (its "Enable scrolling" menu toggle switches single <-> continuous).
  // Scrolling must be enabled by default since the mobile/tablet web-app
  // versions won't be redesigned. Set explicitly rather than relying on the
  // vendor default so this survives vendor bumps.
  try { docVm?.setLayout?.('continuous'); } catch (_) { /* non-fatal */ }

  // The vendor's own re-application of the PDF's /PageLayout viewer
  // preference does NOT go through setLayout() in a way that emits
  // layoutChanged() -- a subscription to that observable never fires even
  // though getLayout() reverts to 'single' a few seconds later. Poll
  // getLayout() instead and force it back for a short window after open;
  // stop once the window passes so a later, genuine user choice to switch to
  // single-page isn't fought.
  const layoutDeadline = Date.now() + LAYOUT_FIX_WINDOW_MS;
  _layoutFixInterval = setInterval(() => {
    if (Date.now() > layoutDeadline) {
      if (_layoutFixInterval) clearInterval(_layoutFixInterval);
      _layoutFixInterval = null;
      return;
    }
    try {
      if (docVm?.getLayout?.() !== 'continuous') docVm?.setLayout?.('continuous');
    } catch (_) { /* non-fatal */ }
  }, LAYOUT_FIX_POLL_MS);
}

// Mount the viewer once. `initialFile`, when given, is opened by the viewer as
// part of initialization (via `initialDocument`) rather than as a separate
// post-init openFile() call — one mount + open instead of two phases.
function initEditor(initialFile?: File): Promise<ViewerResult> {
  if (editorReady) return editorReady;
  editorReady = (async () => {
    show(initialFile ? `opening ${initialFile.name}…` : `loading viewer…`);
    const mod = await import(/* @vite-ignore */ `${base}ui/index.js`).catch((err) => {
      throw new Error(`dynamic import failed: ${(err as Error).message}`);
    });
    const PdfEditor = (mod as { PdfEditor: (opts: Record<string, unknown>) => Promise<ViewerResult> }).PdfEditor;
    if (typeof PdfEditor !== 'function') {
      throw new Error(`PdfEditor not exported. Got: ${typeof PdfEditor}`);
    }
    const result = await PdfEditor({
      container: viewerEl,
      license,
      basePath: `${base}public`,
      openDocumentsInNewTab: false,
      layoutConfig: {        header: {
          activeTab: 'edit',
          tabs: {
            list: {
              edit: {}, page: {}, comment: {}, secure: {},
              fillAndSign: {}, forms: {},
              tools: { tools: ['merge', 'compress'] },
            },
            displayMode: 'embedded',
          },
        },
        topBar: {
          controls: {
            mainMenu: {
              options: {
                createNew: false, open: false, openFromUrl: false,
                print: false, printSelection: false, close: false,
                saveOptimized: false, settings: false, snapshot: false,
              },
            },
            viewOptions: { options: { viewSideBySide: false } },
            snapshot: false,
            print: false,
          },
        },
        navigationBar: {
          enabled: true,
          controls: {
            pageNavigationButtons: true,
            pageNumberInput: true,
            viewSelectButton: false,
            downloadButton: true,
          },
        },
      },
      ...(initialFile ? { initialDocument: { file: initialFile } } : {}),
      // Renamed from onDownloadFile in @avanquest/pdf-web-viewer 0.10.4's
      // rework of save/export handling (IDeviceConfig/customProviders) — same
      // (file: File) => void shape, still fires for Download and every
      // generated artefact (extracted images, split/compress output, etc.)
      // since we don't implement deviceConfig.
      onExportFile: async (file: File) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // This single callback fires for every export kind (Download, extracted
        // images, split/compress output, etc. -- see comment above). Defaulting
        // to `_currentFilePath` unconditionally meant a non-PDF export (e.g. an
        // extracted image) still offered the open document's own name with a
        // .pdf extension, since _currentFilePath is truthy whenever a PDF is
        // open and always won the `||`. Only reuse it for an actual PDF export;
        // otherwise trust the exported file's own name/extension, kept in the
        // same folder as the open document for convenience.
        const isPdfExport = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        const dir = _currentFilePath ? _currentFilePath.replace(/[/\\][^/\\]+$/, '') : '';
        const defaultPath = isPdfExport
          ? (_currentFilePath || file.name)
          : joinDirAndName(dir, file.name);
        await saveFileBytes(bytes, defaultPath);
      },
    });
    const wrapperShadowRoot = (result as any).ui?.pdfWebElement?.shadowRoot as ShadowRoot | undefined;
    if (wrapperShadowRoot) ensureTopBarGap(wrapperShadowRoot);
    const svc = (result as any).ui?.pdfWebService;
    _pdfWebService = svc;
    _pdfSdk = (result as any).sdk;
    // documentOpened$ fires when a document is fully loaded — single authoritative subscription.
    // Handles all subsequent display_pdf calls; the first open is handled separately below.
    svc?.documentOpened$?.subscribe?.((docVm: any) => {
      applyDefaultViewSettings(docVm);
      // Resolve the pending openPdf() Promise so commands are unblocked.
      if (_resolveDocOpen) { const r = _resolveDocOpen; _resolveDocOpen = null; r(); }
      // Notify server that the new document is ready (clears _pendingDocOpen gate).
      (app as any).callServerTool({ name: 'report_viewer_result', arguments: { type: 'doc_opened' } }).catch(() => {});
    });
    const initial = svc?.getActiveDocumentViewElement?.()?.documentView;
    if (initial) applyDefaultViewSettings(initial);

    statusEl.style.display = 'none';
    viewerMaskEl.style.display = 'none';
    return result;
  })().catch((err: unknown) => {
    viewerMaskEl.style.display = 'none';
    const friendly = friendlyOpenErrorMessage(err);
    show(friendly ?? `init failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`, true);
    // Clear the server-side _pendingDocOpen gate even on failure. Without
    // this, a genuinely failed/stuck editor init (bad license, WASM load
    // failure, etc.) left that gate permanently true, and every tool call
    // afterward would first sit through the full doc-open grace window
    // (pollViewerResult in server.ts) before its own timeout even started --
    // turning a fast, correct "nothing is open" failure into a much slower
    // one for no benefit.
    (app as any).callServerTool({ name: 'report_viewer_result', arguments: { type: 'doc_opened' } }).catch(() => {});
    // openPdf()'s caller (ontoolresult) awaits this same promise
    // chain and has its OWN catch that also calls show(err.message, true) --
    // re-throwing the original raw err let that outer show() overwrite the
    // friendly one just displayed above with the raw message/stack again.
    // Re-throw a friendly-only Error instead so every downstream catch that
    // re-displays err.message shows the same friendly text, not the raw one.
    if (friendly) throwFriendlyOpenError(friendly);
    throw err;
  });
  return editorReady;
}

// Shown when a PDF referenced by chat history (or its token) is no
// longer reachable -- e.g. the file was deleted/moved since it was opened, or
// the token expired across a remount. Both fileFromToken paths below funnel
// a "file_not_found" code here instead of surfacing the raw fetch/fs error.
const FILE_NOT_FOUND_MESSAGE = 'The file could not be opened because it no longer exists at the original location.';

async function fileFromToken(token: string, name: string, filePath?: string): Promise<File> {
  // In web contexts (Cowork / claude.ai) dynamic import('http://...') is blocked
  // as mixed content. Use the MCP channel instead.
  if (isWeb(app)) {
    const result = await (app as any).callServerTool({
      name: 'read_pdf_bytes_by_token',
      arguments: { token, filePath },
    });
    const data = JSON.parse(result.content[0].text) as { base64?: string; error?: string; code?: string };
    if (data.code === 'file_not_found') throwFriendlyOpenError(FILE_NOT_FOUND_MESSAGE);
    if (data.error) throw new Error(data.error);
    if (!data.base64) throw new Error('empty response from read_pdf_bytes_by_token');
    return new File([b64ToBytes(data.base64).buffer as ArrayBuffer], name, { type: 'application/pdf' });
  }
  // Desktop: fetch via HTTP import channel.
  const q = filePath ? `?fp=${encodeURIComponent(filePath)}` : '';
  try {
    const bytes = await loadBytes(`file/${token}${q}`);
    return new File([bytes.buffer as ArrayBuffer], name, { type: 'application/pdf' });
  } catch (err) {
    if ((err as Error & { code?: string }).code === 'file_not_found') throwFriendlyOpenError(FILE_NOT_FOUND_MESSAGE);
    throw err;
  }
}

async function openPdf(token: string, name: string, filePath?: string): Promise<void> {
  const file = await fileFromToken(token, name, filePath);
  if (!editorReady) {
    // First open: mount the viewer with the document so it loads during init.
    await initEditor(file);
    // documentOpened$ fires during PdfEditor() init, BEFORE our subscription is wired up.
    // Send doc_opened manually so the server-side _pendingDocOpen gate is cleared.
    (app as any).callServerTool({ name: 'report_viewer_result', arguments: { type: 'doc_opened' } }).catch(() => {});
    return;
  }
  // Viewer already mounted (subsequent display_pdf call): open into it.
  show(`opening ${name}…`);
  const editor = await editorReady;
  const svc = (editor as any).ui?.pdfWebService;
  _pdfWebService = svc;
  _pdfSdk = (editor as any).sdk;

  // openDocument()/openFile() previously raced against a fixed
  // timeout and, on timeout, fell through silently to whatever document was
  // already active — still the PREVIOUS file if the open was merely slow,
  // not actually failed. A command (e.g. split_pdf) then ran against the
  // wrong document. Wait for the SDK's own activeDocumentChanged$ event to
  // confirm the viewer actually switched to the document we asked to open,
  // instead of polling or trusting a stale reference; the timeout below is
  // only an outer abort bound, not a "proceed anyway" fallback.
  let changeSub: { unsubscribe: () => void } | undefined;
  const activeMatch = new Promise<any>((resolve) => {
    const current = svc?.getActiveDocumentViewElement?.()?.documentView;
    if ((current as any)?.getDocument?.()?.name === name) { resolve(current); return; }
    changeSub = svc?.activeDocumentChanged$?.subscribe?.((docVm: any) => {
      if (docVm?.getDocument?.()?.name === name) resolve(docVm);
    });
  });

  let openErr: unknown;
  try {
    if (svc?.openDocument) {
      await svc.openDocument(file);
    } else {
      await (editor.ui?.pdfWebElement?.documentView?.openFile(file) ?? Promise.resolve());
    }
  } catch (err) { openErr = err; /* open error — the activeMatch wait below is the real gate */ }

  const activeVm = await Promise.race([
    activeMatch,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  changeSub?.unsubscribe?.();

  // Unblock the server-side command gate regardless of outcome — a failure here
  // must not leave later tool calls sitting through the doc-open grace window.
  (app as any).callServerTool({ name: 'report_viewer_result', arguments: { type: 'doc_opened' } }).catch(() => {});
  if (!activeVm) {
    // A well-understood open failure (e.g. XFA) never fires
    // activeDocumentChanged$, so it always lands here after the timeout --
    // show the friendly message instead of the generic "didn't switch" one.
    const friendly = friendlyOpenErrorMessage(openErr);
    if (friendly) { show(friendly, true); throwFriendlyOpenError(friendly); }
    const stillActive = (svc?.getActiveDocumentViewElement?.()?.documentView as any)?.getDocument?.()?.name;
    throw new Error(`Viewer did not switch to "${name}" (currently showing "${stillActive ?? 'no document'}") — refusing to run the command against the wrong file.`);
  }
  applyDefaultViewSettings(activeVm);
  statusEl.style.display = 'none';
}

const COMPRESS_QUALITY: Record<string, number> = {
  max: 0.15, high: 0.25, medium: 0.5, low: 0.75, min: 1.0,
};

async function saveChunked(bytes: Uint8Array, targetPath: string, label = 'Saving', silent = false, _isRetry = false): Promise<void> {
  const totalSize = bytes.length;
  // Every call gets its own id so the server never mixes this
  // export's chunks with a concurrent one for the same token (auto-save on
  // command, the debounced isModified auto-save, and manual Save/Save
  // As/Export can all fire close together for the same document).
  const saveId = `${_currentToken}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let offset = 0;
  while (offset < totalSize) {
    const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
    let bin = '';
    for (let i = 0; i < chunk.length; i += 65536) bin += String.fromCharCode(...chunk.subarray(i, i + 65536));
    const result = await (app as any).callServerTool({
      name: 'save_pdf',
      arguments: { token: _currentToken, savePath: targetPath, chunk: btoa(bin), offset, totalSize, saveId },
    });
    // An MCP tool error comes back as a normal resolved result
    // (isError: true / an `error` field in the JSON body), not a rejected
    // promise -- this await alone never caught save_pdf failing (e.g. an
    // expired file token), so every caller's try/catch never fired and
    // saveFileBytes went straight to "PDF saved successfully" regardless.
    const data = JSON.parse((result.content[0] as { text: string }).text) as { error?: string };
    if (data.error) {
      // Renewing the token on every get_viewer_command poll only
      // helps while the widget is actively polling -- a document left open
      // through a long enough background/inactive stretch (throttled iframe,
      // sleep, etc.) can still outlive TOKEN_TTL_MS with no poll ever landing
      // to renew it. _currentFilePath is a real filesystem path for a
      // locally-opened document (for a pdfUrl-based open it's the source URL
      // instead, where refreshing a file token isn't meaningful) -- self-heal
      // by minting a fresh token for that same, still-perfectly-valid file
      // and retrying once, instead of only ever erroring out.
      const isLocalPath = !/^https?:\/\//i.test(_currentFilePath);
      if (!_isRetry && isLocalPath && /token expired/i.test(data.error)) {
        const refreshRes = await (app as any).callServerTool({
          name: 'refresh_file_token',
          arguments: { filePath: _currentFilePath },
        });
        const refreshData = JSON.parse((refreshRes.content[0] as { text: string }).text) as { token?: string; error?: string };
        if (refreshData.token) {
          _currentToken = refreshData.token;
          return saveChunked(bytes, targetPath, label, silent, true);
        }
      }
      throw new Error(data.error);
    }
    offset += chunk.length;
    if (!silent) showSaveProgress(label, (offset / totalSize) * 100);
  }
}

// After every edit, silently re-export the current document into a
// single persistent working copy (<original name>_updated.pdf, next to the
// original) instead of leaving edits unsaved in memory or writing a fresh
// file per action. Re-derives/reuses _workingFilePath per open document —
// reset alongside _currentFilePath wherever a (different) file becomes
// current (see those assignment sites).
let _workingFilePath: string | null = null;

function getWorkingFilePath(): string | null {
  if (!_currentFilePath) return null;
  if (_workingFilePath) return _workingFilePath;
  const dot = _currentFilePath.lastIndexOf('.');
  const base = dot > -1 ? _currentFilePath.slice(0, dot) : _currentFilePath;
  const ext = dot > -1 ? _currentFilePath.slice(dot) : '.pdf';
  // If the file the user opened is already a working copy from a previous
  // session (e.g. they reopened "foo_updated.pdf" directly), keep saving
  // into that same file instead of chaining another "_updated" onto it.
  _workingFilePath = base.endsWith('_updated') ? _currentFilePath : `${base}_updated${ext}`;
  return _workingFilePath;
}

// The command-success trigger below and the debounced isModified
// trigger can both fire within moments of each other for the same edit. Two
// overlapping exports are wasteful even now that the server can no longer
// mix their bytes together, so coalesce: a call that arrives while one is
// already running just waits for it and requests one more run afterward
// (to pick up any edit the in-flight export missed) instead of starting a
// second export of its own.
let _autoSaveInFlight: Promise<string | null> | null = null;
let _autoSaveRerunRequested = false;

async function autoSaveWorkingCopy(): Promise<string | null> {
  if (_autoSaveInFlight) {
    _autoSaveRerunRequested = true;
    return _autoSaveInFlight;
  }
  _autoSaveInFlight = (async () => {
    const targetPath = getWorkingFilePath();
    if (!targetPath) return null;
    try {
      const doc = (activeDocumentView() as any)?.getDocument?.();
      if (!doc) return null;
      const raw = await doc.exportDocument({ as: 'uint8array' });
      const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
      await saveChunked(bytes, targetPath, 'Auto-saving', /* silent */ true);
      return targetPath;
    } catch (err) {
      beacon(`auto-save working copy failed: ${(err as Error).message}`);
      return null;
    }
  })();
  try {
    return await _autoSaveInFlight;
  } finally {
    _autoSaveInFlight = null;
    if (_autoSaveRerunRequested) {
      _autoSaveRerunRequested = false;
      void autoSaveWorkingCopy();
    }
  }
}

// MUTATING_COMMAND_TYPES only catches edits driven by our
// own chat-issued commands. A user editing the document directly through the
// vendor viewer's own UI (dragging an annotation, typing in a form field,
// clicking its built-in rotate button, ...) never goes through that command
// path at all, so it needs an independent signal. `getDocument().onIsModified
// Changed` is backed by the shared undo/redo history and fires for ANY edit
// regardless of origin (confirmed against the SDK source) -- including our
// own commands, hence the debounce so a chat-driven edit doesn't trigger two
// exports back-to-back with the command-type-based save above.
let _autoSaveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleDebouncedAutoSave(): void {
  if (_autoSaveDebounceTimer !== undefined) clearTimeout(_autoSaveDebounceTimer);
  _autoSaveDebounceTimer = setTimeout(async () => {
    _autoSaveDebounceTimer = undefined;
    const savedPath = await autoSaveWorkingCopy();
    if (savedPath) {
      // Not a poll target for any pending tool call -- a side-channel note
      // the server folds into whichever tool response comes next (see
      // report_viewer_result's 'auto_save' handling in server.ts).
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'auto_save', json: JSON.stringify({ success: true, path: savedPath }) },
      }).catch(() => {});
    }
  }, 800);
}

let _isModifiedSub: { unsubscribe: () => void } | null = null;
function watchDocumentModifications(docVm: any): void {
  _isModifiedSub?.unsubscribe();
  _isModifiedSub = null;
  try {
    const doc = docVm?.getDocument?.();
    const sub = doc?.onIsModifiedChanged?.subscribe?.((isModified: boolean) => {
      if (isModified) scheduleDebouncedAutoSave();
    });
    if (sub) _isModifiedSub = sub;
  } catch (_) { /* non-fatal — the command-type-based save still covers chat-driven edits */ }
}

function startViewerCommandPoller(): void {
  // setInterval fires on a fixed clock regardless of whether the
  // previous tick's async callback has finished — a slow command (SDK call,
  // or the auto-save export+upload after every edit) left multiple
  // ticks running concurrently against the active document, racing each
  // other. That's a very plausible source of "PDF stops responding after
  // several operations" and the resulting server-side poll timeout. A single
  // in-flight guard serializes ticks so only one command is ever processed
  // at a time.
  let processing = false;
  setInterval(async () => {
    if (!editorReady || processing) return;
    processing = true;
    try {
      // Pass this widget's own token so the server can tell a stale,
      // still-mounted widget (an earlier chat turn's render) apart from the
      // one covering the model's most recent open — see get_viewer_command.
      const result = await (app as any).callServerTool({ name: 'get_viewer_command', arguments: { token: _currentToken } });
      const { command } = JSON.parse((result.content[0] as { text: string }).text) as { command: Record<string, unknown> | null };
      if (!command) return;
      // Wait for any in-progress document open to complete before executing viewer commands.
      if (_openingDocument) try { await _openingDocument; } catch { /* ignore */ }
      await editorReady;
      if (command.type === 'rotate_pages') {
        await handleRotatePages({ angle: command.angle as number, pages: command.pages as number[] | null });
      } else if (command.type === 'add_annotation') {
        await handleAddAnnotation(command as AnnotationCommand);
      } else if (command.type === 'search_text') {
        await handleSearchText({
          query: command.query as string,
          caseSensitive: command.caseSensitive as boolean,
          wholeWord: command.wholeWord as boolean,
        });
      } else if (command.type === 'navigate_search') {
        await handleNavigateSearch({ direction: command.direction as string });
      } else if (command.type === 'close_document') {
        await handleCloseDocument();
      } else if (command.type === 'get_view_state') {
        await handleGetViewState();
      } else if (command.type === 'set_view_state') {
        await handleSetViewState({ page: command.page as number });
      } else if (command.type === 'read_document_info') {
        await handleReadDocumentInfo();
      } else if (command.type === 'read_page_info') {
        await handleReadPageInfo({ page: command.page as number });
      } else if (command.type === 'delete_annotation') {
        await handleDeleteAnnotation({ page: command.page as number, annotIndex: command.annotIndex as number });
      } else if (command.type === 'read_text') {
        await handleReadText({ pages: command.pages as number[] | null });
      } else if (command.type === 'get_page_image') {
        await handleGetPageImage({ page: command.page as number, zoom: command.zoom as number });
      } else if (command.type === 'update_annotation') {
        await handleUpdateAnnotation({
          page: command.page as number,
          annotIndex: command.annotIndex as number,
          color: command.color as string | null,
          fillColor: command.fillColor as string | null,
          opacity: command.opacity as number | null,
          text: command.text as string | null,
        });
      } else if (command.type === 'replace_text') {
        await handleReplaceText({
          searchText: command.searchText as string,
          replaceWith: command.replaceWith as string,
          page: command.page as number | null,
          replaceAll: command.replaceAll as boolean,
          caseSensitive: command.caseSensitive as boolean,
        });
      } else if (command.type === 'read_annotations') {
        await handleReadAnnotations({ page: command.page as number | null });
      } else if (command.type === 'insert_blank_page') {
        await handleInsertBlankPage({ afterPage: command.after_page as number | null });
      } else if (command.type === 'read_bookmarks') {
        await handleReadBookmarks();
      } else if (command.type === 'add_bookmark') {
        await handleAddBookmark({ page: command.page as number, title: command.title as string | null, parentPath: command.parentPath as number[] });
      } else if (command.type === 'delete_bookmark') {
        await handleDeleteBookmark({ path: command.path as number[] });
      } else if (command.type === 'delete_all_bookmarks') {
        await handleDeleteAllBookmarks();
      } else if (command.type === 'extract_images') {
        await handleExtractImages({ outputPath: command.outputPath as string, pages: command.pages as number[] | null, format: command.format as string });
      } else if (command.type === 'export_comments') {
        await handleExportComments({ outputPath: command.outputPath as string });
      } else if (command.type === 'resize_pages') {
        await handleResizePages({ width: command.width as number, height: command.height as number, pages: command.pages as number[] | null });
      } else if (command.type === 'delete_pages') {
        await handleDeletePages({ pages: command.pages as number[] });
      } else if (command.type === 'move_pages') {
        await handleMovePages({ pages: command.pages as number[], afterPage: command.afterPage as number });
      } else if (command.type === 'duplicate_pages') {
        await handleDuplicatePages({ pages: command.pages as number[], afterPage: command.afterPage as number | null });
      } else if (command.type === 'reverse_pages') {
        await handleReversePages({ pages: command.pages as number[] | null });
      } else if (command.type === 'undo') {
        await handleUndo();
      } else if (command.type === 'redo') {
        await handleRedo();
      } else if (command.type === 'update_document_properties') {
        await handleUpdateDocumentProperties({
          title: command.title as string | null,
          author: command.author as string | null,
          subject: command.subject as string | null,
          keywords: command.keywords as string | null,
        });
      } else if (command.type === 'read_form_fields') {
        await handleReadFormFields();
      } else if (command.type === 'update_form_field') {
        await handleUpdateFormField({
          field_name: command.field_name as string,
          value: command.value as string,
        });
      } else if (command.type === 'read_page_text_blocks') {
        await handleReadPageTextBlocks({ page: command.page as number });
      } else if (command.type === 'format_text') {
        await handleFormatText({
          page: command.page as number,
          text: command.text as string,
          occurrence: (command.occurrence as number) ?? 1,
          all_occurrences: command.all_occurrences as boolean | undefined,
          font_size: command.font_size as number | undefined,
          font_family: command.font_family as string | undefined,
          font_style: command.font_style as string | undefined,
          underline: command.underline as boolean | undefined,
          underline_color: command.underline_color as string | undefined,
          strikeout: command.strikeout as boolean | undefined,
          strikeout_color: command.strikeout_color as string | undefined,
          text_color: command.text_color as string | undefined,
          highlight_color: command.highlight_color as string | undefined,
        });
      } else if (command.type === 'add_image_to_page') {
        await handleAddImageToPage({
          page: command.page as number,
          token: command.token as string,
          x: command.x as number | null,
          y: command.y as number | null,
          width: command.width as number | null,
        });
      } else if (command.type === 'apply_redactions') {
        await handleApplyRedactions();
      } else if (command.type === 'delete_bates_numbering') {
        await handleDeleteBatesNumbering();
      } else if (command.type === 'delete_watermark') {
        await handleDeleteWatermark({ range: command.range as string[] });
      } else if (command.type === 'delete_header') {
        await handleDeleteHeader({ range: command.range as string[] });
      } else if (command.type === 'delete_page_number') {
        await handleDeletePageNumber({ range: command.range as string[] | null, pages: command.pages as number[] | null });
      } else if (command.type === 'insert_page_number') {
        await handleInsertPageNumber({ fontFamily: command.fontFamily as string, fontSize: command.fontSize as number, fontColor: command.fontColor as string, format: command.format as string, position: command.position as number, range: command.range as string[] | null, startNumber: command.startNumber as number });
      } else if (command.type === 'delete_text_blocks') {
        await handleDeleteTextBlocks({ pageIndex: command.pageIndex as number, blockIndices: command.blockIndices as number[] });
      } else if (command.type === 'convert_to_images') {
        await handleConvertToImages({ dpi: command.dpi as number | null, outputPath: command.outputPath as string });
      } else if (command.type === 'extract_pages') {
        await handleExtractPages({ Range: command.Range as string[], outputPath: command.outputPath as string });
      } else if (command.type === 'save_as') {
        await handleSaveAs({ outputPath: command.outputPath as string | null, fileName: command.fileName as string | null });
      } else if (command.type === 'set_security_permissions') {
        await handleSetSecurityPermissions({ userPassword: command.userPassword as string, ownerPassword: command.ownerPassword as string, cryptMethod: command.cryptMethod as number, permFlags: command.permFlags as number });
      } else if (command.type === 'search_and_redact') {
        await handleSearchAndRedact({ text: command.text as string, caseSensitive: command.caseSensitive as boolean, wholeWord: command.wholeWord as boolean });
      } else if (command.type === 'add_text_to_page') {
        await handleAddTextToPage({
          page: command.page as number,
          text: command.text as string,
          x: command.x as number,
          y: command.y as number,
          width: command.width as number,
          height: command.height as number,
          font_size: command.font_size as number | undefined,
        });
      } else if (command.type === 'add_form_field') {
        await handleAddFormField({
          page: command.page as number,
          field_type: command.field_type as string,
          label: command.label as string | null,
          x: command.x as number,
          y: command.y as number,
          width: command.width as number,
          height: command.height as number,
          default_value: command.default_value as string | null,
          options: command.options as string[] | null,
          bg_color: command.bg_color as string | null,
          border_color: command.border_color as string | null,
          field_name: command.field_name as string | null,
        });
      } else if (command.type === 'circle_text') {
        await handleCircleText({
          text: command.text as string,
          page: command.page as number | null,
          shape: command.shape as string,
          color: command.color as string | null,
          border_width: command.border_width as number | null,
          padding: command.padding as number | null,
        });
      } else if (command.type === 'reset_selection') {
        (activeDocumentView() as any)?.resetSelection?.();
        await (app as any).callServerTool({
          name: 'report_viewer_result',
          arguments: { type: 'reset_selection', json: JSON.stringify({ success: true }) },
        });
      } else if (command.type === 'get_selection_info') {
        await handleGetSelectionInfo();
      } else if (command.type === 'format_selected_text') {
        await handleFormatSelectedText({
          font_size: command.font_size as number | undefined,
          font_family: command.font_family as string | undefined,
          font_style: command.font_style as string | undefined,
          text_color: command.text_color as string | undefined,
          highlight_color: command.highlight_color as string | undefined,
          underline_color: command.underline_color as string | undefined,
          strikeout_color: command.strikeout_color as string | undefined,
        });
      }
    } catch (_) {
      /* swallow — individual handlers already report their own errors via show()/report_viewer_result */
    } finally {
      processing = false;
    }
  }, 800);
}

// Report a handler failure back to the server so its pollViewerResult-based
// tool returns the real error to the model instead of sitting out its timeout.
// Success-only reporting was how "add a green square" could fail in the viewer
// while the model confidently told the user it was done.
async function reportFailure(type: string, err: unknown): Promise<void> {
  await (app as any).callServerTool({
    name: 'report_viewer_result',
    arguments: { type, json: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) },
  }).catch(() => {});
}

async function handleRotatePages(data: { angle: number; pages: number[] | null }): Promise<void> {
  try {
    show('Rotating pages…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const totalPages = (doc.getPages() as unknown[]).length;
    const range: number[] = data.pages
      ? data.pages.filter((p) => p >= 1 && p <= totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);
    await (doc as any).rotatePages({ range, angle: data.angle });
    applyContainerHeight(null);
    show(`Rotated ${range.length} page(s) by ${data.angle}°`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    // rotate_pages responds to Claude immediately (fire-and-forget on the server
    // side), so this report can't affect that tool's own reply — but it still
    // feeds the shared _pageCount/_workingFile tracking that the
    // *next* tool call's response will include.
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'rotate_pages', json: JSON.stringify({ success: true }) },
    }).catch(() => {});
  } catch (err) {
    show(`Rotate error: ${err instanceof Error ? err.message : String(err)}`, true);
    await reportFailure('rotate_pages', err);
  }
}

async function handleInsertBlankPage(data: { afterPage: number | null }): Promise<void> {
  try {
    show('Inserting blank page…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const pages = doc.getPages() as Array<{ width?: number; height?: number }>;
    const totalPages = pages.length;

    // index is 0-based insertion position: insertBlankPages inserts BEFORE that index
    let index: number;
    if (data.afterPage === null || data.afterPage === undefined) {
      index = totalPages; // append at end
    } else if (data.afterPage === 0) {
      index = 0; // insert before first page → becomes page 1
    } else {
      index = Math.min(data.afterPage, totalPages); // insert after page N
    }

    // Match dimensions of the adjacent page; fall back to A4
    const refPage = pages[Math.min(index, totalPages - 1)];
    const w = refPage?.width ?? 595;
    const h = refPage?.height ?? 842;

    await (doc as any).insertBlankPages({ index, numBlankPages: 1, rectangle: [0, 0, w, h] });
    applyContainerHeight(null);

    const where = index === 0 ? 'as first page'
      : index >= totalPages ? 'at the end'
      : `after page ${index}`;
    show(`Inserted blank page ${where}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    // See handleRotatePages above: feeds the shared _pageCount/_workingFile
    // tracking for the next tool call.
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'insert_blank_page', json: JSON.stringify({ success: true }) },
    }).catch(() => {});
  } catch (err) {
    show(`Insert page error: ${err instanceof Error ? err.message : String(err)}`, true);
    await reportFailure('insert_blank_page', err);
  }
}

async function handleAddImageToPage(data: {
  page: number;
  token: string;
  x: number | null;
  y: number | null;
  width: number | null;
}): Promise<void> {
  try {
    show('Loading image…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');

    const pages = doc.getPages() as Array<{ width?: number; height?: number }>;
    const pageIndex = data.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) {
      throw new Error(`page ${data.page} out of range (document has ${pages.length} pages)`);
    }
    const page = pages[pageIndex];
    const pw = page?.width ?? 595;
    const ph = page?.height ?? 842;

    // Load image bytes via the /mod/file/{token} channel
    const bytes = await loadBytes(`file/${data.token}`);
    let bin = '';
    for (let j = 0; j < bytes.length; j += 65536)
      bin += String.fromCharCode(...bytes.subarray(j, j + 65536));

    // Detect format: SVG starts with '<', JPEG with FF D8, otherwise PNG
    const isSvg = bytes[0] === 0x3C; // '<'
    const mime = isSvg ? 'image/svg+xml'
      : (bytes[0] === 0xFF && bytes[1] === 0xD8 ? 'image/jpeg' : 'image/png');

    let base64Data: string;
    let naturalWidth: number;
    let naturalHeight: number;

    if (isSvg) {
      // Render SVG to canvas → get PNG base64 and dimensions
      const svgText = new TextDecoder().decode(bytes);
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
      const svgUrl = URL.createObjectURL(svgBlob);
      try {
        const svgImg = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Could not decode SVG'));
          img.src = svgUrl;
        });
        const w = svgImg.naturalWidth || 400;
        const h = svgImg.naturalHeight || 400;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(svgImg, 0, 0);
        base64Data = canvas.toDataURL('image/png').replace(/^data:[^;]+;base64,/, '');
        naturalWidth = w; naturalHeight = h;
      } finally {
        URL.revokeObjectURL(svgUrl);
      }
    } else {
      base64Data = btoa(bin);
      const dims = await new Promise<{ naturalWidth: number; naturalHeight: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
        img.onerror = () => reject(new Error('Could not decode image'));
        img.src = `data:${mime};base64,${base64Data}`;
      });
      naturalWidth = dims.naturalWidth;
      naturalHeight = dims.naturalHeight;
    }
    if (!naturalWidth || !naturalHeight) throw new Error('Image has zero dimensions');

    // Target size in PDF points; default: 50% page width, aspect ratio preserved
    const imgWidthPt = ((data.width ?? 50) / 100) * pw;
    const imgHeightPt = imgWidthPt * (naturalHeight / naturalWidth);

    // Position: bottom-left corner in PDF user space (origin bottom-left, Y up)
    const tx = data.x !== null ? (data.x / 100) * pw : (pw - imgWidthPt) / 2;
    const ty = data.y !== null ? (data.y / 100) * ph : (ph - imgHeightPt) / 2;

    // 2D affine transform [scaleX, 0, 0, scaleY, tx, ty] mapping image pixels to PDF points
    const scale = imgWidthPt / naturalWidth;
    const transform = [scale, 0, 0, scale, tx, ty];

    await (doc as any).insertImageContentElement({ pageIndex, transform, imageData: base64Data });
    applyContainerHeight(null);

    show(`Image added to page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    // See handleRotatePages above: feeds the shared _pageCount/_workingFile
    // tracking for the next tool call.
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'add_image_to_page', json: JSON.stringify({ success: true }) },
    }).catch(() => {});
  } catch (err) {
    show(`Add image error: ${err instanceof Error ? err.message : String(err)}`, true);
    await reportFailure('add_image_to_page', err);
  }
}

// ── Engine call retry ────────────────────────────────────────────────────────
// createAnnotation/changeAnnotationProperties/createTextBlock/
// editPageText occasionally throw a transient native
// `json.exception.type_error.30x` (nlohmann::json) on otherwise-identical,
// minimal params — confirmed by reproducing the exact same call three times
// and getting "type must be string, but is {object|null|number}" for the
// same field each time. Not something our params can be at fault for (we
// weren't varying object/null/number across those calls), and a bare retry
// reliably recovers, so treat it as engine flakiness rather than a data bug.
// Applied at every direct doc/pdfEditor mutation call site rather than only
// the one that first surfaced it, since nothing about this is specific to
// widget creation.
function isTransientEngineError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /json\.exception\.type_error/.test(msg);
}

async function withEngineRetry<T>(fn: () => Promise<T>, attempts = 6, baseDelayMs = 200, label = 'engine call'): Promise<T> {
  // Log every attempt (not just the final failure) via show()'s silent
  // beacon channel, so the full attempt sequence (timing, which attempt
  // succeeded/exhausted, exact error each time) is visible in debug logging
  // instead of only the final outcome shown on failure.
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (i > 0) show(`engineRetry: ${label} succeeded on attempt ${i + 1}/${attempts}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      show(`engineRetry: ${label} attempt ${i + 1}/${attempts} failed: ${msg}`);
      if (i === attempts - 1 || !isTransientEngineError(err)) throw err;
      // Backoff instead of a fixed delay: 3 quick retries weren't enough to
      // reliably clear this (add_form_field still surfaced the error
      // after 3x250ms), so give the engine progressively more time to settle.
      await new Promise<void>((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw new Error('unreachable'); // attempts is always >= 1
}

type AnnotationCommand = {
  shape: string; page: number; x: number; y: number;
  width: number; height: number; color: string | null; fillColor: string | null; borderWidth: number | null;
};

async function handleAddAnnotation(data: AnnotationCommand): Promise<void> {
  try {
    show('Adding annotation…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const pages = (doc.getPages() as unknown[]);
    const pageIndex = data.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) {
      throw new Error(`page ${data.page} out of range (document has ${pages.length} pages)`);
    }
    const page = pages[pageIndex] as { width?: number; height?: number };
    const pw = page.width || 595;
    const ph = page.height || 842;
    const x1 = (data.x / 100) * pw;
    const y2 = ph - (data.y / 100) * ph;
    const x2 = ((data.x + data.width) / 100) * pw;
    const y1 = ph - ((data.y + data.height) / 100) * ph;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const color = data.color ?? '#FF0000';
    const bw = data.borderWidth ?? 2;
    const fill = data.fillColor ?? undefined;
    let params: Record<string, unknown>;
    switch (data.shape) {
      case 'oval':
        params = { T: 'Circle', rect: [x1, y1, x2, y2], color, interior_color: fill, BS: { W: bw } };
        break;
      case 'rectangle':
        params = { T: 'Square', rect: [x1, y1, x2, y2], color, interior_color: fill, BS: { W: bw } };
        break;
      case 'rhombus':
        params = { T: 'Polygon', points: [[cx, y1], [x2, cy], [cx, y2], [x1, cy]], color, interior_color: fill, BS: { W: bw } };
        break;
      case 'line':
        params = { T: 'Line', start: [x1, cy], end: [x2, cy], color, BS: { W: bw } };
        break;
      case 'arrow':
        params = { T: 'Line', start: [x1, cy], end: [x2, cy], end_style: 'OpenArrow', color, BS: { W: bw } };
        break;
      default:
        params = { T: 'Square', rect: [x1, y1, x2, y2], color, BS: { W: bw } };
    }
    await withEngineRetry(() => (doc as any).createAnnotation({ pageIndex, params }));
    show(`Added ${data.shape} on page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    // See handleRotatePages above: feeds the shared _pageCount/_workingFile
    // tracking for the next tool call.
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'add_annotation', json: JSON.stringify({ success: true }) },
    }).catch(() => {});
  } catch (err) {
    show(`Annotation error: ${err instanceof Error ? err.message : String(err)}`, true);
    await reportFailure('add_annotation', err);
  }
}

async function handleCircleText(data: {
  text: string;
  page: number | null;
  shape: string;
  color: string | null;
  border_width: number | null;
  padding: number | null;
}): Promise<void> {
  try {
    show(`Circling "${data.text}"…`);
    const documentView = activeDocumentView();
    if (!documentView) throw new Error('document view not available');
    const doc = (documentView as any).getDocument?.();
    if (!doc) throw new Error('document not available');

    documentView.stopSearch?.();
    let ranges: any[] = [];
    const sub = (documentView as any).onSearchResults().subscribe((r: any[]) => { ranges = r; });
    await (documentView as any).search(data.text, 1); // IgnoreCase=1
    sub.unsubscribe();

    const filterPage = data.page != null ? data.page - 1 : null;
    const filtered = filterPage !== null
      ? ranges.filter((r: any) => (r?.begin?.pageIndex ?? -1) === filterPage)
      : ranges;

    if (filtered.length === 0) {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'circle_text', json: JSON.stringify({ count: 0 }) },
      });
      show(`No matches for "${data.text}"`);
      setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
      return;
    }

    const rects = computeSearchRects(filtered, documentView);
    const pad = data.padding ?? 2;
    const color = data.color ?? '#FF0000';
    const bw = data.border_width ?? 2;
    const annotType = data.shape === 'oval' ? 'Circle' : 'Square';

    let count = 0;
    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      const rect = rects[i];
      if (!rect) continue;
      const pageIndex = r?.begin?.pageIndex ?? 0;
      await withEngineRetry(() => (doc as any).createAnnotation({
        pageIndex,
        params: {
          T: annotType,
          rect: [rect.left - pad, rect.top - pad, rect.right + pad, rect.bottom + pad],
          color,
          BS: { W: bw },
        },
      }));
      count++;
    }

    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'circle_text', json: JSON.stringify({ count }) },
    });
    show(`Circled ${count} occurrence(s) of "${data.text}"`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'circle_text', json: JSON.stringify({ count: 0, error: msg }) },
    });
    show(`Circle text error: ${msg}`, true);
  }
}

function computeSearchRects(ranges: any[], documentView: any): (any | null)[] {
  const doc = (documentView as any).getDocument?.();
  return ranges.map((r: any) => {
    try {
      if (!doc) return null;
      const page = doc.getPage(r.begin?.pageIndex ?? 0);
      if (!page) return null;
      const pageText = page.getPageText?.();
      if (!pageText) return null;
      const ci = r.begin?.charIndex ?? 0;
      const ce = r.end?.charIndex ?? ci + 1;
      let rect: any = null;
      for (let i = ci; i < ce; i++) {
        try {
          const cq = pageText.getCharQuad(i).getBound();
          if (!rect) {
            rect = { left: cq.left, top: cq.top, right: cq.right, bottom: cq.bottom };
          } else {
            rect.left = Math.min(rect.left, cq.left);
            rect.top = Math.min(rect.top, cq.top);
            rect.right = Math.max(rect.right, cq.right);
            rect.bottom = Math.max(rect.bottom, cq.bottom);
          }
        } catch { /* skip bad char */ }
      }
      return rect;
    } catch { return null; }
  });
}

function buildSearchHighlight(): { drawHighlight: (target: any, pageIndex: number) => void } {
  return {
    drawHighlight(target: any, pageIndex: number) {
      for (let i = 0; i < _searchRanges.length; i++) {
        if (i === _searchIndex) continue; // current result is shown by blue selection
        const r = _searchRanges[i];
        if ((r?.begin?.pageIndex ?? -1) !== pageIndex) continue;
        const rect = _searchRects[i];
        if (rect) target.fillRect(rect, 'rgba(255, 220, 0, 0.5)');
      }
    },
  };
}

async function handleSearchText(data: { query: string; caseSensitive: boolean; wholeWord: boolean }): Promise<void> {
  try {
    show(`Searching for "${data.query}"…`);
    const documentView = activeDocumentView();
    if (!documentView) throw new Error('document view not available');

    // Mirror toolbar: stop previous search, clear selection and highlight
    documentView.stopSearch?.();
    documentView.resetSelection?.();
    (documentView as any).setHighlight?.(null);

    // PageTextSearchFlags: IgnoreCase=1, WholeWord=2
    let flags = 0;
    if (!data.caseSensitive) flags |= 1; // IgnoreCase
    if (data.wholeWord) flags |= 2;       // WholeWord

    let lastRanges: any[] = [];
    const sub = documentView.onSearchResults().subscribe((ranges: any[]) => {
      lastRanges = ranges;
    });

    await documentView.search(data.query, flags);
    sub.unsubscribe();

    const count = lastRanges.length;
    const pageSet = new Set<number>();
    for (const r of lastRanges) {
      if (r?.begin?.pageIndex !== undefined) pageSet.add(r.begin.pageIndex + 1);
    }
    const pages = Array.from(pageSet).sort((a: number, b: number) => a - b);

    if (count > 0) {
      _searchRanges = lastRanges;
      _searchRects = computeSearchRects(lastRanges, documentView);
      _searchIndex = 0;
      _searchDocumentView = documentView;
      // selectText() calls setActiveTool(VIEW) which clears highlight — re-set after
      await documentView.selectText(lastRanges[0]);
      (documentView as any).setHighlight?.(buildSearchHighlight());
      (documentView as any).invalidate?.();
    } else {
      _searchRanges = [];
      _searchRects = [];
      _searchDocumentView = null;
    }

    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'search', count, pages },
    });

    if (count === 0) {
      show(`No matches for "${data.query}"`);
    } else {
      show(`${count} match${count === 1 ? '' : 'es'} — result 1 of ${count}`);
    }
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
  } catch (err) {
    show(`Search error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'search', count: 0, pages: [] },
      });
    } catch (_) {}
  }
}

async function handleNavigateSearch(data: { direction: string }): Promise<void> {
  if (_searchRanges.length === 0 || !_searchDocumentView) return;
  if (data.direction === 'next') {
    _searchIndex = (_searchIndex + 1) % _searchRanges.length;
  } else {
    _searchIndex = (_searchIndex - 1 + _searchRanges.length) % _searchRanges.length;
  }
  // selectText() calls setActiveTool(VIEW) which clears highlight — re-set after
  await _searchDocumentView.selectText(_searchRanges[_searchIndex]);
  (_searchDocumentView as any).setHighlight?.(buildSearchHighlight());
  _searchDocumentView.invalidate?.();
  show(`Result ${_searchIndex + 1} of ${_searchRanges.length}`);
  setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
}

async function handleCloseDocument(): Promise<void> {
  try {
    const editor = await editorReady!;
    const docViewEl = (editor as any).ui?.pdfWebService?.getActiveDocumentViewElement?.();
    await docViewEl?.closeDocument?.();
    _currentToken = '';
    _currentFilePath = '';
    _workingFilePath = null;
    _isModifiedSub?.unsubscribe();
    _isModifiedSub = null;
    _searchRanges = [];
    _searchRects = [];
    _searchDocumentView = null;
    show('Document closed');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
  } catch (err) {
    show(`Close error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleGetViewState(): Promise<void> {
  try {
    const documentView = activeDocumentView();
    const doc = (documentView as any)?.getDocument?.();
    const currentPage = ((documentView as any)?.getFocusPage?.() ?? 0) + 1;
    const pageCount = (doc as any)?.getNumPages?.() ?? 0;
    const title: string = (doc as any)?.title ?? '';
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'view_state', json: JSON.stringify({ page: currentPage, pageCount, title, filePath: _currentFilePath }) },
    });
  } catch (err) {
    show(`get_view_state error: ${err instanceof Error ? err.message : String(err)}`, true);
    await reportFailure('view_state', err);
  }
}

async function handleSetViewState(data: { page: number }): Promise<void> {
  try {
    (activeDocumentView() as any)?.goToPage?.(data.page - 1);
    show(`Page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 1500);
  } catch (err) {
    show(`Navigation error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleReadDocumentInfo(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const info: Record<string, unknown> = {
      // This tool has no path argument — it always reports on
      // whichever document is currently active, which is wrong the moment
      // the model calls it to check a file it's about to open (e.g. to plan
      // split ranges) rather than one it already opened. Surfacing the
      // actual open file's name/path lets that mismatch be caught instead of
      // silently used as if it were the file just named in the conversation.
      fileName: doc.name ?? '',
      filePath: doc.filePath ?? _currentFilePath ?? '',
      pageCount: doc.getNumPages?.() ?? 0,
      title: doc.title ?? '',
      author: doc.author ?? '',
      creator: doc.creator ?? '',
      producer: doc.producer ?? '',
      subject: doc.subject ?? '',
      keywords: doc.keywords ?? '',
      createDate: doc.createDate ?? '',
      modifyDate: doc.modifyDate ?? '',
      bookmarksCount: doc.bookmarksCount ?? 0,
      size: doc.size ?? 0,
      isSigned: doc.isSigned ?? false,
      isModified: doc.isModified ?? false,
      isReadOnly: doc.isReadOnly ?? false,
      ownerPasswordRequired: ownerPasswordRequired(doc),
    };
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'document_info', json: JSON.stringify(info) },
    });
  } catch (err) {
    show(`read_document_info error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'document_info', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleReadAnnotations(data: { page: number | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const results: any[] = [];
    const pageCount = (doc.getNumPages?.() ?? 0) as number;
    const startPage = data.page !== null ? data.page - 1 : 0;
    const endPage = data.page !== null ? data.page - 1 : pageCount - 1;
    for (let pi = startPage; pi <= endPage; pi++) {
      // Read annotations off the document's own public `annotations`
      // model (doc.getPage(i).annotations) instead of the vendor SDK's
      // internal `pdfEditor.getPageAnnotations()` -- (doc as any).pdfEditor
      // was reaching for a true JS private class field the SDK never exposes
      // (confirmed against the shipped 0.10.6 bundle and its .d.ts: no
      // DocumentModel/PageModel property is ever named pdfEditor), so it was
      // always undefined, not merely slow to attach.
      const page = (doc as any).getPage?.(pi);
      const annots: any[] = page?.annotations ?? [];
      annots.forEach((ann: any, idx: number) => {
        const rect = ann.rect;
        results.push({
          page: pi + 1,
          index: idx,
          type: ann.type ?? 'unknown',
          color: ann.color ?? null,
          content: ann.content ?? '',
          rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        });
      });
    }
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'read_annotations', json: JSON.stringify({ annotations: results }) },
    });
  } catch (err) {
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'read_annotations', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleGetPageImage(data: { page: number; zoom: number }): Promise<void> {
  try {
    const pageIndex = data.page - 1;
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const result = await (doc as any).getPagePreview({ pageIndex, dpr: 1, zoom: data.zoom });
    const bytes: Uint8Array = result.body;
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...(bytes.subarray(i, i + chunk) as unknown as number[]));
    }
    const base64 = btoa(binary);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'get_page_image', json: JSON.stringify({ base64 }) },
    });
  } catch (err) {
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'get_page_image', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

// Reads one page's text via the same PageText mechanism regardless
// of whether `doc` is the live viewer document or a headless document opened
// just to read back an OCR result (see handleReadText) -- both expose the
// same getPages()/loadPageContent()/getPageText() surface.
async function getPageTextString(doc: any, pageIndex: number): Promise<string> {
  const pageModel = (doc.getPages() as any[])[pageIndex];
  if (!pageModel.isLoaded) await doc.loadPageContent(pageModel);
  const pt = pageModel.getPageText();
  const numChars = pt.getNumChars();
  let text = '';
  for (let i = 0; i < numChars; i++) text += pt.getCharUnicode(i);
  return text;
}

// Online-tool commands (document.ocr/convert/translate) take a
// caller-supplied IApiOperationClient -- the SDK ships no default
// implementation, integrators are expected to provide their own. The actual
// HTTP work can't happen here though: this iframe's sandbox CSP blocks
// fetch() to arbitrary origins (see beacon()'s comment near the top of this
// file -- it can't even fetch() its own local server). So this client
// forwards the SDK-built formData to the MCP server (ocr_upload_chunk +
// ocr_run, server.ts), which does the real start/poll/download against
// https://developers.avanquest.com/api-reference/getting-started, and reads
// the result back the same way display_pdf's web-mode fallback already does
// (fileFromToken).
function createApiOperationClient() {
  return {
    async execute(_endpoints: { start: string }, formData: FormData) {
      const file = formData.get('file') as File;
      const pages = formData.get('pages') as string | null;
      const password = formData.get('password') as string | null;
      const language = formData.get('language') as string | null;
      const deskew = formData.get('deskew') as string | null;

      const bytes = new Uint8Array(await file.arrayBuffer());
      const totalSize = bytes.length;
      const ocrId = `ocr:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      let offset = 0;
      while (offset < totalSize) {
        const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
        let bin = '';
        for (let i = 0; i < chunk.length; i += 65536) bin += String.fromCharCode(...chunk.subarray(i, i + 65536));
        await (app as any).callServerTool({
          name: 'ocr_upload_chunk',
          arguments: { ocrId, chunk: btoa(bin), offset, totalSize },
        });
        offset += chunk.length;
      }

      const runRes = await (app as any).callServerTool({
        name: 'ocr_run',
        arguments: {
          ocrId, totalSize,
          pages: pages ?? undefined,
          password: password ?? undefined,
          language: language ?? undefined,
          deskew: deskew === 'true',
        },
      });
      const runData = JSON.parse(runRes.content[0].text) as { token?: string; error?: string };
      if (runData.error) return { finalStatus: { status: 'failed', error: { message: runData.error } } };

      const resultFile = await fileFromToken(runData.token!, 'ocr-result.pdf');
      const ab = await resultFile.arrayBuffer();
      return {
        finalStatus: { status: 'completed' },
        download: { ab, filename: 'ocr-result.pdf', contentType: 'application/pdf' },
      };
    },
  };
}

async function handleReadText(data: { pages: number[] | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const numPages = (doc.getPages() as unknown[]).length;
    const pageIndices = data.pages && data.pages.length > 0
      ? data.pages.map((p) => p - 1).filter((i) => i >= 0 && i < numPages)
      : Array.from({ length: numPages }, (_, i) => i);

    const pageText = new Map<number, { text: string; ocr: boolean }>();
    const noTextPages: number[] = [];
    for (const idx of pageIndices) {
      const text = await getPageTextString(doc, idx);
      if (text.length === 0) noTextPages.push(idx);
      else pageText.set(idx, { text, ocr: false });
    }

    if (noTextPages.length > 0) {
      let ocrResult: any;
      try {
        ocrResult = await (doc as any).ocr({
          pages: noTextPages,
          deskew: true,
          client: createApiOperationClient(),
          callback: () => {},
          abortSignal: new AbortController().signal,
        });
      } catch (err) {
        throw new Error(`OCR failed for page(s) ${noTextPages.map((i) => i + 1).join(', ')}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Headless: reads the OCR result's text without touching the visible
      // viewer/tabs. ocrResult.file's pages correspond 1:1, in order, to the
      // noTextPages indices we requested (per document.ocr()'s own page
      // subset extraction), so map back by position.
      const ocrDoc = await _pdfSdk.openDocument({ file: ocrResult.file, readOnly: true });
      for (let i = 0; i < noTextPages.length; i++) {
        const ocrText = await getPageTextString(ocrDoc, i);
        pageText.set(noTextPages[i], { text: ocrText, ocr: true });
      }
    }

    const PAGE_SEPARATOR = '------------------------------';
    const text = pageIndices
      .map((idx) => {
        const entry = pageText.get(idx);
        if (!entry) return '';
        return entry.ocr ? `[OCR] ${entry.text}` : entry.text;
      })
      .join(`\n${PAGE_SEPARATOR}\n`);

    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'read_text', json: JSON.stringify({ text }) },
    });
  } catch (err) {
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'read_text', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleUpdateAnnotation(data: { page: number; annotIndex: number; color: string | null; fillColor: string | null; opacity: number | null; text: string | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageIndex = data.page - 1;
    // changeAnnotationProperties is a public method directly on
    // DocumentModel (data: {pageIndex, annotIndex, properties}, type:
    // AnnotsTypes) -- it never took a documentId, and never lived on
    // doc.pdfEditor (see handleReadAnnotations above for why that was always
    // undefined). The `type` argument is required by the worker to know which
    // annotation subtype it's patching, read off the existing annotation.
    const page = (doc as any).getPage?.(pageIndex);
    const annotation = page?.annotations?.[data.annotIndex];
    if (!annotation) throw new Error(`annotation ${data.annotIndex} not found on page ${data.page}`);
    const properties: Record<string, unknown> = {};
    if (data.color !== null) properties['C'] = data.color;
    if (data.fillColor !== null) properties['IC'] = data.fillColor;
    if (data.opacity !== null) { properties['CA'] = data.opacity; properties['ca'] = data.opacity; }
    if (data.text !== null) properties['c'] = data.text;
    await withEngineRetry(() => (doc as any).changeAnnotationProperties({ pageIndex, annotIndex: data.annotIndex, properties }, annotation.type));
    show(`Updated annotation ${data.annotIndex} on page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'update_annotation', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`update_annotation error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'update_annotation', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteAnnotation(data: { page: number; annotIndex: number }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageIndex = data.page - 1;
    await (doc as any).deleteAnnotations({ pageIndex, annotIds: [data.annotIndex] });
    show(`Deleted annotation ${data.annotIndex} on page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_annotation', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_annotation error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_annotation', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleReadPageInfo(data: { page: number }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageIndex = data.page - 1;
    const page = doc.getPage?.(pageIndex);
    if (!page) throw new Error(`page ${data.page} not found`);
    const info = { page: data.page, width: page.width, height: page.height, rotation: page.rotate };
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'page_info', json: JSON.stringify(info) },
    });
  } catch (err) {
    show(`read_page_info error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'page_info', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleReplaceText(data: { searchText: string; replaceWith: string; page: number | null; replaceAll: boolean; caseSensitive: boolean }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');

    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    const startPage = data.page !== null ? data.page - 1 : 0;
    const endPage = data.page !== null ? data.page - 1 : totalPages - 1;

    let count = 0;
    const search = data.caseSensitive ? data.searchText : data.searchText.toLowerCase();

    outer:
    for (let pi = startPage; pi <= endPage; pi++) {
      const page = doc.getPage?.(pi);
      // textBlocks may live on the page model under doc.pages or directly on getPage() result
      const pageModel = (doc as any).pages?.[pi] ?? page;
      const textBlocks: any[] = (pageModel as any)?.textBlocks ?? [];

      for (let bi = 0; bi < textBlocks.length; bi++) {
        const block = textBlocks[bi];
        const paragraphs: any[] = (block as any)?.paragraphs ?? [];

        // Gather full text of the block to find positions
        let blockText = '';
        for (const para of paragraphs) {
          const lines: any[] = para?.getLines?.() ?? [];
          for (const line of lines) {
            blockText += (line?.text ?? '');
          }
        }

        const haystack = data.caseSensitive ? blockText : blockText.toLowerCase();
        let offset = 0;
        let pos = haystack.indexOf(search, offset);
        while (pos !== -1) {
          await (doc as any).replaceText?.({
            pageIndex: pi,
            textblockIndex: bi,
            charPosition: pos,
            charCount: data.searchText.length,
            text: data.replaceWith,
            font: {},
          });
          count++;
          if (!data.replaceAll) break outer;

          // Rebuild block text after replacement (length may differ)
          blockText = blockText.slice(0, pos) + data.replaceWith + blockText.slice(pos + data.searchText.length);
          offset = pos + data.replaceWith.length;
          pos = (data.caseSensitive ? blockText : blockText.toLowerCase()).indexOf(search, offset);
        }
      }
    }

    if (count > 0) {
      show(`Replaced ${count} occurrence${count === 1 ? '' : 's'} of "${data.searchText}"`);
      setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    }

    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'replace_text', json: JSON.stringify({ count }) },
    });
  } catch (err) {
    show(`replace_text error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'replace_text', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

// A document with owner-level restrictions (security.requiresOwnerPassword)
// that hasn't been unlocked yet (security.knownOwnerPassword empty) still
// "opens" and renders its already-loaded pages, but the underlying engine
// treats it as a locked shell for anything requiring a deeper parse (e.g.
// bookmarks) — reporting misleadingly empty results ("no bookmarks, 2
// pages") instead of a clear "this needs a password" error.
function ownerPasswordRequired(doc: any): boolean {
  return !!doc?.security?.requiresOwnerPassword && !doc?.security?.knownOwnerPassword;
}

async function handleReadBookmarks(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    if (ownerPasswordRequired(doc)) {
      throw new Error('This document has an owner password set. Its bookmarks cannot be read until it is unlocked with that password.');
    }
    const raw: any[] = doc.bookmarks ?? [];
    const result: { path: number[]; title: string; page: number }[] = [];
    const walk = (items: any[], parentPath: number[]) => {
      items.forEach((b, i) => {
        const path = [...parentPath, i];
        // doc.bookmarks returns parsed PdfBookmark instances (not raw JSON).
        // The page index lives in the first goToPage action's .value (0-based).
        const goTo = b.actions?.find?.((a: any) => a.type === 'goToPage');
        const page = goTo?.value != null ? (goTo.value as number) + 1 : 0;
        result.push({ path, title: b.text ?? '', page });
        if (b.items?.length) walk(b.items, path);
      });
    };
    walk(raw, []);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'read_bookmarks', json: JSON.stringify({ bookmarks: result }) },
    });
  } catch (err) {
    show(`read_bookmarks error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'read_bookmarks', json: JSON.stringify({ error: String(err) }) },
      });
    } catch (_) {}
  }
}

// Resolves the sibling array a bookmark would land in for a given parent
// path (an array of 0-based child indices, root when empty) — walks doc's
// live bookmark tree the same way handleReadBookmarks does.
function getBookmarkSiblings(doc: any, parentPath: number[]): any[] {
  let items: any[] = doc.bookmarks ?? [];
  for (const idx of parentPath) {
    items = items[idx]?.items ?? [];
  }
  return items;
}

async function handleAddBookmark(data: { page: number; title: string | null; parentPath: number[] }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    // Without an explicit index, the engine inserts each new
    // bookmark at the front of its parent's children instead of the end, so
    // several add_bookmark calls in one request land in reverse order.
    // Append explicitly by passing the current sibling count as the index.
    const siblingCount = getBookmarkSiblings(doc, data.parentPath).length;
    await doc.addBookmark({ pageIndex: data.page - 1, title: data.title ?? `Page ${data.page}`, parentIndex: data.parentPath, index: siblingCount });
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'add_bookmark', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`add_bookmark error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'add_bookmark', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteBookmark(data: { path: number[] }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await doc.deleteBookmark({ path: data.path });
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_bookmark', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_bookmark error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_bookmark', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteAllBookmarks(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await doc.deleteAllBookmarks();
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_all_bookmarks', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_all_bookmarks error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_all_bookmarks', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// ── Minimal stored-only ZIP writer ──────────────────────────────────────────

function makeCrc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
}
const _CRC32 = makeCrc32Table();
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ _CRC32[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  type Entry = { nameBytes: Uint8Array; data: Uint8Array; crc: number; offset: number };
  const entries: Entry[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    entries.push({ nameBytes, data: f.data, crc, offset });
    offset += 30 + nameBytes.length + f.data.length;
  }
  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const e of entries) centralDirSize += 46 + e.nameBytes.length;

  const out = new Uint8Array(centralDirOffset + centralDirSize + 22);
  const dv = new DataView(out.buffer);
  let pos = 0;

  for (const e of entries) {
    dv.setUint32(pos, 0x04034B50, true); dv.setUint16(pos+4, 20, true);
    dv.setUint16(pos+6, 0, true); dv.setUint16(pos+8, 0, true);
    dv.setUint16(pos+10, 0, true); dv.setUint16(pos+12, 0, true);
    dv.setUint32(pos+14, e.crc, true);
    dv.setUint32(pos+18, e.data.length, true); dv.setUint32(pos+22, e.data.length, true);
    dv.setUint16(pos+26, e.nameBytes.length, true); dv.setUint16(pos+28, 0, true);
    out.set(e.nameBytes, pos+30);
    out.set(e.data, pos+30+e.nameBytes.length);
    pos += 30 + e.nameBytes.length + e.data.length;
  }
  for (const e of entries) {
    dv.setUint32(pos, 0x02014B50, true); dv.setUint16(pos+4, 20, true); dv.setUint16(pos+6, 20, true);
    dv.setUint16(pos+8, 0, true); dv.setUint16(pos+10, 0, true);
    dv.setUint16(pos+12, 0, true); dv.setUint16(pos+14, 0, true);
    dv.setUint32(pos+16, e.crc, true);
    dv.setUint32(pos+20, e.data.length, true); dv.setUint32(pos+24, e.data.length, true);
    dv.setUint16(pos+28, e.nameBytes.length, true);
    dv.setUint16(pos+30, 0, true); dv.setUint16(pos+32, 0, true);
    dv.setUint16(pos+34, 0, true); dv.setUint16(pos+36, 0, true);
    dv.setUint32(pos+38, 0, true); dv.setUint32(pos+42, e.offset, true);
    out.set(e.nameBytes, pos+46);
    pos += 46 + e.nameBytes.length;
  }
  dv.setUint32(pos, 0x06054B50, true);
  dv.setUint16(pos+4, 0, true); dv.setUint16(pos+6, 0, true);
  dv.setUint16(pos+8, entries.length, true); dv.setUint16(pos+10, entries.length, true);
  dv.setUint32(pos+12, centralDirSize, true); dv.setUint32(pos+16, centralDirOffset, true);
  dv.setUint16(pos+20, 0, true);
  return out;
}

// ── extract_images ───────────────────────────────────────────────────────────

async function handleExtractImages(data: { outputPath: string; pages: number[] | null; format: string }): Promise<void> {
  try {
    showSaveProgress('Extracting images');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');

    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    const pageNums: number[] = data.pages
      ? data.pages.filter((p) => p >= 1 && p <= totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);

    // extractImages expects Range as string array of 1-based page numbers (Ir() converts them to 0-based internally)
    const rangeStrings = pageNums.map(String);
    const raw = await (doc as any).extractImages({ Range: rangeStrings, ImageFileType: data.format === 'jpeg' ? 'jpg' : 'png' });

    let zipBytes: Uint8Array;

    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      // Worker already returned a ZIP or single image buffer — save as-is
      zipBytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array((raw as ArrayBufferView).buffer, (raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteLength);
    } else if (Array.isArray(raw)) {
      // Array of { name?, filename?, data?, body? } objects
      const ext = data.format === 'jpeg' ? 'jpg' : 'png';
      const zipFiles = (raw as any[]).filter(Boolean).map((item, i) => {
        const name: string = item.name ?? item.filename ?? `image_${i + 1}.${ext}`;
        const bytes: Uint8Array = item.data instanceof Uint8Array ? item.data
          : item.body instanceof Uint8Array ? item.body
          : item.data instanceof ArrayBuffer ? new Uint8Array(item.data)
          : new Uint8Array(item.body ?? []);
        return { name, data: bytes };
      });
      if (zipFiles.length === 0) throw new Error('No images found in document');
      zipBytes = buildZip(zipFiles);
    } else {
      throw new Error(`Unexpected extractImages result type: ${typeof raw}`);
    }

    await saveChunked(zipBytes, data.outputPath, 'Saving images ZIP');

    showSaveSuccess('Images extracted successfully', data.outputPath);

    const count = Array.isArray(raw) ? (raw as any[]).length : 1;
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'extract_images', json: JSON.stringify({ success: true, path: data.outputPath, count }) },
    });
  } catch (err) {
    showSaveError(`Extract images failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'extract_images', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// ── export_comments ──────────────────────────────────────────────────────────

async function handleExportComments(data: { outputPath: string }): Promise<void> {
  try {
    showSaveProgress('Exporting comments');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');

    const raw = await (doc as any).exportComments();

    let bytes: Uint8Array;
    if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (ArrayBuffer.isView(raw)) {
      bytes = new Uint8Array((raw as ArrayBufferView).buffer, (raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteLength);
    } else if (typeof raw === 'string') {
      bytes = new TextEncoder().encode(raw);
    } else {
      bytes = new TextEncoder().encode(JSON.stringify(raw));
    }

    if (bytes.length === 0) throw new Error('No comments to export');

    await saveChunked(bytes, data.outputPath, 'Saving comments');

    showSaveSuccess('Comments exported successfully', data.outputPath);

    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'export_comments', json: JSON.stringify({ success: true, path: data.outputPath }) },
    });
  } catch (err) {
    showSaveError(`Export comments failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'export_comments', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleResizePages(data: { width: number; height: number; pages: number[] | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    const range1based: number[] = data.pages
      ? data.pages.filter((p) => p >= 1 && p <= totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);
    // resizePages passes Range directly to the WASM worker (unlike rotatePages which converts internally)
    const range0based = range1based.map((p) => p - 1);
    await (doc as any).resizePages({ Rectangle: [0, 0, data.width, data.height], Range: range0based });
    show(`Resized ${range1based.length} page(s) to ${data.width}×${data.height} pt`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'resize_pages', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`resize_pages error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'resize_pages', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeletePages(data: { pages: number[] }): Promise<void> {
  try {
    show('Deleting pages…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    // deletePages converts 1-based → 0-based internally (.map(e => +e - 1))
    const range1based = data.pages.filter((p) => p >= 1 && p <= totalPages);
    if (range1based.length === 0) throw new Error('No valid pages to delete');
    await (doc as any).deletePages({ range: range1based });
    show(`Deleted ${range1based.length} page(s)`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_pages', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_pages error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_pages', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleMovePages(data: { pages: number[]; afterPage: number }): Promise<void> {
  try {
    show('Moving pages…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    const rangeStrings = data.pages.filter((p) => p >= 1 && p <= totalPages).map(String);
    if (rangeStrings.length === 0) throw new Error('No valid pages to move');
    await (doc as any).movePages({ index: data.afterPage, range: rangeStrings });
    show(`Moved ${rangeStrings.length} page(s)`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'move_pages', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`move_pages error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'move_pages', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDuplicatePages(data: { pages: number[]; afterPage: number | null }): Promise<void> {
  try {
    show('Duplicating pages…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    const sourceRange = data.pages.filter((p) => p >= 1 && p <= totalPages).map(String);
    if (sourceRange.length === 0) throw new Error('No valid pages to duplicate');
    const index = data.afterPage !== null ? data.afterPage : totalPages;
    await (doc as any).insertDuplicatePages({ index, sourceRange });
    show(`Duplicated ${sourceRange.length} page(s)`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'duplicate_pages', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`duplicate_pages error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'duplicate_pages', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleReversePages(data: { pages: number[] | null }): Promise<void> {
  try {
    show('Reversing pages…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const totalPages = (doc.getNumPages?.() ?? 0) as number;
    const params: Record<string, unknown> = {};
    if (data.pages) {
      params.range = data.pages.filter((p) => p >= 1 && p <= totalPages).map(String);
    }
    await (doc as any).reversePage(params);
    show('Page order reversed');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'reverse_pages', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`reverse_pages error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'reverse_pages', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleUndo(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await doc.undo();
    show('Undo');
    setTimeout(() => { statusEl.style.display = 'none'; }, 1500);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'undo', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`undo error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'undo', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleRedo(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await doc.redo();
    show('Redo');
    setTimeout(() => { statusEl.style.display = 'none'; }, 1500);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'redo', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`redo error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'redo', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleUpdateDocumentProperties(data: { title: string | null; author: string | null; subject: string | null; keywords: string | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const properties: Record<string, string> = {};
    if (data.title !== null) properties['T'] = data.title;
    if (data.author !== null) properties['A'] = data.author;
    if (data.subject !== null) properties['S'] = data.subject;
    if (data.keywords !== null) properties['K'] = data.keywords;
    await (doc as any).changeDocumentProperties({ properties });
    show('Document properties updated');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'update_document_properties', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`update_document_properties error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'update_document_properties', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// Normalise an AcroForm choice item (dropdown/listbox option) to { name, value }.
// PDF /Opt entries can be a plain string, a two-element [exportValue, displayText]
// array, or an object — handle all three so options are never reported as undefined.
function normalizeChoiceItem(it: any): { name: string; value: string } {
  if (Array.isArray(it)) {
    const value = String(it[0] ?? '');
    const name = String(it[1] ?? it[0] ?? '');
    return { name, value };
  }
  if (it && typeof it === 'object') {
    const value = String(it.value ?? it.name ?? '');
    const name = String(it.name ?? it.value ?? '');
    return { name, value };
  }
  const s = String(it);
  return { name: s, value: s };
}

async function handleReadFormFields(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const raw: any[] = doc.acroforms ?? [];
    // Read the real on-state values of button fields once so checkboxes and, in
    // particular, radio groups report the exact values needed to select them.
    const { map: onValuesByField } = await collectButtonOnValues(doc);
    const fields = raw.map((f: any) => {
      let type = f.type as string;
      if (type === 'Tx') type = 'text';
      else if (type === 'Btn') type = f.buttonType ?? 'button';
      else if (type === 'Ch') type = f.iCombo ? 'dropdown' : 'listbox';
      else if (type === 'Sig') type = 'signature';
      const entry: Record<string, unknown> = {
        field_name: f.fieldName,
        type,
        value: f.value ?? '',
        read_only: f.isReadOnly?.() ?? false,
      };
      if (f.uiFieldName && f.uiFieldName !== f.fieldName) entry.ui_name = f.uiFieldName;
      if ((type === 'dropdown' || type === 'listbox') && Array.isArray(f.items) && f.items.length > 0) {
        entry.options = f.items.map(normalizeChoiceItem);
      }
      if (type === 'check' || type === 'radio' || type === 'checkbox' || type === 'button') {
        // A checkbox/radio is "on" when its value is anything other than the
        // Off/empty state.
        const v = String(f.value ?? '');
        entry.checked = v !== '' && v.toLowerCase() !== 'off';
        const onValues = onValuesByField.get(f.fieldName) ?? [];
        if (type === 'radio' || onValues.length > 1) {
          // Radio group: expose the selectable option values in order so the
          // caller can pass an exact value or a 1-based index to update_form_field.
          if (onValues.length > 0) {
            entry.options = onValues.slice();
          } else if (Array.isArray(f.C) && f.C.length > 0) {
            // A radio group where no option has ever been selected has no
            // on-value discoverable via V on any widget (V only reflects the
            // CURRENT toggle state, so a never-picked option never appears
            // there) -- but the field's own JSON exposes its export values
            // directly under "C" regardless of selection state (IFormField.C
            // in the SDK types). Use that instead of guessing blind.
            entry.options = f.C.map((v: unknown) => String(v));
          }
          // Otherwise: nothing pre-selected and no "C" export-values list
          // either -- leave options unset rather than guessing.
        } else if (onValues.length === 1) {
          // Single checkbox: report its on-value ("yes"/"true"/"1" also work).
          entry.on_value = onValues[0];
        }
      }
      return entry;
    });
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'read_form_fields', json: JSON.stringify({ success: true, fields }) },
    });
  } catch (err) {
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'read_form_fields', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

const FALSY_FORM_VALUES = new Set(['', 'off', 'no', 'false', '0', 'unchecked', 'none', 'n']);
const TRUTHY_FORM_VALUES = new Set(['on', 'yes', 'true', '1', 'checked', 'check', 'x', 'y']);

// Did the change actually take effect? changeAcroformValue is a no-op when the
// value doesn't match what the field accepts — in that case `changed` is empty.
function changeApplied(result: any): boolean {
  const changed = result?.changed;
  if (!changed) return false;
  if (Array.isArray(changed)) return changed.length > 0;
  if (Array.isArray(changed.pages)) return changed.pages.length > 0;
  return true;
}

async function tryChangeAcroform(doc: any, field: string, value: string): Promise<boolean> {
  try {
    const result = await doc.changeAcroformValue({ field, value });
    return changeApplied(result);
  } catch {
    return false;
  }
}

// Read the real "on" state name(s) of checkbox/radio fields from their widget
// annotations. In the engine, a widget annotation exposes its on-state via the
// `V` key (a constant per widget, distinct from the field's current value), and
// this is exactly what the viewer uses to toggle the control on click. The
// on-state is frequently NOT "Yes" (it can be "On", "1", a per-option name, …),
// so we must read it rather than guess. A single scan returns a map from field
// name to its distinct on-values, in widget order (which matches the visual
// order of the radio options — index i is the (i+1)-th option).
// `widgetCounts`, keyed the same as the returned map, counts widgets that
// contributed nothing to their field's on-values (V was empty/"Off"). V only
// reflects a widget's CURRENT toggle state, so a radio option that has never
// been selected can't be discovered through it -- the count lets callers
// report "N widgets found, no selectable value" instead of guessing blind.
async function collectButtonOnValues(doc: any): Promise<{ map: Map<string, string[]>; widgetCounts: Map<string, number> }> {
  const map = new Map<string, string[]>();
  const widgetCounts = new Map<string, number>();
  if (doc?.getPage === undefined) return { map, widgetCounts };
  const pageCount = (doc.getNumPages?.() ?? 0) as number;
  for (let pi = 0; pi < pageCount; pi++) {
    // Same public annotations model as handleReadAnnotations -- this used to
    // go through doc.pdfEditor.getPageAnnotations(), which was always
    // undefined (see the note there).
    const page = doc.getPage?.(pi);
    const annots: any[] = page?.annotations ?? [];
    for (const ann of annots) {
      const native = (ann as any)?.nativeData ?? {};
      if (native.T !== 'Widget') continue;
      const field = typeof native.P === 'string' ? native.P : '';
      if (!field) continue;
      const v = typeof native.V === 'string' ? native.V : '';
      if (v === '' || v.toLowerCase() === 'off') {
        widgetCounts.set(field, (widgetCounts.get(field) ?? 0) + 1);
        continue;
      }
      let list = map.get(field);
      if (!list) { list = []; map.set(field, list); }
      if (!list.includes(v)) list.push(v);
    }
  }
  return { map, widgetCounts };
}

async function getButtonOnValues(doc: any, fieldName: string): Promise<string[]> {
  const { map } = await collectButtonOnValues(doc);
  return map.get(fieldName) ?? [];
}

const CHOICE_EDIT_FLAG = 262144; // kPDChoiceFieldFlagEdit — combo accepts free text

// Resolve a dropdown/listbox input to the option the caller meant. Matching is
// intentionally forgiving so natural inputs work:
//   • exact name / export-value (case-insensitive, trimmed)
//   • numeric equivalence ("2" ↔ "02", "2022" ↔ "2022")
//   • prefix either way, ≥3 chars ("Feb" ↔ "February", "Sept" ↔ "Sep")
//   • a bare integer as a 1-based option index (month number "2" → 2nd option)
// For an editable combo (Edit flag) an unmatched input becomes free text.
// Returns the option ({name, value}) or null when no option matches.
function resolveChoiceOption(field: any, input: string): { name: string; value: string } | null {
  const items = (Array.isArray(field.items) ? field.items : []).map(normalizeChoiceItem);
  const raw = input.trim();
  const editable = ((field.fieldFlags ?? 0) & CHOICE_EDIT_FLAG) !== 0;
  if (items.length === 0) return { name: raw, value: raw }; // free text / no option list
  const norm = raw.toLowerCase();
  const num = Number(raw);
  const isNum = raw !== '' && Number.isFinite(num);

  for (const it of items) if (it.name.toLowerCase() === norm) return it;
  for (const it of items) if (it.value.toLowerCase() === norm) return it;
  if (isNum) {
    for (const it of items) {
      const nn = Number(it.name); const nv = Number(it.value);
      if ((it.name !== '' && Number.isFinite(nn) && nn === num) ||
          (it.value !== '' && Number.isFinite(nv) && nv === num)) return it;
    }
  }
  if (norm.length >= 3) {
    for (const it of items) {
      const n = it.name.toLowerCase();
      if (n.length >= 3 && (n.startsWith(norm) || norm.startsWith(n))) return it;
    }
  }
  if (isNum && Number.isInteger(num) && num >= 1 && num <= items.length) return items[num - 1];
  return editable ? { name: raw, value: raw } : null;
}

async function handleUpdateFormField(data: { field_name: string; value: string }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');

    const fields: any[] = doc.acroforms ?? [];
    const field = fields.find((f: any) => f.fieldName === data.field_name);
    if (!field) {
      const names = fields.map((f: any) => f.fieldName).filter(Boolean);
      const available = names.length > 0 ? `Available fields: ${names.join(', ')}` : 'This document has no form fields.';
      throw new Error(`form field not found: "${data.field_name}". ${available}`);
    }
    if (field.isReadOnly?.()) throw new Error(`form field is read-only: "${data.field_name}"`);

    const rawType = field.type as string; // 'Tx' | 'Btn' | 'Ch' | 'Sig'
    const currentValue = String(field.value ?? '');
    let applied = false;
    let appliedValue = data.value;

    if (rawType === 'Btn') {
      // Checkbox / radio button. The engine unchecks with an empty string and
      // checks with the widget's real on-state value (often NOT "Yes"). Read the
      // on-state(s) from the widget annotations so the correct value is used.
      const norm = data.value.trim().toLowerCase();
      const currentlyChecked = currentValue !== '' && currentValue.toLowerCase() !== 'off';
      let onValues = await getButtonOnValues(doc, data.field_name);
      if (onValues.length === 0 && Array.isArray(field.C) && field.C.length > 0) {
        // Same fallback as read_form_fields (see the comment
        // there) -- a never-selected radio group has nothing discoverable
        // via V, but the field's own "C" export-values list still works.
        onValues = field.C.map((v: unknown) => String(v));
      }
      const isRadio = field.buttonType === 'radio' || onValues.length > 1;
      if (FALSY_FORM_VALUES.has(norm)) {
        // The viewer unchecks with an empty string; fall back to "Off" if the
        // engine rejects it. Report "Off" as the resulting state either way.
        appliedValue = 'Off';
        applied = !currentlyChecked ||
                  (await tryChangeAcroform(doc, data.field_name, '')) ||
                  (await tryChangeAcroform(doc, data.field_name, 'Off'));
      } else if (isRadio) {
        // Radio group: select one specific option. Each option is identified by
        // its on-value (from the widgets, in visual order). Accept either the
        // exact on-value or a 1-based ordinal index ("2" = second option). Never
        // fall back to the first option — that silently ignores the request.
        let target = onValues.find((v) => v.toLowerCase() === norm);
        if (!target && /^\d+$/.test(norm)) {
          const idx = parseInt(norm, 10) - 1;
          if (idx >= 0 && idx < onValues.length) target = onValues[idx];
        }
        if (!target) {
          let list: string;
          if (onValues.length > 0) {
            list = `Its options (in order) are: ${onValues.map((v, i) => `${i + 1}=${v}`).join(', ')}.`;
          } else {
            const { widgetCounts } = await collectButtonOnValues(doc);
            const count = widgetCounts.get(data.field_name) ?? 0;
            list = `No selectable options were found on its ${count} widget(s).`;
          }
          throw new Error(`"${data.field_name}" is a radio group; pass one of its option values or a 1-based index. ${list}`);
        }
        appliedValue = target;
        applied = target === currentValue || (await tryChangeAcroform(doc, data.field_name, target));
      } else {
        // Single checkbox: check it using the widget's real on-value, falling
        // back to common guesses only when no on-state could be read.
        if (currentlyChecked && (onValues.length === 0 || onValues.includes(currentValue))) {
          appliedValue = currentValue;
          applied = true;
        } else {
          const candidates = [...onValues];
          if (!TRUTHY_FORM_VALUES.has(norm) && data.value !== '') candidates.push(data.value);
          candidates.push('Yes', 'On', '1', field.selfName || field.fieldName, data.field_name);
          const tried = new Set<string>();
          for (const c of candidates) {
            if (!c || tried.has(c)) continue;
            tried.add(c);
            if (await tryChangeAcroform(doc, data.field_name, c)) {
              applied = true;
              appliedValue = c;
              break;
            }
          }
        }
      }
    } else if (rawType === 'Ch') {
      // Dropdown / listbox. Set the option's display NAME — the engine keys the
      // rendered selection off the label (a value not among the labels shows
      // blank). Fall back to the export value only if the label is rejected.
      // (We can't verify via the widget: these combos keep the value on the
      // field, not the widget annotation, so its `V` reads empty.)
      const opts = (Array.isArray(field.items) ? field.items : []).map(normalizeChoiceItem);
      const target = resolveChoiceOption(field, data.value);
      if (target === null) {
        const list = opts.map((o: { name: string; value: string }) => (o.name === o.value ? o.value : `${o.name} (${o.value})`)).join(', ');
        throw new Error(`value "${data.value}" is not a valid option for "${data.field_name}". Available: ${list || '(none)'}`);
      }
      appliedValue = target.name;
      applied = target.name === currentValue ||
                (await tryChangeAcroform(doc, data.field_name, target.name)) ||
                (target.value !== target.name && (await tryChangeAcroform(doc, data.field_name, target.value)));
      if (!applied) {
        const list = opts.map((o: { name: string; value: string }) => (o.name === o.value ? o.value : `${o.name} (${o.value})`)).join(', ');
        throw new Error(`value "${data.value}" did not take effect on "${data.field_name}". Valid options: ${list || '(none)'}`);
      }
    } else {
      // Text field (or signature) — set the value verbatim.
      applied = data.value === currentValue || (await tryChangeAcroform(doc, data.field_name, data.value));
    }

    if (!applied) {
      throw new Error(`the engine did not accept value "${data.value}" for field "${data.field_name}"`);
    }

    // Keep the in-memory field value in sync so read_form_fields reflects the
    // change, and refresh the viewer so the update is visible immediately.
    try { field.value = appliedValue; } catch (_) {}
    (activeDocumentView() as any)?.invalidate?.();

    show('Form field updated');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'update_form_field', json: JSON.stringify({ success: true, applied_value: appliedValue }) },
    });
  } catch (err) {
    show(`update_form_field error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'update_form_field', json: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleApplyRedactions(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await (doc as any).applyRedactions();
    show('Redactions applied permanently');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'apply_redactions', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`apply_redactions error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'apply_redactions', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteBatesNumbering(): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await (doc as any).deleteBatesNumbering();
    show('Bates numbering removed');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_bates_numbering', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_bates_numbering error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_bates_numbering', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteWatermark(data: { range: string[] | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    // null range = whole document (the server normalizes ["all"] to null) --
    // expand it to an explicit 1-N, the only form the engine parses.
    const range = data.range && data.range.length > 0 ? data.range : [`1-${(doc as any).getNumPages?.() ?? 1}`];
    await (doc as any).deleteWatermark({ range });
    show('Watermark removed');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_watermark', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_watermark error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_watermark', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteHeader(data: { range: string[] | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    // See handleDeleteWatermark: null = whole document, expand to 1-N.
    const range = data.range && data.range.length > 0 ? data.range : [`1-${(doc as any).getNumPages?.() ?? 1}`];
    await (doc as any).deleteHeader({ range });
    show('Headers/footers removed');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_header', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_header error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_header', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeletePageNumber(data: { range: string[] | null; pages: number[] | null }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageCount: number = (doc as any).getNumPages?.() ?? 1;
    const params: Record<string, unknown> = {};
    if (data.pages && data.pages.length > 0) {
      params['pages'] = data.pages;
    } else {
      params['range'] = data.range && data.range.length > 0 ? data.range : [`1-${pageCount}`];
    }
    await (doc as any).deletePageNumber(params);
    show('Page numbers removed');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_page_number', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_page_number error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_page_number', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleInsertPageNumber(data: { fontFamily: string; fontSize: number; fontColor: string; format: string; position: number; range: string[] | null; startNumber: number }): Promise<void> {
  try {
    show('Inserting page numbers…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const params: Record<string, unknown> = {
      font: { family: data.fontFamily, size: data.fontSize, color: data.fontColor },
      format: data.format,
      position: data.position,
      start: data.startNumber,
      range: data.range && data.range.length > 0 ? data.range : [`1-${(doc as any).getNumPages?.() ?? 1}`],
    };
    await (doc as any).insertPageNumber(params);
    show('Page numbers inserted');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'insert_page_number', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`insert_page_number error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'insert_page_number', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleDeleteTextBlocks(data: { pageIndex: number; blockIndices: number[] }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await (doc as any).deleteTextBlocks({ pageIndex: data.pageIndex, blockIndices: data.blockIndices });
    show(`Deleted ${data.blockIndices.length} text block(s)`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'delete_text_blocks', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`delete_text_blocks error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'delete_text_blocks', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleConvertToImages(data: { dpi: number | null; outputPath: string }): Promise<void> {
  try {
    showSaveProgress('Converting pages to images');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const zipFile: File = await (doc as any).convertToImages(data.dpi ?? undefined);
    const bytes = new Uint8Array(await zipFile.arrayBuffer());
    await saveChunked(bytes, data.outputPath, 'Saving images ZIP');
    showSaveSuccess('Pages converted to images successfully', data.outputPath);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'convert_to_images', json: JSON.stringify({ success: true, path: data.outputPath }) },
    });
  } catch (err) {
    showSaveError(`Convert to images failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'convert_to_images', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleExtractPages(data: { Range: string[] | null; outputPath: string }): Promise<void> {
  try {
    showSaveProgress('Extracting pages');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const totalPages = (doc as any).getNumPages?.() ?? 1;
    // See handleDeleteWatermark: null = whole document, expand to 1-N.
    const Range = data.Range && data.Range.length > 0 ? data.Range : [`1-${totalPages}`];
    const raw = await (doc as any).extractPages({ Range });
    const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
    await saveChunked(bytes, data.outputPath, 'Saving extracted PDF');
    showSaveSuccess('Pages extracted successfully', data.outputPath);
    // report_viewer_result gets auto-stamped with the SOURCE document's
    // _pageCount (for state-freshness on mutating commands) -- but
    // extract_pages doesn't mutate/replace the open document, so that count
    // is the wrong one to show for the new file.
    // Compute the real extracted count from the resolved ranges instead.
    const extractedPages = new Set<string>();
    for (const r of Range) for (const p of parseSplitRange(r, totalPages)) extractedPages.add(p);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'extract_pages', json: JSON.stringify({ success: true, path: data.outputPath, extractedPageCount: extractedPages.size }) },
    });
  } catch (err) {
    showSaveError(`Extract pages failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'extract_pages', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleSaveAs(data: { outputPath: string | null; fileName: string | null }): Promise<void> {
  try {
    showSaveProgress('Saving copy');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const raw = await (doc as any).exportDocument({ as: 'uint8array' });
    const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
    let targetPath = data.outputPath;
    if (!targetPath) {
      const dir = _currentFilePath ? _currentFilePath.replace(/[/\\][^/\\]+$/, '') : '';
      const name = data.fileName || 'document_copy.pdf';
      targetPath = joinDirAndName(dir, name);
    }
    await saveChunked(bytes, targetPath, 'Saving copy');
    _currentFilePath = targetPath;
    _workingFilePath = null; // "Save As" makes targetPath the new original — start a fresh working copy from it
    showSaveSuccess('PDF saved successfully', targetPath);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'save_as', json: JSON.stringify({ success: true, path: targetPath }) },
    });
  } catch (err) {
    showSaveError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'save_as', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleSetSecurityPermissions(data: { userPassword: string; ownerPassword: string; cryptMethod: number; permFlags: number }): Promise<void> {
  try {
    show('Setting security permissions…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await (doc as any).setSecurityPermissions({
      userPassword: data.userPassword || undefined,
      ownerPassword: data.ownerPassword || undefined,
      cryptMethod: data.cryptMethod,
      permFlags: data.permFlags,
    });
    show('Security permissions updated');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'set_security_permissions', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`set_security_permissions error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'set_security_permissions', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleSearchAndRedact(data: { text: string; caseSensitive: boolean; wholeWord: boolean }): Promise<void> {
  try {
    show(`Searching for "${data.text}"…`);
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');

    // PageTextSearchFlags: 1 = IgnoreCase, 2 = WholeWord
    let flags = 0;
    if (!data.caseSensitive) flags |= 1;
    if (data.wholeWord) flags |= 2;

    const allRanges: any[] = [];
    const sub = (activeDocumentView() as any).onSearchResults?.()?.subscribe?.((ranges: any[]) => {
      if (ranges?.length) allRanges.push(...ranges);
    });
    await (activeDocumentView() as any).search?.(data.text, flags);
    sub?.unsubscribe?.();
    (activeDocumentView() as any).stopSearch?.();

    if (!allRanges.length) {
      show(`No occurrences of "${data.text}" found`);
      setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'search_and_redact', json: JSON.stringify({ success: true, count: 0 }) },
      });
      return;
    }

    show(`Marking ${allRanges.length} occurrence(s) for redaction…`);
    let markedCount = 0;

    for (const range of allRanges) {
      const pageIndex = range.begin?.pageIndex;
      if (pageIndex == null) continue;
      const page = (doc as any).getPage?.(pageIndex);
      if (!page) continue;
      const pageText = page.getPageText?.();
      if (!pageText) continue;

      let combined: { left: number; bottom: number; right: number; top: number } | null = null;
      for (let i = range.begin.charIndex; i < range.end.charIndex; i++) {
        try {
          const bound = pageText.getCharQuad?.(i)?.getBound?.();
          if (!bound) continue;
          const arr: number[] = typeof bound.asArray === 'function' ? bound.asArray() : [bound.left, bound.bottom, bound.right, bound.top];
          const r = { left: arr[0], bottom: arr[1], right: arr[2], top: arr[3] };
          if (!combined) { combined = r; }
          else {
            combined.left = Math.min(combined.left, r.left);
            combined.bottom = Math.min(combined.bottom, r.bottom);
            combined.right = Math.max(combined.right, r.right);
            combined.top = Math.max(combined.top, r.top);
          }
        } catch { /* skip */ }
      }
      if (!combined) continue;

      await withEngineRetry(() => (doc as any).createAnnotation({
        pageIndex,
        params: {
          T: 'Redact',
          rect: [combined.left, combined.bottom, combined.right, combined.top],
          color: '#FFFF0000',
        },
      }));
      markedCount++;
    }

    if (!markedCount) throw new Error('could not compute bounding boxes for matches');

    show('Applying redactions…');
    await (doc as any).applyRedactions();
    show(`Redacted ${markedCount} occurrence(s) of "${data.text}"`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'search_and_redact', json: JSON.stringify({ success: true, count: markedCount }) },
    });
  } catch (err) {
    show(`search_and_redact error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'search_and_redact', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// ── Text block helpers ──────────────────────────────────────────────────────

function getBlockFullText(block: any): string {
  return (block.paragraphs as any[])
    .flatMap((p: any) => p.getLines() as any[])
    .map((l: any) => (typeof l.text === 'string' ? l.text : (l.getText?.() ?? '')))
    .join('');
}

function toArgbColor(hex: string): string {
  const clean = hex.replace(/^#/, '');
  if (clean.length === 6) return `#FF${clean.toUpperCase()}`;
  if (clean.length === 8) return `#${clean.toUpperCase()}`;
  return hex;
}

async function handleReadPageTextBlocks(data: { page: number }): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageIndex = data.page - 1;
    const pages: any[] = doc.getPages?.() ?? [];
    if (pageIndex < 0 || pageIndex >= pages.length) throw new Error(`Page ${data.page} not found`);
    const page = pages[pageIndex];
    if (!page.isLoaded) await doc.loadPageContent(page);
    const textBlocks: any[] = page.textBlocks ?? [];
    const blocks = textBlocks.map((block: any, idx: number) => {
      const text = getBlockFullText(block);
      return { index: idx, text, char_count: text.length };
    });
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'read_page_text_blocks', json: JSON.stringify({ success: true, blocks }) },
    });
  } catch (err) {
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'read_page_text_blocks', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleFormatText(data: {
  page: number;
  text: string;
  occurrence: number;
  all_occurrences?: boolean;
  font_size?: number;
  font_family?: string;
  font_style?: string;
  underline?: boolean;
  underline_color?: string;
  strikeout?: boolean;
  strikeout_color?: string;
  text_color?: string;
  highlight_color?: string;
}): Promise<void> {
  try {
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageIndex = data.page - 1;
    const pages: any[] = doc.getPages?.() ?? [];
    if (pageIndex < 0 || pageIndex >= pages.length) throw new Error(`Page ${data.page} not found`);
    const page = pages[pageIndex];
    if (!page.isLoaded) await doc.loadPageContent(page);
    const textBlocks: any[] = page.textBlocks ?? [];

    const font: Record<string, unknown> = {};
    if (data.font_size !== undefined) font['S'] = data.font_size;
    if (data.font_family !== undefined) font['F'] = data.font_family;
    if (data.font_style !== undefined) {
      const styleMap: Record<string, number> = { regular: 0, italic: 1, bold: 2, bold_italic: 3 };
      const sv = styleMap[data.font_style.toLowerCase()];
      if (sv !== undefined) font['s'] = sv;
    }
    if (data.underline_color !== undefined) font['UL'] = toArgbColor(data.underline_color);
    else if (data.underline !== undefined) font['UL'] = data.underline ? '#FF000000' : '#00000000';
    if (data.strikeout_color !== undefined) font['SO'] = toArgbColor(data.strikeout_color);
    else if (data.strikeout !== undefined) font['SO'] = data.strikeout ? '#FF000000' : '#00000000';
    if (data.text_color !== undefined) font['C'] = toArgbColor(data.text_color);
    if (data.highlight_color !== undefined) font['HL'] = toArgbColor(data.highlight_color);

    let occurrenceLeft = data.all_occurrences ? 0 : (data.occurrence ?? 1);
    let applied = 0;

    for (let blockIdx = 0; blockIdx < textBlocks.length; blockIdx++) {
      const fullText = getBlockFullText(textBlocks[blockIdx]);
      let searchFrom = 0;
      while (true) {
        const pos = fullText.indexOf(data.text, searchFrom);
        if (pos === -1) break;
        if (data.all_occurrences) {
          await (doc as any).changeFontAttributes({ pageIndex, textblockIndex: blockIdx, charPosition: pos, charCount: data.text.length, font });
          applied++;
        } else {
          occurrenceLeft--;
          if (occurrenceLeft === 0) {
            await (doc as any).changeFontAttributes({ pageIndex, textblockIndex: blockIdx, charPosition: pos, charCount: data.text.length, font });
            applied++;
            break;
          }
        }
        searchFrom = pos + 1;
      }
      if (!data.all_occurrences && applied > 0) break;
    }

    if (applied === 0) {
      const hint = data.all_occurrences ? '' : ` (occurrence ${data.occurrence ?? 1})`;
      throw new Error(`Text "${data.text}" not found on page ${data.page}${hint}. Use read_page_text_blocks to see exact text content.`);
    }
    show(`Text formatted (${applied} occurrence${applied > 1 ? 's' : ''})`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'format_text', json: JSON.stringify({ success: true, applied }) },
    });
  } catch (err) {
    show(`format_text error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'format_text', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// ── add_text_to_page ─────────────────────────────────────────────────────────

async function handleAddTextToPage(data: {
  page: number; text: string;
  x: number; y: number; width: number; height: number;
  font_size?: number;
}): Promise<void> {
  try {
    show('Adding text…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const pages = (doc.getPages() as unknown[]);
    const pageIndex = data.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) throw new Error(`page ${data.page} out of range`);
    const page = pages[pageIndex] as { width?: number; height?: number; isLoaded?: boolean; textBlocks?: unknown[] };
    const pw = page.width || 595;
    const ph = page.height || 842;

    const left   = (data.x / 100) * pw;
    const pdfTop = ph - (data.y / 100) * ph;
    const fontSize = data.font_size ?? 12;
    const font = { S: fontSize, F: 'Helvetica', C: '#FF000000' };

    await withEngineRetry(() => (doc as any).createTextBlock({ pageIndex, font, position: [left, pdfTop] }));

    if (!page.isLoaded) await (doc as any).loadPageContent(page);
    const newIdx = ((page.textBlocks as unknown[]) ?? []).length - 1;
    if (newIdx >= 0) {
      await withEngineRetry(() => (doc as any).editPageText({
        pageIndex,
        textblocks: [{ index: newIdx, spans: [{ text: data.text, font }] }],
      }));
    }

    show(`Text added to page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'add_text_to_page', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`add_text_to_page error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'add_text_to_page', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// ── add_form_field ────────────────────────────────────────────────────────────

type AddFormFieldCommand = {
  page: number; field_type: string; label: string | null;
  x: number; y: number; width: number; height: number;
  default_value: string | null; options: string[] | null;
  bg_color: string | null; border_color: string | null;
  field_name: string | null;
};

async function handleAddFormField(data: AddFormFieldCommand): Promise<void> {
  try {
    show('Adding form field…');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const pages = (doc.getPages() as unknown[]);
    const pageIndex = data.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) throw new Error(`page ${data.page} out of range`);
    const page = pages[pageIndex] as { width?: number; height?: number };
    const pw = page.width || 595;
    const ph = page.height || 842;

    // Convert % to absolute points; R uses PDF coords (y=0 at bottom-left)
    const left   = (data.x / 100) * pw;
    const right  = ((data.x + data.width) / 100) * pw;
    const pdfTop    = ph - (data.y / 100) * ph;
    let pdfBottom   = ph - ((data.y + data.height) / 100) * ph;

    // A listbox sized well beyond its option count renders as a
    // mostly-empty box (the caller/model's height % isn't tied to how many
    // options it asked for). A description hint isn't enforcement -- clamp
    // the box height here so it actually reflects the number of options.
    // Only ever shrinks a too-generous box; never grows one, since growing
    // risks overlapping unrelated content lower on the page.
    if (data.field_type === 'listbox' && data.options && data.options.length > 0) {
      const ROW_HEIGHT_PT = 14;
      const PADDING_PT = 4;
      const desiredHeightPt = data.options.length * ROW_HEIGHT_PT + PADDING_PT;
      const requestedHeightPt = pdfTop - pdfBottom;
      if (requestedHeightPt > desiredHeightPt) {
        pdfBottom = pdfTop - desiredHeightPt;
      }
    }

    const ftMap: Record<string, string> = {
      text: 'TextBox', checkbox: 'CheckBox', radio: 'RadioButton',
      dropdown: 'ComboBox', listbox: 'ListBox', button: 'PushButton',
    };
    const FT = ftMap[data.field_type] ?? 'TextBox';

    const requestedName = data.field_name?.trim() || null;
    if (requestedName) {
      const existingNames = ((doc.acroforms ?? []) as any[]).map((f) => f.fieldName).filter(Boolean);
      if (existingNames.includes(requestedName)) {
        throw new Error(`field name "${requestedName}" is already used by another field in this document. Existing fields: ${existingNames.join(', ')}`);
      }
    }

    // Without an explicit font size, the engine renders the
    // field's own value/options far too large for the box (looks auto-fit to
    // the widget height). checkbox/radio/button don't display readable text
    // (glyph or CA caption instead), so only the text-bearing types need it
    // -- applied via the post-creation reinforcement patch below, not here
    // (see comment above params.BC).
    const FIELD_FONT_SIZE = 10;

    const params: Record<string, unknown> = {
      T: 'Widget',
      FT,
      R: [left, pdfBottom, right, pdfTop],
    };
    // CA (Caption) only works for PushButton; for other types we add a FreeText label separately
    if (data.field_type === 'button' && data.label != null) params.CA = data.label;
    if (data.bg_color != null) params.BG = data.bg_color;
    if (data.border_color != null) params.BC = data.border_color;
    // The vendor's own UI widget-creation code (ui/chunks --
    // the class backing its "drag to create a form field" toolbar tool)
    // unconditionally sets O:{} for ComboBox/ListBox at creation time, even
    // though it's immediately replaced by the "Items" dialog's own separate
    // patch afterward. Removing O entirely (rather than sending it empty)
    // was the actual regression: the engine appears to require the key's
    // *presence* at creation for Ch-field init, not any particular content --
    // its absence, not its earlier non-empty content, is what the
    // json.exception.type_error.302 was reacting to all along. Restore the
    // empty placeholder to match the one payload shape actually exercised by
    // the shipped product; the real options still go through the separate
    // changeAnnotationProperties patch below unchanged.
    if (data.field_type === 'dropdown' || data.field_type === 'listbox') params.O = {};
    // Fnt in createAnnotation's own params destabilizes ComboBox/
    // ListBox creation the same way N and (earlier) O did -- same
    // json.exception.type_error.302 signature, reproduced with nothing else
    // non-minimal in the payload. The font-size reinforcement patch below
    // (applied via a separate changeAnnotationProperties call after creation,
    // same split-into-its-own-call pattern as O/N) already covers every
    // FIELD_TEXT_TYPES case on its own, so dropping it from creation costs
    // nothing.

    if (data.field_type === 'checkbox') {
      params.V = data.default_value === 'Yes' ? 'Yes' : 'Off';
    } else if (data.default_value != null) {
      params.V = data.default_value;
    }

    // Tag which step threw if a retry still doesn't recover (see
    // withEngineRetry above) — createAnnotation itself, or the follow-up
    // changeAnnotationProperties — instead of one generic "add_form_field
    // error" that gives no way to tell which call and payload were involved.
    // Log the exact outgoing payload once per call site (it's identical
    // across retries of the same call, so no need to repeat it per attempt).
    show(`engineSend: createAnnotation(pageIndex=${pageIndex}, params=${JSON.stringify(params)})`);
    let response: any;
    try {
      response = await withEngineRetry(() => (doc as any).createAnnotation({ pageIndex, params }), 6, 200, `createAnnotation(FT=${FT})`);
    } catch (err) {
      throw new Error(`createAnnotation(FT=${FT}, params=${JSON.stringify(params)}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const fieldName: string | null = response?.F?.N ?? response?.field?.[0]?.N ?? null;

    // response.annot is a plain content snapshot (IPDFAnnotationContent), not
    // the live PdfAnnotation instance stored in page.annotations, so reference
    // equality (indexOf) never matches — match by the stable numeric `id`
    // both shapes carry instead. Shared by the options patch and the font
    // reinforcement below, both of which need the same just-created index.
    const findCreatedAnnotIndex = (): number => {
      const pageAnnotations = ((doc.getPages() as any[])[pageIndex]?.annotations as any[]) ?? [];
      const targetId = response?.annot?.id;
      return pageAnnotations.findIndex((a) => (a?.nativeData?.id ?? a?.id) === targetId);
    };

    // The engine always resets O to {} when creating a ComboBox/ListBox widget
    // (confirmed in the vendor's own widget-creation code), silently
    // discarding any options passed in createAnnotation's params. The vendor's
    // own "Items" dialog applies options via a separate changeAnnotationProperties
    // call after creation, so mirror that here: locate the just-created
    // annotation's index on the page and patch its options in as a second step.
    // Fnt is patched separately from O below -- bundling both into
    // one changeAnnotationProperties call corrupted O in testing (the engine
    // returned garbage bytes in field.O instead of the requested strings).
    if (data.field_type === 'dropdown' || data.field_type === 'listbox') {
      const hasOptions = !!data.options && data.options.length > 0;
      if (hasOptions) {
        const annotIndex = findCreatedAnnotIndex();
        if (annotIndex >= 0) {
          const optionsProperties = { field: { O: data.options!.map((o) => ({ name: o, value: o })) } };
          show(`engineSend: changeAnnotationProperties(options) annotIndex=${annotIndex}, pageIndex=${pageIndex}, properties=${JSON.stringify(optionsProperties)}`);
          try {
            await withEngineRetry(() => (doc as any).changeAnnotationProperties(annotIndex, pageIndex, optionsProperties, 'Widget'), 6, 200, 'changeAnnotationProperties(options)');
          } catch (err) {
            throw new Error(`changeAnnotationProperties(annotIndex=${annotIndex}, pageIndex=${pageIndex}, properties=${JSON.stringify(optionsProperties)}) failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Font reinforcement is cosmetic -- keep it best-effort so a font
          // hiccup never costs the (working, load-bearing) options patch.
          const fontProperties1 = { Fnt: { S: FIELD_FONT_SIZE, F: 'Helvetica' } };
          show(`engineSend: changeAnnotationProperties(font) annotIndex=${annotIndex}, pageIndex=${pageIndex}, properties=${JSON.stringify(fontProperties1)}`);
          try {
            await withEngineRetry(() => (doc as any).changeAnnotationProperties(annotIndex, pageIndex, fontProperties1, 'Widget'), 6, 200, 'changeAnnotationProperties(font, dropdown/listbox with options)');
          } catch { /* font reinforcement is best-effort */ }
        } else {
          throw new Error(`could not locate created annotation on page ${pageIndex} (response.annot=${JSON.stringify(response?.annot)})`);
        }
      } else {
        // No options to apply -- font reinforcement alone is cosmetic, so
        // don't fail the whole call if the annotation can't be located.
        try {
          const annotIndex = findCreatedAnnotIndex();
          if (annotIndex >= 0) {
            const fontProperties2 = { Fnt: { S: FIELD_FONT_SIZE, F: 'Helvetica' } };
            show(`engineSend: changeAnnotationProperties(font) annotIndex=${annotIndex}, pageIndex=${pageIndex}, properties=${JSON.stringify(fontProperties2)}`);
            await withEngineRetry(() => (doc as any).changeAnnotationProperties(annotIndex, pageIndex, fontProperties2, 'Widget'), 6, 200, 'changeAnnotationProperties(font, dropdown/listbox no options)');
          }
        } catch { /* font reinforcement is best-effort */ }
      }
    } else if (data.field_type === 'text') {
      // Same font-size reinforcement as above, for the one other
      // text-bearing type. Best-effort: a missed patch just leaves the
      // (already-attempted) createAnnotation Fnt param as the only source of
      // truth, same as before this fix existed.
      try {
        const annotIndex = findCreatedAnnotIndex();
        if (annotIndex >= 0) {
          const fontProperties3 = { Fnt: { S: FIELD_FONT_SIZE, F: 'Helvetica' } };
          show(`engineSend: changeAnnotationProperties(font) annotIndex=${annotIndex}, pageIndex=${pageIndex}, properties=${JSON.stringify(fontProperties3)}`);
          await withEngineRetry(() => (doc as any).changeAnnotationProperties(annotIndex, pageIndex, fontProperties3, 'Widget'), 6, 200, 'changeAnnotationProperties(font, text)');
        }
      } catch { /* font reinforcement is best-effort */ }
    }

    // Passing N (requested field name) directly in createAnnotation's
    // params destabilized ComboBox/ListBox creation the same way O once did --
    // N belongs to the FormField schema, not the Widget annotation's own
    // creation payload (see the api_reference.md CreateAnnot/Widget section:
    // no N there), and bundling an out-of-schema key into that payload
    // apparently corrupts something engine-side for Choice fields specifically
    // (matches the exact json.exception.type_error.302 signature already seen
    // for O). Try applying it as its own separate best-effort patch afterward
    // instead -- consistent with how O/Fnt are already split out above, and
    // already documented as "not guaranteed to be honored" in the tool schema,
    // so a failed/no-op patch here is not a regression.
    if (requestedName) {
      try {
        const annotIndex = findCreatedAnnotIndex();
        if (annotIndex >= 0) {
          const nameProperties = { field: { N: requestedName } };
          show(`engineSend: changeAnnotationProperties(name) annotIndex=${annotIndex}, pageIndex=${pageIndex}, properties=${JSON.stringify(nameProperties)}`);
          await withEngineRetry(() => (doc as any).changeAnnotationProperties(annotIndex, pageIndex, nameProperties, 'Widget'), 6, 200, 'changeAnnotationProperties(name)');
        }
      } catch { /* requested name is best-effort -- engine auto-assigns one regardless */ }
    }

    // Passing V in the createAnnotation params above is unreliable
    // for text fields — the engine sometimes creates the field without ever
    // applying it, leaving the value empty until a separate update_form_field
    // call. changeAcroformValue is the same call update_form_field already
    // relies on to *verify* a value actually took (see tryChangeAcroform), so
    // reinforce it here too instead of trusting the creation param alone.
    if (fieldName && data.default_value != null && data.field_type !== 'dropdown' && data.field_type !== 'listbox') {
      const target = data.field_type === 'checkbox' ? (params.V as string) : data.default_value;
      await tryChangeAcroform(doc, fieldName, target);
    }

    // For non-button types, add a plain text label above the field via createTextBlock.
    // createTextBlock's position is the block's TOP-left corner (text
    // grows downward from it -- confirmed by handleAddTextToPage using the same
    // convention). The label used to be placed at exactly pdfTop, the field
    // rect's own top edge, so it rendered growing straight down INTO the field
    // instead of sitting above it. Push it up by one line height plus a small
    // gap so it clears the field instead of overlapping it.
    if (data.label != null && data.field_type !== 'button') {
      const LABEL_FONT_SIZE = 9;
      const LABEL_GAP_PT = 3;
      const labelPdfTop = Math.min(ph - 1, pdfTop + LABEL_FONT_SIZE * 1.2 + LABEL_GAP_PT);
      try {
        const labelFont = { S: LABEL_FONT_SIZE, F: 'Helvetica', C: '#FF000000' };
        show(`engineSend: createTextBlock(label) pageIndex=${pageIndex}, font=${JSON.stringify(labelFont)}, position=${JSON.stringify([left, labelPdfTop])}`);
        await withEngineRetry(() => (doc as any).createTextBlock({ pageIndex, font: labelFont, position: [left, labelPdfTop] }), 6, 200, 'createTextBlock(label)');
        const pageModel = (doc as any).pages?.[pageIndex] ?? pages[pageIndex];
        if (!pageModel.isLoaded) await (doc as any).loadPageContent(pageModel);
        const newIdx = ((pageModel.textBlocks as unknown[]) ?? []).length - 1;
        if (newIdx >= 0) {
          const editPageTextData = { pageIndex, textblocks: [{ index: newIdx, spans: [{ text: data.label, font: labelFont }] }] };
          show(`engineSend: editPageText(label) ${JSON.stringify(editPageTextData)}`);
          await withEngineRetry(() => (doc as any).editPageText(editPageTextData), 6, 200, 'editPageText(label)');
        }
      } catch { /* label is optional */ }
    }

    show(`Form field added${fieldName ? `: ${fieldName}` : ''}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'add_form_field', json: JSON.stringify({ success: true, field_name: fieldName }) },
    });
  } catch (err) {
    show(`add_form_field error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'add_form_field', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

function parseSplitRange(str: string, total: number): string[] {
  const pages = new Set<string>();
  for (const part of str.split(',').map((s) => s.trim())) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= Math.min(b, total); i++) pages.add(String(i));
    } else if (part) {
      pages.add(part);
    }
  }
  return [...pages].sort((a, b) => Number(a) - Number(b));
}

async function handleSplit(cmd: ToolCommand): Promise<void> {
  const { ranges, pagesPerFile, outputDir = '', baseName = 'split' } = cmd;
  try {
    showSaveProgress('Splitting PDF');
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const totalPages = ((doc as any).getPages() as unknown[]).length;
    const sep = outputDir.includes('\\') ? '\\' : '/';

    let groups: string[][];
    if (ranges) {
      groups = ranges.map((r) => parseSplitRange(r, totalPages));
    } else {
      groups = [];
      for (let start = 1; start <= totalPages; start += pagesPerFile!) {
        const end = Math.min(start + pagesPerFile! - 1, totalPages);
        const chunk: string[] = [];
        for (let p = start; p <= end; p++) chunk.push(String(p));
        groups.push(chunk);
      }
    }

    const saved: Array<{ path: string; pages: number }> = [];
    for (let i = 0; i < groups.length; i++) {
      const pages = groups[i];
      if (!pages.length) continue;
      showSaveProgress(`Splitting — part ${i + 1} of ${groups.length}`);
      const extracted = new Uint8Array(await (doc as any).extractPages({ Range: pages }));
      const label = pages.length === 1 ? `p${pages[0]}` : `p${pages[0]}-${pages[pages.length - 1]}`;
      const outPath = outputDir ? `${outputDir}${sep}${baseName}_${label}.pdf` : `${baseName}_${label}.pdf`;
      await saveChunked(extracted, outPath, `Saving part ${i + 1} of ${groups.length}`);
      saved.push({ path: outPath, pages: pages.length });
    }
    showSaveSuccess(`Split into ${saved.length} file${saved.length !== 1 ? 's' : ''}`, outputDir || undefined);
    // split_pdf's own tool response returns immediately (it has to,
    // to deliver the open target to this widget in the first place) — this is
    // the only place the REAL outcome (actual source page count, actual files
    // produced) is known. Report it so get_last_operation_result can hand the
    // model ground truth instead of it guessing or reusing a stale answer
    // from an earlier, unrelated read_document_information call.
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'split_done', json: JSON.stringify({ success: true, sourcePages: totalPages, files: saved }) },
    }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSaveError(`Split failed: ${message}`);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'split_done', json: JSON.stringify({ success: false, error: message }) },
    }).catch(() => {});
  }
}

async function handleMerge(files: Array<{ token: string; name: string }>, outputPath: string): Promise<void> {
  try {
    showSaveProgress(`Merging ${files.length} PDFs`);
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    for (let i = 1; i < files.length; i++) {
      showSaveProgress(`Merging — inserting file ${i + 1} of ${files.length} (${files[i].name})`);
      const bytes = await loadBytes(`file/${files[i].token}`);
      let bin = '';
      for (let j = 0; j < bytes.length; j += 65536) bin += String.fromCharCode(...bytes.subarray(j, j + 65536));
      const pageCount = (doc.getPages as () => unknown[])().length;
      await (doc as any).insertPagesFromFile({ index: pageCount, sourceFile: btoa(bin) });
    }
    showSaveProgress('Exporting merged PDF');
    const merged = new Uint8Array(await (doc as any).exportDocument({ as: 'uint8array' }));
    beacon(`merge done: ${merged.length} bytes → ${outputPath}`);
    await saveChunked(merged, outputPath, 'Saving merged PDF');
    _currentFilePath = outputPath;
    _workingFilePath = null; // merge produces a new original — start a fresh working copy from it
    showSaveSuccess('PDFs merged successfully', outputPath);
    const totalPages = ((doc as any).getPages() as unknown[]).length;
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'merge_done', json: JSON.stringify({ success: true, outputPath, totalPages, fileCount: files.length }) },
    }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSaveError(`Merge failed: ${message}`);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'merge_done', json: JSON.stringify({ success: false, error: message }) },
    }).catch(() => {});
  }
}

async function handleCompress(compression: string, outputPath: string): Promise<void> {
  try {
    showSaveProgress(`Compressing (${compression})`);
    const doc = (activeDocumentView() as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const qualityValue = COMPRESS_QUALITY[compression] ?? 0.5;
    const originalSize = doc.size ?? 0;
    const compressed = new Uint8Array(await doc.compress(qualityValue));
    beacon(`compress done: ${compressed.length} bytes → ${outputPath}`);
    await saveChunked(compressed, outputPath, 'Saving compressed PDF');
    showSaveSuccess('PDF compressed successfully', outputPath);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'compress_done', json: JSON.stringify({ success: true, outputPath, originalSize, compressedSize: compressed.length }) },
    }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showSaveError(`Compress failed: ${message}`);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'compress_done', json: JSON.stringify({ success: false, error: message }) },
    }).catch(() => {});
  }
}

type ToolCommand = {
  type: string;
  quality?: string;
  compression?: string;
  outputPath?: string;
  files?: Array<{ token: string; name: string }>;
  ranges?: string[];
  pagesPerFile?: number;
  outputDir?: string;
  baseName?: string;
  opId?: string;
};

// ── Fullscreen arbitration across sibling widget iframes ────────────────────
// A widget's iframe re-fires `ontoolresult` on every remount — not just on a
// genuinely new tool call, but also when scrolling it back into view, or when
// reopening a past chat much later. Each widget also runs on its own ephemeral
// sandbox origin (a random per-instance claudemcpcontent.com subdomain), so
// BroadcastChannel/localStorage cannot coordinate between them even for
// concurrent opens. The one thing every widget in a conversation actually
// shares is the local Node MCP server process, so arbitration happens there
// via the claim_fullscreen tool, keyed on the document's token: the first
// widget to claim a given token gets fullscreen; any later claim for that
// same token (a remount) is denied and stays inline with its manual expand
// button.
function shouldAutoFullscreen(token: string): Promise<boolean> {
  return (app as any).callServerTool({ name: 'claim_fullscreen', arguments: { token } })
    .then((r: { content?: Array<{ text?: string }> }) => {
      const parsed = JSON.parse(r.content?.[0]?.text ?? '{}') as { allow?: boolean };
      return parsed.allow ?? true;
    })
    .catch(() => true);
}

// Same remount problem as fullscreen arbitration above, but for the
// command itself — ontoolresult re-fires with the same open target (and thus
// the same command) on every remount, not just on a genuinely new tool call.
// Without this, a scroll-back-into-view or reopening an old chat re-ran
// compress_pdf/merge_pdf/split_pdf and silently overwrote the output file.
// Arbitrated server-side (claim_operation, mirroring claim_fullscreen) so it
// survives this widget instance being torn down and remounted fresh.
function shouldRunOperation(opId: string, outputPath?: string): Promise<boolean> {
  return (app as any).callServerTool({ name: 'claim_operation', arguments: { opId, outputPath } })
    .then((r: { content?: Array<{ text?: string }> }) => {
      const parsed = JSON.parse(r.content?.[0]?.text ?? '{}') as { allow?: boolean };
      return parsed.allow ?? true;
    })
    .catch(() => true);
}

type OpenTarget = { token?: string; name?: string; filePath?: string; command?: ToolCommand };

// Every observed host strips `structuredContent` from `ontoolresult` (absent
// on every firing, live open or historical replay).
// `get_pending_open`'s fallback returns a single server-process-wide "last
// opened" pointer, which is wrong for a remounted widget once some OTHER
// conversation has opened a different document since. The tool's own `content`
// array reliably differs per call and is not affected by whatever strips
// structuredContent, so the server also embeds the open target there (see
// `openTargetContentBlock` in src/server.ts) — check that first.
function parseOpenTargetFromContent(result: { content?: Array<{ text?: string }> }): OpenTarget | undefined {
  for (const block of result.content ?? []) {
    if (!block.text) continue;
    try {
      const parsed = JSON.parse(block.text) as { open?: OpenTarget };
      if (parsed.open?.token && parsed.open?.name) return parsed.open;
    } catch { /* not our JSON block, keep looking */ }
  }
  return undefined;
}

app.ontoolresult = async (result) => {
  let data = (result as { structuredContent?: OpenTarget }).structuredContent;
  beacon(`ontoolresult fired: structuredContent.command=${JSON.stringify((data as any)?.command)}`);
  if (!(data?.token && data.name)) {
    data = parseOpenTargetFromContent(result as { content?: Array<{ text?: string }> });
    beacon(`ontoolresult: structuredContent missing token/name, fell back to content block, command=${JSON.stringify((data as any)?.command)}`);
  }
  // Last-resort fallback for hosts where neither of the above arrives (e.g. very
  // old cached widget builds): ask the server for the last-known open target.
  if (!(data?.token && data.name)) {
    try {
      const r = await (app as any).callServerTool({ name: 'get_pending_open', arguments: {} });
      const parsed = JSON.parse((r.content?.[0] as { text?: string })?.text ?? '{}') as { open?: OpenTarget };
      if (parsed.open?.token && parsed.open?.name) data = parsed.open;
    } catch { /* leave data as-is; open is skipped below if still empty */ }
  }
  if (data?.token && data.name) {
    const token = data.token;
    _currentToken = data.token;
    _currentFilePath = data.filePath ?? '';
    _workingFilePath = null; // new document open — start a fresh working copy derived from this path
    _openingDocument = openPdf(data.token, data.name, data.filePath).then(async () => {
      try {
        if (await shouldAutoFullscreen(token)) {
          const r = await (app as any).requestDisplayMode({ mode: 'fullscreen' });
          updateFullscreenBtn(r?.mode ?? 'fullscreen');
        }
      } catch (_) {}
      const command = data.command;
      if (command && (command.type === 'compress_pdf' || command.type === 'merge_pdf' || command.type === 'split_pdf')) {
        // No opId means an older cached widget build minted this command
        // before opId existed — run it (fail open) rather than silently skip
        // a legitimate first run.
        beacon(`ontoolresult: about to arbitrate ${command.type} opId=${command.opId ?? '(none)'}`);
        const allow = !command.opId || (await shouldRunOperation(command.opId, command.outputPath));
        beacon(`ontoolresult: ${command.type} opId=${command.opId ?? '(none)'} allow=${allow}`);
        if (allow) {
          if (command.type === 'compress_pdf') {
            await handleCompress(command.compression ?? 'medium', command.outputPath ?? _currentFilePath);
          } else if (command.type === 'merge_pdf') {
            await handleMerge(command.files ?? [], command.outputPath ?? _currentFilePath);
          } else {
            await handleSplit(command);
          }
        } else {
          beacon(`skipped re-running ${command.type} (opId ${command.opId}) — already executed, this is a remount replay`);
        }
      }
    }).catch((err) => {
      if (isFriendlyOpenError(err)) { show(err.message, true); return; }
      show(`open failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`, true);
    }).finally(() => {
      _openingDocument = null;
    });
  }
};

// ── get_selection_info ───────────────────────────────────────────────────────

// Text can be selected either while copying text from the page ('TextCopy')
// or while editing text inside a text-box/annotation ('TextEdit'). Both selection
// implementations store the underlying caret in the same `selectCaret` field, but
// 'TextEdit' overrides getSelectionData() to return its transformer instead, so we
// must read the field directly rather than going through getSelectionData().
function getTextSelectionCaret(dv: any): any {
  const selType: string | null = dv?.getSelectionType?.() ?? null;
  if (selType !== 'TextCopy' && selType !== 'TextEdit') return null;
  const sel = dv?.getSelection?.();
  if (!sel) return null;
  return sel.selectCaret ?? sel.getSelectionData?.() ?? null;
}

async function handleGetSelectionInfo(): Promise<void> {
  try {
    const dv = activeDocumentView() as any;
    const caret = getTextSelectionCaret(dv);
    const text: string | null = caret?.getSelectedText?.() ?? null;
    const range = caret?.getSelectedRange?.();
    const font: unknown = (range && !range.empty?.()) ? (caret?.getFontAttributes?.(range.begin) ?? null) : null;
    const hasSelection = caret !== null && text !== null;
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'get_selection_info', json: JSON.stringify({ hasSelection, text, fontAttributes: font }) },
    });
  } catch (err) {
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'get_selection_info', json: JSON.stringify({ hasSelection: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

// ── format_selected_text ─────────────────────────────────────────────────────

async function handleFormatSelectedText(data: {
  font_size?: number;
  font_family?: string;
  font_style?: string;
  text_color?: string;
  highlight_color?: string;
  underline_color?: string;
  strikeout_color?: string;
}): Promise<void> {
  try {
    const dv = activeDocumentView() as any;
    const caret = getTextSelectionCaret(dv);
    if (!caret) throw new Error('No text selected in viewer. Select text first, then call this tool.');

    const range = caret.getSelectedRange?.();
    if (!range || range.empty?.()) throw new Error('Selection range is empty.');

    const font: Record<string, unknown> = {};
    if (data.font_size !== undefined) font['S'] = data.font_size;
    if (data.font_family !== undefined) font['F'] = data.font_family;
    if (data.font_style !== undefined) {
      const styleMap: Record<string, number> = { regular: 0, italic: 1, bold: 2, bold_italic: 3 };
      const sv = styleMap[data.font_style.toLowerCase()];
      if (sv !== undefined) font['s'] = sv;
    }
    if (data.text_color !== undefined) font['C'] = toArgbColor(data.text_color);
    if (data.highlight_color !== undefined) font['HL'] = toArgbColor(data.highlight_color);
    if (data.underline_color !== undefined) font['UL'] = toArgbColor(data.underline_color);
    if (data.strikeout_color !== undefined) font['SO'] = toArgbColor(data.strikeout_color);

    const position = range.begin;
    const textBlockData = caret.getTextBlockData?.(position);
    if (!textBlockData) throw new Error('Could not resolve text block for selection.');

    const doc = dv.getDocument?.();
    if (!doc?.changeFontAttributes) throw new Error('viewer does not support changeFontAttributes');

    await doc.changeFontAttributes({
      pageIndex: position.pageIndex,
      textblockIndex: textBlockData.textBlockIndex,
      charPosition: textBlockData.charIndex,
      charCount: range.end.charIndex - range.begin.charIndex,
      font,
    });

    show('Selection formatted');
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'format_selected_text', json: JSON.stringify({ success: true }) },
    });
  } catch (err) {
    show(`format_selected_text error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'format_selected_text', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

(async () => {
  try {
    await app.connect();
    const platform = detectPlatform(app);
    beacon(`connected to host, platform=${platform}, isDesktop=${isDesktop(app)}`);
    startViewerCommandPoller();
    const initialCtx = (app as any).getHostContext?.();
    applyContainerHeight(initialCtx);
    fullscreenBtn.style.display = 'flex';
    updateFullscreenBtn(initialCtx?.displayMode ?? 'inline');
    // Don't mount eagerly — wait for the first display_pdf result so the
    // viewer can open that document as part of initialization.
  } catch (err) {
    show(`connect failed: ${(err as Error).message}`, true);
  }
})();
