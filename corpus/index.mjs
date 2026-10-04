// Index the replay corpus: corpus/replays/*.rep -> index.json, one
// entry per replay with its map, length and players (name + race, read from
// the starting units so Random shows its real race).
//
// The sandbox uses the index to skip replays a definition can't apply to (no
// player of its race, or the wrong matchup) without simulating them.
//
// Uses the same engine as the sandbox, so run the site build first:
//   node build-site.mjs && node corpus/index.mjs [dir] [out]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, gunzipMaybe } from '../site/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', 'site');
const dir = process.argv[2] ?? join(here, 'replays');
const out = process.argv[3] ?? join(here, 'index.json');

const buf = (p) => {
	const b = readFileSync(p);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const engine = await createEngine({
	simModule: await WebAssembly.compile(readFileSync(join(site, 'engine', 'bwsim_wasm.wasm'))),
	identModule: await WebAssembly.compile(readFileSync(join(site, 'build_identifier.wasm'))),
	pack: await gunzipMaybe(buf(join(site, 'engine', 'sim.pack.gz')))
});

const files = readdirSync(dir).filter((f) => f.endsWith('.rep')).sort();
const index = [];
let failed = 0;
for (const [i, file] of files.entries()) {
	try {
		const { handle, timeline } = await engine.simulate(buf(join(dir, file)), { frames: 0 });
		engine.free(handle);
		index.push({
			file,
			map: timeline.map,
			frames: timeline.frame_count,
			players: timeline.players.map((p) => ({ name: p.name, race: p.race }))
		});
	} catch (err) {
		failed++;
		console.error(`${file}: ${err.message}`);
	}
	if (process.env.VERBOSE) console.error(file);
	if ((i + 1) % 200 === 0) console.error(`${i + 1}/${files.length}`);
}
writeFileSync(out, JSON.stringify(index) + '\n');
console.error(`indexed ${index.length} replays${failed ? `, ${failed} failed` : ''}`);
