/**
 * Proves the Chrome and Edge builds are one artifact, not two.
 *
 * `docs/architecture.md`, `docs/edge.md` and `PRIVACY.md` all lean on the same
 * claim: `wxt build` and `wxt build -b edge` emit a byte-identical
 * `manifest.json` and byte-identical JS, which is why there is no Edge-specific
 * source, no second permission surface to audit, and why the privacy policy
 * covers the Edge listing unchanged. That claim was true when it was measured
 * by hand; this makes it true every time `npm run check` runs.
 *
 * It compares every emitted file, not just the manifest and the JS. README.md
 * and PRIVACY.md state the claim without qualification, so the check is the
 * unqualified one — and the wider scope costs nothing, because the two builds
 * agree on the HTML, the CSS and the icons as well.
 *
 * Run: node scripts/verify-parity.mjs [chromeOutDir] [edgeOutDir]
 * Exits 0 when the two builds match, 1 with the specific difference otherwise.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const CHROME_DIR = resolve(process.argv[2] ?? '.output/chrome-mv3');
const EDGE_DIR = resolve(process.argv[3] ?? '.output/edge-mv3');

const failures = [];
const fail = (reason) => failures.push(reason);
const pass = (name) => console.log(`  ok  ${name}`);

/** Every file under `dir`, as paths relative to it, in a stable order. */
function filesUnder(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return found;
}

for (const dir of [CHROME_DIR, EDGE_DIR]) {
  try {
    statSync(dir);
  } catch {
    console.error(`${dir} does not exist — run npm run build && npm run build:edge first`);
    process.exit(1);
  }
}

const chromeFiles = filesUnder(CHROME_DIR);
const edgeFiles = filesUnder(EDGE_DIR);

const onlyChrome = chromeFiles.filter((file) => !edgeFiles.includes(file));
const onlyEdge = edgeFiles.filter((file) => !chromeFiles.includes(file));

if (onlyChrome.length > 0) fail(`only in the Chrome build: ${onlyChrome.join(', ')}`);
if (onlyEdge.length > 0) fail(`only in the Edge build: ${onlyEdge.join(', ')}`);
if (onlyChrome.length === 0 && onlyEdge.length === 0) {
  pass(`both builds emit the same ${chromeFiles.length} file(s)`);
}

// Without these, two empty directories would compare equal and report success.
for (const [label, files] of [
  ['Chrome', chromeFiles],
  ['Edge', edgeFiles],
]) {
  if (!files.includes('manifest.json')) fail(`no manifest.json in the ${label} build — is it built?`);
  if (!files.some((file) => file.endsWith('.js'))) fail(`no JS in the ${label} build — is it built?`);
}

/** Byte-for-byte, not parsed: a whitespace-only difference is still a difference. */
function identical(file) {
  return readFileSync(join(CHROME_DIR, file)).equals(readFileSync(join(EDGE_DIR, file)));
}

for (const file of chromeFiles.filter((file) => edgeFiles.includes(file))) {
  if (identical(file)) pass(`${file} is byte-identical in both builds`);
  else
    fail(
      `${file} differs between the Chrome and Edge builds — docs/architecture.md, docs/edge.md ` +
        'and PRIVACY.md all state they are byte-identical, so either the difference is a bug or ' +
        'those documents need to stop claiming one artifact',
    );
}

console.log(
  `\n${failures.length === 0 ? 'CHROME AND EDGE BUILDS ARE IDENTICAL' : `FAILED:\n- ${failures.join('\n- ')}`}`,
);
process.exit(failures.length === 0 ? 0 : 1);
