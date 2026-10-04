//! Build-order identification for StarCraft: Remastered replays.
//!
//! Two halves:
//!   1. *Extraction* ([`extract`]) — diff snapshots of the replay simulation's
//!      unit table into a per-player timeline of construction/production
//!      events (what, when, at what supply).
//!   2. *Matching* ([`matcher`]) — test that timeline against declarative build
//!      definitions ([`defs`], the JSON files in `defs/`). A build is
//!      a *label*, not "the" build: one player in one replay can match several
//!      (an opening and a tech path), so matching yields a set of labels.
//!
//! cwal.gg runs this against its native simulation; the sandbox runs the very
//! same code compiled to wasm, so a definition behaves identically in both.

pub mod defs;
pub mod extract;
pub mod matcher;
pub mod slugs;
pub mod timeline;

pub use defs::{BuildDef, Condition, Have, Op, Step, StepSet, load_defs, parse_mmss};
pub use extract::{Extractor, HudUnit, SIM_STRIDE, SIM_TARGET_FRAMES};
pub use matcher::{DefReport, eval_have, eval_order, explain, matches};
pub use slugs::Category;
pub use timeline::{Event, MS_PER_FRAME, PlayerBuild, ReplayBuild};

#[cfg(test)]
mod tests;
