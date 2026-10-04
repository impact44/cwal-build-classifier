// The replay engine: bwsim's wasm64 build (the same engine cwal.gg's replay
// viewer uses) driving the identifier (identifier/wasm, the same Rust crate
// cwal.gg runs). JavaScript only moves bytes between the two modules;
// extraction and matching both happen in Rust, so what this reports is what
// cwal.gg would label.
//
// Environment-free: callers hand in compiled modules and the decompressed
// sim pack, so the page's workers and the Node corpus indexer share it.

const HUD_MAX = 4000;
const HUD_PLAYERS_LEN = 480;
const HEADER_LEN = 600;

/** Split a decompressed pack: u32 manifest length, JSON manifest, then bytes. */
export const unpack = (buf) => {
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

/** Gunzip if the bytes are gzip (a host may or may not have already). */
export const gunzipMaybe = async (buf) => {
	if (buf.byteLength < 2 || new DataView(buf).getUint16(0, true) !== 0x8b1f) return buf;
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).arrayBuffer();
};

/**
 * @param {{ simModule: WebAssembly.Module, identModule: WebAssembly.Module, pack: ArrayBuffer }} o
 *   `pack` is the decompressed sim.pack.
 */
export const createEngine = async ({ simModule, identModule, pack }) => {
	const files = unpack(pack);
	const ident = (await WebAssembly.instantiate(identModule, {})).exports;
	let sim = null;
	let decodeRep = null;

	const simWrite = (bytes) => {
		const p = sim.bw_alloc(BigInt(bytes.length));
		new Uint8Array(sim.memory.buffer, Number(p), bytes.length).set(bytes);
		return p;
	};
	const identWrite = (bytes) => {
		const p = ident.alloc(bytes.length);
		new Uint8Array(ident.memory.buffer, p, bytes.length).set(bytes);
		return [p, bytes.length];
	};
	const identOut = () =>
		JSON.parse(new TextDecoder().decode(new Uint8Array(ident.memory.buffer, ident.out_ptr(), ident.out_len())));

	// .rep -> .drpl with a growing output buffer (see cwal.gg src/lib/drpl.ts).
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

	// (Re)create the sim instance and stage the pack into it. A replay that
	// fails to load can leave the instance dirty, so failures call this again.
	const bootSim = async () => {
		sim = (await WebAssembly.instantiate(simModule, {})).exports;
		for (const [name, bytes] of files) {
			const nb = new TextEncoder().encode(name);
			const np = simWrite(nb);
			const dp = simWrite(bytes);
			sim.bw_add_file(np, BigInt(nb.length), dp, BigInt(bytes.length));
			sim.bw_free(np, BigInt(nb.length));
			sim.bw_free(dp, BigInt(bytes.length));
		}
		decodeRep = makeDecoder();
	};
	await bootSim();
	let rebooting = null;
	let loaded = false;

	/**
	 * Simulate a replay's first `frames` frames (default: the identifier's
	 * window) and keep the extracted timeline. `frames: 0` reads only the
	 * header and starting units: players, races, map. Returns
	 * `{ handle, timeline }`; free the handle with `free`.
	 */
	const simulate = async (bytes, { frames, onProgress } = {}) => {
		if (rebooting) await rebooting;
		// bwsim keeps ~40MB per loaded game in its heap, and a wasm heap never
		// shrinks, so reusing an instance across a corpus scan grows into
		// gigabytes and slows down. A fresh instance costs a few ms against a
		// ~0.5s simulation.
		if (loaded) await bootSim();
		loaded = true;
		const HUD_REC = ident.hud_rec();
		const STRIDE = ident.sim_stride();
		const TARGET = frames ?? ident.sim_target_frames();
		const unitsPtr = sim.bw_alloc(BigInt(HUD_MAX * HUD_REC));
		const playersPtr = sim.bw_alloc(BigInt(HUD_PLAYERS_LEN));
		const hdrPtr = sim.bw_alloc(BigInt(HEADER_LEN));
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
			while (cur < TARGET) {
				sim.bw_step(STRIDE);
				const now = Number(sim.bw_current_frame());
				if (now <= cur) break; // game over
				cur = now;
				const un = units();
				const pn = players();
				ident.extractor_observe(x, cur, uScratch, un, pScratch, pn);
				if (onProgress && performance.now() - lastPost > 200) {
					onProgress(Math.min(1, cur / TARGET));
					lastPost = performance.now();
				}
			}

			const hn = Number(sim.bw_replay_header(hdrPtr, BigInt(HEADER_LEN)));
			const [hp, hl] = identWrite(new Uint8Array(sim.memory.buffer, Number(hdrPtr), hn).slice());
			const handle = ident.extractor_finish(x, hp, hl);
			ident.dealloc(hp, hl);
			return { handle, timeline: identOut() };
		} catch (err) {
			// Leave a clean instance for the next replay. The frees below still
			// run against the old one: bootSim only swaps it after an await.
			rebooting = bootSim().finally(() => (rebooting = null));
			throw err;
		} finally {
			if (sim) {
				sim.bw_free(unitsPtr, BigInt(HUD_MAX * HUD_REC));
				sim.bw_free(playersPtr, BigInt(HUD_PLAYERS_LEN));
				sim.bw_free(hdrPtr, BigInt(HEADER_LEN));
			}
			ident.dealloc(uScratch, HUD_MAX * HUD_REC);
			ident.dealloc(pScratch, HUD_PLAYERS_LEN);
		}
	};

	/**
	 * Check `defs` ([{file, text}]) and, with a handle, match every player in
	 * that replay against every definition that parsed.
	 * Returns `{ defs: [{file, id?, error?, problems}], players: [...] }`.
	 */
	const identify = (handle, defs) => {
		const [dp, dl] = identWrite(new TextEncoder().encode(JSON.stringify(defs)));
		try {
			ident.identify(handle ?? 0, dp, dl);
			return identOut();
		} finally {
			ident.dealloc(dp, dl);
		}
	};

	return {
		simulate,
		identify,
		free: (handle) => ident.build_free(handle),
		slugs: () => (ident.slugs(), identOut())
	};
};
