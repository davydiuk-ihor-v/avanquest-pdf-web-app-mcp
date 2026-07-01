import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkgPath = resolve(root, 'package.json');
const manifestPath = resolve(root, 'manifest.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

const [major, minor, patch] = pkg.version.split('.').map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;

pkg.version = newVersion;
manifest.version = newVersion;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`version bumped: ${newVersion}`);
