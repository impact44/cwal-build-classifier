# cwal-guides

The open, contributor-editable half of [cwal.gg](https://cwal.gg)'s build orders.
cwal.gg includes this repo as a git submodule, so a merged change here ships to
the site with its next deploy.

| Path | What it is |
|------|------------|
| [`identifier/defs/`](identifier/defs/) | **Build definitions**: the JSON rules that label a player's build from a replay ("12 hatch", "3 hatch spire"). Start with its [README](identifier/defs/README.md). |
| [`identifier/crate/`](identifier/crate/) | The Rust matcher and extractor that evaluate those definitions. cwal.gg's backend uses this crate directly. |
| [`identifier/wasm/`](identifier/wasm/) | The same crate compiled for the browser sandbox. |
| [`guides/`](guides/) | **Build-order guides**: the articles and the components that render them. |
| [`site/`](site/) | The GitHub Pages site: the [identifier sandbox](https://dxrsz.github.io/cwal-guides/identifier/) and the [guide previews](https://dxrsz.github.io/cwal-guides/guides/). |

## Build definitions

Write or edit a definition in the
[sandbox](https://dxrsz.github.io/cwal-guides/identifier/), drop in replays, and
it shows for every player which conditions matched and which didn't. When it
labels the games you expect (and none you don't), copy the JSON into
`identifier/defs/` and open a pull request. `cargo test` checks every
definition for unknown fields, unknown names and malformed times.

To run the sandbox locally (needs Rust with the `wasm32-unknown-unknown`
target, and Node):

```sh
rustup target add wasm32-unknown-unknown
node identifier/build-site.mjs
python3 -m http.server -d site 8000   # then open http://localhost:8000/identifier/
```

The replay simulation the sandbox runs is the build cwal.gg's replay viewer
serves; `build-site.mjs` downloads it from cwal.gg.
