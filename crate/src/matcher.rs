//! Matching a [`BuildDef`] against a player's timeline.
//!
//! Every check produces a report, not just a bool: the sandbox shows
//! contributors which condition held, which didn't, and why, and the boolean
//! answer cwal.gg uses is simply `report.matched`. One code path for both, so
//! the explanation can never disagree with the label.

use crate::defs::{BuildDef, Condition, Have, Op, Step, parse_mmss};
use crate::slugs::Category;
use crate::timeline::{Event, PlayerBuild};
use serde::Serialize;
use std::collections::HashSet;

/// Supply-providing structures, dropped from `order` when
/// `ignore_supply_providers` is set.
const SUPPLY_STRUCTURES: [&str; 3] = ["supply_depot", "pylon", "overlord"];

#[derive(Debug, Clone, Serialize)]
pub struct DefReport {
    pub id: String,
    pub name: String,
    /// True when every gate and every condition passed: the label applies.
    pub matched: bool,
    pub race: Gate,
    pub vs: Gate,
    pub conditions: Vec<ConditionReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Gate {
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConditionReport {
    pub passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<OrderReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub have: Option<HaveReport>,
}

/// An event as shown in a report.
#[derive(Debug, Clone, Serialize)]
pub struct Seen {
    pub slug: &'static str,
    pub seconds: f64,
    pub supply: Option<i32>,
    pub constructed: bool,
}

impl From<&Event> for Seen {
    fn from(e: &Event) -> Self {
        Seen {
            slug: e.slug,
            seconds: e.seconds,
            supply: e.supply,
            constructed: e.constructed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderReport {
    pub passed: bool,
    pub strict: bool,
    /// The sequence the pattern was matched against, after `include_start`,
    /// `ignore_supply_providers` and the units-only-when-named filter.
    pub sequence: Vec<Seen>,
    pub steps: Vec<StepReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Matched,
    Failed,
    /// An earlier step failed, so this one was never tried.
    NotReached,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepReport {
    pub step: String,
    pub status: StepStatus,
    /// Indices into `OrderReport::sequence` this step consumed.
    pub matched: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HaveReport {
    pub passed: bool,
    pub what: String,
    pub op: Op,
    pub expected: u32,
    pub actual: u32,
    /// Human-readable list of the bounds applied ("by start of spire (3:12)").
    pub filters: Vec<String>,
    /// Every `what` event and whether it was counted (and if not, why not).
    pub candidates: Vec<Candidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    #[serde(flatten)]
    pub event: Seen,
    pub counted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_by: Option<String>,
}

pub fn fmt_mmss(secs: f64) -> String {
    let s = secs.max(0.0) as u32;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Does `def` label `player`? `opponent` is the opponent race in a clean 1v1.
pub fn matches(def: &BuildDef, player: &PlayerBuild, opponent: Option<char>) -> bool {
    explain(def, player, opponent).matched
}

/// The full per-condition breakdown behind [`matches`].
pub fn explain(def: &BuildDef, player: &PlayerBuild, opponent: Option<char>) -> DefReport {
    let race = Gate {
        passed: def.race == player.race,
        detail: format!("build is for {}, player is {}", def.race, player.race),
    };
    let vs = if def.vs.is_empty() {
        Gate {
            passed: true,
            detail: "any matchup".into(),
        }
    } else {
        let want: String = def.vs.iter().collect();
        match opponent {
            Some(o) => Gate {
                passed: def.vs.contains(&o),
                detail: format!("build is vs {want}, opponent is {o}"),
            },
            None => Gate {
                passed: false,
                detail: format!("build is vs {want}, but this isn't a clean 1v1"),
            },
        }
    };
    let conditions: Vec<ConditionReport> = def
        .when
        .iter()
        .map(|c| explain_condition(c, &player.events))
        .collect();
    DefReport {
        id: def.id.clone(),
        name: def.name.clone(),
        matched: race.passed && vs.passed && conditions.iter().all(|c| c.passed),
        race,
        vs,
        conditions,
    }
}

pub fn explain_condition(c: &Condition, events: &[Event]) -> ConditionReport {
    let order = c.order.as_ref().map(|o| {
        explain_order(o, events, c.strict, c.include_start, c.ignore_supply_providers)
    });
    let have = c.have.as_ref().map(|h| explain_have(h, events));
    ConditionReport {
        passed: order.as_ref().is_none_or(|o| o.passed) && have.as_ref().is_none_or(|h| h.passed),
        order,
        have,
    }
}

pub fn eval_condition(c: &Condition, events: &[Event]) -> bool {
    explain_condition(c, events).passed
}

/// Match `steps` against the *constructed* events (synthetic starting base
/// excluded, unless `include_start`). Loose (default): a subsequence,
/// interleaving events skipped. Strict: a prefix — each step must be the very
/// next building in the considered sequence.
pub fn explain_order(
    steps: &[Step],
    events: &[Event],
    strict: bool,
    include_start: bool,
    ignore_supply_providers: bool,
) -> OrderReport {
    // Units take part in an order only when the pattern actually names one.
    // Otherwise the steady stream of produced units (marines, zerglings…) would
    // sit between the buildings and break every strict order.
    let named: HashSet<&str> = steps.iter().flat_map(Step::names).collect();

    // The only non-constructed event is the frame-0 starting town hall; folding
    // it in lets a pattern be written from the initial building.
    // `ignore_supply_providers` additionally drops the ever-present supply
    // structures.
    let seq: Vec<&Event> = events
        .iter()
        .filter(|e| matches!(e.category, Category::Building) || named.contains(e.slug))
        .filter(|e| e.constructed || include_start)
        .filter(|e| !ignore_supply_providers || !SUPPLY_STRUCTURES.contains(&e.slug))
        .collect();

    let at = |i: usize| -> String {
        seq.get(i)
            .map(|e| format!("{} at {}", e.slug, fmt_mmss(e.seconds)))
            .unwrap_or_else(|| "the end of the sequence".into())
    };
    let after = |cursor: usize| -> String {
        if cursor == 0 {
            "from the start".into()
        } else {
            format!("after {}", at(cursor - 1))
        }
    };

    let mut cursor = 0usize;
    let mut failed = false;
    let mut reports = Vec::with_capacity(steps.len());
    for step in steps {
        let label = step.label();
        if failed {
            reports.push(StepReport {
                step: label,
                status: StepStatus::NotReached,
                matched: vec![],
                detail: None,
            });
            continue;
        }
        let mut used = Vec::new();
        let mut why: Option<String> = None;
        // Find one event satisfying `pred`, honouring strict/loose.
        let mut take_one = |cursor: &mut usize, pred: &dyn Fn(&str) -> bool, what: &str| -> Option<String> {
            if strict {
                match seq.get(*cursor) {
                    Some(e) if pred(e.slug) => {
                        used.push(*cursor);
                        *cursor += 1;
                        None
                    }
                    _ => Some(format!(
                        "strict: expected {what} as building #{}, found {}",
                        *cursor + 1,
                        at(*cursor)
                    )),
                }
            } else {
                match seq[*cursor..].iter().position(|e| pred(e.slug)) {
                    Some(rel) => {
                        used.push(*cursor + rel);
                        *cursor += rel + 1;
                        None
                    }
                    None => Some(format!("no {what} {}", after(*cursor))),
                }
            }
        };
        match step {
            Step::One(name) => {
                why = take_one(&mut cursor, &|s| s == name.as_str(), name);
            }
            Step::Set(set) => {
                if !set.one_of.is_empty() {
                    let what = format!("one of {}", set.one_of.join(" | "));
                    why = take_one(&mut cursor, &|s| set.one_of.iter().any(|n| n == s), &what);
                }
                if why.is_none() && !set.unordered.is_empty() {
                    let mut needed: Vec<&str> = set.unordered.iter().map(String::as_str).collect();
                    if strict {
                        // The next `needed.len()` buildings must be exactly
                        // this set, in any internal order.
                        let k = needed.len();
                        for i in cursor..cursor + k {
                            let Some(e) = seq.get(i) else {
                                why = Some(format!(
                                    "strict: sequence ended before {}",
                                    needed.join(", ")
                                ));
                                break;
                            };
                            match needed.iter().position(|n| *n == e.slug) {
                                Some(p) => {
                                    needed.swap_remove(p);
                                    used.push(i);
                                }
                                None => {
                                    why = Some(format!(
                                        "strict: building #{} is {}, not one of {}",
                                        i + 1,
                                        at(i),
                                        needed.join(", ")
                                    ));
                                    break;
                                }
                            }
                        }
                        cursor += k;
                    } else {
                        let start = cursor;
                        let mut last = cursor;
                        let mut i = cursor;
                        while !needed.is_empty() && i < seq.len() {
                            if let Some(pos) = needed.iter().position(|n| *n == seq[i].slug) {
                                needed.swap_remove(pos);
                                used.push(i);
                                last = i;
                            }
                            i += 1;
                        }
                        if needed.is_empty() {
                            cursor = last + 1;
                        } else {
                            why = Some(format!("missing {} {}", needed.join(", "), after(start)));
                        }
                    }
                }
            }
        }
        failed = why.is_some();
        reports.push(StepReport {
            step: label,
            status: if failed {
                StepStatus::Failed
            } else {
                StepStatus::Matched
            },
            matched: used,
            detail: why,
        });
    }
    OrderReport {
        passed: !failed,
        strict,
        sequence: seq.iter().map(|e| Seen::from(*e)).collect(),
        steps: reports,
    }
}

pub fn eval_order(
    steps: &[Step],
    events: &[Event],
    strict: bool,
    include_start: bool,
    ignore_supply_providers: bool,
) -> bool {
    explain_order(steps, events, strict, include_start, ignore_supply_providers).passed
}

pub fn explain_have(h: &Have, events: &[Event]) -> HaveReport {
    let mut filters = Vec::new();
    let mut detail = None;

    // Events are sorted by frame, so the first matching anchor is the earliest.
    let boundary = h.by_start_of.as_ref().map(|anchor| {
        let at = events
            .iter()
            .find(|e| e.constructed && e.slug == anchor.as_str())
            .map(|e| e.seconds);
        match at {
            Some(s) => filters.push(format!("by start of {anchor} ({})", fmt_mmss(s))),
            None => filters.push(format!("by start of {anchor} (never started)")),
        }
        at
    });
    let after = h.after.as_deref().and_then(parse_mmss);
    let before = h.before.as_deref().and_then(parse_mmss);
    if let Some(a) = &h.after {
        filters.push(format!("at/after {a}"));
    }
    if let Some(b) = &h.before {
        filters.push(format!("at/before {b}"));
    }
    match (h.supply_min, h.supply_max) {
        (Some(lo), Some(hi)) if lo == hi => filters.push(format!("at {lo} supply")),
        (Some(lo), Some(hi)) => filters.push(format!("at {lo}-{hi} supply")),
        (Some(lo), None) => filters.push(format!("at {lo}+ supply")),
        (None, Some(hi)) => filters.push(format!("at or below {hi} supply")),
        (None, None) => {}
    }
    if h.constructed_only {
        filters.push("built only (not the starting town hall)".into());
    }

    let mut candidates = Vec::new();
    for e in events.iter().filter(|e| e.slug == h.what.as_str()) {
        let excluded_by = if h.constructed_only && !e.constructed {
            Some("starting town hall".to_string())
        } else if after.is_some_and(|a| e.seconds < a) {
            Some(format!("before {}", h.after.as_deref().unwrap_or("")))
        } else if before.is_some_and(|b| e.seconds > b) {
            Some(format!("after {}", h.before.as_deref().unwrap_or("")))
        } else if let Some(Some(bnd)) = boundary
            && e.seconds > bnd
        {
            Some(format!(
                "after {} started",
                h.by_start_of.as_deref().unwrap_or("")
            ))
        } else if let Some(lo) = h.supply_min
            && !e.supply.is_some_and(|s| s >= lo)
        {
            Some(match e.supply {
                Some(s) => format!("supply {s} < {lo}"),
                None => "no supply known".into(),
            })
        } else if let Some(hi) = h.supply_max
            && !e.supply.is_some_and(|s| s <= hi)
        {
            Some(match e.supply {
                Some(s) => format!("supply {s} > {hi}"),
                None => "no supply known".into(),
            })
        } else {
            None
        };
        candidates.push(Candidate {
            event: Seen::from(e),
            counted: excluded_by.is_none(),
            excluded_by,
        });
    }
    let actual = candidates.iter().filter(|c| c.counted).count() as u32;

    let passed = if let Some(None) = boundary {
        // by_start_of present but the anchor never happened: can't hold.
        detail = Some(format!(
            "{} never started, so this fails regardless of the count",
            h.by_start_of.as_deref().unwrap_or("")
        ));
        false
    } else {
        match h.op {
            Op::Gte => actual >= h.count,
            Op::Lte => actual <= h.count,
            Op::Eq => actual == h.count,
        }
    };
    HaveReport {
        passed,
        what: h.what.clone(),
        op: h.op,
        expected: h.count,
        actual,
        filters,
        candidates,
        detail,
    }
}

pub fn eval_have(h: &Have, events: &[Event]) -> bool {
    explain_have(h, events).passed
}
