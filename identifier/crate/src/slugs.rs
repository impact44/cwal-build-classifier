//! BW unit-type id -> stable snake_case slug. Mirrors cwal.gg's frontend
//! analysis maps and sciffer's units.dat. Ids we don't model return None and
//! are simply ignored.

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Building,
    Unit,
    Upgrade,
}

pub fn building_slug(id: u16) -> Option<&'static str> {
    Some(match id {
        // Terran
        106 => "command_center",
        107 => "comsat_station",
        108 => "nuclear_silo",
        109 => "supply_depot",
        110 => "refinery",
        111 => "barracks",
        112 => "academy",
        113 => "factory",
        114 => "starport",
        115 => "control_tower",
        116 => "science_facility",
        117 => "covert_ops",
        118 => "physics_lab",
        120 => "machine_shop",
        122 => "engineering_bay",
        123 => "armory",
        124 => "missile_turret",
        125 => "bunker",
        // Zerg
        131 => "hatchery",
        132 => "lair",
        133 => "hive",
        134 => "nydus_canal",
        135 => "hydralisk_den",
        136 => "defiler_mound",
        137 => "greater_spire",
        138 => "queens_nest",
        139 => "evolution_chamber",
        140 => "ultralisk_cavern",
        141 => "spire",
        142 => "spawning_pool",
        143 => "creep_colony",
        144 => "spore_colony",
        146 => "sunken_colony",
        149 => "extractor",
        // Protoss
        154 => "nexus",
        155 => "robotics_facility",
        156 => "pylon",
        157 => "assimilator",
        159 => "observatory",
        160 => "gateway",
        161 | 162 => "photon_cannon",
        163 => "citadel_of_adun",
        164 => "cybernetics_core",
        165 => "templar_archives",
        166 => "forge",
        167 => "stargate",
        169 => "fleet_beacon",
        170 => "arbiter_tribunal",
        171 => "robotics_support_bay",
        172 => "shield_battery",
        _ => return None,
    })
}

pub fn unit_slug(id: u16) -> Option<&'static str> {
    Some(match id {
        // Terran
        0 => "marine",
        1 => "ghost",
        2 => "vulture",
        3 => "goliath",
        5 | 30 => "siege_tank",
        7 => "scv",
        8 => "wraith",
        9 => "science_vessel",
        11 => "dropship",
        12 => "battlecruiser",
        32 => "firebat",
        34 => "medic",
        58 => "valkyrie",
        // Zerg
        37 => "zergling",
        38 => "hydralisk",
        39 => "ultralisk",
        41 => "drone",
        42 => "overlord",
        43 => "mutalisk",
        44 => "guardian",
        45 => "queen",
        46 => "defiler",
        47 => "scourge",
        62 => "devourer",
        103 => "lurker",
        // Protoss
        60 => "corsair",
        61 => "dark_templar",
        63 => "dark_archon",
        64 => "probe",
        65 => "zealot",
        66 => "dragoon",
        67 => "high_templar",
        68 => "archon",
        69 => "shuttle",
        70 => "scout",
        71 => "arbiter",
        72 => "carrier",
        83 => "reaver",
        84 => "observer",
        _ => return None,
    })
}

pub fn upgrade_slug(id: u8) -> Option<&'static str> {
    Some(match id {
        27 => "zergling_speed",  // Metabolic Boost
        28 => "zergling_attack", // Adrenal Glands
        29 => "hydralisk_speed", // Muscular Augments
        30 => "hydralisk_range", // Grooved Spines
        26 => "overlord_speed",  // Pneumatized Carapace
        33 => "dragoon_range",   // Singularity Charge
        34 => "zealot_speed",    // Leg Enhancements
        17 => "vulture_speed",   // Ion Thrusters
        _ => return None,
    })
}

/// The town hall a race begins the game with — added as a synthetic frame-0
/// event so base counts read as totals ("2 hatch" == two hatcheries) rather
/// than counts of *constructed* halls (which would be one fewer).
pub fn starting_base(race: char) -> Option<&'static str> {
    match race {
        'Z' => Some("hatchery"),
        'T' => Some("command_center"),
        'P' => Some("nexus"),
        _ => None,
    }
}

pub fn race_char(id: u8) -> Option<char> {
    match id {
        0 => Some('Z'),
        1 => Some('T'),
        2 => Some('P'),
        _ => None,
    }
}

/// Every slug a definition may reference (buildings, units, upgrades).
pub fn all() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = (0..=u16::MAX)
        .filter_map(|id| building_slug(id).or_else(|| unit_slug(id)))
        .chain((0..=u8::MAX).filter_map(upgrade_slug))
        .collect();
    v.sort_unstable();
    v.dedup();
    v
}

pub fn is_known(slug: &str) -> bool {
    (0..=255u16).any(|id| building_slug(id) == Some(slug) || unit_slug(id) == Some(slug))
        || (0..=u8::MAX).any(|id| upgrade_slug(id) == Some(slug))
}
