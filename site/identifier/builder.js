// Form editor for a build definition. It edits the parsed JSON object in place
// and writes it back as text, so the JSON tab and the file in the repo stay the
// source of truth: anything the form can't represent sends you to the JSON tab
// rather than being silently dropped.

const DEF_KEYS = new Set(['id', 'name', 'aka', 'race', 'vs', 'notes', 'when']);
const COND_KEYS = new Set(['order', 'strict', 'include_start', 'ignore_supply_providers', 'have']);
const HAVE_KEYS = new Set([
	'what', 'op', 'count', 'after', 'before', 'by_start_of', 'supply_min', 'supply_max', 'constructed_only'
]);
const RACES = { Z: 'Zerg', T: 'Terran', P: 'Protoss' };
const OP_WORD = { gte: 'at least', lte: 'at most', eq: 'exactly' };

const el = (tag, attrs = {}, ...kids) => {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') n.className = v;
		else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
		else if (k === 'value') n.value = v ?? '';
		else if (k === 'checked') n.checked = !!v;
		else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
	}
	for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k);
	return n;
};

// ---- serialization ---------------------------------------------------------
const step = (s) => {
	if (typeof s === 'string') return s;
	if (s.one_of) return { one_of: [...s.one_of] };
	return { unordered: [...(s.unordered ?? [])] };
};

const normCond = (c) => {
	const out = {};
	if (c.order) {
		out.order = c.order.map(step);
		if (c.strict) out.strict = true;
		if (c.include_start) out.include_start = true;
		if (c.ignore_supply_providers) out.ignore_supply_providers = true;
	}
	if (c.have) {
		const h = c.have;
		const o = { what: h.what ?? '', op: h.op ?? 'gte', count: h.count ?? 1 };
		for (const k of ['by_start_of', 'after', 'before']) if (h[k]) o[k] = h[k];
		for (const k of ['supply_min', 'supply_max']) if (Number.isFinite(h[k])) o[k] = h[k];
		if (h.constructed_only) o.constructed_only = true;
		out.have = o;
	}
	return out;
};

const serialize = (d) =>
	JSON.stringify(
		{
			id: d.id ?? '',
			name: d.name ?? '',
			aka: d.aka ?? [],
			race: d.race ?? 'Z',
			vs: d.vs ?? [],
			notes: d.notes ?? '',
			when: (d.when ?? []).map(normCond)
		},
		null,
		2
	) + '\n';

// Can the form represent this object without losing anything?
const unsupported = (d) => {
	if (!d || typeof d !== 'object' || Array.isArray(d)) return 'The definition must be a JSON object.';
	const bad = Object.keys(d).filter((k) => !DEF_KEYS.has(k));
	if (bad.length) return `Unknown field ${bad.map((k) => `"${k}"`).join(', ')}.`;
	if (!Array.isArray(d.when ?? [])) return '"when" must be a list.';
	for (const [i, c] of (d.when ?? []).entries()) {
		const bk = Object.keys(c ?? {}).filter((k) => !COND_KEYS.has(k));
		if (bk.length) return `when[${i}] has unknown field ${bk.map((k) => `"${k}"`).join(', ')}.`;
		const hk = Object.keys(c.have ?? {}).filter((k) => !HAVE_KEYS.has(k));
		if (hk.length) return `when[${i}].have has unknown field ${hk.map((k) => `"${k}"`).join(', ')}.`;
		for (const s of c.order ?? [])
			if (typeof s !== 'string' && !(s && (Array.isArray(s.one_of) || Array.isArray(s.unordered))))
				return `when[${i}].order has a step the form can't show.`;
			else if (s && typeof s === 'object' && s.one_of?.length && s.unordered?.length)
				return `when[${i}].order has a step with both one_of and unordered.`;
	}
	return null;
};

// ---- plain-English summaries -------------------------------------------------
const pretty = (slug) => (slug ? slug.replaceAll('_', ' ') : '?');
const plural = (slug, n) => {
	const p = pretty(slug);
	if (n === 1 || !slug) return p;
	if (/[^aeiou]y$/.test(p)) return p.slice(0, -1) + 'ies';
	return /(s|x|ch|sh)$/.test(p) ? p + 'es' : p + 's';
};
// The halls every player starts with one of. Counts include that free one
// unless constructed_only; orders skip it unless include_start.
export const TOWN_HALLS = new Set(['hatchery', 'command_center', 'nexus']);
const stepText = (s) =>
	typeof s === 'string'
		? pretty(s)
		: s.one_of
			? `any one of ${s.one_of.map(pretty).join(' / ') || '?'}`
			: `${(s.unordered ?? []).map(pretty).join(' + ') || '?'} (any order)`;

export const describe = (c) => {
	const parts = [];
	if (c.order) {
		const seq = c.order.map(stepText).join(', then ') || '(no steps yet)';
		let t = c.strict
			? `The very first buildings are ${seq}, back to back`
			: `${seq[0]?.toUpperCase() ?? ''}${seq.slice(1)} happen in this order (other things may come between)`;
		const names = c.order.flatMap((s) => (typeof s === 'string' ? [s] : (s.one_of ?? s.unordered ?? [])));
		const hall = names.find((n) => TOWN_HALLS.has(n));
		if (hall && !c.include_start) t += `. Each ${pretty(hall)} here is one they built; the one they start with isn't part of the order`;
		const extras = [];
		if (c.include_start) extras.push('counting the starting town hall');
		if (c.ignore_supply_providers) extras.push('ignoring supply depots, pylons and overlords');
		if (extras.length) t += `, ${extras.join(' and ')}`;
		parts.push(t + '.');
	}
	if (c.have) {
		const h = c.have;
		let t = `${OP_WORD[h.op ?? 'gte']} ${h.count ?? 1} ${plural(h.what, h.count ?? 1)}`;
		if (TOWN_HALLS.has(h.what))
			t += h.constructed_only ? ' they built (the one they start with is not counted)' : ' including the one they start with';
		else if (h.constructed_only) t += ' they built';
		if (Number.isFinite(h.supply_min) && Number.isFinite(h.supply_max))
			t += h.supply_min === h.supply_max ? ` started at ${h.supply_min} supply` : ` started at ${h.supply_min}-${h.supply_max} supply`;
		else if (Number.isFinite(h.supply_min)) t += ` started at ${h.supply_min}+ supply`;
		else if (Number.isFinite(h.supply_max)) t += ` started at or below ${h.supply_max} supply`;
		if (h.after) t += `, from ${h.after}`;
		if (h.before) t += `, up to ${h.before}`;
		if (h.by_start_of) t += `, by the time the first ${pretty(h.by_start_of)} starts`;
		parts.push(`Has ${t}.`);
	}
	return parts.join(' ') || 'Empty condition: add an order or a count.';
};

// ---- the form ------------------------------------------------------------------
/**
 * @param {HTMLElement} root
 * @param {{ getText(): string, setText(t: string): void, stats(i: number): {pass:number,total:number}|null, showJson(): void }} io
 */
export const mountBuilder = (root, io) => {
	let def = null;
	let slugs = [];
	const datalist = el('datalist', { id: 'slug-list' });
	document.body.append(datalist);

	const commit = () => io.setText(serialize(def));
	const isSlug = (s) => !slugs.length || slugs.includes(s);

	const slugInput = (value, onchange, placeholder = 'e.g. spawning_pool') => {
		const i = el('input', {
			class: 'slug',
			list: 'slug-list',
			value,
			placeholder,
			spellcheck: 'false',
			autocapitalize: 'off',
			oninput: (e) => {
				const v = e.target.value.trim();
				e.target.classList.toggle('invalid', !!v && !isSlug(v));
				onchange(v);
			}
		});
		if (value && !isSlug(value)) i.classList.add('invalid');
		return i;
	};

	const field = (label, input, help) =>
		el('label', { class: 'field' }, el('span', { class: 'flabel' }, label), input, help && el('span', { class: 'help' }, help));

	const segmented = (options, isOn, toggle) =>
		el(
			'div',
			{ class: 'seg' },
			Object.entries(options).map(([k, label]) =>
				el(
					'button',
					{
						type: 'button',
						'aria-pressed': isOn(k) ? 'true' : 'false',
						title: label,
						onclick: (e) => {
							toggle(k);
							commit();
							for (const b of e.target.parentElement.children)
								b.setAttribute('aria-pressed', isOn(b.dataset.k) ? 'true' : 'false');
						},
						'data-k': k
					},
					k
				)
			)
		);

	const check = (label, value, onchange, help) =>
		el(
			'label',
			{ class: 'check-field', title: help },
			el('input', { type: 'checkbox', checked: value, onchange: (e) => onchange(e.target.checked) }),
			el('span', {}, label),
			help && el('span', { class: 'help' }, help)
		);

	const tools = (list, i, rerender) =>
		el(
			'span',
			{ class: 'tools' },
			el('button', { type: 'button', class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; commit(); rerender(); } }, '↑'),
			el('button', { type: 'button', class: 'icon-btn', title: 'Move down', disabled: i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; commit(); rerender(); } }, '↓'),
			el('button', { type: 'button', class: 'icon-btn danger', title: 'Remove', onclick: () => { list.splice(i, 1); commit(); rerender(); } }, '×')
		);

	// One order step: a single slug, or a group with chips.
	const stepRow = (c, i, refresh) => {
		const s = c.order[i];
		const kind = typeof s === 'string' ? 'one' : s.one_of ? 'one_of' : 'unordered';
		const setKind = (k) => {
			const names = typeof s === 'string' ? (s ? [s] : []) : (s.one_of ?? s.unordered ?? []);
			c.order[i] = k === 'one' ? (names[0] ?? '') : { [k]: names };
			commit();
			render();
		};
		let body;
		if (kind === 'one') {
			body = slugInput(s, (v) => { c.order[i] = v; commit(); refresh(); });
		} else {
			const names = s[kind];
			const chips = el('span', { class: 'chips' });
			const drawChips = () =>
				chips.replaceChildren(
					...names.map((n, j) =>
						el('span', { class: `chip-edit ${isSlug(n) ? '' : 'invalid'}` }, pretty(n),
							el('button', { type: 'button', title: `Remove ${n}`, onclick: () => { names.splice(j, 1); drawChips(); commit(); refresh(); } }, '×'))
					)
				);
			drawChips();
			const add = el('input', {
				class: 'slug',
				list: 'slug-list',
				placeholder: 'add…',
				spellcheck: 'false',
				onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.dispatchEvent(new Event('change')); } },
				onchange: (e) => {
					const v = e.target.value.trim();
					if (!v) return;
					names.push(v);
					e.target.value = '';
					drawChips();
					commit();
					refresh();
				}
			});
			body = el('span', { class: 'group' }, chips, add);
		}
		return el(
			'li',
			{ class: 'step' },
			el('span', { class: 'step-n' }, `${i + 1}`),
			el(
				'select',
				{ onchange: (e) => setKind(e.target.value), title: 'What this step matches' },
				el('option', { value: 'one', selected: kind === 'one' }, 'Exactly'),
				el('option', { value: 'one_of', selected: kind === 'one_of' }, 'Any one of'),
				el('option', { value: 'unordered', selected: kind === 'unordered' }, 'All of, any order')
			),
			body,
			tools(c.order, i, render)
		);
	};

	const orderSection = (c, refresh) =>
		el(
			'div',
			{ class: 'sub' },
			el('div', { class: 'sub-head' }, el('strong', {}, 'Order'), el('span', { class: 'help' }, 'Things that must happen in this sequence'),
				el('button', { type: 'button', class: 'icon-btn danger', title: 'Remove the order check', onclick: () => { delete c.order; delete c.strict; delete c.include_start; delete c.ignore_supply_providers; commit(); render(); } }, '×')),
			el('ol', { class: 'steps-edit' }, c.order.map((_, i) => stepRow(c, i, refresh))),
			el('button', { type: 'button', class: 'add', onclick: () => { c.order.push(''); commit(); render(); } }, '+ Step'),
			el(
				'div',
				{ class: 'checks' },
				check('Strict', c.strict, (v) => { c.strict = v; commit(); refresh(); }, 'the first buildings, back to back, nothing between'),
				check('Include the starting town hall', c.include_start, (v) => { c.include_start = v; commit(); refresh(); }, 'Off: "hatchery" means one they built. On: the Hatchery / CC / Nexus they start with is step one.'),
				check('Ignore supply buildings', c.ignore_supply_providers, (v) => { c.ignore_supply_providers = v; commit(); refresh(); }, 'drop depots, pylons and overlords first')
			)
		);

	const num = (v) => (v === '' ? undefined : Number(v));
	const haveSection = (c, refresh) => {
		const h = c.have;
		const set = (k, v) => { if (v === undefined || v === '' || Number.isNaN(v)) delete h[k]; else h[k] = v; commit(); refresh(); };
		// Only a town hall has a free starting one, so the option only shows there.
		const builtCheck = check(
			'Don\'t count the starting town hall',
			h.constructed_only,
			(v) => set('constructed_only', v || undefined),
			'Without this, "2 hatcheries" means the main plus one built. With it, only built ones count.'
		);
		const syncBuilt = () => (builtCheck.hidden = !TOWN_HALLS.has(h.what) && !h.constructed_only);
		syncBuilt();
		return el(
			'div',
			{ class: 'sub' },
			el('div', { class: 'sub-head' }, el('strong', {}, 'Count'), el('span', { class: 'help' }, 'How many of something, within bounds'),
				el('button', { type: 'button', class: 'icon-btn danger', title: 'Remove the count check', onclick: () => { delete c.have; commit(); render(); } }, '×')),
			el(
				'div',
				{ class: 'have-main' },
				el('select', { onchange: (e) => set('op', e.target.value) },
					...Object.entries(OP_WORD).map(([k, w]) => el('option', { value: k, selected: (h.op ?? 'gte') === k }, w))),
				el('input', { type: 'number', min: 0, class: 'count', value: h.count ?? 1, oninput: (e) => set('count', num(e.target.value) ?? 0) }),
				slugInput(h.what ?? '', (v) => { set('what', v); syncBuilt(); }, 'what to count')
			),
			el(
				'div',
				{ class: 'grid' },
				field('By the start of', slugInput(h.by_start_of ?? '', (v) => set('by_start_of', v || undefined), 'e.g. lair'), 'only count what started before the first one of these'),
				field('From', el('input', { value: h.after ?? '', placeholder: 'm:ss', class: 'time', oninput: (e) => set('after', e.target.value.trim() || undefined) })),
				field('Up to', el('input', { value: h.before ?? '', placeholder: 'm:ss', class: 'time', oninput: (e) => set('before', e.target.value.trim() || undefined) })),
				field('Supply from', el('input', { type: 'number', min: 0, value: h.supply_min ?? '', oninput: (e) => set('supply_min', num(e.target.value)) })),
				field('Supply to', el('input', { type: 'number', min: 0, value: h.supply_max ?? '', oninput: (e) => set('supply_max', num(e.target.value)) }))
			),
			builtCheck
		);
	};

	const statBadge = (i) => {
		const s = io.stats(i);
		if (!s || !s.total) return el('span', { class: 'stat' });
		const cls = s.pass === s.total ? 'all' : s.pass === 0 ? 'none' : 'some';
		return el('span', { class: `stat ${cls}`, title: 'Players of this race in the loaded replays for whom this condition holds' }, `${s.pass}/${s.total} players`);
	};

	const condCard = (c, i) => {
		const summary = el('p', { class: 'summary' }, describe(c));
		const refresh = () => (summary.textContent = describe(c));
		return el(
			'div',
			{ class: 'cond-edit', 'data-cond': i },
			el('div', { class: 'cond-head' }, el('span', { class: 'cond-title' }, `Condition ${i + 1}`), statBadge(i), tools(def.when, i, render)),
			summary,
			c.order && orderSection(c, refresh),
			c.have && haveSection(c, refresh),
			(!c.order || !c.have) &&
				el(
					'div',
					{ class: 'row' },
					!c.order && el('button', { type: 'button', class: 'add', onclick: () => { c.order = ['']; commit(); render(); } }, '+ Order'),
					!c.have && el('button', { type: 'button', class: 'add', onclick: () => { c.have = { what: '', op: 'gte', count: 1 }; commit(); render(); } }, '+ Count')
				)
		);
	};

	const render = () => {
		let parsed;
		try {
			parsed = JSON.parse(io.getText());
		} catch (e) {
			def = null;
			return root.replaceChildren(
				el('div', { class: 'msg err' }, `The JSON doesn't parse (${e.message}), so the form can't show it.`),
				el('button', { type: 'button', onclick: io.showJson }, 'Fix it in JSON')
			);
		}
		const why = unsupported(parsed);
		if (why) {
			def = null;
			return root.replaceChildren(
				el('div', { class: 'msg err' }, `${why} The form only edits fields it knows, so fix this in JSON first.`),
				el('button', { type: 'button', onclick: io.showJson }, 'Open JSON')
			);
		}
		def = parsed;
		def.when ??= [];
		def.aka ??= [];
		def.vs ??= [];
		root.replaceChildren(
			...[
			el(
				'div',
				{ class: 'grid identity' },
				field('Label (id)', el('input', { value: def.id, spellcheck: 'false', oninput: (e) => { def.id = e.target.value; commit(); } }), 'lowercase-with-dashes; this is the tag players get'),
				field('Name', el('input', { value: def.name, oninput: (e) => { def.name = e.target.value; commit(); } })),
				field('Also known as', el('input', { value: def.aka.join(', '), placeholder: 'comma, separated', oninput: (e) => { def.aka = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); commit(); } })),
				field('Player race', segmented(RACES, (k) => def.race === k, (k) => (def.race = k))),
				field('Against', segmented(RACES, (k) => def.vs.includes(k), (k) => (def.vs = def.vs.includes(k) ? def.vs.filter((r) => r !== k) : [...def.vs, k].sort())), 'none selected = any matchup'),
				field('Notes', el('textarea', { rows: 2, value: def.notes ?? '', oninput: (e) => { def.notes = e.target.value; commit(); } }))
			),
			el('h3', { class: 'conds-title' }, 'All of these must hold'),
			def.when.map(condCard),
			el(
				'div',
				{ class: 'row' },
				el('button', { type: 'button', class: 'add', onclick: () => { def.when.push({ order: [''] }); commit(); render(); } }, '+ Order condition'),
				el('button', { type: 'button', class: 'add', onclick: () => { def.when.push({ have: { what: '', op: 'gte', count: 1 } }); commit(); render(); } }, '+ Count condition')
			)
			].flat()
		);
	};

	return {
		render,
		setSlugs(list) {
			slugs = list;
			datalist.replaceChildren(...list.map((s) => el('option', { value: s })));
			if (def) render();
		},
		refreshStats() {
			for (const card of root.querySelectorAll('[data-cond]')) {
				const old = card.querySelector('.stat');
				old?.replaceWith(statBadge(Number(card.dataset.cond)));
			}
		}
	};
};
