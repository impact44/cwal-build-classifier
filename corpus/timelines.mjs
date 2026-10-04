// Precompute every corpus replay's timeline (the first 8 minutes, extracted
// exactly as the sandbox does) so a corpus search only has to match, not
// simulate. Writes site/corpus/timelines.json: one ReplayBuild (or
// null if it failed) per index.json entry, in order.
//
// Results are cached under target/ by a hash of the engine, the identifier
// wasm and the index, so rebuilding the site without changing those is free.
// Simulating 1,000 replays takes a few minutes, spread over worker threads.
//
// Called by build-site.mjs; needs the engine and identifier wasm in place.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createEngine, gunzipMaybe } from '../site/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const site = join(root, 'site');
const buf = (p) => {
	const b = readFileSync(p);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

if (!isMainThread) {
	const engine = await createEngine({
		simModule: await WebAssembly.compile(readFileSync(join(site, 'engine', 'bwsim_wasm.wasm'))),
		identModule: await WebAssembly.compile(readFileSync(join(site, 'build_identifier.wasm'))),
		pack: await gunzipMaybe(buf(join(site, 'engine', 'sim.pack.gz')))
	});
	for (const { idx, file } of workerData.jobs) {
		let timeline = null;
		try {
			const r = await engine.simulate(buf(join(here, 'replays', file)));
			engine.free(r.handle);
			timeline = r.timeline;
		} catch (err) {
			console.error(`${file}: ${err.message}`);
		}
		parentPort.postMessage({ idx, timeline });
	}
	process.exit(0);
}

export const buildTimelines = async () => {
	const indexText = readFileSync(join(here, 'index.json'));
	const index = JSON.parse(indexText);
	const key = createHash('sha256')
		.update(readFileSync(join(site, 'engine', 'bwsim_wasm.wasm')))
		.update(readFileSync(join(site, 'build_identifier.wasm')))
		.update(indexText)
		.digest('hex')
		.slice(0, 16);
	const cacheDir = join(root, 'target', 'corpus-timelines');
	const cached = join(cacheDir, `${key}.json`);
	const out = join(site, 'corpus', 'timelines.json');
	mkdirSync(dirname(out), { recursive: true });
	if (existsSync(cached)) {
		writeFileSync(out, readFileSync(cached));
		console.log(`corpus timelines: cached (${key})`);
		return;
	}

	const n = Math.max(1, Math.min(8, availableParallelism() - 1));
	console.log(`simulating ${index.length} corpus replays on ${n} threads…`);
	const results = new Array(index.length).fill(null);
	let done = 0;
	const started = Date.now();
	await Promise.all(
		Array.from({ length: n }, (_, w) => {
			const jobs = index.map((e, idx) => ({ idx, file: e.file })).filter((j) => j.idx % n === w);
			return new Promise((resolve, reject) => {
				const t = new Worker(fileURLToPath(import.meta.url), { workerData: { jobs } });
				t.on('message', ({ idx, timeline }) => {
					results[idx] = timeline;
					if (++done % 100 === 0) console.log(`  ${done}/${index.length} (${Math.round((Date.now() - started) / 1000)}s)`);
				});
				t.on('error', reject);
				t.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
			});
		})
	);
	const json = JSON.stringify(results);
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(cached, json);
	writeFileSync(out, json);
	const failed = results.filter((r) => !r).length;
	console.log(`corpus timelines: ${index.length - failed} simulated${failed ? `, ${failed} failed` : ''} in ${Math.round((Date.now() - started) / 1000)}s`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildTimelines();
