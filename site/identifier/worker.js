// Sandbox worker: runs the replay simulation (bwsim's wasm64 build, the same
// engine cwal.gg's replay viewer uses) and feeds unit-table snapshots to the
// identifier (identifier/wasm, built from the same Rust crate cwal.gg runs).
//
// JavaScript only moves bytes between the two modules. Extraction and
// matching both happen in Rust, so what this page reports is what cwal.gg
// would label.
//
// Messages in:  {type:'sim', id, name, bytes}   simulate one replay
//               {type:'identify', defs}         re-match every replay
//               {type:'drop', id}               forget a replay
// Messages out: {type:'progress', id, pct}
//               {type:'simmed', id, timeline}   or {type:'error', id, message}
//               {type:'identified', defs, results: {id: playerResults}}

const ENGINE = './engine/';
const HUD_MAX = 4000;
const HUD_PLAYERS_LEN = 480;
const HEADER_LEN = 600;

let sim = null; // bwsim exports (wasm64: sizes and pointers are BigInt)
let ident = null; // identifier exports (wasm32: plain numbers)
let decodeRep = null;
let bootPromise = null;
const builds = new Map(); // replay id -> ReplayBuild handle in `ident`

// ---- packs (same format and gzip sniffing as cwal.gg's src/lib/pack.ts) ----
const fetchPack = async (url) => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
	const buf = await res.arrayBuffer();
	if (buf.byteLength < 2 || new DataView(buf).getUint16(0, true) !== 0x8b1f) return buf;
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).arrayBuffer();
};

const loadPack = async (url) => {
	const buf = await fetchPack(url);
	const mlen = new DataView(buf).getUint32(0, true);
	const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, mlen)));
	const files = [];
	let off = 4 + mlen;
	for (const e of manifest) {
		files.push([e.name, new Uint8Array(buf, off, e.len)]);
		off += e.len;
	}
	return files;
};

// ---- memory helpers --------------------------------------------------------
const simWrite = (bytes) => {
	const p = sim.bw_alloc(BigInt(bytes.length));
	new Uint8Array(sim.memory.buffer, Number(p), bytes.length).set(bytes);
	return p;
};

// Copy bytes into the identifier's memory; returns [ptr, len] to free later.
const identWrite = (bytes) => {
	const p = ident.alloc(bytes.length);
	new Uint8Array(ident.memory.buffer, p, bytes.length).set(bytes);
	return [p, bytes.length];
};

const identOut = () =>
	JSON.parse(new TextDecoder().decode(new Uint8Array(ident.memory.buffer, ident.out_ptr(), ident.out_len())));

// .rep -> .drpl with a growing output buffer (see cwal.gg src/lib/drpl.ts for why).
const makeDecoder = () => {
	let size = 8 * 1024 * 1024;
	let out = sim.bw_alloc(BigInt(size));
	return (bytes) => {
		const rep = simWrite(bytes);
		try {
			for (;;) {
				const n = Number(sim.bw_rep_to_drpl(rep, BigInt(bytes.length), out, BigInt(size)));
				if (n) return new Uint8Array(sim.memory.buffer, Number(out), n).slice();
				if (size >= 64 * 1024 * 1024) throw new Error('not a valid StarCraft: Remastered replay');
				sim.bw_free(out, BigInt(size));
				size *= 2;
				out = sim.bw_alloc(BigInt(size));
			}
		} finally {
			sim.bw_free(rep, BigInt(bytes.length));
		}
	};
};

const boot = () =>
	(bootPromise ??= (async () => {
		const [files, simMod, identMod] = await Promise.all([
			loadPack(ENGINE + 'sim.pack.gz'),
			WebAssembly.compileStreaming(fetch(ENGINE + 'bwsim_wasm.wasm')),
			WebAssembly.compileStreaming(fetch('./build_identifier.wasm'))
		]);
		sim = (await WebAssembly.instantiate(simMod, {})).exports;
		// The identifier survives a sim rebuild: it holds every simulated replay.
		ident ??= (await WebAssembly.instantiate(identMod, {})).exports;
		for (const [name, bytes] of files) {
			const nb = new TextEncoder().encode(name);
			const np = simWrite(nb);
			const dp = simWrite(bytes);
			sim.bw_add_file(np, BigInt(nb.length), dp, BigInt(bytes.length));
			sim.bw_free(np, BigInt(nb.length));
			sim.bw_free(dp, BigInt(bytes.length));
		}
		decodeRep = makeDecoder();
	})());

// ---- simulation ------------------------------------------------------------
const simulate = (id, bytes) => {
	const HUD_REC = ident.hud_rec();
	const STRIDE = ident.sim_stride();
	const TARGET = ident.sim_target_frames();
	const unitsPtr = sim.bw_alloc(BigInt(HUD_MAX * HUD_REC));
	const playersPtr = sim.bw_alloc(BigInt(HUD_PLAYERS_LEN));
	const hdrPtr = sim.bw_alloc(BigInt(HEADER_LEN));
	// Scratch in the identifier for one snapshot, reused every step.
	const uScratch = ident.alloc(HUD_MAX * HUD_REC);
	const pScratch = ident.alloc(HUD_PLAYERS_LEN);
	try {
		const drpl = decodeRep(new Uint8Array(bytes));
		const dp = simWrite(drpl);
		const ok = Number(sim.bw_load(dp, BigInt(drpl.length)));
		sim.bw_free(dp, BigInt(drpl.length));
		if (ok !== 1) throw new Error('the simulation could not load this replay');

		const units = () => {
			const n = Number(sim.bw_hud_units(unitsPtr, BigInt(HUD_MAX * HUD_REC))) * HUD_REC;
			new Uint8Array(ident.memory.buffer, uScratch, n).set(new Uint8Array(sim.memory.buffer, Number(unitsPtr), n));
			return n;
		};
		const players = () => {
			if (Number(sim.bw_hud_players(playersPtr, BigInt(HUD_PLAYERS_LEN))) !== 12) return 0;
			new Uint8Array(ident.memory.buffer, pScratch, HUD_PLAYERS_LEN).set(
				new Uint8Array(sim.memory.buffer, Number(playersPtr), HUD_PLAYERS_LEN)
			);
			return HUD_PLAYERS_LEN;
		};

		const x = ident.extractor_new(uScratch, units());
		let cur = Number(sim.bw_current_frame());
		let lastPost = 0;
		for (;;) {
			sim.bw_step(STRIDE);
			const now = Number(sim.bw_current_frame());
			if (now <= cur) break; // game over
			cur = now;
			const un = units();
			const pn = players();
			ident.extractor_observe(x, cur, uScratch, un, pScratch, pn);
			if (cur >= TARGET) break;
			if (performance.now() - lastPost > 200) {
				postMessage({ type: 'progress', id, pct: cur / TARGET });
				lastPost = performance.now();
			}
		}

		const hn = Number(sim.bw_replay_header(hdrPtr, BigInt(HEADER_LEN)));
		const [hp, hl] = identWrite(new Uint8Array(sim.memory.buffer, Number(hdrPtr), hn).slice());
		const build = ident.extractor_finish(x, hp, hl);
		ident.dealloc(hp, hl);
		builds.set(id, build);
		return identOut();
	} finally {
		sim.bw_free(unitsPtr, BigInt(HUD_MAX * HUD_REC));
		sim.bw_free(playersPtr, BigInt(HUD_PLAYERS_LEN));
		sim.bw_free(hdrPtr, BigInt(HEADER_LEN));
		ident.dealloc(uScratch, HUD_MAX * HUD_REC);
		ident.dealloc(pScratch, HUD_PLAYERS_LEN);
	}
};

const identify = (defs) => {
	const [dp, dl] = identWrite(new TextEncoder().encode(JSON.stringify(defs)));
	try {
		ident.identify(0, dp, dl);
		const status = identOut();
		const results = {};
		for (const [id, h] of builds) {
			ident.identify(h, dp, dl);
			results[id] = identOut().players;
		}
		return { defs: status.defs ?? [], error: status.error, results };
	} finally {
		ident.dealloc(dp, dl);
	}
};

// Messages are handled strictly in order, so an identify never interleaves a sim.
let queue = Promise.resolve();
onmessage = (e) => {
	const msg = e.data;
	queue = queue.then(async () => {
		try {
			await boot();
		} catch (err) {
			postMessage({ type: 'fatal', message: `could not load the engine: ${err.message ?? err}` });
			return;
		}
		if (msg.type === 'sim') {
			try {
				const timeline = simulate(msg.id, msg.bytes);
				postMessage({ type: 'simmed', id: msg.id, timeline });
			} catch (err) {
				// A failed load can leave the sim instance dirty; rebuild it next time.
				sim = null;
				bootPromise = null;
				builds.delete(msg.id);
				postMessage({ type: 'error', id: msg.id, message: err.message ?? String(err) });
			}
		} else if (msg.type === 'identify') {
			postMessage({ type: 'identified', ...identify(msg.defs) });
		} else if (msg.type === 'drop') {
			const h = builds.get(msg.id);
			if (h) ident.build_free(h);
			builds.delete(msg.id);
		} else if (msg.type === 'slugs') {
			ident.slugs();
			postMessage({ type: 'slugs', slugs: identOut() });
		}
	});
};
