# Build definitions

Each `*.json` file in this folder is one **build label** — a pattern that gets
matched against a player's build order (extracted from a replay) and, when it
matches, tags that player with the label. Labels are how the site will let
people search replays by build.

A label is *not* "the build." One player in one replay can match several labels
at once, so we split builds into independent **dimensions** that mix and match:

- an **opening** (how the game starts): `9pool`, `overpool`, `12pool`,
  `11hatch`, `12hatch`, `bbs`, `8rax`, …
- a **structure / tech path** (where it goes): `2hatch-spire`,
  `2.5hatch-spire`, `3hatch-spire`, `3hatch-hydra`, …

So a Zerg might come out as `3hatch-spire` **and** `12hatch`. Write each
dimension as its own file; the matcher applies all of them and a player can win
any number of labels.

> **Try it live:** the [sandbox](https://dxrsz.github.io/cwal-guides/identifier/)
> lets you edit a definition and test it against your own replays in the browser.
>
> **In a hurry?** [`EXAMPLE.jsonc`](./EXAMPLE.jsonc) is a single annotated build
> that uses every feature described below, with `//` comments explaining each
> one. It's a `.jsonc` so the matcher ignores it — real `.json` files can't have
> comments.

## The shape of a file

```json
{
  "id": "2hatch-spire",
  "name": "2 Hatch Spire",
  "aka": ["2 hatch muta", "2h spire"],
  "race": "Z",
  "vs": [],
  "notes": "Two-base tech to Spire: exactly two hatcheries when the Spire starts.",
  "when": [
    { "have": { "what": "hatchery", "op": "eq", "count": 2, "by_start_of": "spire" } }
  ]
}
```

| field   | meaning |
|---------|---------|
| `id`    | Unique slug, kebab-case. This is the label that gets applied. |
| `name`  | Human display name. |
| `aka`   | Aliases, for search. Optional. |
| `race`  | The player race this describes: `"Z"`, `"T"`, or `"P"`. A def only ever applies to players of this race. |
| `vs`    | Opponent races it applies to, e.g. `["P"]` or `["T","P"]`. Empty `[]` = any matchup. Only considered for clean 1v1s. |
| `notes` | Free text describing the build. |
| `when`  | A list of **conditions**. **All** of them must hold (logical AND) for the label to apply. |

## Conditions

Each entry in `when` is a condition object. A condition can carry an `order`
check and/or a `have` check; whichever parts are present must all pass. Put
independent checks in separate `when` entries — it reads cleaner and they AND
together the same way.

### `order` — the sequence buildings are made in

```json
{ "order": ["lair", "spire"] }
```

The listed things must appear in this **relative order** in the player's
timeline. Two modes:

- **loose (default)** — a *subsequence*: the listed buildings appear in order,
  but anything not listed may appear between them and is ignored. Use this for
  "these happened in this order, whatever else was going on."
- **strict** — add `"strict": true` to the condition. Now the listed steps must
  be the **exact first N buildings, back to back, no skipping**. This is a
  prefix match. Use it when the opener *is* a specific first-few-buildings
  sequence.

```json
{ "order": ["barracks", "barracks", "supply_depot"], "strict": true }
```

That is BBS: the first three buildings are literally rax, rax, depot. In strict
mode *every* building counts, so a refinery or depot slipped in before the first
rax would fail the match.

**Supply structures.** Supply Depots, Pylons, and Overlords are built
constantly and usually aren't part of a build's identity. A *loose* order
already ignores anything you don't list, so they don't get in the way there. A
*strict* order counts every building, so add `"ignore_supply_providers": true` to a strict
condition to drop them — e.g. `order: ["gateway", "gateway"], "strict": true,
"ignore_supply_providers": true` matches two gateways in a row even with a pylon built
between them. Leave it off when a supply structure *is* the point (BBS ends on a
depot, so BBS lists the depot and does not ignore it).

A step can be more than a single name:

- `"spawning_pool"` — one specific building.
- `{ "unordered": ["hatchery", "extractor"] }` — all of these, in **any order
  among themselves**, before the next step.
- `{ "one_of": ["spire", "hydralisk_den"] }` — **any one** of these satisfies
  the step.

Order only ever looks at **constructed** buildings. The town hall each player
starts the game with (Hatchery / CC / Nexus) is *not* a constructed building, so
`order: ["hatchery", ...]` refers to the first hatchery the player *built* (the
natural), not the starting one.

If you want the pattern to count *from* the initial building, add
`"include_start": true` to the condition. That folds the free starting town hall
into the front of the sequence, so `order: ["hatchery", "hatchery", "spire"]`
reads as **main + one built hatch + spire** — the way players count bases —
rather than two built hatcheries. Without it, a loose `order: ["hatchery",
"spire"]` would match a build that actually had three hatcheries (main + two
built), mislabeling it; `include_start` (usually with `"strict": true`) lets you
pin exactly how many hatcheries, counting the first. For pure counting,
`have ... eq N` is often simpler — it already counts the starting hall.

### `have` — counting things, optionally bounded

```json
{ "have": { "what": "hatchery", "op": "gte", "count": 3, "by_start_of": "lair" } }
```

Counts how many of `what` match the given bounds and compares the count.

| field            | meaning | default |
|------------------|---------|---------|
| `what`           | The slug to count (a building, or `overlord`). | required |
| `op`             | `gte`, `lte`, or `eq`. | `gte` |
| `count`          | The number to compare against. | `1` |
| `after`          | Only count things started at/after this time, `"m:ss"`. | — |
| `before`         | Only count things started at/before this time, `"m:ss"`. | — |
| `by_start_of`    | Only count things started **before the first `<slug>` begins**. If that anchor never appears, the condition fails. Great for "how many hatcheries did they have when the spire started." | — |
| `supply_min`     | Only count things whose start **supply** is ≥ this. | — |
| `supply_max`     | Only count things whose start supply is ≤ this. | — |
| `constructed_only` | `true` = ignore the free starting town hall when counting. | `false` |

Two things that trip people up:

- **The starting town hall counts.** `hatchery eq 2 by_start_of spire` means
  main + natural — that's why "2 hatch" is count **2**, not 1. If you want to
  count only things the player actually built, set `"constructed_only": true`
  (this is how "was any hatchery down *before the pool*" is asked, without the
  free main hatch getting in the way).
- **Supply bounds are simulation-only.** Supply comes from replaying the game;
  it's what makes "9 pool" vs "12 pool" possible. A def that uses `supply_min` /
  `supply_max` simply won't match under the faster command-stream reader.

## What you can reference (slugs)

Slugs are stable, lowercase, `snake_case`. Supply is the player's **used
supply** at the moment construction starts (for Zerg drone-morph buildings the
count already includes the morphing drone, so "12 pool" reads as 12).

The labeler records **structures** and **produced units**, so you can reference
either. Three things to know about units:

- **Workers are not recorded** (`scv`, `drone`, `probe`) — they're noise for
  build labels, and supply already tracks the economy.
- **Units join an `order` only when the pattern names one.** Otherwise the
  steady stream of marines/zerglings would sit between your buildings and break
  every strict order. Name `valkyrie` in the order and valkyries take part; don't
  name any unit and the order sees buildings only.
- **`overlord` is recorded at its morph *start***, not when it hatches — that's
  what makes the overpool-vs-9-pool split possible. Every other unit is recorded
  when it appears.

**Upgrades and techs are not emitted yet** (`zergling_speed`, `stim`…). They're
in the slug table for the command-stream reader, but the simulation doesn't
report them, so don't build labels on them yet.

**Zerg buildings:** `hatchery` `lair` `hive` `spawning_pool` `extractor`
`hydralisk_den` `spire` `greater_spire` `evolution_chamber` `creep_colony`
`sunken_colony` `spore_colony` `queens_nest` `defiler_mound` `nydus_canal`
`ultralisk_cavern`

**Terran buildings:** `command_center` `supply_depot` `refinery` `barracks`
`academy` `factory` `starport` `engineering_bay` `armory` `bunker`
`missile_turret` `machine_shop` `comsat_station` `control_tower`
`science_facility` `covert_ops` `physics_lab` `nuclear_silo`

**Protoss buildings:** `nexus` `pylon` `assimilator` `gateway` `forge`
`cybernetics_core` `photon_cannon` `shield_battery` `citadel_of_adun`
`robotics_facility` `robotics_support_bay` `observatory` `stargate`
`fleet_beacon` `templar_archives` `arbiter_tribunal`

**Terran units:** `marine` `firebat` `medic` `ghost` `vulture` `goliath`
`siege_tank` `wraith` `valkyrie` `science_vessel` `dropship` `battlecruiser`

**Zerg units:** `zergling` `hydralisk` `lurker` `mutalisk` `scourge` `overlord`
`queen` `defiler` `ultralisk` `guardian` `devourer`

**Protoss units:** `zealot` `dragoon` `dark_templar` `high_templar` `archon`
`dark_archon` `reaver` `shuttle` `observer` `corsair` `scout` `carrier`
`arbiter`

(Workers — `scv`, `drone`, `probe` — are deliberately not recorded.)

## Worked examples

**2.5 hatch spire** — a third hatch goes down *after* the lair, before the spire:
```json
"when": [
  { "order": ["lair", "hatchery", "spire"] },
  { "have": { "what": "hatchery", "op": "eq", "count": 2, "by_start_of": "lair" } },
  { "have": { "what": "hatchery", "op": "eq", "count": 3, "by_start_of": "spire" } }
]
```

**9 pool** — pool before any hatch, at ~9 supply, and no overlord made first:
```json
"when": [
  { "have": { "what": "hatchery", "op": "eq", "count": 0, "by_start_of": "spawning_pool", "constructed_only": true } },
  { "have": { "what": "spawning_pool", "op": "gte", "count": 1, "supply_min": 6, "supply_max": 10 } },
  { "have": { "what": "overlord", "op": "eq", "count": 0, "by_start_of": "spawning_pool" } }
]
```
`overpool` is the same but with `overlord op gte count 1` — an overlord was
started before the pool.

**12 hatch** — the natural hatchery goes down before the pool, at 12 supply:
```json
"when": [
  { "have": { "what": "hatchery", "op": "gte", "count": 1, "supply_min": 12, "supply_max": 13, "by_start_of": "spawning_pool", "constructed_only": true } }
]
```

**8 rax** — first building a rax at 8, second a depot:
```json
"when": [
  { "order": ["barracks", "supply_depot"], "strict": true },
  { "have": { "what": "barracks", "op": "gte", "count": 1, "supply_min": 8, "supply_max": 8 } }
]
```

## Contributing a build

1. Copy the closest existing file, rename it, give it a unique `id`.
2. Encode the defining shape. Prefer **order + counts** over exact times —
   building order is stable across games; timings drift with early fights.
   Reach for supply bounds only when supply is genuinely what defines the build
   (the pool/hatch supply openings).

   **Only put a thing in `order` if its *position* is part of the build.**
   Over-constraining position is the top cause of false negatives. An `order`
   step asserts "this comes after everything before it and before everything
   after it" — that's a strong claim. If a building is merely *required* rather
   than positioned (a Terran Armory can go before or after the Control Tower and
   the build is the same either way), take it out of the order and assert it
   with `have … by_start_of <later thing>` instead. Keep in the order only the
   spine that genuinely never reorders.
3. Keep dimensions separate: an opening file and a structure file, never one
   file that bakes an opener into a tech path.
4. Test it against real replays in the
   [sandbox](https://dxrsz.github.io/cwal-guides/identifier/): paste your
   definition, drop in replays of games that are (and aren't) this build, and
   check every condition's breakdown. It runs the same simulation and matcher
   as cwal.gg, so what it labels is what the site will label. "What the matcher
   sees" under each player is the exact timeline, with supply, your conditions
   are checked against.

   Before opening a pull request, run `cargo test` at the repo root: it fails
   on unknown fields, unknown slugs and malformed times in any definition.
5. Aim for **no false positives** first. A label that fires on the wrong build
   is worse than one that occasionally misses — someone searching for a build
   should trust every result.
