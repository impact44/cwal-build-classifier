// Build identifier sandbox UI. All the real work happens in worker.js (sim)
// and build_identifier.wasm (extraction + matching); this file edits
// definitions and renders the reports those produce.

import { mountBuilder } from './builder.js';
import { mountScan } from './scan.js';

// Only edits and new definitions are stored, so unedited ones always show
// the published version (v1 stored every definition and froze them).
const STORE = 'cwal-identifier-defs-v2';
const TAB_STORE = 'cwal-identifier-tab';
const REPO = 'https://github.com/dxrsz/cwal-guides';
const DEFS_PATH = 'identifier/defs';
const TEMPLATE = {
	id: 'my-build',
	name: 'My Build',
	aka: [],
	race: 'Z',
	vs: [],
	notes: 'What makes this build this build.',
	when: [{ order: ['spawning_pool', 'lair'] }, { have: { what: 'hatchery', op: 'eq', count: 2, by_start_of: 'lair' } }]
};

const $ = (s) => document.querySelector(s);
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
const RACE = { Z: 'Zerg', T: 'Terran', P: 'Protoss' };

// ---- state -----------------------------------------------------------------
let shipped = []; // [{file, text}] as published
let defs = []; // working set: [{file, text}]
let current = 0; // index into defs
let defStatus = {}; // file -> {id, error, problems}
const replays = new Map(); // id -> {name, pct, error, timeline, players}
let nextId = 1;

const save = () => {
	try {
		const edits = defs.filter(isModified);
		localStorage.setItem(STORE, JSON.stringify({ edits, current: defs[current]?.file }));
	} catch {
		/* private mode etc: edits just won't persist */
	}
};

const load = async () => {
	shipped = await (await fetch('./defs.json')).json();
	let saved = null;
	try {
		saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
	} catch {
		saved = null;
	}
	defs = shipped.map((s) => ({ ...s }));
	for (const e of saved?.edits ?? []) {
		const i = defs.findIndex((d) => d.file === e.file);
		if (i >= 0) defs[i].text = e.text;
		else defs.push({ file: e.file, text: e.text });
	}
	current = Math.max(0, defs.findIndex((d) => d.file === saved?.current));
	const want = new URLSearchParams(location.hash.slice(1)).get('def');
	const i = defs.findIndex((d) => d.file === want);
	if (i >= 0) current = i;
};

// ---- editor: form + JSON tabs ----------------------------------------------
const syncRevert = () => {
	const d = defs[current];
	$('#revert-def').disabled = !shipped.some((x) => x.file === d.file) || !isModified(d);
};

const setText = (t) => {
	defs[current].text = t;
	$('#editor').value = t;
	syncRevert();
	save();
	requestIdentify();
	scan?.render();
};

// Of the loaded players this definition's race applies to, how many satisfy
// condition i (as of the last match).
const conditionStats = (i) => {
	const focus = focusId();
	let pass = 0;
	let total = 0;
	for (const r of replays.values())
		for (const p of r.players ?? []) {
			const rep = p.reports.find((x) => x.id === focus);
			if (!rep?.race.passed || !rep.conditions[i]) continue;
			total++;
			if (rep.conditions[i].passed) pass++;
		}
	return { pass, total };
};

const builder = mountBuilder($('#builder'), {
	getText: () => defs[current].text,
	setText,
	stats: conditionStats,
	showJson: () => showTab('json')
});

let tab = 'form';
try {
	tab = localStorage.getItem(TAB_STORE) === 'json' ? 'json' : 'form';
} catch {
	/* default */
}
const showTab = (t) => {
	tab = t;
	try {
		localStorage.setItem(TAB_STORE, t);
	} catch {
		/* not persisted */
	}
	$('#tab-form').setAttribute('aria-selected', String(t === 'form'));
	$('#tab-json').setAttribute('aria-selected', String(t === 'json'));
	$('#builder').hidden = t !== 'form';
	$('#editor').hidden = t !== 'json';
	if (t === 'form') builder.render();
};
$('#tab-form').addEventListener('click', () => showTab('form'));
$('#tab-json').addEventListener('click', () => showTab('json'));

// ---- worker ----------------------------------------------------------------
const worker = new Worker('./worker.js', { type: 'module' });
let identifyTimer = 0;
const requestIdentify = () => {
	clearTimeout(identifyTimer);
	identifyTimer = setTimeout(() => worker.postMessage({ type: 'identify', defs }), 120);
};

worker.onmessage = (e) => {
	const m = e.data;
	if (m.type === 'fatal') {
		const s = $('#engine-status');
		s.textContent = m.message;
		s.className = 'engine-status err';
		return;
	}
	if (m.type === 'progress') {
		const r = replays.get(m.id);
		if (r) {
			r.pct = m.pct;
			const bar = document.querySelector(`[data-replay="${m.id}"] .bar > i`);
			if (bar) bar.style.width = `${Math.round(m.pct * 100)}%`;
		}
		return;
	}
	if (m.type === 'simmed') {
		const r = replays.get(m.id);
		if (r) Object.assign(r, { pct: 1, timeline: m.timeline });
		requestIdentify();
		return;
	}
	if (m.type === 'error') {
		const r = replays.get(m.id);
		if (r) r.error = m.message;
		renderReplays();
		return;
	}
	if (m.type === 'slugs') {
		builder.setSlugs(m.slugs);
		return;
	}
	if (m.type === 'identified') {
		$('#engine-status').textContent = '';
		defStatus = Object.fromEntries((m.defs ?? []).map((d) => [d.file, d]));
		for (const [id, players] of Object.entries(m.results)) {
			const r = replays.get(Number(id));
			if (r) r.players = players;
		}
		renderDefList();
		renderDefStatus();
		renderReplays();
		builder.refreshStats();
	}
};

// ---- definitions panel ------------------------------------------------------
const isModified = (d) => {
	const s = shipped.find((x) => x.file === d.file);
	return s ? s.text !== d.text : true;
};

// ---- propose changes ----------------------------------------------------------
// A static page can't open a pull request itself without a GitHub login, so
// each definition goes through GitHub's own editor, which handles the fork,
// the commit and the pull request. New files can be prefilled by URL; GitHub
// has no way to prefill an edit to an existing file, so the JSON is copied for
// pasting instead.
const pending = () => defs.filter(isModified);

const renderPropose = () => {
	const n = pending().length;
	const b = $('#propose');
	b.disabled = n === 0;
	b.textContent = n ? `Propose changes (${n})` : 'Propose changes';
	b.title = n ? '' : 'Edit or add a definition first';
};

const proposeRow = (d) => {
	const st = defStatus[d.file];
	const isNew = !shipped.some((x) => x.file === d.file);
	const blocked = st?.error ? `Fix first: ${st.error}` : st?.problems?.length ? `Fix first: ${st.problems[0]}` : null;
	const label = d.file.replace(/\.json$/, '');
	let action;
	if (blocked) {
		action = el('span', { class: 'msg err' }, blocked);
	} else if (isNew) {
		const url = `${REPO}/new/main/${DEFS_PATH}?filename=${encodeURIComponent(d.file)}&value=${encodeURIComponent(d.text)}`;
		action = el('a', { class: 'btn primary-link', href: url, target: '_blank', rel: 'noopener' }, 'Open pull request ↗');
	} else {
		action = el(
			'button',
			{
				type: 'button',
				onclick: async (e) => {
					await navigator.clipboard.writeText(d.text);
					window.open(`${REPO}/edit/main/${DEFS_PATH}/${encodeURIComponent(d.file)}`, '_blank', 'noopener');
					e.target.textContent = 'Copied: paste over the file in GitHub ↗';
				}
			},
			'Copy JSON & open editor ↗'
		);
	}
	return el(
		'li',
		{},
		el('div', {}, el('strong', {}, label), el('span', { class: 'tag' }, isNew ? ' new' : ' edited')),
		action,
		!blocked && !isNew && el('div', { class: 'help' }, 'Select all in the GitHub editor and paste; your JSON is on the clipboard.')
	);
};

$('#propose').addEventListener('click', () => {
	$('#propose-list').replaceChildren(...pending().map(proposeRow));
	$('#propose-dialog').showModal();
});

const renderDefList = () => {
	renderPropose();
	const ul = $('#def-list');
	ul.replaceChildren(
		...defs.map((d, i) => {
			const st = defStatus[d.file];
			const dot = st?.error ? 'dot err' : st?.problems?.length ? 'dot warn' : 'dot';
			const shippedOne = shipped.some((x) => x.file === d.file);
			const tag = !shippedOne ? 'new' : isModified(d) ? 'edited' : '';
			return el(
				'li',
				{},
				el(
					'button',
					{ type: 'button', 'aria-current': i === current ? 'true' : 'false', onclick: () => select(i) },
					el('span', { class: dot }),
					el('span', { class: 'file' }, d.file.replace(/\.json$/, '')),
					tag && el('span', { class: 'tag' }, tag)
				)
			);
		})
	);
};

const renderDefStatus = () => {
	const d = defs[current];
	const st = d && defStatus[d.file];
	const box = $('#def-status');
	if (!st) return box.replaceChildren();
	if (st.error) return box.replaceChildren(el('div', { class: 'msg err' }, `Invalid definition: ${st.error}`));
	if (st.problems.length)
		return box.replaceChildren(...st.problems.map((p) => el('div', { class: 'msg warn' }, p)));
	box.replaceChildren(el('div', { class: 'msg ok' }, `Valid. Label: ${st.id}`));
};

const select = (i) => {
	current = i;
	const d = defs[i];
	$('#editor').value = d.text;
	$('#editor-title').textContent = d.file;
	const shippedOne = shipped.some((x) => x.file === d.file);
	syncRevert();
	if (tab === 'form') builder.render();
	$('#delete-def').disabled = shippedOne;
	history.replaceState(null, '', `#def=${encodeURIComponent(d.file)}`);
	save();
	renderDefList();
	renderDefStatus();
	renderReplays();
	scan?.render();
};

const uniqueFile = (base) => {
	let f = `${base}.json`;
	for (let n = 2; defs.some((d) => d.file === f); n++) f = `${base}-${n}.json`;
	return f;
};

$('#editor').addEventListener('input', (e) => {
	defs[current].text = e.target.value;
	syncRevert();
	save();
	requestIdentify();
	scan.render();
});
$('#editor').addEventListener('keydown', (e) => {
	if (e.key !== 'Tab' || e.shiftKey) return;
	e.preventDefault();
	document.execCommand('insertText', false, '  ');
});
$('#new-def').addEventListener('click', () => {
	defs.push({ file: uniqueFile('my-build'), text: JSON.stringify(TEMPLATE, null, 2) + '\n' });
	select(defs.length - 1);
	requestIdentify();
});
$('#delete-def').addEventListener('click', () => {
	if (!confirm(`Delete ${defs[current].file} from this browser?`)) return;
	defs.splice(current, 1);
	select(Math.max(0, current - 1));
	requestIdentify();
});
$('#revert-def').addEventListener('click', () => {
	const s = shipped.find((x) => x.file === defs[current].file);
	if (s) defs[current].text = s.text;
	select(current);
	requestIdentify();
});
$('#reset-defs').addEventListener('click', () => {
	if (!confirm('Discard every local edit and new definition?')) return;
	defs = shipped.map((s) => ({ ...s }));
	select(0);
	requestIdentify();
});
$('#copy-def').addEventListener('click', async (e) => {
	await navigator.clipboard.writeText(defs[current].text);
	e.target.textContent = 'Copied';
	setTimeout(() => (e.target.textContent = 'Copy JSON'), 1200);
});
$('#only-race').addEventListener('change', () => renderReplays());

// ---- replays -----------------------------------------------------------------
const addReplay = (name, bytes, url) => {
	const id = nextId++;
	replays.set(id, { name, pct: 0, url });
	worker.postMessage({ type: 'sim', id, bytes }, [bytes]);
	return id;
};
const addFiles = async (files) => {
	for (const f of files) {
		if (!/\.rep$/i.test(f.name)) continue;
		addReplay(f.name, await f.arrayBuffer());
	}
	if (!$('#engine-status').textContent) $('#engine-status').textContent = 'Loading the simulation engine (about 9MB, once)…';
	renderReplays();
};

const scan = mountScan($('#scan'), {
	focus: () => defs[current] ?? null,
	inspect: async (url, name) => {
		const res = await fetch(url);
		if (!res.ok) {
			// The page's corpus list is older than the site (the corpus changed).
			const id = nextId++;
			replays.set(id, { name, error: `This replay is no longer in the corpus (HTTP ${res.status}). Reload the page to get the current corpus.` });
			return renderReplays();
		}
		const id = addReplay(name, await res.arrayBuffer(), url);
		renderReplays();
		document.querySelector(`[data-replay="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
});
const drop = $('#drop');
$('#file').addEventListener('change', (e) => addFiles(e.target.files));
drop.addEventListener('dragover', (e) => {
	e.preventDefault();
	drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
	e.preventDefault();
	drop.classList.remove('over');
	addFiles(e.dataTransfer.files);
});

const focusId = () => defStatus[defs[current]?.file]?.id;

const ok = (pass) => el('span', { class: `icon ${pass ? 'ok' : 'bad'}` }, pass ? '✓' : '✗');

const evLabel = (e) =>
	e.constructed ? `${e.slug} ${mmss(e.seconds)}${e.supply != null ? ` @${e.supply}` : ''}` : `${e.slug} (start)`;

const renderOrder = (o) => {
	const hits = new Set(o.steps.flatMap((s) => s.matched));
	return el(
		'div',
		{},
		el(
			'div',
			{ class: 'check' },
			ok(o.passed),
			el('span', {}, `order (${o.strict ? 'strict: the first buildings, back to back' : 'loose: in this order, others may come between'})`)
		),
		el(
			'ul',
			{ class: 'steps' },
			o.steps.map((s) =>
				el(
					'li',
					{},
					s.status === 'not_reached'
						? el('span', { class: 'icon skip' }, '–')
						: ok(s.status === 'matched'),
					el('code', {}, s.step),
					s.status === 'matched' &&
						el('span', { class: 'detail' }, s.matched.map((i) => evLabel(o.sequence[i])).join(', ')),
					s.status === 'failed' && el('span', { class: 'detail' }, s.detail),
					s.status === 'not_reached' && el('span', { class: 'detail' }, 'not checked')
				)
			)
		),
		el(
			'div',
			{ class: 'seq', title: 'The sequence the order was matched against' },
			o.sequence.length
				? o.sequence.map((e, i) => el('span', { class: hits.has(i) ? 'hit' : '' }, e.constructed ? `${e.slug} ${mmss(e.seconds)}` : `${e.slug} (start)`))
				: el('span', {}, '(nothing built)')
		)
	);
};

const OPS = { gte: '≥', lte: '≤', eq: '=' };
const renderHave = (h) =>
	el(
		'div',
		{},
		el(
			'div',
			{ class: 'check' },
			ok(h.passed),
			el(
				'span',
				{},
				'have ',
				el('code', {}, h.what),
				h.filters.length ? ` (${h.filters.join(', ')})` : '',
				`: found ${h.actual}`,
				h.candidates.some((c) => c.counted && !c.constructed) ? ' (including the starting one)' : '',
				`, needs ${OPS[h.op]} ${h.expected}`
			)
		),
		h.detail && el('div', { class: 'detail' }, h.detail),
		h.candidates.length
			? el(
					'div',
					{ class: 'cands' },
					h.candidates.map((c) =>
						el(
							'span',
							{ class: `cand ${c.counted ? 'in' : 'out'}`, title: c.excluded_by ?? 'counted' },
							evLabel(c),
							c.excluded_by ? ` · ${c.excluded_by}` : ''
						)
					)
				)
			: el('div', { class: 'detail' }, `no ${h.what} in this game's first 8 minutes`)
	);

const renderReport = (r) =>
	el(
		'div',
		{},
		el(
			'div',
			{ class: `verdict ${r.matched ? 'ok' : 'bad'}` },
			r.matched ? `✓ Labelled ${r.id}` : `✗ Not ${r.id}`
		),
		el('div', { class: 'check' }, ok(r.race.passed), el('span', {}, `race: ${r.race.detail}`)),
		el('div', { class: 'check' }, ok(r.vs.passed), el('span', {}, `matchup: ${r.vs.detail}`)),
		r.conditions.map((c, i) =>
			el(
				'div',
				{ class: `cond ${c.passed ? 'ok' : 'bad'}` },
				el('div', { class: 'cond-title' }, `Condition ${i + 1}`),
				c.order && renderOrder(c.order),
				c.have && renderHave(c.have)
			)
		)
	);

const renderTimeline = (events) =>
	el(
		'details',
		{ class: 'timeline' },
		el('summary', {}, 'What the matcher sees (first 8 minutes)'),
		el(
			'div',
			{ class: 'tl' },
			events.map((e) =>
				el(
					'div',
					{},
					el('span', { class: 't' }, mmss(e.seconds)),
					el('span', { class: e.category === 'unit' ? 'u' : '' }, e.constructed ? e.slug : `${e.slug} (start)`),
					e.supply != null ? el('span', { class: 's' }, ` @${e.supply}`) : ''
				)
			)
		)
	);

const renderReplays = () => {
	const focus = focusId();
	const onlyRace = $('#only-race').checked;
	const box = $('#replays');
	box.replaceChildren(
		...[...replays].reverse().map(([id, r]) => {
			const head = el(
				'div',
				{ class: 'replay-head' },
				el(
					'span',
					{ class: 'replay-name' },
					r.name,
					r.url && el('a', { class: 'dl', href: r.url, download: r.name, title: 'Download the replay to watch it in StarCraft' }, 'Download')
				),
				el(
					'span',
					{ class: 'replay-meta' },
					r.error ? '' : r.timeline ? `${r.timeline.map} · ${mmss((r.timeline.frame_count * 42) / 1000)}` : 'simulating…'
				)
			);
			if (r.error) return el('div', { class: 'replay', 'data-replay': id }, head, el('div', { class: 'msg err' }, r.error));
			if (!r.players)
				return el(
					'div',
					{ class: 'replay', 'data-replay': id },
					head,
					el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(r.pct * 100)}%` }))
				);
			const players = r.players.map((p) => {
				const labels = p.reports.filter((x) => x.matched).map((x) => x.id);
				const focusReport = p.reports.find((x) => x.id === focus);
				const events = r.timeline.players.find((t) => t.player_id === p.player_id)?.events ?? [];
				if (onlyRace && focusReport && !focusReport.race.passed) return null;
				return el(
					'div',
					{ class: 'player' },
					el(
						'div',
						{ class: 'player-head' },
						el('span', { class: 'player-name' }, p.name || `player ${p.player_id}`),
						el('span', { class: 'race', title: RACE[p.race] }, `${p.race}v${p.opponent ?? '?'}`),
						el(
							'span',
							{ class: 'labels' },
							labels.length
								? labels.map((l) => el('span', { class: `chip ${l === focus ? 'focus' : ''}` }, l))
								: el('span', { class: 'none' }, 'no labels')
						)
					),
					focusReport && renderReport(focusReport),
					renderTimeline(events)
				);
			});
			const shown = players.filter(Boolean);
			return el(
				'div',
				{ class: 'replay', 'data-replay': id },
				head,
				shown.length ? shown : el('div', { class: 'none' }, 'No players of this race in this game.')
			);
		})
	);
};

await load();
showTab(tab);
select(current);
requestIdentify();
worker.postMessage({ type: 'slugs' });
