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
  const mod = (await import(/* @vite-ignore */ `${base}mod/${rel}`)) as { default: string | null };
  if (!mod.default) throw new Error(`asset not found: ${rel}`);
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
  statusEl.style.background = isError ? '#fee' : '#fff';
  statusEl.style.border = isError ? '1px solid #f33' : '1px solid #ccc';
  statusEl.style.color = isError ? '#900' : '#333';
  statusEl.textContent = msg;
  beacon(isError ? `ERROR: ${msg}` : msg);
  // Auto-dismiss error toasts so they don't linger on screen forever. Success
  // messages are hidden by their own handlers (and aren't shown in production).
  if (isError) {
    _statusHideTimer = setTimeout(() => { statusEl.style.display = 'none'; _statusHideTimer = undefined; }, 6000);
  }
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

window.addEventListener('error', (e) => {
  show(`window.error: ${e.message}\n${e.filename}:${e.lineno}:${e.colno}`, true);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (msg.includes('Clipboard') || msg.includes('clipboard')) { e.preventDefault(); return; }
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
    // server-relative path (e.g. "public/pwv-workers/").
    const rel = new URL(dir).pathname.replace(/^\//, '');
    let manifest: Record<string, string> = {};
    try {
      manifest = JSON.parse(new TextDecoder().decode(await loadBytes(rel + 'manifest.json')));
    } catch {
      // fall back to unhashed names
    }
    const jsFile = manifest['pdfworker.js'] ?? 'pdfworker.js';
    const wasmFile = manifest['pdfworker.wasm'] ?? 'pdfworker.wasm';
    const dataFile = manifest['pdfworker.data'] ?? 'pdfworker.data';
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
  { name: 'Avanquest PDF Viewer', version: '0.4.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
);

// Intercept report_viewer_result to automatically inject current doc state (_pageCount, _currentPage).
// This gives the server fresh page count after every operation so Claude doesn't work with stale state.
{
  const _orig = (app as any).callServerTool.bind(app);
  (app as any).callServerTool = async (params: { name: string; arguments: Record<string, unknown> }) => {
    if (params.name === 'report_viewer_result') {
      try {
        const doc = (_currentDocumentView as any)?.getDocument?.();
        const pages = doc?.getPages?.() as unknown[] | undefined;
        if (pages) {
          const parsed = JSON.parse(params.arguments.json as string);
          parsed._pageCount = pages.length;
          const idx = (_currentDocumentView as any)?.getCurrentPageIndex?.();
          if (typeof idx === 'number') parsed._currentPage = idx + 1;
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

let _currentDocumentView: any = null;
// Resolves when the current openPdf() call completes (including page-load wait).
// Command poller awaits this before dispatching so stale document state is never read.
let _openingDocument: Promise<void> | null = null;
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
  document.documentElement.style.height = `${h}px`;
  document.body.style.height = `${h}px`;
  viewerEl.style.height = `${h}px`;
}

app.addEventListener('hostcontextchanged', (ctx: any) => {
  applyContainerHeight(ctx);
  if (ctx?.displayMode && !(_lockedFullscreenH > 0 && ctx.displayMode === 'inline')) {
    updateFullscreenBtn(ctx.displayMode);
  }
});

const CHUNK_SIZE = 256 * 1024;

let _currentToken = '';
let _currentFilePath = '';

function showSaveDialog(defaultPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:20000;display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;border:1px solid #555;border-radius:8px;padding:20px;width:520px;max-width:90vw;font-family:monospace;color:#ccc';
    box.innerHTML = `<div style="margin-bottom:12px;font-size:14px;color:#fff">Save PDF as</div>`;

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
    statusEl.style.display = 'block';
    statusEl.textContent = 'Saving…';
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
      let b64 = '';
      for (let i = 0; i < chunk.length; i += 65536) {
        b64 += String.fromCharCode(...chunk.subarray(i, i + 65536));
      }
      await (app as any).callServerTool({
        name: 'save_pdf',
        arguments: { token: _currentToken, savePath, chunk: btoa(b64), offset, totalSize: bytes.length },
      });
      offset += chunk.length;
      statusEl.textContent = `Saving… ${Math.round((offset / bytes.length) * 100)}%`;
    }
    statusEl.textContent = 'Saved!';
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  } catch (err) {
    statusEl.style.display = 'block';
    statusEl.style.background = '#fee';
    statusEl.textContent = `Save error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

let editorReady: Promise<ViewerResult> | null = null;

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
      workerPath: `${base}public/pwv-workers/`,
      fontsPath: `${base}public/pwv-fonts/`,
      i18nPath: `${base}public/pwv-i18n/`,
      stampsPath: `${base}public/pwv-stamps/`,
      layoutConfig: {
        header: {
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
      },
      ...(initialFile ? { initialDocument: { file: initialFile } } : {}),
      onDownloadFile: async (file: File) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await saveFileBytes(bytes, _currentFilePath || file.name);
      },
    });
    const svc = (result as any).ui?.pdfWebService;
    // documentOpened$ fires when a document is fully loaded — single authoritative subscription.
    // Handles all subsequent display_pdf calls; the first open is handled separately below.
    svc?.documentOpened$?.subscribe?.((docVm: any) => {
      _currentDocumentView = docVm;
      // Resolve the pending openPdf() Promise so commands are unblocked.
      if (_resolveDocOpen) { const r = _resolveDocOpen; _resolveDocOpen = null; r(); }
      // Notify server that the new document is ready (clears _pendingDocOpen gate).
      (app as any).callServerTool({ name: 'report_viewer_result', arguments: { type: 'doc_opened' } }).catch(() => {});
    });
    const initial = svc?.getActiveDocumentViewElement?.()?.documentView;
    if (initial) _currentDocumentView = initial;

    statusEl.style.display = 'none';
    return result;
  })().catch((err: unknown) => {
    show(`init failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`, true);
    throw err;
  });
  return editorReady;
}

async function fileFromToken(token: string, name: string, filePath?: string): Promise<File> {
  // In web contexts (Cowork / claude.ai) dynamic import('http://...') is blocked
  // as mixed content. Use the MCP channel instead.
  if (isWeb(app)) {
    const result = await (app as any).callServerTool({
      name: 'read_pdf_bytes_by_token',
      arguments: { token, filePath },
    });
    const data = JSON.parse(result.content[0].text) as { base64?: string; error?: string };
    if (data.error) throw new Error(data.error);
    if (!data.base64) throw new Error('empty response from read_pdf_bytes_by_token');
    return new File([b64ToBytes(data.base64).buffer as ArrayBuffer], name, { type: 'application/pdf' });
  }
  // Desktop: fetch via HTTP import channel.
  const q = filePath ? `?fp=${encodeURIComponent(filePath)}` : '';
  const bytes = await loadBytes(`file/${token}${q}`);
  return new File([bytes.buffer as ArrayBuffer], name, { type: 'application/pdf' });
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
  // Use the canonical openDocument() API and read the active document directly after it
  // resolves — more reliable than waiting for documentOpened$ which may not fire for every case.
  const svc = (editor as any).ui?.pdfWebService;
  try {
    if (svc?.openDocument) {
      await Promise.race([
        svc.openDocument(file),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('open timeout')), 10_000)),
      ]);
    } else {
      await Promise.race([
        editor.ui?.pdfWebElement?.documentView?.openFile(file) ?? Promise.resolve(),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('open timeout')), 10_000)),
      ]);
    }
  } catch { /* timeout or open error — proceed with whatever document is active */ }
  // After openDocument resolves, read the active document directly.
  const activeVm = svc?.getActiveDocumentViewElement?.()?.documentView;
  if (activeVm) _currentDocumentView = activeVm;
  // Unblock the server-side command gate.
  (app as any).callServerTool({ name: 'report_viewer_result', arguments: { type: 'doc_opened' } }).catch(() => {});
  statusEl.style.display = 'none';
}

const COMPRESS_QUALITY: Record<string, number> = {
  max: 0.15, high: 0.25, medium: 0.5, low: 0.75, min: 1.0,
};

async function saveChunked(bytes: Uint8Array, targetPath: string): Promise<void> {
  const totalSize = bytes.length;
  let offset = 0;
  while (offset < totalSize) {
    const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
    let bin = '';
    for (let i = 0; i < chunk.length; i += 65536) bin += String.fromCharCode(...chunk.subarray(i, i + 65536));
    await (app as any).callServerTool({
      name: 'save_pdf',
      arguments: { token: _currentToken, savePath: targetPath, chunk: btoa(bin), offset, totalSize },
    });
    offset += chunk.length;
    statusEl.textContent = `Compressing… saving ${Math.round((offset / totalSize) * 100)}%`;
  }
}

function startViewerCommandPoller(): void {
  setInterval(async () => {
    if (!editorReady) return;
    try {
      const result = await (app as any).callServerTool({ name: 'get_viewer_command', arguments: {} });
      const { command } = JSON.parse((result.content[0] as { text: string }).text) as { command: Record<string, unknown> | null };
      if (!command) return;
      // Wait for any in-progress document open to complete before executing viewer commands.
      if (_openingDocument) try { await _openingDocument; } catch { /* ignore */ }
      // Always refresh _currentDocumentView from the live service before each command so that
      // stale references from a previous document never leak into tool handlers.
      {
        const ed = await editorReady;
        const freshVm = (ed as any).ui?.pdfWebService?.getActiveDocumentViewElement?.()?.documentView;
        if (freshVm) _currentDocumentView = freshVm;
      }
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
        await handleReadText();
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
        (_currentDocumentView as any)?.resetSelection?.();
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
    } catch (_) {}
  }, 800);
}

async function handleRotatePages(data: { angle: number; pages: number[] | null }): Promise<void> {
  try {
    show('Rotating pages…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const totalPages = (doc.getPages() as unknown[]).length;
    const range: number[] = data.pages
      ? data.pages.filter((p) => p >= 1 && p <= totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);
    await (doc as any).rotatePages({ range, angle: data.angle });
    applyContainerHeight(null);
    show(`Rotated ${range.length} page(s) by ${data.angle}°`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  } catch (err) {
    show(`Rotate error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleInsertBlankPage(data: { afterPage: number | null }): Promise<void> {
  try {
    show('Inserting blank page…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
  } catch (err) {
    show(`Insert page error: ${err instanceof Error ? err.message : String(err)}`, true);
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');

    const pages = doc.getPages() as Array<{ width?: number; height?: number }>;
    const pageIndex = data.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) {
      show(`Error: page ${data.page} out of range`, true);
      return;
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
  } catch (err) {
    show(`Add image error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

type AnnotationCommand = {
  shape: string; page: number; x: number; y: number;
  width: number; height: number; color: string | null; fillColor: string | null; borderWidth: number | null;
};

async function handleAddAnnotation(data: AnnotationCommand): Promise<void> {
  try {
    show('Adding annotation…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const pages = (doc.getPages() as unknown[]);
    const pageIndex = data.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) {
      show(`Error: page ${data.page} out of range`, true);
      return;
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
    await (doc as any).createAnnotation({ pageIndex, params });
    show(`Added ${data.shape} on page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  } catch (err) {
    show(`Annotation error: ${err instanceof Error ? err.message : String(err)}`, true);
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
    const documentView = _currentDocumentView;
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
      await (doc as any).createAnnotation({
        pageIndex,
        params: {
          T: annotType,
          rect: [rect.left - pad, rect.top - pad, rect.right + pad, rect.bottom + pad],
          color,
          BS: { W: bw },
        },
      });
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
    const documentView = _currentDocumentView;
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
    _currentDocumentView = null;
    _currentToken = '';
    _currentFilePath = '';
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
    const documentView = _currentDocumentView;
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
  }
}

async function handleSetViewState(data: { page: number }): Promise<void> {
  try {
    (_currentDocumentView as any)?.goToPage?.(data.page - 1);
    show(`Page ${data.page}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 1500);
  } catch (err) {
    show(`Navigation error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleReadDocumentInfo(): Promise<void> {
  try {
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const info: Record<string, unknown> = {
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const docId = (doc as any).id;
    const pdfEditor = (doc as any).pdfEditor;
    if (!pdfEditor) throw new Error('pdfEditor not accessible');
    const results: any[] = [];
    const pageCount = (doc.getNumPages?.() ?? 0) as number;
    const startPage = data.page !== null ? data.page - 1 : 0;
    const endPage = data.page !== null ? data.page - 1 : pageCount - 1;
    for (let pi = startPage; pi <= endPage; pi++) {
      const annots: any[] = await pdfEditor.getPageAnnotations({ documentId: docId, index: pi });
      (annots ?? []).forEach((ann: any, idx: number) => {
        const R = ann.R;
        results.push({
          page: pi + 1,
          index: idx,
          type: ann.T ?? 'unknown',
          color: ann.C ?? null,
          content: ann.c ?? '',
          rect: Array.isArray(R) ? { left: R[0], top: R[1], right: R[2], bottom: R[3] } : null,
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

async function handleReadText(): Promise<void> {
  try {
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const file: File = await (doc as any).convertToText();
    const text = await file.text();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const pageIndex = data.page - 1;
    const docId = (doc as any).id;
    const pdfEditor = (doc as any).pdfEditor;
    if (!pdfEditor) throw new Error('pdfEditor not accessible');
    const properties: Record<string, unknown> = {};
    if (data.color !== null) properties['C'] = data.color;
    if (data.fillColor !== null) properties['IC'] = data.fillColor;
    if (data.opacity !== null) { properties['CA'] = data.opacity; properties['ca'] = data.opacity; }
    if (data.text !== null) properties['c'] = data.text;
    await pdfEditor.changeAnnotationProperties(docId, { pageIndex, annotIndex: data.annotIndex, properties });
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

async function handleReadBookmarks(): Promise<void> {
  try {
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
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

async function handleAddBookmark(data: { page: number; title: string | null; parentPath: number[] }): Promise<void> {
  try {
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await doc.addBookmark({ pageIndex: data.page - 1, title: data.title ?? `Page ${data.page}`, parentIndex: data.parentPath });
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    show('Extracting images…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

    statusEl.textContent = `Saving ZIP (${(zipBytes.length / 1024).toFixed(0)} KB)…`;
    await saveChunked(zipBytes, data.outputPath);

    show(`Extracted images saved to ${data.outputPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);

    const count = Array.isArray(raw) ? (raw as any[]).length : 1;
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'extract_images', json: JSON.stringify({ success: true, path: data.outputPath, count }) },
    });
  } catch (err) {
    show(`extract_images error: ${err instanceof Error ? err.message : String(err)}`, true);
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
    show('Exporting comments…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

    statusEl.textContent = 'Saving comments…';
    await saveChunked(bytes, data.outputPath);

    show(`Comments exported to ${data.outputPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);

    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'export_comments', json: JSON.stringify({ success: true, path: data.outputPath }) },
    });
  } catch (err) {
    show(`export_comments error: ${err instanceof Error ? err.message : String(err)}`, true);
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const raw: any[] = doc.acroforms ?? [];
    // Read the real on-state values of button fields once so checkboxes and, in
    // particular, radio groups report the exact values needed to select them.
    const onValuesByField = await collectButtonOnValues(doc);
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
          if (onValues.length > 0) entry.options = onValues.slice();
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
async function collectButtonOnValues(doc: any): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const pdfEditor = doc?.pdfEditor;
  const docId = doc?.id;
  if (!pdfEditor || docId === undefined) return map;
  const pageCount = (doc.getNumPages?.() ?? 0) as number;
  for (let pi = 0; pi < pageCount; pi++) {
    let annots: any[] = [];
    try {
      annots = await pdfEditor.getPageAnnotations({ documentId: docId, index: pi });
    } catch {
      continue;
    }
    for (const a of annots ?? []) {
      if (a?.T !== 'Widget') continue;
      const field = typeof a.P === 'string' ? a.P : '';
      if (!field) continue;
      const v = typeof a.V === 'string' ? a.V : '';
      if (v === '' || v.toLowerCase() === 'off') continue;
      let list = map.get(field);
      if (!list) { list = []; map.set(field, list); }
      if (!list.includes(v)) list.push(v);
    }
  }
  return map;
}

async function getButtonOnValues(doc: any, fieldName: string): Promise<string[]> {
  const map = await collectButtonOnValues(doc);
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
      const onValues = await getButtonOnValues(doc, data.field_name);
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
          const list = onValues.length > 0
            ? `Its options (in order) are: ${onValues.map((v, i) => `${i + 1}=${v}`).join(', ')}.`
            : 'No selectable options were found on its widgets.';
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
    (_currentDocumentView as any)?.invalidate?.();

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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

async function handleDeleteWatermark(data: { range: string[] }): Promise<void> {
  try {
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await (doc as any).deleteWatermark({ range: data.range });
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

async function handleDeleteHeader(data: { range: string[] }): Promise<void> {
  try {
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    await (doc as any).deleteHeader({ range: data.range });
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    show('Converting pages to images…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const zipFile: File = await (doc as any).convertToImages(data.dpi ?? undefined);
    const bytes = new Uint8Array(await zipFile.arrayBuffer());
    statusEl.textContent = `Saving ZIP (${(bytes.length / 1024).toFixed(0)} KB)…`;
    await saveChunked(bytes, data.outputPath);
    show(`Images saved to ${data.outputPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'convert_to_images', json: JSON.stringify({ success: true, path: data.outputPath }) },
    });
  } catch (err) {
    show(`convert_to_images error: ${err instanceof Error ? err.message : String(err)}`, true);
    try {
      await (app as any).callServerTool({
        name: 'report_viewer_result',
        arguments: { type: 'convert_to_images', json: JSON.stringify({ success: false, error: String(err) }) },
      });
    } catch (_) {}
  }
}

async function handleExtractPages(data: { Range: string[]; outputPath: string }): Promise<void> {
  try {
    show('Extracting pages…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const raw = await (doc as any).extractPages({ Range: data.Range });
    const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
    statusEl.textContent = `Saving extracted PDF (${(bytes.length / 1024).toFixed(0)} KB)…`;
    await saveChunked(bytes, data.outputPath);
    show(`Pages extracted to ${data.outputPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'extract_pages', json: JSON.stringify({ success: true, path: data.outputPath }) },
    });
  } catch (err) {
    show(`extract_pages error: ${err instanceof Error ? err.message : String(err)}`, true);
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
    show('Saving copy…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');
    const raw = await (doc as any).exportDocument({ as: 'uint8array' });
    const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
    let targetPath = data.outputPath;
    if (!targetPath) {
      const dir = _currentFilePath ? _currentFilePath.replace(/[/\\][^/\\]+$/, '') : '';
      const name = data.fileName || 'document_copy.pdf';
      targetPath = dir ? `${dir}\\${name}` : name;
    }
    statusEl.textContent = `Saving… (${(bytes.length / 1024).toFixed(0)} KB)`;
    await saveChunked(bytes, targetPath);
    _currentFilePath = targetPath;
    show(`Saved as ${targetPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    await (app as any).callServerTool({
      name: 'report_viewer_result',
      arguments: { type: 'save_as', json: JSON.stringify({ success: true, path: targetPath }) },
    });
  } catch (err) {
    show(`save_as error: ${err instanceof Error ? err.message : String(err)}`, true);
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available');

    // PageTextSearchFlags: 1 = IgnoreCase, 2 = WholeWord
    let flags = 0;
    if (!data.caseSensitive) flags |= 1;
    if (data.wholeWord) flags |= 2;

    const allRanges: any[] = [];
    const sub = (_currentDocumentView as any).onSearchResults?.()?.subscribe?.((ranges: any[]) => {
      if (ranges?.length) allRanges.push(...ranges);
    });
    await (_currentDocumentView as any).search?.(data.text, flags);
    sub?.unsubscribe?.();
    (_currentDocumentView as any).stopSearch?.();

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

      await (doc as any).createAnnotation({
        pageIndex,
        params: {
          T: 'Redact',
          rect: [combined.left, combined.bottom, combined.right, combined.top],
          color: '#FFFF0000',
        },
      });
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

    await (doc as any).createTextBlock({ pageIndex, font, position: [left, pdfTop] });

    if (!page.isLoaded) await (doc as any).loadPageContent(page);
    const newIdx = ((page.textBlocks as unknown[]) ?? []).length - 1;
    if (newIdx >= 0) {
      await (doc as any).editPageText({
        pageIndex,
        textblocks: [{ index: newIdx, spans: [{ text: data.text, font }] }],
      });
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
};

async function handleAddFormField(data: AddFormFieldCommand): Promise<void> {
  try {
    show('Adding form field…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
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
    const pdfBottom = ph - ((data.y + data.height) / 100) * ph;

    const ftMap: Record<string, string> = {
      text: 'TextBox', checkbox: 'CheckBox', radio: 'RadioButton',
      dropdown: 'ComboBox', listbox: 'ListBox', button: 'PushButton',
    };
    const FT = ftMap[data.field_type] ?? 'TextBox';

    const params: Record<string, unknown> = {
      T: 'Widget',
      FT,
      R: [left, pdfBottom, right, pdfTop],
    };
    // CA (Caption) only works for PushButton; for other types we add a FreeText label separately
    if (data.field_type === 'button' && data.label != null) params.CA = data.label;
    if (data.bg_color != null) params.BG = data.bg_color;
    if (data.border_color != null) params.BC = data.border_color;

    if (data.field_type === 'checkbox') {
      params.V = data.default_value === 'Yes' ? 'Yes' : 'Off';
    } else if (data.default_value != null) {
      params.V = data.default_value;
    }

    if (data.field_type === 'dropdown' || data.field_type === 'listbox') {
      params.O = data.options ? data.options.map((o) => ({ name: o, value: o })) : {};
    }

    const response = await (doc as any).createAnnotation({ pageIndex, params }) as any;
    const fieldName: string | null = response?.F?.N ?? response?.field?.[0]?.N ?? null;

    // For non-button types, add a plain text label above the field via createTextBlock.
    if (data.label != null && data.field_type !== 'button') {
      const fieldPdfTop = ph - (data.y / 100) * ph;
      try {
        const labelFont = { S: 11, F: 'Helvetica', C: '#FF000000' };
        await (doc as any).createTextBlock({ pageIndex, font: labelFont, position: [left, fieldPdfTop] });
        const pageModel = (doc as any).pages?.[pageIndex] ?? pages[pageIndex];
        if (!pageModel.isLoaded) await (doc as any).loadPageContent(pageModel);
        const newIdx = ((pageModel.textBlocks as unknown[]) ?? []).length - 1;
        if (newIdx >= 0) {
          await (doc as any).editPageText({
            pageIndex,
            textblocks: [{ index: newIdx, spans: [{ text: data.label, font: labelFont }] }],
          });
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
    show('Splitting PDF…');
    const doc = (_currentDocumentView as any)?.getDocument?.();
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

    const saved: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const pages = groups[i];
      if (!pages.length) continue;
      statusEl.textContent = `Split: extracting part ${i + 1} of ${groups.length}…`;
      const extracted = new Uint8Array(await (doc as any).extractPages({ Range: pages }));
      const label = pages.length === 1 ? `p${pages[0]}` : `p${pages[0]}-${pages[pages.length - 1]}`;
      const outPath = outputDir ? `${outputDir}${sep}${baseName}_${label}.pdf` : `${baseName}_${label}.pdf`;
      await saveChunked(extracted, outPath);
      saved.push(outPath);
    }
    show(`Split into ${saved.length} file${saved.length !== 1 ? 's' : ''}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
  } catch (err) {
    show(`Split failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleMerge(files: Array<{ token: string; name: string }>, outputPath: string): Promise<void> {
  try {
    show(`Merging ${files.length} PDFs…`);
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    for (let i = 1; i < files.length; i++) {
      statusEl.textContent = `Merging… inserting file ${i + 1} of ${files.length} (${files[i].name})`;
      const bytes = await loadBytes(`file/${files[i].token}`);
      let bin = '';
      for (let j = 0; j < bytes.length; j += 65536) bin += String.fromCharCode(...bytes.subarray(j, j + 65536));
      const pageCount = (doc.getPages as () => unknown[])().length;
      await (doc as any).insertPagesFromFile({ index: pageCount, sourceFile: btoa(bin) });
    }
    statusEl.textContent = `Exporting merged PDF…`;
    const merged = new Uint8Array(await (doc as any).exportDocument({ as: 'uint8array' }));
    beacon(`merge done: ${merged.length} bytes → ${outputPath}`);
    await saveChunked(merged, outputPath);
    _currentFilePath = outputPath;
    show(`Merged and saved to ${outputPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
  } catch (err) {
    show(`Merge failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleCompress(compression: string, outputPath: string): Promise<void> {
  try {
    show(`Compressing (compression: ${compression})…`);
    const doc = (_currentDocumentView as any)?.getDocument?.();
    if (!doc) throw new Error('document not available in viewer');
    const qualityValue = COMPRESS_QUALITY[compression] ?? 0.5;
    const compressed = new Uint8Array(await doc.compress(qualityValue));
    beacon(`compress done: ${compressed.length} bytes → ${outputPath}`);
    statusEl.textContent = `Compressed! Saving to ${outputPath}…`;
    await saveChunked(compressed, outputPath);
    show(`Compressed and saved to ${outputPath}`);
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
  } catch (err) {
    show(`Compress failed: ${err instanceof Error ? err.message : String(err)}`, true);
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
};

app.ontoolresult = (result) => {
  const data = (result as {
    structuredContent?: { token?: string; name?: string; filePath?: string; command?: ToolCommand };
  }).structuredContent;
  if (data?.token && data.name) {
    _currentToken = data.token;
    _currentFilePath = data.filePath ?? '';
    _openingDocument = openPdf(data.token, data.name, data.filePath).then(async () => {
      try {
        const r = await (app as any).requestDisplayMode({ mode: 'fullscreen' });
        updateFullscreenBtn(r?.mode ?? 'fullscreen');
      } catch (_) {}
      if (data.command?.type === 'compress_pdf') {
        await handleCompress(data.command.compression ?? 'medium', data.command.outputPath ?? _currentFilePath);
      } else if (data.command?.type === 'merge_pdf') {
        await handleMerge(data.command.files ?? [], data.command.outputPath ?? _currentFilePath);
      } else if (data.command?.type === 'split_pdf') {
        await handleSplit(data.command);
      }
    }).catch((err) => {
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
    const dv = _currentDocumentView as any;
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
    const dv = _currentDocumentView as any;
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
