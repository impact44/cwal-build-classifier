// Sandbox worker. Runs the engine (engine.js) off the main thread.
//
// Two roles, chosen by the messages it gets:
//   * the sandbox's own replays: 'sim' one dropped file, 'identify' them all
//     against the working definitions, 'drop' one;
//   * a corpus scan worker: 'scan' one corpus replay by URL against the
//     definition set by 'scan-defs'. Timelines are kept, so a rescan after an
//     edit re-matches without simulating again.
//
// Messages out: progress, simmed / error, identified, scanned, slugs, fatal.

import { createEngine, gunzipMaybe } from './engine.js';

const ENGINE = './engine/';

let enginePromise = null;
const engine = () =>
	(enginePromise ??= (async () => {
		const get = async (url) => {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
			return res;
		};
		const [pack, simModule, identModule] = await Promise.all([
			get(ENGINE + 'sim.pack.gz').then((r) => r.arrayBuffer()).then(gunzipMaybe),
			get(ENGINE + 'bwsim_wasm.wasm').then((r) => WebAssembly.compileStreaming(r)),
			get('./build_identifier.wasm').then((r) => WebAssembly.compileStreaming(r))
		]);
		return createEngine({ simModule, identModule, pack });
	})());

const builds = new Map(); // dropped replay id -> handle
const corpus = new Map(); // corpus url -> handle (or null when it failed)
let scanDefs = [];

const handle = async (msg, eng) => {
	if (msg.type === 'sim') {
		try {
			const { handle, timeline } = await eng.simulate(msg.bytes, {
				onProgress: (pct) => postMessage({ type: 'progress', id: msg.id, pct })
			});
			builds.set(msg.id, handle);
			postMessage({ type: 'simmed', id: msg.id, timeline });
		} catch (err) {
			postMessage({ type: 'error', id: msg.id, message: err.message ?? String(err) });
		}
	} else if (msg.type === 'identify') {
		const status = eng.identify(0, msg.defs);
		const results = {};
		for (const [id, h] of builds) results[id] = eng.identify(h, msg.defs).players;
		postMessage({ type: 'identified', defs: status.defs ?? [], error: status.error, results });
	} else if (msg.type === 'drop') {
		const h = builds.get(msg.id);
		if (h) eng.free(h);
		builds.delete(msg.id);
	} else if (msg.type === 'slugs') {
		postMessage({ type: 'slugs', slugs: eng.slugs() });
	} else if (msg.type === 'scan-defs') {
		scanDefs = msg.defs;
	} else if (msg.type === 'scan') {
		let h = corpus.get(msg.url);
		const simulated = h === undefined;
		try {
			if (simulated) {
				const res = await fetch(msg.url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				h = (await eng.simulate(await res.arrayBuffer())).handle;
				corpus.set(msg.url, h);
			}
			if (h === null) throw new Error('this replay failed to simulate');
			const players = eng.identify(h, scanDefs).players ?? [];
			postMessage({ type: 'scanned', idx: msg.idx, simulated, players });
		} catch (err) {
			corpus.set(msg.url, null);
			postMessage({ type: 'scanned', idx: msg.idx, simulated, error: err.message ?? String(err) });
		}
	}
};

// Handled strictly in order, so an identify never interleaves a sim.
let queue = Promise.resolve();
onmessage = (e) => {
	const msg = e.data;
	queue = queue.then(async () => {
		let eng;
		try {
			eng = await engine();
		} catch (err) {
			postMessage({ type: 'fatal', message: `could not load the engine: ${err.message ?? err}` });
			return;
		}
		await handle(msg, eng);
	});
};
