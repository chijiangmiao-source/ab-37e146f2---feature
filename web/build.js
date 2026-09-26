#!/usr/bin/env node
'use strict';

/**
 * Page build: validate web sources and assemble the dist directory.
 *
 * Usage: node web/build.js [--src DIR] [--out DIR] [--check]
 *   --src    source directory (default: <repo>/web/src)
 *   --out    output directory (default: <repo>/web/dist)
 *   --check  after building, re-verify the emitted artifacts
 *
 * The build fails (exit 1) if any source is missing, the JavaScript does not
 * parse, or the HTML references assets that do not exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { check: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--src') args.src = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

const REQUIRED = ['index.html', 'app.js', 'styles.css'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fail(msg) {
  console.error(`[build] FAIL: ${msg}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);
  const webRoot = path.resolve(__dirname);
  const srcDir = path.resolve(args.src || path.join(webRoot, 'src'));
  const outDir = path.resolve(args.out || path.join(webRoot, 'dist'));

  // 1. required sources exist
  for (const name of REQUIRED) {
    if (!fs.existsSync(path.join(srcDir, name))) fail(`missing source file ${name}`);
  }

  // 2. JavaScript parses
  const appJs = path.join(srcDir, 'app.js');
  try {
    execFileSync(process.execPath, ['--check', appJs], { stdio: 'pipe' });
  } catch (err) {
    fail(`app.js does not parse: ${err.stderr ? err.stderr.toString() : err.message}`);
  }

  // 3. HTML references resolve to real files
  const html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
  const refs = [];
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) refs.push(m[1]);
  if (refs.length === 0) fail('index.html references no script/stylesheet assets');
  for (const ref of refs) {
    if (/^https?:/.test(ref)) continue;
    if (!fs.existsSync(path.join(srcDir, ref))) fail(`index.html references missing asset "${ref}"`);
  }
  // page must mount the expected form controls
  for (const id of ['grammar-form', 'terminals', 'nonterminals', 'start', 'productions', 'cancel-btn']) {
    if (!html.includes(`id="${id}"`)) fail(`index.html is missing required element #${id}`);
  }

  // 4. emit dist
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { builtAt: new Date().toISOString(), files: [] };
  for (const name of REQUIRED) {
    const data = fs.readFileSync(path.join(srcDir, name));
    fs.writeFileSync(path.join(outDir, name), data);
    manifest.files.push({ name, bytes: data.length, sha256: sha256(data) });
  }
  fs.writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify(manifest, null, 2));

  // 5. optional verification pass over emitted artifacts
  if (args.check) {
    for (const entry of manifest.files) {
      const emitted = fs.readFileSync(path.join(outDir, entry.name));
      if (sha256(emitted) !== entry.sha256) fail(`checksum mismatch for ${entry.name}`);
    }
    const info = JSON.parse(fs.readFileSync(path.join(outDir, 'build-info.json'), 'utf8'));
    if (info.files.length !== REQUIRED.length) fail('build-info.json is incomplete');
  }

  console.log(`[build] OK: ${REQUIRED.length} files -> ${outDir}`);
}

main();
