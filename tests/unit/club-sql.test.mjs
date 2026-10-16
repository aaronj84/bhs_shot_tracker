import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = readFileSync(
  path.join(ROOT, "supabase/migrations/20261016180000_club_visitation.sql"),
  "utf8"
);

let db;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.players (
      id uuid primary key default gen_random_uuid(),
      name text,
      short_name text
    );
  `);
  await db.exec(MIGRATION);
  await db.exec(`
    insert into public.players (id, name, short_name) values
      ('11111111-1111-4111-8111-111111111111', 'Susie Demo', 'Susie'),
      ('22222222-2222-4222-8222-222222222222', 'Jackie Demo', 'Jackie'),
      ('33333333-3333-4333-8333-333333333333', 'Other Demo', 'Other');
  `);
});

describe("club visitation SQL", () => {
  it("stores opponent teams with zero Brighton players and both-sides affiliations", async () => {
    await db.exec(`
      insert into public.club_teams (id, organization_name, team_name) values
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Club A', 'Team A'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Club B', 'Team B'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'Opp C', 'Team C');
      insert into public.club_player_affiliations (player_id, club_team_id, active) values
        ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true),
        ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true),
        ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', true);
      insert into public.club_facilities (id, name, city) values
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'RAC', 'South Jordan');
      insert into public.club_fields (id, club_facility_id, label) values
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc5', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Field 5'),
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc7', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Field 7');
    `);

    // same team, one game vs opponent with no Brighton players
    await db.exec(`
      insert into public.club_games (id, home_team_id, away_team_id, kickoff_at, status, club_facility_id, club_field_id)
      values (
        'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        '2026-04-11 16:00:00-06',
        'scheduled',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc5'
      );
    `);

    const { rows: oneSide } = await db.query(
      `select brighton_player_count, brighton_both_sides,
              jsonb_array_length(home_brighton_players) as home_n,
              jsonb_array_length(away_brighton_players) as away_n
       from public.v_club_game_brighton where club_game_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'`
    );
    expect(oneSide[0].brighton_player_count).toBe(2);
    expect(oneSide[0].brighton_both_sides).toBe(false);
    expect(oneSide[0].home_n).toBe(2);
    expect(oneSide[0].away_n).toBe(0);

    // Brighton vs Brighton
    await db.exec(`
      insert into public.club_games (id, home_team_id, away_team_id, kickoff_at, status, club_facility_id, club_field_id)
      values (
        'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        '2026-04-12 10:00:00-06',
        'scheduled',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc7'
      );
    `);
    const { rows: both } = await db.query(
      `select brighton_both_sides, brighton_player_count from public.v_club_game_brighton
       where club_game_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'`
    );
    expect(both[0].brighton_both_sides).toBe(true);
    expect(both[0].brighton_player_count).toBe(3);
  });

  it("rejects field belonging to a different facility", async () => {
    await db.exec(`
      insert into public.club_facilities (id, name) values
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Other Complex');
      insert into public.club_fields (id, club_facility_id, label) values
        ('cccccccc-cccc-4ccc-8ccc-cccccccccc99', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Field 1');
    `);
    let failed = false;
    try {
      await db.exec(`
        insert into public.club_games (home_team_id, away_team_id, club_facility_id, club_field_id, status)
        values (
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          'cccccccc-cccc-4ccc-8ccc-cccccccccc99',
          'scheduled'
        );
      `);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("supports three competitions/sources for one team and shared itineraries without owner", async () => {
    await db.exec(`
      insert into public.club_competitions (id, name, competition_type) values
        ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'League', 'league'),
        ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', 'Invite', 'invitational'),
        ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', 'Cup', 'tournament');
      insert into public.club_team_competitions (id, club_team_id, club_competition_id) values
        ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'),
        ('ffffffff-ffff-4fff-8fff-fffffffffff2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'),
        ('ffffffff-ffff-4fff-8fff-fffffffffff3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3');
      insert into public.club_schedule_sources (club_team_competition_id, source_url, provider) values
        ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'https://example.test/a.ics', 'ics'),
        ('ffffffff-ffff-4fff-8fff-fffffffffff2', 'https://example.test/b.csv', 'csv'),
        ('ffffffff-ffff-4fff-8fff-fffffffffff3', 'https://example.test/c.json', 'json');
      insert into public.club_itineraries (id, name, target_date) values
        ('99999999-9999-4999-8999-999999999999', 'Saturday North Valley', '2026-04-11');
      insert into public.club_itinerary_stops (club_itinerary_id, club_game_id, stop_order) values
        ('99999999-9999-4999-8999-999999999999', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 1),
        ('99999999-9999-4999-8999-999999999999', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 2);
    `);
    const { rows: src } = await db.query(
      `select count(*)::int as n from club_schedule_sources s
       join club_team_competitions tc on tc.id = s.club_team_competition_id
       where tc.club_team_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`
    );
    expect(src[0].n).toBe(3);
    const { rows: stops } = await db.query(
      `select count(*)::int as n from club_itinerary_stops where club_itinerary_id = '99999999-9999-4999-8999-999999999999'`
    );
    expect(stops[0].n).toBe(2);
  });

  it("logs game changes with conflict review status", async () => {
    await db.exec(`
      insert into public.club_sync_runs (id, club_schedule_source_id, result)
      select 'aaaa1111-1111-4111-8111-111111111111', id, 'ok' from club_schedule_sources limit 1;
      insert into public.club_game_changes (club_game_id, changed_fields, old_values, new_values, review_status)
      values (
        'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        array['kickoff_at'],
        '{"kickoff_at":"old"}'::jsonb,
        '{"kickoff_at":"new"}'::jsonb,
        'conflict'
      );
    `);
    const { rows } = await db.query(
      `select review_status from club_game_changes where club_game_id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'`
    );
    expect(rows[0].review_status).toBe("conflict");
  });
});
