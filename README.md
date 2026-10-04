# cwal-build-classifier

The build-order classifier behind [cwal.gg](https://cwal.gg): the rules that
label a player's build from a replay ("12 hatch", "3 hatch spire"), the code
that evaluates them, and a sandbox to write and test new ones. cwal.gg includes
this repo as a git submodule, so a merged definition ships with the site's next
deploy.

| Path | What it is |
|------|------------|
| [`defs/`](defs/) | **Build definitions**: one JSON file per label. Start with its [README](defs/README.md). |
| [`crate/`](crate/) | The Rust matcher and extractor that evaluate those definitions. cwal.gg's backend uses this crate directly. |
| [`wasm/`](wasm/) | The same crate compiled for the browser sandbox. |
| [`corpus/`](corpus/) | 1,000 high-MMR ladder replays (1v1, 5+ minutes, 2300-2700 MMR) the sandbox can search with a definition, and their index. |
| [`site/`](site/) | The [sandbox](https://dxrsz.github.io/cwal-build-classifier/), published to GitHub Pages. |

## Writing a definition

Write or edit a definition in the
[sandbox](https://dxrsz.github.io/cwal-build-classifier/), drop in replays, and
it shows for every player which conditions matched and which didn't. **Search**
runs it over the 1,000 replays in `corpus/` and lists every player it labels,
so you can check for false positives across real games; each result can be
inspected condition by condition or downloaded to watch in StarCraft.

When it labels the games you expect (and none you don't), **Propose changes**
opens a pull request through GitHub. `cargo test` (run in CI on every pull
request) checks every definition for unknown fields, unknown names and
malformed times.

The site build simulates the corpus ahead of time (`corpus/timelines.mjs`), so
a search only matches and takes well under a second. To add replays to the
corpus, put them in `corpus/replays/` and rebuild the index with
`node corpus/index.mjs` (after `node build-site.mjs`, which it uses for the
engine).

## Running the sandbox locally

Needs Rust with the `wasm32-unknown-unknown` target, and Node.

```sh
rustup target add wasm32-unknown-unknown
node build-site.mjs
python3 -m http.server -d site 8000   # then open http://localhost:8000/
```

The replay simulation the sandbox runs is the build cwal.gg's replay viewer
serves; `build-site.mjs` downloads it from cwal.gg.
