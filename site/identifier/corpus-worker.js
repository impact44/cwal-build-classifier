// Corpus search over precomputed timelines (corpus/timelines.json, built by
// identifier/corpus/timelines.mjs). Only the identifier wasm is needed: no
// simulation happens here, so a search is just matching.
//
// In:  {type:'scan', seq, defs, start, end}   match one chunk of the corpus
// Out: {type:'ready', count} once, then {type:'chunk', seq, end, hits} or
//      {type:'error', seq?, message}

let ident = null;
let ready = null;

const boot = () =>
	(ready ??= (async () => {
		const [mod, timelines] = await Promise.all([
			WebAssembly.compileStreaming(fetch('./build_identifier.wasm')),
			fetch('./corpus/timelines.json').then((r) => {
				if (!r.ok) throw new Error(`timelines: HTTP ${r.status}`);
				return r.arrayBuffer();
			})
		]);
		ident = (await WebAssembly.instantiate(mod, {})).exports;
		const bytes = new Uint8Array(timelines);
		const p = ident.alloc(bytes.length);
		new Uint8Array(ident.memory.buffer, p, bytes.length).set(bytes);
		const n = ident.corpus_load(p, bytes.length);
		ident.dealloc(p, bytes.length);
		if (n < 0) throw new Error(out().error);
		postMessage({ type: 'ready', count: n });
	})());

const out = () =>
	JSON.parse(new TextDecoder().decode(new Uint8Array(ident.memory.buffer, ident.out_ptr(), ident.out_len())));

onmessage = async (e) => {
	const m = e.data;
	try {
		await boot();
	} catch (err) {
		postMessage({ type: 'error', message: err.message ?? String(err) });
		return;
	}
	if (m.type !== 'scan') return;
	const bytes = new TextEncoder().encode(JSON.stringify(m.defs));
	const p = ident.alloc(bytes.length);
	new Uint8Array(ident.memory.buffer, p, bytes.length).set(bytes);
	ident.corpus_scan(p, bytes.length, m.start, m.end);
	ident.dealloc(p, bytes.length);
	const r = out();
	if (r.error) postMessage({ type: 'error', seq: m.seq, message: r.error });
	else postMessage({ type: 'chunk', seq: m.seq, end: m.end, hits: r.hits });
};
