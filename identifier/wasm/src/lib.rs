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
