// RDB-8046 regression check: two overlapping save_pdf exports for the same
// document used to interleave their chunks (buffers keyed only by the file
// token) and could race on the final fs.writeFile to the same path, producing
// a truncated/corrupt "_updated.pdf". This spins up the real compiled server
// over stdio, mints a token via display_pdf, then fires two concurrent
// chunked saves at the same target path -- one exercising the current
// (saveId-keyed) behavior, one exercising the legacy fallback (no saveId,
// keyed by token) to document that the fallback path is still order-dependent.
//
// Run after `npm run build`:  node scripts/verify-concurrent-save.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHUNK_SIZE = 262144;

function makePayload(byteValue, size) {
  return Buffer.alloc(size, byteValue);
}

async function sendChunked(client, { token, targetPath, bytes, saveId }) {
  const totalSize = bytes.length;
  let offset = 0;
  while (offset < totalSize) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    const args = {
      token,
      savePath: targetPath,
      chunk: chunk.toString('base64'),
      offset,
      totalSize,
    };
    if (saveId) args.saveId = saveId;
    await client.callTool({ name: 'save_pdf', arguments: args });
    offset += chunk.length;
  }
}

async function runScenario(client, { label, targetPath, sourcePdf, useSaveIds }) {
  const openResult = await client.callTool({ name: 'display_pdf', arguments: { path: sourcePdf } });
  const token = openResult.structuredContent?.token;
  if (!token) throw new Error(`display_pdf did not return a token: ${JSON.stringify(openResult)}`);

  // Two distinct "documents" being auto-saved to the same working-copy path
  // at roughly the same time -- mirrors the real trigger overlap (command
  // success save vs. debounced isModified save).
  const payloadA = makePayload(0xaa, CHUNK_SIZE * 3 + 12345);
  const payloadB = makePayload(0xbb, CHUNK_SIZE * 2 + 777);

  await Promise.all([
    sendChunked(client, {
      token,
      targetPath,
      bytes: payloadA,
      saveId: useSaveIds ? `sessionA-${Date.now()}` : undefined,
    }),
    sendChunked(client, {
      token,
      targetPath,
      bytes: payloadB,
      saveId: useSaveIds ? `sessionB-${Date.now()}` : undefined,
    }),
  ]);

  const final = await fs.readFile(targetPath);
  const matchesA = final.equals(payloadA);
  const matchesB = final.equals(payloadB);
  const clean = matchesA || matchesB;

  console.log(`[${label}] final size=${final.length} (A=${payloadA.length}, B=${payloadB.length}) -> ${clean ? `OK, matches ${matchesA ? 'A' : 'B'} intact` : 'CORRUPT: neither payload intact'}`);
  return clean;
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwv-save-test-'));
  const sourcePdf = path.join(tmpDir, 'source.pdf');
  await fs.writeFile(sourcePdf, '%PDF-1.4\n%%EOF\n');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server.js', '--allowed-dirs', tmpDir],
    env: { ...process.env, PWV_DEBUG: 'false' },
  });
  const client = new Client({ name: 'verify-concurrent-save', version: '1.0.0' });
  await client.connect(transport);

  try {
    const fixedOk = await runScenario(client, {
      label: 'current client (saveId per export)',
      targetPath: path.join(tmpDir, 'source_updated_fixed.pdf'),
      sourcePdf,
      useSaveIds: true,
    });

    const legacyOk = await runScenario(client, {
      label: 'legacy fallback (no saveId, keyed by token)',
      targetPath: path.join(tmpDir, 'source_updated_legacy.pdf'),
      sourcePdf,
      useSaveIds: false,
    });

    console.log('');
    console.log(fixedOk
      ? 'PASS: concurrent saves with saveId never interleave.'
      : 'FAIL: concurrent saves with saveId produced a corrupt file -- fix regressed.');
    console.log(legacyOk
      ? 'note: legacy no-saveId path happened not to interleave this run (still not guaranteed -- always send saveId).'
      : 'note: legacy no-saveId path interleaved as expected -- this is why saveId is required, not optional in practice.');

    if (!fixedOk) process.exitCode = 1;
  } finally {
    await client.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
