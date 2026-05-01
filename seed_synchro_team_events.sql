-- =============================================================
-- SAMPLE DATA — SYNCHRONISED & TEAM EVENTS
--
-- Adds on top of the bulk-* orgs created by
-- seed_bulk_test_data.sql:
--   - 20 synchronised pair events (11-judge panels, 5 rounds,
--     6 pairs each)
--   - 10 team events (5-judge panels, 5 rounds, 3 teams of 4
--     members each, members rotating round-by-round)
--   - Promotes 3 spectator-only users per bulk org to also hold
--     the 'judge' role so each org has 11 judges to fill a
--     synchro panel.
--
-- Prerequisites:
--   1. seed_bulk_test_data.sql has been run (creates bulk-*
--      orgs and their users)
--   2. migrations/004_event_types_and_synchro.sql has been run
--   3. migrations/005_teams.sql has been run
--
-- Run:
--   psql -d your_db_name -f seed_synchro_team_events.sql
--
-- Idempotent — reruns delete events in the 3001..3030 ID range
-- and any teams associated with them, then re-create.
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- Helpers (session-local)
-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.uuid_n(u uuid)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN substring(u::text from 25 for 12) ~ '^[0-9]+$'
             THEN substring(u::text from 25 for 12)::bigint
           ELSE NULL
         END
$$;

CREATE OR REPLACE FUNCTION pg_temp.snap_score(raw numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(0.0, LEAST(10.0, ROUND(raw * 2)::numeric / 2))::numeric(3,1)
$$;

-- Return a synchro-flavoured per-judge score:
--   judge_pos in 1..2/3 (or 1..3 for 11-panel) → exec for diver A
--   in 3..4/4..6 → exec for diver B
--   in 5..9/7..11 → synchronisation
-- All approximately 5–9 range, deterministic from the inputs so
-- reruns produce identical data.
CREATE OR REPLACE FUNCTION pg_temp.synchro_score(
    pair_skill numeric, judge_pos integer, round_num integer
) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.snap_score(
    6.5 + pair_skill
    -- judge bias by position
    + (((judge_pos * 13 + round_num * 7) % 5) - 2)::numeric * 0.15
    -- round trend
    - round_num * 0.05
  )
$$;

-- -------------------------------------------------------------
-- Cleanup any prior run.
-- Events 3001..3030 are owned by this seed; deleting them
-- cascades dive lists, scores, audit log entries, event_judges,
-- event_managers and event_teams. Teams 3001..3030 are tagged
-- the same way.
-- -------------------------------------------------------------
DELETE FROM events
 WHERE pg_temp.uuid_n(id) BETWEEN 3001 AND 3030;
DELETE FROM teams
 WHERE pg_temp.uuid_n(id) BETWEEN 3001 AND 3030;

-- -------------------------------------------------------------
-- Promote 3 spectator-only bulk users per org to also hold the
-- 'judge' role. Positions 47-49 within each org of 50.
-- ON CONFLICT DO NOTHING means rerunning is safe.
-- -------------------------------------------------------------
INSERT INTO user_org_roles (user_id, org_id, role)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    'judge'::org_role
FROM generate_series(1, 1000) AS n
WHERE ((n - 1) % 50) + 1 BETWEEN 47 AND 49
ON CONFLICT DO NOTHING;

-- =============================================================
-- 20 SYNCHRONISED PAIR EVENTS — 1 per bulk org
-- =============================================================
INSERT INTO events (id, org_id, name, gender, height, number_of_judges, total_rounds, status, event_type, created_at)
SELECT
    ('e0000000-0000-0000-0000-' || lpad((3000 + n)::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    (2024 + ((n - 1) / 10))::text || ' ' ||
    (ARRAY['USA','GBR','CAN','AUS','NZL','JPN','CHN','KOR','DEU','FRA',
           'ITA','ESP','BRA','MEX','ARG','RUS','UKR','ROU','SWE','NOR'])[n] ||
    ' Synchro ' ||
    (ARRAY['10m','3m'])[((n - 1) % 2) + 1],
    (ARRAY['Female','Male','Mixed'])[((n - 1) % 3) + 1]::event_gender,
    (ARRAY['10m','3m'])[((n - 1) % 2) + 1]::board_height,
    11,    -- World Aquatics 11-judge synchro panel
    5,
    'Completed'::event_status,
    'synchro_pair'::event_type,
    now() - interval '500 days' + (n * interval '14 days')
FROM generate_series(1, 20) AS n;

-- Synchro event managers: pick the first meet_manager in each org
INSERT INTO event_managers (event_id, user_id, added_by, added_at)
SELECT e.id, mgr.id, mgr.id, e.created_at
FROM events e
JOIN LATERAL (
    SELECT u.id FROM users u
    JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'meet_manager'
    WHERE u.org_id = e.org_id ORDER BY u.id LIMIT 1
) mgr ON true
WHERE pg_temp.uuid_n(e.id) BETWEEN 3001 AND 3020;

-- Synchro event judges: 11 per event from the host org
INSERT INTO event_judges (event_id, judge_id, judge_number)
SELECT event_id, judge_id, judge_number
FROM (
    SELECT
        e.id AS event_id,
        u.id AS judge_id,
        ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY u.id) AS judge_number
    FROM events e
    JOIN users u ON u.org_id = e.org_id
    JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'judge'
    WHERE pg_temp.uuid_n(e.id) BETWEEN 3001 AND 3020
) ranked
WHERE judge_number <= 11;

-- =============================================================
-- 10 TEAM EVENTS — distributed across bulk orgs 1..10
-- =============================================================
INSERT INTO events (id, org_id, name, gender, height, number_of_judges, total_rounds, status, event_type, created_at)
SELECT
    ('e0000000-0000-0000-0000-' || lpad((3020 + n)::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    (2024 + ((n - 1) / 5))::text || ' ' ||
    (ARRAY['USA','GBR','CAN','AUS','NZL','JPN','CHN','KOR','DEU','FRA'])[n] ||
    ' Team Event ' ||
    (ARRAY['Spring','Summer','Autumn','Winter','Open'])[((n - 1) % 5) + 1],
    'Mixed'::event_gender,
    (ARRAY['3m','10m'])[((n - 1) % 2) + 1]::board_height,
    5,
    5,
    'Completed'::event_status,
    'team'::event_type,
    now() - interval '400 days' + (n * interval '21 days')
FROM generate_series(1, 10) AS n;

-- Team event managers
INSERT INTO event_managers (event_id, user_id, added_by, added_at)
SELECT e.id, mgr.id, mgr.id, e.created_at
FROM events e
JOIN LATERAL (
    SELECT u.id FROM users u
    JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'meet_manager'
    WHERE u.org_id = e.org_id ORDER BY u.id LIMIT 1
) mgr ON true
WHERE pg_temp.uuid_n(e.id) BETWEEN 3021 AND 3030;

-- Team event judges: 5 per event
INSERT INTO event_judges (event_id, judge_id, judge_number)
SELECT event_id, judge_id, judge_number
FROM (
    SELECT
        e.id AS event_id,
        u.id AS judge_id,
        ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY u.id) AS judge_number
    FROM events e
    JOIN users u ON u.org_id = e.org_id
    JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'judge'
    WHERE pg_temp.uuid_n(e.id) BETWEEN 3021 AND 3030
) ranked
WHERE judge_number <= 5;

-- =============================================================
-- TEAMS — 3 per team event, named after the host country.
-- IDs in range 3001..3030 (10 events × 3 teams).
-- =============================================================
INSERT INTO teams (id, org_id, name, short_code, created_at)
SELECT
    ('90000000-0000-0000-0000-' || lpad((3000 + (event_n - 1) * 3 + team_n)::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad(event_n::text, 12, '0'))::uuid,
    (ARRAY['USA','GBR','CAN','AUS','NZL','JPN','CHN','KOR','DEU','FRA'])[event_n] ||
        ' Team ' || (ARRAY['Alpha','Bravo','Charlie'])[team_n],
    (ARRAY['USA','GBR','CAN','AUS','NZL','JPN','CHN','KOR','DEU','FRA'])[event_n] ||
        '-' || (ARRAY['A','B','C'])[team_n],
    now() - interval '380 days' + (event_n * 7 + team_n) * interval '1 day'
FROM generate_series(1, 10) AS event_n
CROSS JOIN generate_series(1, 3) AS team_n;

-- Team membership: 4 members per team, divers at positions
-- 14 + (team_n - 1) * 4 + member_n - 1 within their org
INSERT INTO team_members (team_id, user_id)
SELECT
    ('90000000-0000-0000-0000-' || lpad((3000 + (event_n - 1) * 3 + team_n)::text, 12, '0'))::uuid,
    ('d0000000-0000-0000-0000-' || lpad(
        (50 * (event_n - 1) + 14 + (team_n - 1) * 4 + member_n - 1)::text, 12, '0'
    ))::uuid
FROM generate_series(1, 10) AS event_n
CROSS JOIN generate_series(1, 3) AS team_n
CROSS JOIN generate_series(1, 4) AS member_n;

-- Enter teams in their event
INSERT INTO event_teams (event_id, team_id)
SELECT
    ('e0000000-0000-0000-0000-' || lpad((3020 + event_n)::text, 12, '0'))::uuid,
    ('90000000-0000-0000-0000-' || lpad((3000 + (event_n - 1) * 3 + team_n)::text, 12, '0'))::uuid
FROM generate_series(1, 10) AS event_n
CROSS JOIN generate_series(1, 3) AS team_n;

-- =============================================================
-- DIVE LISTS + SCORES (single DO block — needs row-level
-- procedural logic for picking dives from the directory)
-- =============================================================
DO $$
DECLARE
  ev_id          uuid;
  team_id_val    uuid;
  member_id      uuid;
  primary_id     uuid;
  partner_id_val uuid;
  diver_n        bigint;
  dive_uuid      uuid;
  judge_uuid     uuid;
  r              integer;
  j              integer;
  height_pick    numeric;
  height_text    text;
  pair_skill     numeric;
  base_score     numeric;
  ev_created     timestamptz;
  member_pos     integer;
  event_n        integer;
  pair_n         integer;
  team_n         integer;
  dive_codes     text[] := ARRAY['101', '201', '301', '401', '103', '107', '105'];
  dive_pos       text[] := ARRAY['B', 'B', 'B', 'B', 'B', 'C', 'B'];
BEGIN
  -- ============================================================
  -- SYNCHRO EVENTS — 6 pairs × 5 rounds × 11 judges per event
  -- ============================================================
  FOR event_n IN 1..20 LOOP
    ev_id := ('e0000000-0000-0000-0000-' || lpad((3000 + event_n)::text, 12, '0'))::uuid;
    height_text := (ARRAY['10m','3m'])[((event_n - 1) % 2) + 1];
    height_pick := CASE height_text WHEN '10m' THEN 10.0 WHEN '3m' THEN 3.0 END;
    SELECT created_at INTO ev_created FROM events WHERE id = ev_id;

    FOR pair_n IN 1..6 LOOP
      -- Primary + partner: divers at positions 14+2*(pair_n-1) and 14+2*(pair_n-1)+1
      diver_n := 50 * (event_n - 1) + 14 + (pair_n - 1) * 2;
      primary_id := ('d0000000-0000-0000-0000-' || lpad(diver_n::text, 12, '0'))::uuid;
      partner_id_val := ('d0000000-0000-0000-0000-' || lpad((diver_n + 1)::text, 12, '0'))::uuid;
      -- Skill from the pair number — earlier pairs slightly stronger
      pair_skill := 0.6 - (pair_n - 1) * 0.15;

      FOR r IN 1..5 LOOP
        SELECT id INTO dive_uuid FROM dive_directory
         WHERE dive_code = dive_codes[r] AND height = height_pick AND position = dive_pos[r]::dive_position
         LIMIT 1;
        -- Fallback to any dive at the height if the specific pick doesn't exist
        IF dive_uuid IS NULL THEN
          SELECT id INTO dive_uuid FROM dive_directory WHERE height = height_pick LIMIT 1;
        END IF;

        -- Dive list row: primary owns the row, partner is referenced
        INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number)
        VALUES (ev_id, primary_id, partner_id_val, dive_uuid, r);

        -- 11 per-judge scores, grouped by position (1-3 exec A, 4-6 exec B, 7-11 sync)
        FOR j IN 1..11 LOOP
          SELECT judge_id INTO judge_uuid FROM event_judges
           WHERE event_id = ev_id AND judge_number = j;
          INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score, created_at)
          VALUES (
            ev_id, primary_id, judge_uuid, dive_uuid, r,
            pg_temp.synchro_score(pair_skill, j, r),
            ev_created + (r * interval '15 minutes') + (j * interval '5 seconds')
          );
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  -- ============================================================
  -- TEAM EVENTS — 3 teams × 5 rounds × 5 judges per event.
  -- Member rotation: round n's diver is team-position
  -- ((n - 1) % 4) + 1 (so 1, 2, 3, 4, 1).
  -- ============================================================
  FOR event_n IN 1..10 LOOP
    ev_id := ('e0000000-0000-0000-0000-' || lpad((3020 + event_n)::text, 12, '0'))::uuid;
    height_text := (ARRAY['3m','10m'])[((event_n - 1) % 2) + 1];
    height_pick := CASE height_text WHEN '10m' THEN 10.0 WHEN '3m' THEN 3.0 END;
    SELECT created_at INTO ev_created FROM events WHERE id = ev_id;

    FOR team_n IN 1..3 LOOP
      team_id_val := ('90000000-0000-0000-0000-' ||
        lpad((3000 + (event_n - 1) * 3 + team_n)::text, 12, '0'))::uuid;

      FOR r IN 1..5 LOOP
        member_pos := ((r - 1) % 4) + 1;
        diver_n := 50 * (event_n - 1) + 14 + (team_n - 1) * 4 + member_pos - 1;
        member_id := ('d0000000-0000-0000-0000-' || lpad(diver_n::text, 12, '0'))::uuid;

        SELECT id INTO dive_uuid FROM dive_directory
         WHERE dive_code = dive_codes[r] AND height = height_pick AND position = dive_pos[r]::dive_position
         LIMIT 1;
        IF dive_uuid IS NULL THEN
          SELECT id INTO dive_uuid FROM dive_directory WHERE height = height_pick LIMIT 1;
        END IF;

        INSERT INTO competitor_dive_lists (event_id, competitor_id, team_id, dive_id, round_number)
        VALUES (ev_id, member_id, team_id_val, dive_uuid, r);

        -- Skill varies by team and member to give realistic spread
        base_score := 6.0 + (3 - team_n) * 0.4 + (member_pos % 3) * 0.15 - r * 0.05;

        FOR j IN 1..5 LOOP
          SELECT judge_id INTO judge_uuid FROM event_judges
           WHERE event_id = ev_id AND judge_number = j;
          INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score, created_at)
          VALUES (
            ev_id, member_id, judge_uuid, dive_uuid, r,
            pg_temp.snap_score(base_score + ((j - 3)::numeric * 0.2)),
            ev_created + (r * interval '12 minutes') + (j * interval '4 seconds')
          );
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- -------------------------------------------------------------
-- AUDIT LOG — backfill an 'insert' entry for every score we
-- just seeded so the audit trail reflects the test data.
-- -------------------------------------------------------------
INSERT INTO score_audit_log
    (score_id, event_id, competitor_id, judge_id, round_number,
     action, old_score, new_score, actor_user_id, ip_address, user_agent, created_at)
SELECT
    s.id, s.event_id, s.competitor_id, s.judge_id, s.round_number,
    'insert', NULL, s.score, s.judge_id,
    ('10.'
        || (((pg_temp.uuid_n(s.event_id))      % 254) + 1)::text || '.'
        || (((pg_temp.uuid_n(s.competitor_id)) % 254) + 1)::text || '.'
        || (((pg_temp.uuid_n(s.judge_id))      % 254) + 1)::text)::inet,
    'Mozilla/5.0 (iPad) seed/synchro_team',
    s.created_at
FROM scores s
WHERE pg_temp.uuid_n(s.event_id) BETWEEN 3001 AND 3030;

COMMIT;

-- =============================================================
-- DONE
--
-- 20 synchro events (3001..3020), one per bulk-* org, 11-judge
-- panels, 6 pairs each, 5 rounds. Standings are computed under
-- the World Aquatics synchro rule: judges 1-3 score Diver A's
-- execution (drop high+low, keep middle 1), 4-6 Diver B (same),
-- 7-11 score synchronisation (drop high+low, keep middle 3).
-- Award per dive = (1 exec A + 1 exec B + 3 sync) × DD × 0.6.
--
-- 10 team events (3021..3030), 3 teams of 4 members each. Team
-- members rotate round-by-round (team's diver in round N is
-- member ((N-1) %% 4) + 1). Standings sum each team's per-dive
-- scores. Each dive scored under standard 5-judge individual
-- rules (drop high+low, sum middle 3 × DD).
--
-- Spot-check from psql:
--   SELECT count(*) FROM events
--    WHERE substring(id::text from 25 for 12)::bigint BETWEEN 3001 AND 3030;
--   -- expect 30
--
--   SELECT count(*) FROM teams
--    WHERE substring(id::text from 25 for 12)::bigint BETWEEN 3001 AND 3030;
--   -- expect 30
--
--   SELECT count(*) FROM scores s
--    WHERE substring(s.event_id::text from 25 for 12)::bigint BETWEEN 3001 AND 3030;
--   -- expect 6,600 (synchro) + 750 (team) = 7,350
-- =============================================================
