use crate::defs::*;
use crate::matcher::*;
use crate::slugs::Category;
use crate::timeline::*;

fn ev(slug: &'static str, secs: f64, constructed: bool) -> Event {
    Event {
        slug,
        category: Category::Building,
        frame: (secs * 1000.0 / MS_PER_FRAME) as i32,
        seconds: secs,
        constructed,
        tile: None,
        supply: None,
    }
}

/// A 2-hatch-muta-shaped timeline: main (synthetic) + natural, pool, gas,
/// lair, spire — and no third hatch before the spire.
fn two_hatch_muta() -> PlayerBuild {
    PlayerBuild {
        player_id: 0,
        race: 'Z',
        name: "z".into(),
        events: vec![
            ev("hatchery", 0.0, false), // main
            ev("hatchery", 60.0, true), // natural
            ev("spawning_pool", 75.0, true),
            ev("extractor", 90.0, true),
            ev("lair", 175.0, true),
            ev("spire", 210.0, true),
        ],
    }
}

fn two_and_half_hatch_muta() -> PlayerBuild {
    let mut p = two_hatch_muta();
    // third hatch between lair and spire
    p.events.insert(5, ev("hatchery", 190.0, true));
    p
}

fn muta_def(id: &str, hatch_count: u32) -> BuildDef {
    BuildDef {
        id: id.into(),
        name: id.into(),
        aka: vec![],
        race: 'Z',
        vs: vec!['T', 'P'],
        notes: String::new(),
        when: vec![
            Condition {
                order: Some(vec![
                    Step::Set(StepSet {
                        unordered: vec![
                            "hatchery".into(),
                            "spawning_pool".into(),
                            "extractor".into(),
                        ],
                        one_of: vec![],
                    }),
                    Step::One("lair".into()),
                    Step::One("spire".into()),
                ]),
                strict: false,
                include_start: false,
                ignore_supply_providers: false,
                have: None,
            },
            Condition {
                have: Some(Have {
                    op: Op::Eq,
                    count: hatch_count,
                    by_start_of: Some("spire".into()),
                    ..Have::of("hatchery")
                }),
                ..Default::default()
            },
        ],
    }
}

#[test]
fn two_hatch_matches_two_not_two_and_half() {
    let two = muta_def("2hatch", 2);
    let twohalf = muta_def("2.5hatch", 3);
    assert!(matches(&two, &two_hatch_muta(), Some('T')));
    assert!(!matches(&twohalf, &two_hatch_muta(), Some('T')));
}

#[test]
fn two_and_half_matches_its_own_count() {
    let two = muta_def("2hatch", 2);
    let twohalf = muta_def("2.5hatch", 3);
    assert!(matches(&twohalf, &two_and_half_hatch_muta(), Some('T')));
    // the extra hatch means it is NOT a plain 2-hatch
    assert!(!matches(&two, &two_and_half_hatch_muta(), Some('T')));
}

#[test]
fn matchup_filter_excludes_wrong_opponent() {
    let two = muta_def("2hatch", 2);
    assert!(!matches(&two, &two_hatch_muta(), Some('Z'))); // vs is [T,P]
    assert!(!matches(&two, &two_hatch_muta(), None)); // unknown opponent
}

#[test]
fn order_respects_sequence() {
    // Spire built before Lair: a frame-sorted timeline has spire earlier in
    // the vector, so the lair->spire step order can't be satisfied.
    let p = PlayerBuild {
        player_id: 0,
        race: 'Z',
        name: "z".into(),
        events: vec![
            ev("hatchery", 0.0, false),
            ev("hatchery", 60.0, true),
            ev("spawning_pool", 75.0, true),
            ev("extractor", 90.0, true),
            ev("spire", 200.0, true),
            ev("lair", 220.0, true),
        ],
    };
    let two = muta_def("2hatch", 2);
    assert!(!matches(&two, &p, Some('T')));
}

#[test]
fn by_start_of_missing_anchor_fails_closed() {
    let h = Have {
        by_start_of: Some("spire".into()),
        ..Have::of("hatchery")
    };
    // no spire in this timeline
    let events = vec![ev("hatchery", 0.0, false), ev("hatchery", 60.0, true)];
    assert!(!eval_have(&h, &events));
}

#[test]
fn parse_mmss_works() {
    assert_eq!(parse_mmss("2:49"), Some(169.0));
    assert_eq!(parse_mmss("0:07"), Some(7.0));
    assert_eq!(parse_mmss("nope"), None);
}

#[test]
fn strict_order_is_a_prefix() {
    let steps = vec![
        Step::One("barracks".into()),
        Step::One("barracks".into()),
        Step::One("supply_depot".into()),
    ];
    // BBS: rax, rax, depot as the first three (synthetic CC ignored).
    let bbs = vec![
        ev("command_center", 0.0, false),
        ev("barracks", 60.0, true),
        ev("barracks", 75.0, true),
        ev("supply_depot", 90.0, true),
        ev("refinery", 120.0, true),
    ];
    assert!(eval_order(&steps, &bbs, true, false, false));
    // Depot first breaks a strict prefix.
    let depot_first = vec![
        ev("supply_depot", 50.0, true),
        ev("barracks", 60.0, true),
        ev("barracks", 75.0, true),
    ];
    assert!(!eval_order(&steps, &depot_first, true, false, false));
    // A building wedged between the two rax breaks strict, but loose (a
    // subsequence) still matches it.
    let interrupted = vec![
        ev("barracks", 60.0, true),
        ev("refinery", 65.0, true),
        ev("barracks", 75.0, true),
        ev("supply_depot", 90.0, true),
    ];
    assert!(!eval_order(&steps, &interrupted, true, false, false));
    assert!(eval_order(&steps, &interrupted, false, false, false));
}

/// A produced-unit event (Category::Unit).
fn evu(slug: &'static str, secs: f64) -> Event {
    let mut e = ev(slug, secs, true);
    e.category = Category::Unit;
    e
}

#[test]
fn units_only_join_an_order_when_named() {
    // Marines popping between the two barracks must NOT break BBS.
    let bbs = vec![
        ev("barracks", 60.0, true),
        evu("marine", 65.0),
        ev("barracks", 75.0, true),
        evu("marine", 80.0),
        ev("supply_depot", 90.0, true),
    ];
    let steps = vec![
        Step::One("barracks".into()),
        Step::One("barracks".into()),
        Step::One("supply_depot".into()),
    ];
    assert!(eval_order(&steps, &bbs, true, false, false));

    // But a pattern that names a unit can match on it.
    let valk = vec![
        ev("barracks", 60.0, true),
        ev("factory", 120.0, true),
        ev("starport", 200.0, true),
        evu("valkyrie", 320.0),
    ];
    let with_unit = vec![
        Step::One("factory".into()),
        Step::One("starport".into()),
        Step::One("valkyrie".into()),
    ];
    assert!(eval_order(&with_unit, &valk, false, false, false));
    // ...and fails when that unit never appears.
    let no_valk = &valk[..3];
    assert!(!eval_order(&with_unit, no_valk, false, false, false));
}

#[test]
fn ignore_supply_providers_skips_pylons_in_strict_order() {
    // A pylon built between the two gateways breaks a strict [gate, gate].
    let with_pylon = vec![
        ev("pylon", 40.0, true),
        ev("gateway", 60.0, true),
        ev("pylon", 70.0, true),
        ev("gateway", 90.0, true),
    ];
    let two_gate = vec![Step::One("gateway".into()), Step::One("gateway".into())];
    assert!(!eval_order(&two_gate, &with_pylon, true, false, false));
    // With ignore_supply_providers the pylons drop out, so the two gates are adjacent.
    assert!(eval_order(&two_gate, &with_pylon, true, false, true));
}

#[test]
fn include_start_folds_in_the_initial_hatch() {
    // A player who BUILT one hatch then a spire has two hatcheries total
    // (main + the built one).
    let two_base = vec![
        ev("hatchery", 0.0, false), // the free starting hatch
        ev("hatchery", 60.0, true), // the natural
        ev("spire", 120.0, true),
    ];
    let three = vec![
        Step::One("hatchery".into()),
        Step::One("hatchery".into()),
        Step::One("spire".into()),
    ];
    // Without the start, only one hatchery is "built", so a 3-hatchery
    // strict pattern can't match.
    assert!(!eval_order(&three, &two_base, true, false, false));
    // Folding the initial hatch in, the strict sequence is
    // start-hatch, built-hatch, spire — exactly three counting the main.
    assert!(eval_order(&three, &two_base, true, true, false));
}

/// Every shipped definition parses (unknown fields rejected) and passes the
/// slug / time / shape checks the sandbox also shows contributors.
#[test]
fn shipped_defs_are_clean() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../defs");
    let defs = load_defs(&dir).expect("defs load");
    assert!(defs.len() >= 13, "found {} defs", defs.len());
    let mut ids = std::collections::HashSet::new();
    for d in &defs {
        assert!(ids.insert(d.id.clone()), "duplicate id {}", d.id);
        assert!(d.problems().is_empty(), "{}: {:?}", d.id, d.problems());
    }
}

#[test]
fn typo_fields_are_rejected() {
    let bad = r#"{"id":"x","name":"x","race":"Z","when":[{"have":{"what":"spire","by_start":"lair"}}]}"#;
    assert!(BuildDef::parse(bad).is_err());
}

#[test]
fn unknown_slug_is_reported() {
    let d = BuildDef::parse(r#"{"id":"x","name":"x","race":"Z","when":[{"order":["spawningpool"]}]}"#).unwrap();
    assert_eq!(d.problems().len(), 1);
}

#[test]
fn explain_points_at_the_failing_step() {
    let p = two_hatch_muta();
    let steps = vec![Step::One("lair".into()), Step::One("hydralisk_den".into()), Step::One("spire".into())];
    let r = explain_order(&steps, &p.events, false, false, false);
    assert!(!r.passed);
    assert!(matches!(r.steps[0].status, StepStatus::Matched));
    assert!(matches!(r.steps[1].status, StepStatus::Failed));
    assert!(matches!(r.steps[2].status, StepStatus::NotReached));
    assert!(r.steps[1].detail.as_deref().unwrap().contains("after lair at 2:55"));
}

#[test]
fn explain_have_lists_excluded_candidates() {
    let p = two_and_half_hatch_muta();
    let h = Have { op: Op::Eq, count: 2, by_start_of: Some("lair".into()), ..Have::of("hatchery") };
    let r = explain_have(&h, &p.events);
    assert!(r.passed);
    assert_eq!(r.actual, 2);
    assert_eq!(r.candidates.len(), 3);
    assert_eq!(r.candidates[2].excluded_by.as_deref(), Some("after lair started"));
}
