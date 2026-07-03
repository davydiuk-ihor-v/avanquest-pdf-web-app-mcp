// Packs the .mcpb from a clean staging directory containing only what the
// installed extension needs at runtime: dist/, manifest.json, icon.png,
// LICENSE, and a package.json trimmed to `dependencies` (no devDependencies).
// Packing the repo root directly (`mcpb pack .`) drags in ~95MB of build
// tooling (typescript, vite/rolldown, esbuild, @anthropic-ai/mcpb itself)
// because devDependencies live in the same node_modules.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagingDir = resolve(root, '.mcpb-staging');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const outFile = process.argv[2] ?? resolve(root, `${pkg.name}.mcpb`);

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

for (const entry of ['dist', 'manifest.json', 'icon.png', 'LICENSE']) {
  const src = resolve(root, entry);
  if (existsSync(src)) cpSync(src, resolve(stagingDir, entry), { recursive: true });
}

const trimmedPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  private: pkg.private,
  type: pkg.type,
  dependencies: pkg.dependencies,
};
writeFileSync(resolve(stagingDir, 'package.json'), JSON.stringify(trimmedPkg, null, 2) + '\n');

console.log('Installing production dependencies in staging...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: stagingDir,
  stdio: 'inherit',
  shell: true,
});

console.log('Packing .mcpb from staging...');
execFileSync('mcpb', ['pack', stagingDir, outFile], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});

if (!process.env.KEEP_STAGING) {
  rmSync(stagingDir, { recursive: true, force: true });
}

console.log(`Done: ${outFile}`);
