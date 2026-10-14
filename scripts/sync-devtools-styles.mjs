#!/usr/bin/env node
// Downloads DevTools' own design-system stylesheets from the published
// `chrome-devtools-frontend` npm package (via unpkg) into vendor/devtools/.
//
//   node scripts/sync-devtools-styles.mjs            # pinned version below
//   node scripts/sync-devtools-styles.mjs 1.0.1717196  # explicit version
//   node scripts/sync-devtools-styles.mjs latest       # newest published version
//
// The files are BSD-3-Clause (The Chromium Authors) and are saved unmodified
// below a short provenance header.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED = '1.0.1717196';
const FILES = [
  'front_end/design_system_tokens.css', // --sys-color-*, --sys-size-*, --sys-typescale-*, ...
  'front_end/application_tokens.css',   // app-level overrides on top of the system tokens
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor', 'devtools');

let version = process.argv[2] || PINNED;
if (version === 'latest') {
  const res = await fetch('https://registry.npmjs.org/chrome-devtools-frontend/latest');
  if (!res.ok) throw new Error(`registry lookup failed: ${res.status}`);
  version = (await res.json()).version;
}

await mkdir(out, { recursive: true });
for (const file of FILES) {
  const url = `https://unpkg.com/chrome-devtools-frontend@${version}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const header = `/* Vendored from chrome-devtools-frontend@${version} (${file}).\n * BSD-3-Clause, The Chromium Authors. Do not edit; regenerate with scripts/sync-devtools-styles.mjs. */\n`;
  const name = file.split('/').pop();
  await writeFile(join(out, name), header + (await res.text()));
  console.log(`saved vendor/devtools/${name} (${version})`);
}
