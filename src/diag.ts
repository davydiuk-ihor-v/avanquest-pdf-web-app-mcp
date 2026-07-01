import { App } from '@modelcontextprotocol/ext-apps';

declare global {
  interface Window {
    PWV_CONFIG: { base: string; license: string; proxy: string };
  }
}

const out = document.getElementById('out')!;
const { base } = window.PWV_CONFIG;

function line(msg: string): void {
  out.textContent += msg + '\n';
}

document.addEventListener('securitypolicyviolation', (e) => {
  line(`CSP VIOLATION: directive=${e.violatedDirective} blocked=${e.blockedURI || '(inline)'}`);
});
window.addEventListener('error', (e) => {
  line(`window.error: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  line(`unhandledrejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}: timeout after ${ms}ms`)), ms)),
  ]);
}

async function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    line(`PASS  ${name}`);
  } catch (e) {
    line(`FAIL  ${name}: ${(e as Error).message}`);
  }
}

line(`module script executing OK`);
line(`location=${location.href}`);
line(`base=${base}`);

(async () => {
  const app = new App({ name: 'PWV Diag', version: '0.3.0' }, {});

  await run('host bridge connect', () => withTimeout(app.connect(), 5000, 'connect'));

  await run('blob worker', () =>
    withTimeout(
      new Promise((res, rej) => {
        const url = URL.createObjectURL(new Blob(['postMessage("ok")'], { type: 'text/javascript' }));
        const w = new Worker(url);
        w.onmessage = res;
        w.onerror = (e) => rej(new Error(e.message || 'worker error event'));
      }),
      3000,
      'worker',
    ),
  );

  await run('wasm instantiate from bytes', () =>
    WebAssembly.instantiate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
  );

  await run('blob module import', () =>
    import(/* @vite-ignore */ URL.createObjectURL(new Blob(['export default 1'], { type: 'text/javascript' }))),
  );

  await run('fetch http://127.0.0.1 (connect-src)', () =>
    withTimeout(fetch(`${base}log`, { method: 'POST', body: 'diag: fetch reached server' }), 4000, 'fetch'),
  );

  await run('import http://127.0.0.1 module (script-src)', () =>
    withTimeout(import(/* @vite-ignore */ `${base}ui/index.js`), 8000, 'import'),
  );

  line('diagnostics complete');
})();
