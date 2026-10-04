//! The extracted per-player timeline the matcher reads. The simulation
//! extractor ([`crate::extract`]) produces it in cwal.gg and in the sandbox
//! alike, so a definition matches the same way in both places.

use crate::slugs::Category;
use serde::{Deserialize, Deserializer, Serialize};

/// Milliseconds per frame on Fastest, so timings agree with the durations
/// shown elsewhere on cwal.gg.
pub const MS_PER_FRAME: f64 = 42.0;

/// Spelled as an alias so serde's derive doesn't read the `'static` as a
/// borrow from the input (`known_slug` maps it to the static string instead).
pub type Slug = &'static str;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    #[serde(deserialize_with = "known_slug")]
    pub slug: Slug,
    /// Buildings always take part in an `order`; units only when the pattern
    /// names them, so a stream of marines can't break a strict building order.
    pub category: Category,
    pub frame: i32,
    pub seconds: f64,
    /// False for the synthetic starting town hall; true for anything the player
    /// actually built. Order patterns look at constructed events only; count
    /// conditions look at all of them.
    pub constructed: bool,
    /// Build placement tile, when the source carried one. Used to dedupe
    /// re-issued build commands (same building, same tile == one construction).
    #[serde(skip)]
    pub tile: Option<(u16, u16)>,
    /// The owner's used supply when this started. Only the simulation fills
    /// this in (the command stream can't know it); None otherwise.
    pub supply: Option<i32>,
}

impl Event {
    /// The synthetic frame-0 town hall every player starts with.
    pub fn starting_base(slug: &'static str) -> Self {
        Event {
            slug,
            category: Category::Building,
            frame: 0,
            seconds: 0.0,
            constructed: false,
            tile: None,
            supply: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayerBuild {
    pub player_id: u8,
    pub name: String,
    pub race: char,
    pub events: Vec<Event>,
}

/// A timeline as serialized (the sandbox's precomputed corpus timelines) reads
/// back into the same shape, so matching a stored timeline is identical to
/// matching a fresh extraction.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplayBuild {
    pub map: String,
    pub frame_count: u32,
    pub players: Vec<PlayerBuild>,
}

impl ReplayBuild {
    /// The opponent race for a given player, when the game is a clean 1v1 (so
    /// matchup-scoped builds can be filtered). None for team games / oddities.
    pub fn opponent_race(&self, player_id: u8) -> Option<char> {
        let others: Vec<char> = self
            .players
            .iter()
            .filter(|p| p.player_id != player_id)
            .map(|p| p.race)
            .collect();
        match others.as_slice() {
            [r] => Some(*r),
            _ => None,
        }
    }
}

/// Map a serialized slug back to the static one, rejecting names the extractor
/// could never have produced.
fn known_slug<'de, D: Deserializer<'de>>(d: D) -> Result<&'static str, D::Error> {
    let s = String::deserialize(d)?;
    crate::slugs::intern(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown slug {s:?}")))
}
