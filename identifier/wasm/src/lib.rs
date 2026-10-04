//! The identifier compiled for the browser sandbox (`wasm32-unknown-unknown`).
//!
//! A plain C ABI rather than wasm-bindgen, so the sandbox needs no generated
//! glue and the build needs nothing beyond `cargo`. JavaScript owns the sim
//! (bwsim's own wasm module) and feeds this module raw snapshot bytes; this
//! module owns extraction and matching, which are the exact code cwal.gg runs.
//!
//! Byte buffers cross the boundary through `alloc`/`dealloc`; results come
//! back as JSON in a shared output buffer read with `out_ptr`/`out_len`.

use build_identifier::extract::{self, Extractor};
use build_identifier::{BuildDef, ReplayBuild, explain};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_out(bytes: Vec<u8>) -> usize {
    let n = bytes.len();
    OUT.with(|o| *o.borrow_mut() = bytes);
    n
}

fn set_out_json<T: Serialize>(v: &T) -> usize {
    set_out(serde_json::to_vec(v).unwrap_or_else(|e| format!("{{\"error\":{:?}}}", e.to_string()).into_bytes()))
}

/// # Safety
/// `ptr..ptr+len` must be a live allocation from [`alloc`] (or len 0).
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from a matching [`alloc`] call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
}

#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_stride() -> u32 {
    extract::SIM_STRIDE
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_target_frames() -> i32 {
    extract::SIM_TARGET_FRAMES
}

#[unsafe(no_mangle)]
pub extern "C" fn hud_rec() -> usize {
    extract::HUD_REC
}

/// Start extracting from the frame-0 unit table. Returns a handle.
///
/// # Safety
/// Buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn extractor_new(units: *const u8, units_len: usize) -> *mut Extractor {
    let seed = extract::parse_hud_units(unsafe { bytes(units, units_len) });
    Box::into_raw(Box::new(Extractor::new(&seed)))
}

/// Feed one snapshot. `players_len == 0` means no supply this frame.
///
/// # Safety
/// `h` from [`extractor_new`], buffers from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn extractor_observe(
    h: *mut Extractor,
    frame: i32,
    units: *const u8,
    units_len: usize,
    players: *const u8,
    players_len: usize,
) {
    let x = unsafe { &mut *h };
    let units = extract::parse_hud_units(unsafe { bytes(units, units_len) });
    let players = (players_len > 0).then(|| unsafe { bytes(players, players_len) });
    x.observe(frame, &units, players);
}

/// Consume the extractor; returns a build handle and leaves the timeline JSON
/// in the output buffer.
///
/// # Safety
/// `h` from [`extractor_new`] (freed here), header buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn extractor_finish(
    h: *mut Extractor,
    header: *const u8,
    header_len: usize,
) -> *mut ReplayBuild {
    let x = unsafe { Box::from_raw(h) };
    let hdr = extract::parse_header(unsafe { bytes(header, header_len) });
    let build = x.finish(&hdr);
    set_out_json(&build);
    Box::into_raw(Box::new(build))
}

/// # Safety
/// `h` from [`extractor_finish`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn build_free(h: *mut ReplayBuild) {
    if !h.is_null() {
        drop(unsafe { Box::from_raw(h) });
    }
}

#[derive(Deserialize)]
struct DefFile {
    file: String,
    text: String,
}

#[derive(Serialize)]
struct DefStatus {
    file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    problems: Vec<String>,
}

#[derive(Serialize)]
struct PlayerResult<'a> {
    player_id: u8,
    name: &'a str,
    race: char,
    opponent: Option<char>,
    reports: Vec<build_identifier::DefReport>,
}

#[derive(Serialize)]
struct IdentifyResult<'a> {
    defs: Vec<DefStatus>,
    players: Vec<PlayerResult<'a>>,
}

/// Parse and check definitions, and (with a build handle) match every player
/// against every definition that parsed. Input is a JSON array of
/// `{file, text}`; output JSON is left in the output buffer.
///
/// # Safety
/// `build` is null or from [`extractor_finish`]; the defs buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn identify(build: *const ReplayBuild, defs: *const u8, defs_len: usize) -> usize {
    let files: Vec<DefFile> = match serde_json::from_slice(unsafe { bytes(defs, defs_len) }) {
        Ok(f) => f,
        Err(e) => return set_out_json(&serde_json::json!({ "error": e.to_string() })),
    };
    let mut statuses = Vec::new();
    let mut parsed: Vec<BuildDef> = Vec::new();
    for f in files {
        match BuildDef::parse(&f.text) {
            Ok(d) => {
                statuses.push(DefStatus {
                    file: f.file,
                    id: Some(d.id.clone()),
                    error: None,
                    problems: d.problems(),
                });
                parsed.push(d);
            }
            Err(e) => statuses.push(DefStatus {
                file: f.file,
                id: None,
                error: Some(e.to_string()),
                problems: vec![],
            }),
        }
    }
    let players = match unsafe { build.as_ref() } {
        None => vec![],
        Some(rep) => rep
            .players
            .iter()
            .map(|p| {
                let opponent = rep.opponent_race(p.player_id);
                PlayerResult {
                    player_id: p.player_id,
                    name: &p.name,
                    race: p.race,
                    opponent,
                    reports: parsed.iter().map(|d| explain(d, p, opponent)).collect(),
                }
            })
            .collect(),
    };
    set_out_json(&IdentifyResult { defs: statuses, players })
}

/// Every slug a definition may reference, as a JSON array.
#[unsafe(no_mangle)]
pub extern "C" fn slugs() -> usize {
    set_out_json(&build_identifier::slugs::all())
}

// ---- corpus: precomputed timelines, matched without simulating -------------

thread_local! {
    static CORPUS: RefCell<Vec<Option<ReplayBuild>>> = const { RefCell::new(Vec::new()) };
}

/// Load the corpus timelines: a JSON array, one `ReplayBuild` (or null for a
/// replay that failed to simulate) per index entry, in index order. Returns how
/// many loaded, or -1 with the error in the output buffer.
///
/// # Safety
/// Buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn corpus_load(ptr: *const u8, len: usize) -> i32 {
    match serde_json::from_slice::<Vec<Option<ReplayBuild>>>(unsafe { bytes(ptr, len) }) {
        Ok(v) => {
            let n = v.len() as i32;
            CORPUS.with(|c| *c.borrow_mut() = v);
            n
        }
        Err(e) => {
            set_out_json(&serde_json::json!({ "error": e.to_string() }));
            -1
        }
    }
}

#[derive(Serialize)]
struct Hit<'a> {
    idx: usize,
    players: Vec<HitPlayer<'a>>,
}

#[derive(Serialize)]
struct HitPlayer<'a> {
    player_id: u8,
    name: &'a str,
    race: char,
    opponent: Option<char>,
}

/// Match corpus entries `start..end` against the first definition in the JSON
/// `[{file, text}]` array, leaving `{hits: [{idx, players}]}` (only players it
/// labels) or `{error}` in the output buffer. Called in chunks so the page can
/// show progress and stop between them.
///
/// # Safety
/// Buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn corpus_scan(defs: *const u8, defs_len: usize, start: usize, end: usize) -> usize {
    let def = serde_json::from_slice::<Vec<DefFile>>(unsafe { bytes(defs, defs_len) })
        .map_err(|e| e.to_string())
        .and_then(|f| f.into_iter().next().ok_or_else(|| "no definition".to_string()))
        .and_then(|f| BuildDef::parse(&f.text).map_err(|e| e.to_string()));
    let def = match def {
        Ok(d) => d,
        Err(e) => return set_out_json(&serde_json::json!({ "error": e })),
    };
    CORPUS.with(|c| {
        let corpus = c.borrow();
        let end = end.min(corpus.len());
        let hits: Vec<Hit> = (start.min(end)..end)
            .filter_map(|idx| {
                let rep = corpus[idx].as_ref()?;
                let players: Vec<HitPlayer> = rep
                    .players
                    .iter()
                    .filter_map(|p| {
                        let opponent = rep.opponent_race(p.player_id);
                        build_identifier::matches(&def, p, opponent).then_some(HitPlayer {
                            player_id: p.player_id,
                            name: &p.name,
                            race: p.race,
                            opponent,
                        })
                    })
                    .collect();
                (!players.is_empty()).then_some(Hit { idx, players })
            })
            .collect();
        set_out_json(&serde_json::json!({ "hits": hits }))
    })
}
