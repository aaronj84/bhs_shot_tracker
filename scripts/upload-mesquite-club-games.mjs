#!/usr/bin/env node
/**
 * Load the Nov 5–7 2026 Mesquite club games (GotSport team schedules).
 *
 * Tracked teams: Cottonwood FC G0910 Red BD, G1011 Red ND, G1011 Red TT,
 * and Utah Rio FC U16G DH. Opponents are created so each fixture has both
 * sides. Re-running is safe: rows are matched by name or GotSport game id.
 * Games a coach has marked verified are left alone.
 *
 * Preview the parsed sheet (no database):
 *   node scripts/upload-mesquite-club-games.mjs --print
 *
 * Dry-run against a project (reads, does not write):
 *   SHOTS_SUPABASE_URL=... SHOTS_SUPABASE_ANON_KEY=... \
 *     node scripts/upload-mesquite-club-games.mjs
 *
 * After the club migration is on PROD:
 *   SHOTS_SUPABASE_URL=https://sczdnalqmymhdornhkbn.supabase.co \
 *   SHOTS_SUPABASE_ANON_KEY=<prod anon key> \
 *     node scripts/upload-mesquite-club-games.mjs --allow-prod --apply
 *
 * Point the URL at DEV and pass --apply to rehearse before production.
 * Utah Rio FC U16G DH is tracked through a club player named "Utah Rio".
 */

import { createClient } from "@supabase/supabase-js";

const PROD_REF = "sczdnalqmymhdornhkbn";
const TZ = "America/Los_Angeles";
// Nov 1 2026 is the first Sunday, so this weekend is Pacific Standard Time.
const OFFSET = "-08:00";
const SEASON = "Fall 2026";
const SOURCE = "mesquite-nov-2026-upload";

const COMPETITION = {
  name: "Mesquite U16/17 Girls, Nov 2026",
  competition_type: "tournament",
  season_year: 2026,
  starts_on: "2026-11-05",
  ends_on: "2026-11-07",
  status: "active",
};

const FACILITIES = [
  {
    name: "Mesquite Regional Sports and Event Complex",
    street_address: "1635 World Champion Way",
    city: "Mesquite",
    state: "NV",
    postal_code: "89027",
    timezone: TZ,
    latitude: 36.822509,
    longitude: -114.131119,
    aliases: ["Mesquite Sports and Events Complex", "Mesquite Sports & Event Complex"],
    fields: ["Field 2", "Field 4", "Field 5"],
  },
  {
    name: "Mesquite Recreation Center",
    street_address: "100 W Old Mill Road",
    city: "Mesquite",
    state: "NV",
    postal_code: "89027",
    timezone: TZ,
    latitude: 36.808609,
    longitude: -114.070221,
    aliases: ["Mesquite Rec Center"],
    fields: ["Field 7"],
  },
];

/**
 * `players` are club-roster names. A shot-tracker link is added only when
 * public.players has that exact name.
 */
const TEAMS = [
  {
    teamName: "Cottonwood FC G0910 Red BD",
    organizationName: "Cottonwood FC",
    ageGroup: "U16/U17",
    genderDivision: "Girls",
    aliases: ["G0910 Red BD", "CFC G10 Red BD"],
    tracked: true,
    players: ["Svea Johnson", "Claire Wood", "Jane Erickson", "Eden Morgan", "Vienna Holtby"],
  },
  {
    teamName: "Cottonwood FC G1011 Red ND",
    organizationName: "Cottonwood FC",
    ageGroup: "U16/U17",
    genderDivision: "Girls",
    aliases: ["G1011 Red ND"],
    notes: "GotSport team 0131-01ADG16-0037",
    tracked: true,
    players: ["Abigail Platz", "Zoey Henderson", "Avery Tait", "Myken Menlove"],
  },
  {
    teamName: "Cottonwood FC G1011 Red TT",
    organizationName: "Cottonwood FC",
    ageGroup: "U16/U17",
    genderDivision: "Girls",
    aliases: ["G1011 Red TT"],
    notes: "GotSport team 0131-01ADG16-0038",
    tracked: true,
    players: [
      "Kali-Shea Rodgers",
      "Lizzie Fawson",
      "Lucy Ingebrigtsen",
      "Mehana Larson",
      "Samantha Smith",
      "Sarah Fowles",
    ],
  },
  {
    teamName: "Utah Rio FC U16G DH",
    organizationName: "Utah Rio FC",
    ageGroup: "U16",
    genderDivision: "Girls",
    aliases: ["Utah Rio"],
    tracked: true,
    players: ["Utah Rio"],
  },
  {
    teamName: "Peak SC 2011G TH",
    organizationName: "Peak SC",
    ageGroup: "U16",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "VIPERS N1 10/11G-CB",
    organizationName: "VIPERS",
    ageGroup: "U16/U17",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "Copper Mountain 11 SB",
    organizationName: "Copper Mountain",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "FireFC U16g ZH",
    organizationName: "FireFC",
    ageGroup: "U16",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "Metasport FC 09/10G U17 RH (SFC)",
    organizationName: "Metasport FC",
    ageGroup: "U17",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "Shooters SC U16 Atwood",
    organizationName: "Shooters SC",
    ageGroup: "U16",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "ALBION SC Utah GU16 Academy",
    organizationName: "ALBION SC",
    ageGroup: "U16",
    genderDivision: "Girls",
    players: [],
  },
  {
    teamName: "SSFC Valkyrie U17 KS",
    organizationName: "SSFC",
    ageGroup: "U17",
    genderDivision: "Girls",
    players: [],
  },
];

const COMPLEX = "Mesquite Regional Sports and Event Complex";
const REC = "Mesquite Recreation Center";

function fixture(row) {
  return {
    externalId: `gotsport:${row.id}`,
    gotSportId: row.id,
    round: row.round,
    kickoffAt: `${row.date}T${row.time}:00${OFFSET}`,
    dayLabel: row.day,
    timeLabel: row.clock,
    facility: row.facility,
    field: `Field ${row.field}`,
    home: row.home || null,
    away: row.away || null,
    rawHome: row.rawHome || null,
    rawAway: row.rawAway || null,
    status: row.status || "scheduled",
  };
}

const GAMES = [
  fixture({
    id: "629638",
    round: "U16/17 Girls A",
    date: "2026-11-05",
    time: "20:10",
    day: "Thu Nov 5",
    clock: "8:10 PM",
    facility: COMPLEX,
    field: "2",
    home: "Peak SC 2011G TH",
    away: "Cottonwood FC G0910 Red BD",
  }),
  fixture({
    id: "629637",
    round: "U16/17 Girls A",
    date: "2026-11-05",
    time: "20:10",
    day: "Thu Nov 5",
    clock: "8:10 PM",
    facility: REC,
    field: "7",
    home: "VIPERS N1 10/11G-CB",
    away: "Utah Rio FC U16G DH",
  }),
  fixture({
    id: "629761",
    round: "G1011 Red TT",
    date: "2026-11-06",
    time: "08:30",
    day: "Fri Nov 6",
    clock: "8:30 AM",
    facility: COMPLEX,
    field: "2",
    home: "Copper Mountain 11 SB",
    away: "Cottonwood FC G1011 Red TT",
  }),
  fixture({
    id: "787566",
    round: "U16/17 Girls C",
    date: "2026-11-06",
    time: "11:10",
    day: "Fri Nov 6",
    clock: "11:10 AM",
    facility: COMPLEX,
    field: "2",
    home: "Cottonwood FC G1011 Red ND",
    away: "Shooters SC U16 Atwood",
  }),
  fixture({
    id: "629635",
    round: "U16/17 Girls A",
    date: "2026-11-06",
    time: "13:50",
    day: "Fri Nov 6",
    clock: "1:50 PM",
    facility: COMPLEX,
    field: "4",
    home: "Utah Rio FC U16G DH",
    away: "Cottonwood FC G0910 Red BD",
  }),
  fixture({
    id: "629763",
    round: "G1011 Red TT",
    date: "2026-11-06",
    time: "16:30",
    day: "Fri Nov 6",
    clock: "4:30 PM",
    facility: REC,
    field: "7",
    home: "Cottonwood FC G1011 Red TT",
    away: "FireFC U16g ZH",
  }),
  fixture({
    id: "629633",
    round: "U16/17 Girls A",
    date: "2026-11-06",
    time: "19:10",
    day: "Fri Nov 6",
    clock: "7:10 PM",
    facility: COMPLEX,
    field: "4",
    home: "Peak SC 2011G TH",
    away: "Utah Rio FC U16G DH",
  }),
  fixture({
    id: "629634",
    round: "U16/17 Girls A",
    date: "2026-11-06",
    time: "19:10",
    day: "Fri Nov 6",
    clock: "7:10 PM",
    facility: COMPLEX,
    field: "5",
    home: "Cottonwood FC G0910 Red BD",
    away: "VIPERS N1 10/11G-CB",
  }),
  fixture({
    id: "787561",
    round: "U16/17 Girls C",
    date: "2026-11-06",
    time: "20:30",
    day: "Fri Nov 6",
    clock: "8:30 PM",
    facility: COMPLEX,
    field: "2",
    home: "Cottonwood FC G1011 Red ND",
    away: "ALBION SC Utah GU16 Academy",
  }),
  fixture({
    id: "629765",
    round: "G1011 Red TT",
    date: "2026-11-07",
    time: "09:20",
    day: "Sat Nov 7",
    clock: "9:20 AM",
    facility: COMPLEX,
    field: "2",
    home: "Metasport FC 09/10G U17 RH (SFC)",
    away: "Cottonwood FC G1011 Red TT",
  }),
  fixture({
    id: "787564",
    round: "U16/17 Girls C",
    date: "2026-11-07",
    time: "10:40",
    day: "Sat Nov 7",
    clock: "10:40 AM",
    facility: REC,
    field: "7",
    home: "SSFC Valkyrie U17 KS",
    away: "Cottonwood FC G1011 Red ND",
  }),
  fixture({
    id: "629731",
    round: "U16/17 Girls A Final",
    date: "2026-11-07",
    time: "15:20",
    day: "Sat Nov 7",
    clock: "3:20 PM",
    facility: COMPLEX,
    field: "5",
    rawHome: "1st of A",
    rawAway: "2nd of A",
    status: "tbd",
  }),
];

const NOT_LOADED = [
  {
    gotSportId: "629636",
    when: "Fri Nov 6 · 1:50 PM · Field 2 · Mesquite Regional Sports and Event Complex",
    reason: "VIPERS N1 10/11G-CB vs Peak SC 2011G TH — neither side is a tracked team",
  },
];

const SHORT_NAMES = {
  "Abigail Platz": "Abby",
  "Utah Rio": "Utah Rio",
};

function shortName(name) {
  return SHORT_NAMES[name] || name.split(/\s+/)[0];
}

function teamByName(name) {
  return TEAMS.find((t) => t.teamName === name) || null;
}

function playersFor(teamName) {
  return teamByName(teamName)?.players || [];
}

function validateCatalog() {
  const problems = [];
  const teamNames = new Set(TEAMS.map((t) => t.teamName));
  if (teamNames.size !== TEAMS.length) problems.push("Duplicate team name in catalog");
  const facilityNames = new Set(FACILITIES.map((f) => f.name));
  const fields = new Set(FACILITIES.flatMap((f) => f.fields.map((label) => `${f.name}::${label}`)));
  const ids = new Set();
  for (const game of GAMES) {
    if (ids.has(game.externalId)) problems.push(`Duplicate game id ${game.externalId}`);
    ids.add(game.externalId);
    if (Number.isNaN(new Date(game.kickoffAt).getTime())) {
      problems.push(`Bad kickoff ${game.externalId}`);
    }
    if (!facilityNames.has(game.facility)) problems.push(`Unknown facility on ${game.gotSportId}`);
    if (!fields.has(`${game.facility}::${game.field}`)) {
      problems.push(`Unknown field ${game.field} on ${game.gotSportId}`);
    }
    for (const side of [game.home, game.away]) {
      if (side && !teamNames.has(side)) problems.push(`Unknown team "${side}" on ${game.gotSportId}`);
    }
    if (!game.home && !game.rawHome) problems.push(`Game ${game.gotSportId} has no home side`);
    if (!game.away && !game.rawAway) problems.push(`Game ${game.gotSportId} has no away side`);
  }
  for (const team of TEAMS.filter((t) => t.tracked)) {
    if (!team.players.length) problems.push(`${team.teamName} has no players`);
    const plays = GAMES.some((g) => g.home === team.teamName || g.away === team.teamName);
    if (!plays) problems.push(`${team.teamName} has no games`);
  }
  return problems;
}

function printSchedule() {
  console.log(`${COMPETITION.name}`);
  console.log("Kickoffs are Pacific Standard Time (Mesquite).");
  console.log("");
  let day = "";
  for (const game of GAMES) {
    if (game.dayLabel !== day) {
      day = game.dayLabel;
      console.log(day);
    }
    const home = game.home || game.rawHome;
    const away = game.away || game.rawAway;
    const players = [...playersFor(game.home), ...playersFor(game.away)];
    console.log(`  ${game.timeLabel}  ${game.field}  ${game.facility}`);
    console.log(`         ${home} vs ${away}`);
    console.log(`         ${game.round} · GotSport ${game.gotSportId}${game.status === "tbd" ? " · teams TBD" : ""}`);
    if (players.length) console.log(`         ${players.join(", ")}`);
    console.log("");
  }
  console.log("Not loaded:");
  for (const row of NOT_LOADED) console.log(`  GotSport ${row.gotSportId} · ${row.when}`);
  console.log(`  ${NOT_LOADED[0].reason}`);
}

function parseArgs(argv) {
  const flags = { print: false, apply: false, allowProd: false, help: false };
  for (const arg of argv) {
    if (arg === "--print") flags.print = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--allow-prod") flags.allowProd = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return flags;
}

function projectRef(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

function unwrap(result, label) {
  if (result.error) {
    const msg = result.error.message || String(result.error);
    const missing = /schema cache|does not exist|club_/i.test(msg);
    const hint = missing ? " Club tables are missing. Migrate this project, then re-run." : "";
    throw new Error(`${label}: ${msg}.${hint}`);
  }
  return result.data;
}

async function findRows(sb, table, column, value, label) {
  const data = unwrap(await sb.from(table).select("*").eq(column, value), label);
  return data || [];
}

async function connect(url, anonKey) {
  // Node 20 has no global WebSocket. Realtime is unused here.
  if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = class NoopWebSocket {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    };
  }
  const sb = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: globalThis.WebSocket },
  });
  const { error } = await sb.auth.signInAnonymously();
  if (error) {
    throw new Error(
      `Anonymous sign-in failed: ${error.message}. The club tables allow writes for an authenticated session.`
    );
  }
  return sb;
}

async function ensureFacility(sb, facility, apply, log) {
  const rows = await findRows(sb, "club_facilities", "name", facility.name, facility.name);
  if (rows.length > 1) throw new Error(`Multiple facilities named ${facility.name}`);
  if (rows.length === 1) {
    log(`facility exists  ${facility.name}`);
    return rows[0].id;
  }
  log(`facility insert  ${facility.name}`);
  if (!apply) return null;
  const inserted = unwrap(
    await sb
      .from("club_facilities")
      .insert({
        name: facility.name,
        street_address: facility.street_address,
        city: facility.city,
        state: facility.state,
        postal_code: facility.postal_code,
        timezone: facility.timezone,
        latitude: facility.latitude,
        longitude: facility.longitude,
        aliases: facility.aliases,
        geocode_status: "manual",
        maps_url: `https://maps.google.com/?q=${facility.latitude},${facility.longitude}`,
      })
      .select("id")
      .single(),
    facility.name
  );
  return inserted.id;
}

async function ensureField(sb, facilityId, label, apply, log) {
  if (!facilityId) {
    log(`field insert    ${label}`);
    return null;
  }
  const data = unwrap(
    await sb.from("club_fields").select("id").eq("club_facility_id", facilityId).eq("label", label),
    label
  );
  if ((data || []).length > 1) throw new Error(`Multiple fields ${label}`);
  if (data?.length === 1) {
    log(`field exists    ${label}`);
    return data[0].id;
  }
  log(`field insert    ${label}`);
  if (!apply) return null;
  const inserted = unwrap(
    await sb.from("club_fields").insert({ club_facility_id: facilityId, label }).select("id").single(),
    label
  );
  return inserted.id;
}

async function ensureTeam(sb, team, apply, log) {
  const rows = await findRows(sb, "club_teams", "team_name", team.teamName, team.teamName);
  if (rows.length > 1) throw new Error(`Multiple teams named ${team.teamName}`);
  if (rows.length === 1) {
    log(`team exists     ${team.teamName}`);
    return rows[0].id;
  }
  log(`team insert     ${team.teamName}`);
  if (!apply) return null;
  const inserted = unwrap(
    await sb
      .from("club_teams")
      .insert({
        organization_name: team.organizationName || "",
        team_name: team.teamName,
        age_group: team.ageGroup || null,
        gender_division: team.genderDivision || null,
        aliases: team.aliases || [],
        notes: team.notes || null,
        active: true,
      })
      .select("id")
      .single(),
    team.teamName
  );
  return inserted.id;
}

async function ensureCompetition(sb, apply, log) {
  const rows = await findRows(sb, "club_competitions", "name", COMPETITION.name, COMPETITION.name);
  if (rows.length > 1) throw new Error(`Multiple competitions named ${COMPETITION.name}`);
  if (rows.length === 1) {
    log(`competition exists  ${COMPETITION.name}`);
    return rows[0].id;
  }
  log(`competition insert  ${COMPETITION.name}`);
  if (!apply) return null;
  const inserted = unwrap(
    await sb.from("club_competitions").insert(COMPETITION).select("id").single(),
    COMPETITION.name
  );
  return inserted.id;
}

async function ensureEnrollment(sb, teamId, competitionId, teamName, apply, log) {
  if (!teamId || !competitionId) {
    log(`enroll insert   ${teamName}`);
    return;
  }
  const data = unwrap(
    await sb
      .from("club_team_competitions")
      .select("id")
      .eq("club_team_id", teamId)
      .eq("club_competition_id", competitionId),
    `enrollment ${teamName}`
  );
  if (data?.length) {
    log(`enroll exists   ${teamName}`);
    return;
  }
  log(`enroll insert   ${teamName}`);
  if (!apply) return;
  unwrap(
    await sb.from("club_team_competitions").insert({
      club_team_id: teamId,
      club_competition_id: competitionId,
    }),
    `enrollment ${teamName}`
  );
}

async function ensurePlayer(sb, name, apply, log) {
  const rows = await findRows(sb, "club_players", "name", name, name);
  if (rows.length > 1) throw new Error(`Multiple club players named ${name}`);
  let clubPlayerId = rows[0]?.id || null;
  if (clubPlayerId) log(`player exists   ${name}`);
  else {
    log(`player insert   ${name}`);
    if (apply) {
      const inserted = unwrap(
        await sb.from("club_players").insert({ name, short_name: shortName(name) }).select("id").single(),
        name
      );
      clubPlayerId = inserted.id;
    }
  }
  return clubPlayerId;
}

async function ensureLink(sb, name, clubPlayerId, apply, log) {
  const roster = await findRows(sb, "players", "name", name, `roster ${name}`);
  if (roster.length === 0) {
    log(`link none       ${name} (no shot-tracker row with this exact name)`);
    return;
  }
  if (roster.length > 1) {
    log(`link skip       ${name} (${roster.length} shot-tracker rows)`);
    return;
  }
  const playerId = roster[0].id;
  if (!clubPlayerId) {
    log(`link insert     ${name} → shot tracker`);
    return;
  }
  const existing = unwrap(
    await sb
      .from("club_player_links")
      .select("id, player_id, club_player_id")
      .or(`player_id.eq.${playerId},club_player_id.eq.${clubPlayerId}`),
    `link ${name}`
  );
  if ((existing || []).some((row) => row.player_id === playerId && row.club_player_id === clubPlayerId)) {
    log(`link exists     ${name}`);
    return;
  }
  if (existing?.length) {
    log(`link skip       ${name} (already linked to someone else)`);
    return;
  }
  log(`link insert     ${name} → shot tracker`);
  if (!apply) return;
  unwrap(
    await sb.from("club_player_links").insert({ player_id: playerId, club_player_id: clubPlayerId }),
    `link ${name}`
  );
}

async function ensureAffiliation(sb, clubPlayerId, teamId, playerName, teamName, apply, log) {
  if (!clubPlayerId || !teamId) {
    log(`affiliation insert  ${playerName} → ${teamName}`);
    return;
  }
  const data = unwrap(
    await sb
      .from("club_player_affiliations")
      .select("id")
      .eq("club_player_id", clubPlayerId)
      .eq("club_team_id", teamId)
      .eq("active", true),
    `affiliation ${playerName}`
  );
  if (data?.length) {
    log(`affiliation exists  ${playerName} → ${teamName}`);
    return;
  }
  log(`affiliation insert  ${playerName} → ${teamName}`);
  if (!apply) return;
  unwrap(
    await sb.from("club_player_affiliations").insert({
      club_player_id: clubPlayerId,
      club_team_id: teamId,
      active: true,
      season_label: SEASON,
    }),
    `affiliation ${playerName}`
  );
}

function gamePatch(game, ids, existing) {
  const patch = {
    club_competition_id: ids.competitionId,
    kickoff_at: game.kickoffAt,
    kickoff_timezone: TZ,
    club_facility_id: ids.facilityId,
    club_field_id: ids.fieldId,
    round_title: game.round,
    source_attribution: SOURCE,
    external_fixture_key: game.externalId,
    last_seen_at: new Date().toISOString(),
  };
  if (ids.homeId) {
    patch.home_team_id = ids.homeId;
    patch.raw_home_label = null;
  } else if (!existing?.home_team_id) {
    patch.raw_home_label = game.rawHome;
  }
  if (ids.awayId) {
    patch.away_team_id = ids.awayId;
    patch.raw_away_label = null;
  } else if (!existing?.away_team_id) {
    patch.raw_away_label = game.rawAway;
  }
  const teamsFilled = existing?.home_team_id && existing?.away_team_id;
  if (!(game.status === "tbd" && teamsFilled)) patch.status = game.status;
  return patch;
}

async function ensureGame(sb, game, ids, apply, log) {
  const label = `${game.gotSportId} ${game.home || game.rawHome} vs ${game.away || game.rawAway}`;
  const rows = await findRows(sb, "club_games", "external_fixture_key", game.externalId, label);
  if (rows.length > 1) throw new Error(`Multiple games for ${game.externalId}`);
  const existing = rows[0];
  if (existing?.coach_verified_at) {
    log(`game skip       ${label} (coach verified)`);
    return;
  }
  const patch = gamePatch(game, ids, existing);
  if (!existing) {
    log(`game insert     ${label}`);
    if (!apply) return;
    unwrap(await sb.from("club_games").insert(patch), label);
    return;
  }
  log(`game update     ${label}`);
  if (!apply) return;
  unwrap(await sb.from("club_games").update(patch).eq("id", existing.id), label);
}

async function upload(sb, apply) {
  const log = (line) => console.log(line);
  const facilityIds = new Map();
  const fieldIds = new Map();
  for (const facility of FACILITIES) {
    const facilityId = await ensureFacility(sb, facility, apply, log);
    facilityIds.set(facility.name, facilityId);
    for (const label of facility.fields) {
      const fieldId = await ensureField(sb, facilityId, label, apply, log);
      fieldIds.set(`${facility.name}::${label}`, fieldId);
    }
  }

  const competitionId = await ensureCompetition(sb, apply, log);
  const teamIds = new Map();
  for (const team of TEAMS) {
    teamIds.set(team.teamName, await ensureTeam(sb, team, apply, log));
  }
  for (const team of TEAMS) {
    if (!GAMES.some((g) => g.home === team.teamName || g.away === team.teamName)) continue;
    await ensureEnrollment(sb, teamIds.get(team.teamName), competitionId, team.teamName, apply, log);
  }

  for (const team of TEAMS) {
    const teamId = teamIds.get(team.teamName);
    for (const name of team.players) {
      const clubPlayerId = await ensurePlayer(sb, name, apply, log);
      await ensureLink(sb, name, clubPlayerId, apply, log);
      await ensureAffiliation(sb, clubPlayerId, teamId, name, team.teamName, apply, log);
    }
  }

  for (const game of GAMES) {
    await ensureGame(
      sb,
      game,
      {
        competitionId,
        facilityId: facilityIds.get(game.facility),
        fieldId: fieldIds.get(`${game.facility}::${game.field}`),
        homeId: game.home ? teamIds.get(game.home) : null,
        awayId: game.away ? teamIds.get(game.away) : null,
      },
      apply,
      log
    );
  }
}

function printHelp() {
  console.log(`Usage: node scripts/upload-mesquite-club-games.mjs [options]

Options:
  --print        Print the schedule and exit. No database.
  --apply        Write rows. Default is a dry run.
  --allow-prod   Required with --apply when the URL is production.
  -h, --help     Show this help.

Env: SHOTS_SUPABASE_URL, SHOTS_SUPABASE_ANON_KEY
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }
  const problems = validateCatalog();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  if (flags.print && flags.apply) {
    console.error("Use either --print or --apply.");
    process.exit(1);
  }
  if (flags.print) {
    printSchedule();
    return;
  }

  const url = process.env.SHOTS_SUPABASE_URL || "";
  const anonKey = process.env.SHOTS_SUPABASE_ANON_KEY || "";
  if (!url || !anonKey) {
    console.error("SHOTS_SUPABASE_URL and SHOTS_SUPABASE_ANON_KEY are required.");
    console.error("Use --print to review the schedule without a database.");
    process.exit(1);
  }
  const ref = projectRef(url);
  const prod = ref === PROD_REF;
  if (prod && flags.apply && !flags.allowProd) {
    console.error(`Refusing to write to PROD (${ref}).`);
    console.error("After the club migration is applied, re-run with --allow-prod --apply.");
    process.exit(1);
  }
  console.log(`Target ${ref || url} (${prod ? "PROD" : "not PROD"}) — ${flags.apply ? "APPLY" : "dry run"}`);
  const sb = await connect(url, anonKey);
  try {
    await upload(sb, flags.apply);
  } finally {
    await sb.auth.signOut();
  }
  console.log(flags.apply ? "Wrote club games." : "Dry run. Re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
