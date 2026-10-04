// Build the sandbox into site/identifier/:
//   build_identifier.wasm  the identifier crate compiled for the browser
//   defs.json              every identifier/defs/*.json, as [{file, text}]
//   engine/                bwsim's wasm + sim data pack, fetched from cwal.gg
//
// The engine is fetched rather than vendored: it is the exact build cwal.gg's
// replay viewer serves, so the sandbox simulates replays the way the site does.
// Set ENGINE_BASE to fetch it elsewhere, or SKIP_ENGINE=1 to keep what's there.
//
//   node identifier/build-site.mjs        then serve site/ (e.g. npx serve site)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site', 'identifier');
const ENGINE_BASE = process.env.ENGINE_BASE ?? 'https://cwal.gg/viewer/';

console.log('building identifier wasm…');
execFileSync(
	'cargo',
	['build', '-p', 'build-identifier-wasm', '--release', '--target', 'wasm32-unknown-unknown'],
	{ cwd: root, stdio: 'inherit' }
);
copyFileSync(
	join(root, 'target', 'wasm32-unknown-unknown', 'release', 'build_identifier_wasm.wasm'),
	join(out, 'build_identifier.wasm')
);

const defsDir = join(root, 'identifier', 'defs');
const defs = readdirSync(defsDir)
	.filter((f) => f.endsWith('.json'))
	.sort()
	.map((file) => ({ file, text: readFileSync(join(defsDir, file), 'utf8') }));
writeFileSync(join(out, 'defs.json'), JSON.stringify(defs));
console.log(`wrote ${defs.length} definitions`);

const engine = join(out, 'engine');
mkdirSync(engine, { recursive: true });
for (const f of ['bwsim_wasm.wasm', 'sim.pack.gz']) {
	if (process.env.SKIP_ENGINE && existsSync(join(engine, f))) continue;
	console.log(`fetching ${ENGINE_BASE}${f}…`);
	const res = await fetch(ENGINE_BASE + f);
	if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
	writeFileSync(join(engine, f), Buffer.from(await res.arrayBuffer()));
}
console.log('done: serve site/ and open /identifier/');
