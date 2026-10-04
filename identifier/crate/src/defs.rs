//! Build definitions (`identifier/defs/*.json`). See `identifier/defs/README.md`
//! for the contributor-facing description of every field.

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aka: Vec<String>,
    /// The player race this build describes.
    pub race: char,
    /// Opponent races this build applies to. Empty == any matchup.
    #[serde(default)]
    pub vs: Vec<char>,
    #[serde(default)]
    pub notes: String,
    /// All conditions must hold (AND).
    pub when: Vec<Condition>,
}

/// One condition. Modelled as optional slots rather than a tagged enum so new
/// condition kinds can be added without breaking existing files; every slot
/// present must pass. Unknown fields are rejected, so a typo such as
/// `by_start` fails loudly instead of silently widening the match.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    /// Relative construction order (a subsequence of the player's timeline).
    #[serde(default)]
    pub order: Option<Vec<Step>>,
    /// When true, `order` matches the *first* constructed buildings exactly and
    /// consecutively (a strict prefix, no skipping) — e.g. BBS is literally
    /// barracks, barracks, depot as the opening three. Default false = loose
    /// subsequence.
    #[serde(default)]
    pub strict: bool,
    /// When true, the free starting town hall (Hatchery / CC / Nexus) is folded
    /// into the front of the `order` sequence, so a pattern can be written from
    /// the initial building. With it, `order: ["hatchery", "hatchery", "spire"]`
    /// reads as main + one built hatch + spire — the way players count bases —
    /// instead of two *built* hatcheries. Default false = built buildings only.
    #[serde(default)]
    pub include_start: bool,
    /// When true, supply structures (Supply Depot, Pylon, Overlord) are dropped
    /// from the `order` sequence before matching. They're built constantly and
    /// rarely part of a build's identity, so this lets a *strict* order ignore
    /// them — e.g. gateway, gateway even with a pylon built between. A loose
    /// order already skips anything unlisted, so this mainly matters for strict.
    /// If a supply structure *is* the point (BBS ends on a depot), leave it off
    /// and list it. Default false.
    #[serde(default)]
    pub ignore_supply_providers: bool,
    /// A quantified existence / count check, optionally time- or anchor-bounded.
    #[serde(default)]
    pub have: Option<Have>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Step {
    /// A single building/unit that must appear next in order.
    One(String),
    /// A group step: `{ "unordered": [...] }` or `{ "one_of": [...] }`.
    Set(StepSet),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepSet {
    /// All of these must appear (any internal order) before the next step.
    #[serde(default)]
    pub unordered: Vec<String>,
    /// Any one of these satisfies the step.
    #[serde(default)]
    pub one_of: Vec<String>,
}

impl Step {
    /// Every slug this step names.
    pub fn names(&self) -> Vec<&str> {
        match self {
            Step::One(n) => vec![n.as_str()],
            Step::Set(s) => s
                .unordered
                .iter()
                .chain(s.one_of.iter())
                .map(String::as_str)
                .collect(),
        }
    }

    /// Human-readable form, as shown in the sandbox breakdown.
    pub fn label(&self) -> String {
        match self {
            Step::One(n) => n.clone(),
            Step::Set(s) => {
                let mut parts = Vec::new();
                if !s.one_of.is_empty() {
                    parts.push(format!("one of {}", s.one_of.join(" | ")));
                }
                if !s.unordered.is_empty() {
                    parts.push(format!("all of {{{}}}", s.unordered.join(", ")));
                }
                parts.join(", then ")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Gte,
    Lte,
    Eq,
}

impl Op {
    pub fn symbol(self) -> &'static str {
        match self {
            Op::Gte => ">=",
            Op::Lte => "<=",
            Op::Eq => "==",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Have {
    /// Slug of the building/unit/upgrade to count.
    pub what: String,
    #[serde(default = "default_op")]
    pub op: Op,
    #[serde(default = "default_count")]
    pub count: u32,
    /// Only count occurrences at/after this time ("m:ss").
    #[serde(default)]
    pub after: Option<String>,
    /// Only count occurrences at/before this time ("m:ss").
    #[serde(default)]
    pub before: Option<String>,
    /// Only count occurrences up to the moment the first `by_start_of` begins.
    /// If that anchor never appears, the condition fails closed.
    #[serde(default)]
    pub by_start_of: Option<String>,
    /// Only count occurrences whose start supply is >= this. Events without a
    /// supply value (the command-stream path, or the synthetic starting base)
    /// never satisfy a supply bound, so supply conditions are sim-only.
    #[serde(default)]
    pub supply_min: Option<i32>,
    /// Only count occurrences whose start supply is <= this.
    #[serde(default)]
    pub supply_max: Option<i32>,
    /// Only count actually-constructed events, excluding the synthetic starting
    /// base. Used to ask "was anything built before X" without the free hatch.
    #[serde(default)]
    pub constructed_only: bool,
}

impl Have {
    /// A bare `have` with only `what` set, for tests and builders.
    pub fn of(what: &str) -> Self {
        Have {
            what: what.into(),
            op: Op::Gte,
            count: 1,
            after: None,
            before: None,
            by_start_of: None,
            supply_min: None,
            supply_max: None,
            constructed_only: false,
        }
    }
}

fn default_op() -> Op {
    Op::Gte
}
fn default_count() -> u32 {
    1
}

/// Parse "m:ss" (or "mm:ss") into whole seconds.
pub fn parse_mmss(s: &str) -> Option<f64> {
    let (m, sec) = s.split_once(':')?;
    let m: f64 = m.trim().parse().ok()?;
    let sec: f64 = sec.trim().parse().ok()?;
    Some(m * 60.0 + sec)
}

impl BuildDef {
    /// Parse one definition from JSON text.
    pub fn parse(text: &str) -> Result<BuildDef, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// Problems serde can't see: names that aren't slugs (which would silently
    /// never match), malformed times, empty groups. Empty == clean.
    pub fn problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !matches!(self.race, 'Z' | 'T' | 'P') {
            out.push(format!("race {:?} must be \"Z\", \"T\" or \"P\"", self.race));
        }
        for r in &self.vs {
            if !matches!(r, 'Z' | 'T' | 'P') {
                out.push(format!("vs entry {r:?} must be \"Z\", \"T\" or \"P\""));
            }
        }
        if self.id.is_empty() || !self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.') {
            out.push(format!("id {:?} should be a lowercase kebab-case slug", self.id));
        }
        if self.when.is_empty() {
            out.push("`when` is empty, so this would label every player of the race".into());
        }
        fn slug(out: &mut Vec<String>, at: String, s: &str) {
            if !crate::slugs::is_known(s) {
                out.push(format!("{at}: unknown slug {s:?} (it can never match)"));
            }
        }
        for (i, c) in self.when.iter().enumerate() {
            let at = format!("when[{i}]");
            if c.order.is_none() && c.have.is_none() {
                out.push(format!("{at}: has neither `order` nor `have`, so it always passes"));
            }
            if let Some(order) = &c.order {
                for (j, step) in order.iter().enumerate() {
                    if let Step::Set(s) = step
                        && s.one_of.is_empty()
                        && s.unordered.is_empty()
                    {
                        out.push(format!("{at}.order[{j}]: needs `one_of` or `unordered`"));
                    }
                    for n in step.names() {
                        slug(&mut out, format!("{at}.order[{j}]"), n);
                    }
                }
            }
            if let Some(h) = &c.have {
                slug(&mut out, format!("{at}.have.what"), &h.what);
                if let Some(a) = &h.by_start_of {
                    slug(&mut out, format!("{at}.have.by_start_of"), a);
                }
            }
        }
        for (i, c) in self.when.iter().enumerate() {
            if let Some(h) = &c.have {
                for (k, v) in [("after", &h.after), ("before", &h.before)] {
                    if let Some(t) = v
                        && parse_mmss(t).is_none()
                    {
                        out.push(format!("when[{i}].have.{k}: {t:?} is not \"m:ss\""));
                    }
                }
            }
        }
        out
    }
}

/// Load every `*.json` in a directory (sorted by file name). `.jsonc` files
/// such as `EXAMPLE.jsonc` are documentation and are skipped.
pub fn load_defs(dir: &Path) -> Result<Vec<BuildDef>, String> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("reading build defs from {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    entries.sort();
    let mut defs = Vec::new();
    for path in entries {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        let def = BuildDef::parse(&text).map_err(|e| format!("parsing {}: {e}", path.display()))?;
        defs.push(def);
    }
    Ok(defs)
}
