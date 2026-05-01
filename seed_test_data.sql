-- =============================================================
-- DiveRecorder — TEST DATA SEED
--
-- Layered on top of init.sql. Adds:
--
--   - 20 country-federation organisations (slug 'bulk-xxx')
--   - 80 clubs (4 per org)
--   - 1000 users distributed across them with a realistic role mix
--   - 50 individual events (mostly Completed, some Live, some Upcoming)
--   - 20 synchronised pair events (11-judge panels, 5 rounds, 6 pairs each)
--   - 10 team events (3 teams of 4 members each, 5 rounds)
--   - dive lists, judge scores and audit history for all of them
--
-- Designed so the archive view, scoreboard, diver profiles and
-- the audit log all have meaningful volumes of data immediately.
--
-- All seeded users share the password: password123
-- Org admins are the lowest-numbered user in each org:
--   bulk_user_0001 → United States Diving (USA)
--   bulk_user_0051 → British Aquatics Trust (GBR)
--   ... continuing every 50 users through bulk_user_0951 (NOR).
--
-- Run:
--   psql -d diverecorder -f seed_test_data.sql
--
-- Idempotent — reruns first delete every org with slug 'bulk-*'
-- (and everything cascading from them) before re-seeding. Will
-- not touch the 'admin' org or the admin user from init.sql.
-- =============================================================

BEGIN;

-- =============================================================
-- BULK DATA: 20 country orgs, 80 clubs, 1000 users, 50 individual events
-- =============================================================

-- -------------------------------------------------------------
-- Cleanup any prior bulk run.
-- users.org_id has ON DELETE RESTRICT, so users go first; their
-- removal cascades to roles, scores, dive lists, audit entries,
-- managers and judge assignments.
-- -------------------------------------------------------------
DELETE FROM users
 WHERE org_id IN (SELECT id FROM organisations WHERE slug LIKE 'bulk-%');

DELETE FROM organisations WHERE slug LIKE 'bulk-%';

-- -------------------------------------------------------------
-- Helper functions in pg_temp — dropped at session end.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.snap_score(raw numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(0.0, LEAST(10.0, ROUND(raw * 2)::numeric / 2))::numeric(3,1)
$$;

-- Extract the embedded sequence number from a positional UUID like
-- 'd0000000-0000-0000-0000-000000000123' → 123. The last 12 chars
-- of the canonical UUID text live at positions 25..36.
--
-- Returns NULL when those 12 chars aren't all digits (i.e. a real
-- random UUID, or a positional UUID from a different seed). That
-- way `uuid_n(x) BETWEEN 2001 AND 2050` safely excludes any
-- non-bulk row instead of erroring on the cast.
CREATE OR REPLACE FUNCTION pg_temp.uuid_n(u uuid)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN substring(u::text from 25 for 12) ~ '^[0-9]+$'
             THEN substring(u::text from 25 for 12)::bigint
           ELSE NULL
         END
$$;

-- =============================================================
-- 20 ORGANISATIONS — one per country
-- =============================================================
INSERT INTO organisations (id, name, country_code, slug, status, created_at)
SELECT
    ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    name,
    code,
    'bulk-' || lower(code),
    'active',
    now() - interval '1000 days' + (n * interval '20 days')
FROM (VALUES
    (1,  'United States Diving',          'USA'),
    (2,  'British Aquatics Trust',        'GBR'),
    (3,  'Canadian Diving Federation',    'CAN'),
    (4,  'Australian Aquatic Council',    'AUS'),
    (5,  'New Zealand Diving',            'NZL'),
    (6,  'Japan Aquatics Association',    'JPN'),
    (7,  'Diving Federation of China',    'CHN'),
    (8,  'Korea Diving Federation',       'KOR'),
    (9,  'Deutscher Schwimm Verband',     'DEU'),
    (10, 'Federation Francaise',          'FRA'),
    (11, 'Federazione Italiana',          'ITA'),
    (12, 'Real Federacion Espanola',      'ESP'),
    (13, 'Confederacao Brasileira',       'BRA'),
    (14, 'Federacion Mexicana',           'MEX'),
    (15, 'Confederacion Argentina',       'ARG'),
    (16, 'Russian Aquatic Federation',    'RUS'),
    (17, 'Ukrainian Aquatic Federation',  'UKR'),
    (18, 'Federatia Romana',              'ROU'),
    (19, 'Svenska Simforbundet',          'SWE'),
    (20, 'Norges Svommeforbund',          'NOR')
) AS v(n, name, code);

-- =============================================================
-- 80 CLUBS — 4 per org. Each user is assigned to one of their
-- org's clubs by their position within the org.
-- =============================================================
INSERT INTO clubs (id, org_id, name, short_code, created_at)
SELECT
    -- Global club number = 4 × (org_n - 1) + club_n  (1..80)
    ('f0000000-0000-0000-0000-' || lpad((4 * (org_n - 1) + club_n)::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad(org_n::text, 12, '0'))::uuid,
    country_code || ' ' || (ARRAY[
        'National Centre',
        'Coastal Aquatics',
        'Capital Diving Club',
        'Mountain Sports Centre'
    ])[club_n],
    country_code || '-' || club_n,
    now() - interval '850 days' + (org_n * club_n * interval '6 hours')
FROM (
    SELECT n AS org_n, code AS country_code
    FROM (VALUES
        (1, 'USA'), (2, 'GBR'), (3, 'CAN'), (4, 'AUS'), (5, 'NZL'),
        (6, 'JPN'), (7, 'CHN'), (8, 'KOR'), (9, 'DEU'), (10, 'FRA'),
        (11, 'ITA'), (12, 'ESP'), (13, 'BRA'), (14, 'MEX'), (15, 'ARG'),
        (16, 'RUS'), (17, 'UKR'), (18, 'ROU'), (19, 'SWE'), (20, 'NOR')
    ) AS v(n, code)
) AS country_orgs
CROSS JOIN generate_series(1, 4) AS clubs(club_n);

-- =============================================================
-- 1000 USERS — 50 per org. Names rotate across two pools so we
-- get reasonable variety without needing to spell out 1000 rows.
-- All users share password "password123". Each user is assigned
-- a club within their org based on their position within the org.
-- =============================================================
INSERT INTO users (id, username, password, full_name, email, org_id, club_id, is_system_admin, created_at)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    'bulk_user_' || lpad(n::text, 4, '0'),
    '$2b$12$wuMDqANijStjgHfsWYwJuuAdXc3tagXOn3/BnhizZsCY.8IHj3Evy',
    (ARRAY[
        'Alex','Bailey','Casey','Drew','Emery','Finley','Greer','Harper','Indigo','Jordan',
        'Kai','Logan','Morgan','Nova','Ocean','Phoenix','Quinn','River','Sage','Taylor',
        'Avery','Blake','Cameron','Dakota','Ellis','Frankie','Hayden','Iona','Jules','Kit'
    ])[((n * 7) % 30) + 1] || ' ' ||
    (ARRAY[
        'Anderson','Brooks','Chen','Davis','Evans','Fischer','Garcia','Hernandez','Ibrahim','Johnson',
        'Kim','Lee','Martinez','Nakamura','Oduya','Patel','Quintero','Ramirez','Singh','Tanaka',
        'Ueno','Vasquez','Williams','Xu','Yamamoto','Zhao','Adebayo','Bergstrom','Costa','Dimitrov'
    ])[((n * 13) % 30) + 1],
    'bulk_user_' || lpad(n::text, 4, '0') || '@example.com',
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    -- Club: org_n = (n-1)/50 + 1, club_within_org = (n-1) % 4 + 1
    -- → global club number = 4 × (org_n - 1) + club_within_org
    ('f0000000-0000-0000-0000-' || lpad(
        (4 * ((n - 1) / 50) + (((n - 1) % 4) + 1))::text, 12, '0'
    ))::uuid,
    false,
    now() - interval '900 days' + (n * interval '12 hours')
FROM generate_series(1, 1000) AS n;

-- =============================================================
-- USER ROLES — within each org of 50 users (position p = ((n-1) % 50) + 1):
--   p = 1            org_admin + meet_manager
--   p = 2-5          meet_manager (5 per org)
--   p = 4-5          also referee (so referees exist)
--   p = 6-13         judge (8 per org → 160 total — covers 7-judge panels)
--   p = 14-43        diver (30 per org → 600 total)
--   p = 44-50        spectator only
-- Everyone also gets 'spectator' as a baseline.
-- =============================================================
INSERT INTO user_org_roles (user_id, org_id, role)
SELECT u.id, u.org_id, 'spectator'::org_role
FROM users u
WHERE u.username LIKE 'bulk_user_%';

INSERT INTO user_org_roles (user_id, org_id, role)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    'org_admin'::org_role
FROM generate_series(1, 1000) AS n
WHERE ((n - 1) % 50) + 1 = 1;

INSERT INTO user_org_roles (user_id, org_id, role)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    'meet_manager'::org_role
FROM generate_series(1, 1000) AS n
WHERE ((n - 1) % 50) + 1 BETWEEN 1 AND 5;

INSERT INTO user_org_roles (user_id, org_id, role)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    'referee'::org_role
FROM generate_series(1, 1000) AS n
WHERE ((n - 1) % 50) + 1 IN (4, 5);

INSERT INTO user_org_roles (user_id, org_id, role)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    'judge'::org_role
FROM generate_series(1, 1000) AS n
WHERE ((n - 1) % 50) + 1 BETWEEN 6 AND 13;

INSERT INTO user_org_roles (user_id, org_id, role)
SELECT
    ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) / 50) + 1)::text, 12, '0'))::uuid,
    'diver'::org_role
FROM generate_series(1, 1000) AS n
WHERE ((n - 1) % 50) + 1 BETWEEN 14 AND 43;

-- =============================================================
-- ROLE AUDIT BACKFILL — record a 'granted' entry for every
-- bulk role assignment so the User Manager drawer's audit
-- history isn't empty for these accounts. Self-granted (no
-- actor) since the seed creates them programmatically.
-- =============================================================
INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id, note, created_at)
SELECT
    r.user_id,
    r.org_id,
    r.role,
    'granted',
    NULL,
    'seeded',
    u.created_at
FROM user_org_roles r
JOIN users u ON u.id = r.user_id
WHERE u.username LIKE 'bulk_user_%';

-- =============================================================
-- 50 EVENTS — distributed across orgs and across ~3 years.
-- Mostly Completed (the archive's main test surface), a handful
-- Live and a few Upcoming.
-- =============================================================
INSERT INTO events (id, org_id, name, gender, height, number_of_judges, total_rounds, status, created_at)
SELECT
    ('e0000000-0000-0000-0000-' || lpad((2000 + n)::text, 12, '0'))::uuid,
    ('c0000000-0000-0000-0000-' || lpad((((n - 1) % 20) + 1)::text, 12, '0'))::uuid,
    -- e.g. "2024 USA Spring Classic 10m"
    (2022 + ((n - 1) / 17))::text || ' ' ||
    (ARRAY['USA','GBR','CAN','AUS','NZL','JPN','CHN','KOR','DEU','FRA',
           'ITA','ESP','BRA','MEX','ARG','RUS','UKR','ROU','SWE','NOR'])
        [((n - 1) % 20) + 1] || ' ' ||
    (ARRAY['National Open','Invitational','Championship','Spring Classic','Summer Cup',
           'Autumn Trials','Winter Meet','Junior Open','Masters Cup','Grand Prix'])
        [((n - 1) % 10) + 1] || ' ' ||
    (ARRAY['1m','3m','5m','7.5m','10m'])[((n - 1) % 5) + 1],
    (ARRAY['Female','Male','Mixed'])[((n - 1) % 3) + 1]::event_gender,
    (ARRAY['1m','3m','5m','7.5m','10m'])[((n - 1) % 5) + 1]::board_height,
    -- 5 judges most events, 7 for the bigger championships
    CASE WHEN n % 4 = 0 THEN 7 ELSE 5 END,
    CASE WHEN n % 3 = 0 THEN 5 ELSE 6 END,
    CASE
        WHEN n <= 42 THEN 'Completed'::event_status
        WHEN n <= 47 THEN 'Live'::event_status
        ELSE             'Upcoming'::event_status
    END,
    now() - interval '900 days' + (n * interval '15 days')
FROM generate_series(1, 50) AS n;

-- =============================================================
-- EVENT MANAGERS — first meet_manager in the event's org
-- =============================================================
INSERT INTO event_managers (event_id, user_id, added_by, added_at)
SELECT
    e.id,
    mgr.id,
    mgr.id,
    e.created_at
FROM events e
JOIN LATERAL (
    SELECT u.id
    FROM users u
    JOIN user_org_roles r
      ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'meet_manager'
    WHERE u.org_id = e.org_id
    ORDER BY u.id
    LIMIT 1
) mgr ON true
WHERE pg_temp.uuid_n(e.id) BETWEEN 2001 AND 2050;

-- =============================================================
-- EVENT JUDGES — first N judges from the event's org, where N
-- is the event's number_of_judges. Judge_number is assigned 1..N.
-- =============================================================
INSERT INTO event_judges (event_id, judge_id, judge_number)
SELECT event_id, judge_id, judge_number
FROM (
    SELECT
        e.id AS event_id,
        u.id AS judge_id,
        ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY u.id) AS judge_number,
        e.number_of_judges
    FROM events e
    JOIN users u ON u.org_id = e.org_id
    JOIN user_org_roles r
      ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'judge'
    WHERE pg_temp.uuid_n(e.id) BETWEEN 2001 AND 2050
) ranked
WHERE judge_number <= number_of_judges;

-- =============================================================
-- COMPETITOR DIVE LISTS
-- 8 divers per event drawn from the host org. Each diver gets a
-- different dive_directory entry per round (rotating by slot so
-- two divers can pick the same dive — realistic).
-- =============================================================
WITH dive_lookup AS (
    SELECT
        id AS dive_id,
        height,
        ROW_NUMBER() OVER (PARTITION BY height ORDER BY dive_code, position) AS slot,
        COUNT(*) OVER (PARTITION BY height) AS height_count
    FROM dive_directory
),
event_div_pick AS (
    SELECT
        e.id          AS event_id,
        e.height      AS event_height,
        e.total_rounds,
        e.created_at,
        e.status,
        u.id          AS competitor_id,
        ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY u.id) AS diver_slot
    FROM events e
    JOIN users u ON u.org_id = e.org_id
    JOIN user_org_roles r
      ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
    WHERE pg_temp.uuid_n(e.id) BETWEEN 2001 AND 2050
)
INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
SELECT
    edp.event_id,
    edp.competitor_id,
    dl.dive_id,
    rn.round_number
FROM event_div_pick edp
CROSS JOIN LATERAL generate_series(1, edp.total_rounds) AS rn(round_number)
JOIN dive_lookup dl
  ON dl.height = (CASE edp.event_height
                    WHEN '1m'   THEN 1.0
                    WHEN '3m'   THEN 3.0
                    WHEN '5m'   THEN 5.0
                    WHEN '7.5m' THEN 7.5
                    WHEN '10m'  THEN 10.0
                  END)
 AND dl.slot   = ((edp.diver_slot + rn.round_number - 1) % dl.height_count) + 1
WHERE edp.diver_slot <= 8;

-- =============================================================
-- SCORES
-- For every (event, diver, round, judge) where the event is
-- Completed (all rounds) or Live (rounds 1-3 only). Upcoming
-- events have dive lists but no scores.
--
-- Per-judge scores are built deterministically:
--   base 5.5  +  diver-skill (0.0 .. 3.4)         driven by user n
--             +  judge bias  (-0.45 .. +0.45)     driven by judge_number
--             -  round trend (0.05 / round)       harder later
--             -  difficulty  (0.3 × (DD - 2.0))   high-DD dives drop a touch
-- Then snapped to a legal 0.5 increment in [0, 10].
-- =============================================================
INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score, created_at)
SELECT
    cdl.event_id,
    cdl.competitor_id,
    ej.judge_id,
    cdl.dive_id,
    cdl.round_number,
    pg_temp.snap_score(
        5.5
        + ((pg_temp.uuid_n(cdl.competitor_id) % 35)::numeric / 10.0)
        + (((ej.judge_number - 3)::numeric) * 0.15)
        - (cdl.round_number * 0.05)
        - (((d.dd::numeric - 2.0)) * 0.3)
        -- A small judge-and-round-specific oscillation for variety
        + ((((ej.judge_number * 17 + cdl.round_number * 7) % 5) - 2)::numeric * 0.1)
    ),
    e.created_at
        + (cdl.round_number * interval '15 minutes')
        + (ej.judge_number  * interval '6 seconds')
FROM competitor_dive_lists cdl
JOIN events         e  ON e.id  = cdl.event_id
JOIN dive_directory d  ON d.id  = cdl.dive_id
JOIN event_judges   ej ON ej.event_id = cdl.event_id
WHERE pg_temp.uuid_n(cdl.event_id) BETWEEN 2001 AND 2050
  AND e.status <> 'Upcoming'
  AND (e.status = 'Completed' OR cdl.round_number <= 3);

-- =============================================================
-- SCORE AUDIT LOG — backfill an "insert" entry for every score,
-- plus a sprinkle of "update" entries on Live events so the
-- audit view shows realistic edits.
-- =============================================================
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
    'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    s.created_at
FROM scores s
WHERE pg_temp.uuid_n(s.event_id) BETWEEN 2001 AND 2050;

-- A few hundred update entries on Live events so the audit log
-- has visible "edited" rows alongside the inserts. The score
-- table's `id` is a random UUID (not positional), so we use
-- hashtext for IP / sampling rather than uuid_n.
INSERT INTO score_audit_log
    (score_id, event_id, competitor_id, judge_id, round_number,
     action, old_score, new_score, actor_user_id, ip_address, user_agent, created_at)
SELECT
    s.id, s.event_id, s.competitor_id, s.judge_id, s.round_number,
    'update',
    GREATEST(0.0, s.score - 0.5),
    s.score,
    s.judge_id,
    ('10.0.0.' || ((abs(hashtext(s.id::text)) % 254) + 1)::text)::inet,
    'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    s.created_at + interval '12 seconds'
FROM scores s
JOIN events e ON e.id = s.event_id
WHERE e.status = 'Live'
  AND pg_temp.uuid_n(s.event_id) BETWEEN 2001 AND 2050
  AND (abs(hashtext(s.id::text)) % 11) = 0;   -- ~9% of live scores

-- =============================================================
-- ROLE REQUESTS — a few pending so the User Manager view has
-- something to triage in a few of the bulk orgs.
-- =============================================================
INSERT INTO role_requests (user_id, org_id, requested_role, status, note, created_at)
SELECT
    u.id,
    u.org_id,
    'judge'::org_role,
    'pending'::request_status,
    'Auto-seeded request for testing',
    now() - interval '5 days' + (pg_temp.uuid_n(u.id) * interval '1 hour')
FROM users u
WHERE u.username LIKE 'bulk_user_%'
  AND ((pg_temp.uuid_n(u.id) - 1) % 50) + 1 BETWEEN 44 AND 46;   -- 3 spectators per org


-- =============================================================
-- SYNCHRO + TEAM EVENTS: 20 synchro pairs + 10 team events
-- =============================================================


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
-- DONE — quick stats (run from psql to confirm volumes):
--
--   SELECT count(*) FROM organisations WHERE slug LIKE 'bulk-%';   -- 20
--   SELECT count(*) FROM clubs;                                    -- 80
--   SELECT count(*) FROM users WHERE username LIKE 'bulk_user_%';  -- 1000
--   SELECT status, count(*) FROM events
--     WHERE substring(id::text from 25 for 12)::bigint
--           BETWEEN 2001 AND 2050 GROUP BY status;                 -- 42 / 5 / 3
--   SELECT count(*) FROM events
--     WHERE substring(id::text from 25 for 12)::bigint
--           BETWEEN 3001 AND 3030;                                 -- 30 (synchro+team)
--   SELECT count(*) FROM teams;                                    -- 30
--   SELECT count(*) FROM scores;                                   -- ~17-19k
--
-- Logging in:
--   bulk_user_NNNN  /  password123
--   (Or admin / admin from init.sql for system-admin access.)
-- =============================================================
