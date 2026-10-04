// Corpus search: run the focused definition over every replay in the corpus
// (identifier/corpus) and list the players it labels.
//
// Normally the site build has already simulated the corpus
// (corpus/timelines.json), so a search only matches: corpus-worker.js runs the
// identifier over the stored timelines in chunks, for progress and Cancel.
//
// Without that file (a local build that skipped it) it falls back to
// simulating: each replay's first 8 minutes, spread over a pool of workers
// that keep the timelines (replay i always goes to worker i % N), so searching
// again only re-matches. Replays the definition can't apply to are skipped
// from the index without simulating. Cancel stops handing out work; the few
// replays in flight finish and still count.

const RACE = { Z: 'Zerg', T: 'Terran', P: 'Protoss' };
const SHOW = 50;

const el = (tag, attrs = {}, ...kids) => {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') n.className = v;
		else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
	}
	for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k);
	return n;
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDur = (frames) => mmss((frames * 42) / 1000);

/**
 * @param {HTMLElement} root
 * @param {{ focus(): {file: string, text: string} | null, inspect(url: string, name: string): void }} io
 */
export const mountScan = (root, io) => {
	let index = null; // [{file, map, frames, players: [{name, race}]}]
	let fast = false; // precomputed timelines available
	let workers = [];
	let corpusWorker = null;
	let corpusReady = false;
	let seq = 0;
	let run = null; // the current or last search
	const CHUNK = 50;

	const poolSize = () => Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
	const url = (file) => `./corpus/replays/${file}`;

	const parseFocus = () => {
		const f = io.focus();
		if (!f) return { error: 'Pick a definition first.' };
		try {
			const d = JSON.parse(f.text);
			if (!'ZTP'.includes(d.race) || !d.race) return { error: 'The definition needs a race (Z, T or P).' };
			return { ...f, id: d.id, race: d.race, vs: Array.isArray(d.vs) ? d.vs : [] };
		} catch {
			return { error: 'Fix the definition\'s JSON to search with it.' };
		}
	};

	// Can this definition apply to anyone in this game? Mirrors the matcher's
	// race and matchup gates, so a skipped replay could never have matched.
	const eligible = (e, def) =>
		e.players.some(
			(p) =>
				p.race === def.race &&
				(!def.vs.length || (e.players.length === 2 && e.players.some((o) => o !== p && def.vs.includes(o.race))))
		);

	const ensureWorkers = () => {
		const n = poolSize();
		while (workers.length < n) {
			const w = new Worker('./worker.js', { type: 'module' });
			const i = workers.length;
			w.onmessage = (e) => onMessage(i, e.data);
			workers.push(w);
		}
	};

	const dispatch = (wi) => {
		if (!run || run.cancelled) return;
		const next = run.queues[wi].shift();
		if (next === undefined) return;
		run.inFlight++;
		workers[wi].postMessage({ type: 'scan', idx: next, url: url(index[next].file) });
	};

	const onMessage = (wi, m) => {
		if (m.type === 'fatal') {
			if (run) run.error = m.message;
			render();
			return;
		}
		if (m.type !== 'scanned' || !run) return;
		run.inFlight--;
		run.done++;
		if (m.simulated) run.simulated++;
		if (m.error) run.failed++;
		else {
			const hits = (m.players ?? []).filter((p) => p.reports?.[0]?.matched);
			if (hits.length) run.matches.push({ idx: m.idx, players: hits, all: m.players });
		}
		dispatch(wi);
		if (run.inFlight === 0 && (run.cancelled || run.queues.every((q) => !q.length))) run.finished = performance.now();
		scheduleRender();
	};

	const ensureCorpusWorker = () => {
		if (corpusWorker) return;
		corpusWorker = new Worker('./corpus-worker.js');
		corpusWorker.onmessage = (e) => {
			const m = e.data;
			if (m.type === 'ready') {
				corpusReady = true;
				return scheduleRender();
			}
			if (!run || m.seq !== run.seq) return;
			if (m.type === 'error') {
				run.error = m.message;
				run.finished = performance.now();
			} else if (m.type === 'chunk') {
				run.done = m.end;
				run.matches.push(...m.hits);
				if (m.end >= run.total || run.cancelled) run.finished = performance.now();
				else nextChunk();
			}
			scheduleRender();
		};
	};

	const nextChunk = () =>
		corpusWorker.postMessage({
			type: 'scan',
			seq: run.seq,
			defs: [{ file: run.def.file, text: run.def.text }],
			start: run.done,
			end: Math.min(run.done + CHUNK, run.total)
		});

	const startFast = (def) => {
		ensureCorpusWorker();
		run = {
			fast: true,
			seq: ++seq,
			def,
			text: def.text,
			total: index.length,
			skipped: 0,
			done: 0,
			simulated: 0,
			failed: 0,
			inFlight: 0,
			matches: [],
			started: performance.now(),
			finished: null,
			cancelled: false,
			shown: SHOW,
			queues: []
		};
		nextChunk();
		render();
	};

	const start = () => {
		const def = parseFocus();
		if (def.error) return render();
		if (fast) return startFast(def);
		ensureWorkers();
		const ids = [];
		let skipped = 0;
		for (const [i, e] of index.entries()) {
			if (eligible(e, def)) ids.push(i);
			else skipped++;
		}
		run = {
			def,
			text: def.text,
			total: ids.length,
			skipped,
			done: 0,
			simulated: 0,
			failed: 0,
			inFlight: 0,
			matches: [],
			started: performance.now(),
			finished: null,
			cancelled: false,
			shown: SHOW,
			queues: workers.map(() => [])
		};
		for (const i of ids) run.queues[i % workers.length].push(i);
		for (const w of workers) w.postMessage({ type: 'scan-defs', defs: [{ file: def.file, text: def.text }] });
		if (!ids.length) run.finished = performance.now();
		workers.forEach((_, wi) => dispatch(wi));
		render();
	};

	const cancel = () => {
		if (!run) return;
		run.cancelled = true;
		for (const q of run.queues) q.length = 0;
		if (run.fast || run.inFlight === 0) run.finished = performance.now();
		render();
	};

	let pending = false;
	const scheduleRender = () => {
		if (pending) return;
		pending = true;
		// A timer, not requestAnimationFrame: rAF stops in a hidden tab, and a
		// long search is exactly when people switch away.
		setTimeout(() => {
			pending = false;
			render();
		}, 150);
	};

	const matchRow = (m) => {
		const e = index[m.idx];
		return el(
			'li',
			{ class: 'hit-row' },
			el(
				'span',
				{ class: 'hit-main' },
				m.players.map((p) =>
					el('span', { class: 'hit-player' }, p.name || `player ${p.player_id}`, ' ', el('span', { class: 'race' }, `${p.race}v${p.opponent ?? '?'}`))
				),
				el('span', { class: 'hit-meta' }, `${e.map} · ${fmtDur(e.frames)}`)
			),
			el(
				'span',
				{ class: 'row' },
				el('a', { class: 'btn', href: url(e.file), download: e.file, title: 'Download the replay to watch it in StarCraft' }, 'Download'),
				el('button', { type: 'button', onclick: () => io.inspect(url(e.file), e.file) }, 'Inspect')
			)
		);
	};

	const render = () => {
		if (!index) return;
		const def = parseFocus();
		const running = run && !run.finished;
		const other = run && !running && run.def.file !== io.focus()?.file;
		const stale = run && !running && !other && run.text !== io.focus()?.text;
		const kids = [];

		const head = el(
			'div',
			{ class: 'scan-head' },
			el(
				'div',
				{},
				el('strong', {}, `Search ${index.length.toLocaleString()} replays`),
				el(
					'div',
					{ class: 'help' },
					def.error
						? def.error
						: fast
							? `Finds every player ${def.id ? `"${def.id}"` : 'this definition'} labels in ${index.length.toLocaleString()} high-MMR ladder games (1v1, 5+ minutes). The games are simulated ahead of time, so this only matches.`
							: `Finds every player ${def.id ? `"${def.id}"` : 'this definition'} labels. Each game's first 8 minutes are simulated once; searching again after an edit is instant for games already simulated.`
				)
			),
			running
				? el('button', { type: 'button', class: 'danger-solid', onclick: cancel }, 'Cancel')
				: el('button', { type: 'button', class: 'primary', disabled: !!def.error, onclick: start }, run ? 'Search again' : 'Search')
		);
		kids.push(head);

		if (run) {
			const elapsed = ((run.finished ?? performance.now()) - run.started) / 1000;
			const pct = run.total ? run.done / run.total : 1;
			const rate = run.done / Math.max(elapsed, 0.001);
			const left = rate > 0 ? (run.total - run.done) / rate : 0;
			kids.push(
				el('div', { class: 'bar big' }, el('i', { style: `width:${(pct * 100).toFixed(1)}%` })),
				el(
					'div',
					{ class: 'scan-stats' },
					run.fast && !corpusReady && !run.error
						? el('span', {}, 'Loading the corpus timelines (about 1MB)…')
						: el('span', {}, el('b', {}, run.done.toLocaleString()), ` of ${run.total.toLocaleString()} replays checked`),
					el('span', { class: 'scan-matches' }, el('b', {}, run.matches.length.toLocaleString()), ` matching ${run.matches.length === 1 ? 'game' : 'games'}`),
					running && !run.fast && run.done > 3 && el('span', {}, `about ${mmss(left)} left`),
					!running &&
						el(
							'span',
							{},
							`${run.cancelled ? 'cancelled' : 'done'} in ${elapsed < 60 ? `${elapsed.toFixed(elapsed < 10 ? 1 : 0)}s` : mmss(elapsed)}`
						),
					run.skipped > 0 &&
						el(
							'span',
							{ class: 'help' },
							`${run.skipped.toLocaleString()} skipped: no ${RACE[run.def.race]} player${run.def.vs.length ? ` vs ${run.def.vs.map((r) => RACE[r]).join('/')}` : ''}`
						),
					run.failed > 0 && el('span', { class: 'help' }, `${run.failed} failed to simulate`)
				),
				run.error && el('div', { class: 'msg err' }, run.error),
				stale && el('div', { class: 'msg warn' }, 'The definition changed since this search. Search again to update the results.'),
				other && el('div', { class: 'msg warn' }, `These results are for ${run.def.file.replace(/\.json$/, '')}. Search again for this definition.`)
			);
			if (run.matches.length) {
				const sorted = [...run.matches].sort((a, b) => a.idx - b.idx);
				kids.push(
					el('ul', { class: 'hits' }, sorted.slice(0, run.shown).map(matchRow)),
					sorted.length > run.shown &&
						el('button', { type: 'button', class: 'add', onclick: () => { run.shown += SHOW; render(); } }, `Show ${Math.min(SHOW, sorted.length - run.shown)} more`)
				);
			} else if (!running && run.total) {
				kids.push(el('div', { class: 'none' }, 'No games match. Drop in a replay you expect to match to see which condition fails.'));
			}
		}
		root.replaceChildren(...kids.filter(Boolean));
	};

	(async () => {
		try {
			const res = await fetch('./corpus/index.json');
			if (!res.ok) throw new Error(String(res.status));
			index = await res.json();
			fast = (await fetch('./corpus/timelines.json', { method: 'HEAD' })).ok;
			render();
		} catch {
			root.replaceChildren(el('div', { class: 'help' }, 'The replay corpus is not available in this build.'));
		}
	})();

	return { render };
};
