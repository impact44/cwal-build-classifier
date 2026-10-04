//! Simulation-based extraction: turn snapshots of the bwsim unit table into a
//! per-player build timeline.
//!
//! This is a pure state machine over snapshots, so the same code runs in
//! cwal.gg's backend (native bwsim) and in the sandbox (bwsim's wasm build,
//! driven from JavaScript). The driver's whole job is:
//!
//! ```text
//! let mut x = Extractor::new(&parse_hud_units(&units_at_frame_0));
//! loop {
//!     step the sim SIM_STRIDE frames;
//!     x.observe(frame, &parse_hud_units(&units), Some(&hud_players));
//!     if frame >= SIM_TARGET_FRAMES { break }
//! }
//! let build = x.finish(&replay_header);
//! ```
//!
//! Diffing the unit table sees what actually happened — real construction
//! starts, real supply, morphs timed from the build queue rather than from
//! completion, cancelled work discarded — which the command stream can only
//! guess at.

use crate::slugs::{Category, building_slug, starting_base, unit_slug};
use crate::timeline::{Event, MS_PER_FRAME, PlayerBuild, ReplayBuild};
use std::collections::{HashMap, HashSet};

/// ~8 minutes at ~24 frames per game second. Every opening and early-structure
/// label resolves well within this, so drivers never sim the rest.
pub const SIM_TARGET_FRAMES: i32 = 11_520;

/// Frames between snapshots (~1 game second).
pub const SIM_STRIDE: u32 = 24;

/// `hud_units` / `bw_hud_units` record stride and a buffer capacity in records.
pub const HUD_REC: usize = 72;
pub const HUD_MAX: usize = 4000;

/// `hud_players` / `bw_hud_players`: 12 rows of 40 bytes.
pub const HUD_PLAYERS_LEN: usize = 12 * 40;

/// `replay_header_info` / `bw_replay_header` buffer size.
pub const HEADER_LEN: usize = 600;

/// Zerg egg (the generic larva-morph cocoon) and overlord unit-type ids. An egg
/// whose build-queue target is an overlord marks the *start* of an overlord
/// morph, which is what separates overpool from 9 pool.
const EGG_TYPE: u16 = 36;
const OVERLORD_TYPE: u16 = 42;

/// Zerg building-morph targets: Lair, Hive, Greater Spire, Spore, Sunken.
///
/// A morphing building keeps its OLD unit type and carries the target in its
/// build queue until the morph finishes — exactly like an egg. So the type only
/// flips on completion, which is ~100s late for a Lair. Watching the build
/// queue instead gives the moment the player actually started the morph, which
/// is what "lair at 2:49" means and what build definitions anchor on.
const ZERG_MORPH_TARGETS: [u16; 5] = [132, 133, 137, 144, 146];

/// Zerg buildings morphed FROM a drone: the drone is consumed the instant the
/// morph starts, so the sampled supply reads one low versus how players count
/// ("12 pool" includes the morphing drone). Building-from-building morphs
/// (Lair/Hive/Greater Spire/Sunken/Spore) consume no drone.
const DRONE_MORPHS: [u16; 11] = [131, 134, 135, 136, 138, 139, 140, 141, 142, 143, 149];

/// One row of the sim's unit table, as much of it as extraction needs.
#[derive(Clone, Copy, Debug)]
pub struct HudUnit {
    pub index: u32,
    pub unit_type: u16,
    pub owner: u8,
    /// A morphing unit's target (offset 52); 0xFFFF when there is none.
    pub build_queue0: u16,
    /// Bit 0 of the flags byte at offset 7: how a cancelled building is told
    /// apart from a finished one.
    pub completed: bool,
}

/// Decode a `hud_units` buffer (`HUD_REC`-byte records).
pub fn parse_hud_units(buf: &[u8]) -> Vec<HudUnit> {
    buf.as_chunks::<HUD_REC>().0.iter()
        .map(|r| HudUnit {
            index: u32::from_le_bytes([r[0], r[1], r[2], r[3]]),
            unit_type: u16::from_le_bytes([r[4], r[5]]),
            owner: r[6],
            build_queue0: u16::from_le_bytes([r[52], r[53]]),
            completed: r[7] & 1 != 0,
        })
        .collect()
}

/// The parts of the replay header extraction reports.
#[derive(Clone, Debug, Default)]
pub struct Header {
    pub frame_count: u32,
    pub map: String,
    /// Lobby slot names; a unit's owner is its slot index.
    pub slot_names: Vec<String>,
}

/// Read a fixed-width, null-terminated BW string, dropping control bytes.
fn read_cstr(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end])
        .chars()
        .filter(|&c| c >= ' ')
        .collect::<String>()
        .trim()
        .to_string()
}

/// Decode a `replay_header_info` buffer: frame count at 0, map name at 4..36,
/// then 12 slots of 44 bytes with the name in the first 25.
pub fn parse_header(hdr: &[u8]) -> Header {
    let n = hdr.len();
    Header {
        frame_count: if n >= 4 {
            u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]])
        } else {
            0
        },
        map: if n >= 36 { read_cstr(&hdr[4..36]) } else { String::new() },
        slot_names: (0..12)
            .map(|s| {
                let o = 36 + s * 44;
                if n >= o + 25 {
                    read_cstr(&hdr[o..o + 25])
                } else {
                    String::new()
                }
            })
            .collect(),
    }
}

fn starting_base_race(unit_type: u16) -> Option<char> {
    match unit_type {
        106 => Some('T'),
        131 => Some('Z'),
        154 => Some('P'),
        _ => None,
    }
}

/// Index into the supply arrays (`[zerg, terran, protoss]`).
fn race_supply_idx(race: char) -> usize {
    match race {
        'Z' => 0,
        'T' => 1,
        _ => 2,
    }
}

struct Rec {
    owner: u8,
    ev: Event,
    cancelled: bool,
}

pub struct Extractor {
    seen: HashMap<u32, u16>,
    races: HashMap<u8, char>,
    recs: Vec<Rec>,
    /// (unit index, target type) -> (index into `recs`, is_in_place_morph) for
    /// constructions not yet confirmed.
    pending: HashMap<(u32, u16), (usize, bool)>,
    /// (unit index, morph target) pairs already recorded at their morph start,
    /// so the later type flip doesn't record the same building twice.
    morph_started: HashSet<(u32, u16)>,
}

impl Extractor {
    /// Seed from the frame-0 unit table: each owner's race from its starting
    /// base (which handles Random), and prime the seen map so pre-placed units
    /// aren't reported as constructions.
    pub fn new(seed: &[HudUnit]) -> Self {
        let mut seen = HashMap::new();
        let mut races = HashMap::new();
        for u in seed {
            seen.insert(u.index, u.unit_type);
            if let Some(r) = starting_base_race(u.unit_type) {
                races.insert(u.owner, r);
            }
        }
        Extractor {
            seen,
            races,
            recs: Vec::new(),
            pending: HashMap::new(),
            morph_started: HashSet::new(),
        }
    }

    /// Feed one snapshot. `players` is the raw `hud_players` buffer, when the
    /// sim provided one (supply is None otherwise).
    pub fn observe(&mut self, frame: i32, units: &[HudUnit], players: Option<&[u8]>) {
        let seconds = frame as f64 * MS_PER_FRAME / 1000.0;
        let supply_of = |owner: u8, race: char| -> Option<i32> {
            let hud = players?;
            let o = owner as usize * 40 + (2 + race_supply_idx(race)) * 4;
            let b = hud.get(o..o + 4)?;
            Some(i32::from_le_bytes([b[0], b[1], b[2], b[3]]) / 2)
        };
        let ev = |slug, category, supply| Event {
            slug,
            category,
            frame,
            seconds,
            constructed: true,
            tile: None,
            supply,
        };

        let now_full: HashMap<u32, (u16, u16, bool)> = units
            .iter()
            .map(|u| (u.index, (u.unit_type, u.build_queue0, u.completed)))
            .collect();

        for u in units {
            let (index, utype, owner, bq) = (u.index, u.unit_type, u.owner, u.build_queue0);
            let Some(&race) = self.races.get(&owner) else {
                continue;
            };

            // Zerg building morph START. The building still reads as its old
            // type here (the type only flips when the morph completes), so this
            // has to be checked before the "type unchanged" guard below.
            if bq != utype
                && ZERG_MORPH_TARGETS.contains(&bq)
                && self.morph_started.insert((index, bq))
                && let Some(slug) = building_slug(bq)
            {
                self.recs.push(Rec {
                    owner,
                    ev: ev(slug, Category::Building, supply_of(owner, race)),
                    cancelled: false,
                });
                self.pending.insert((index, bq), (self.recs.len() - 1, true));
            }

            let prev = self.seen.get(&index).copied();
            if prev == Some(utype) {
                continue;
            }
            if let Some(slug) = building_slug(utype) {
                // A cosmetic type-id change that maps to the same slug is not a
                // new building.
                if prev.and_then(building_slug) == Some(slug) {
                    continue;
                }
                // Already recorded at the moment the morph started.
                if self.morph_started.contains(&(index, utype)) {
                    continue;
                }
                let drone_back = i32::from(DRONE_MORPHS.contains(&utype));
                let supply = supply_of(owner, race).map(|s| s + drone_back);
                self.recs.push(Rec {
                    owner,
                    ev: ev(slug, Category::Building, supply),
                    cancelled: false,
                });
                self.pending.insert((index, utype), (self.recs.len() - 1, false));
            } else if utype == EGG_TYPE && bq == OVERLORD_TYPE {
                // Start of an overlord morph — the "9 overlord" of overpool.
                self.recs.push(Rec {
                    owner,
                    ev: ev("overlord", Category::Unit, supply_of(owner, race)),
                    cancelled: false,
                });
                self.pending
                    .insert((index, OVERLORD_TYPE), (self.recs.len() - 1, true));
            } else if let Some(slug) = unit_slug(utype) {
                // Workers are noise for build labels (supply already tracks the
                // economy), and the overlord is recorded at its morph start above.
                if matches!(slug, "scv" | "drone" | "probe" | "overlord") {
                    continue;
                }
                // Mode toggles (Siege Tank <-> Siege Mode) share a slug and must
                // not count as a second unit.
                if prev.and_then(unit_slug) == Some(slug) {
                    continue;
                }
                self.recs.push(Rec {
                    owner,
                    ev: ev(slug, Category::Unit, supply_of(owner, race)),
                    cancelled: false,
                });
            }
        }

        // Construction is recorded when it STARTS, but only kept once
        // confirmed: the thing either completes, or is still going up when the
        // window ends. A unit that disappears before completing was cancelled —
        // the extractor trick, a cancelled hatchery, a drone killed mid-build —
        // and never really happened.
        let recs = &mut self.recs;
        self.pending
            .retain(|&(idx, target), &mut (rec, morph)| match now_full.get(&idx) {
                None => {
                    recs[rec].cancelled = true;
                    false
                }
                Some(&(t, bq, done)) => {
                    if t == target && done {
                        false // finished — confirmed, stop tracking
                    } else if t != target && (!morph || bq != target) {
                        // Turned into something else, or the morph was called off.
                        recs[rec].cancelled = true;
                        false
                    } else {
                        true // still going up
                    }
                }
            });

        self.seen = now_full.iter().map(|(&k, &(t, _, _))| (k, t)).collect();
    }

    /// Whatever is still pending at the window edge is legitimately under
    /// construction, so it stays; only cancelled work is dropped.
    pub fn finish(self, header: &Header) -> ReplayBuild {
        let mut events: HashMap<u8, Vec<Event>> = HashMap::new();
        for r in self.recs {
            if !r.cancelled {
                events.entry(r.owner).or_default().push(r.ev);
            }
        }
        let mut players: Vec<PlayerBuild> = self
            .races
            .iter()
            .map(|(&owner, &race)| {
                let mut evs = events.remove(&owner).unwrap_or_default();
                evs.sort_by_key(|e| e.frame);
                if let Some(start) = starting_base(race) {
                    evs.insert(0, Event::starting_base(start));
                }
                PlayerBuild {
                    player_id: owner,
                    name: header
                        .slot_names
                        .get(owner as usize)
                        .cloned()
                        .unwrap_or_default(),
                    race,
                    events: evs,
                }
            })
            .collect();
        players.sort_by_key(|p| p.player_id);
        ReplayBuild {
            map: header.map.clone(),
            frame_count: header.frame_count,
            players,
        }
    }
}
