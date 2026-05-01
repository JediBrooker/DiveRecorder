-- =============================================================
-- DIVING APP — CLEAN v2 SCHEMA
-- Run against a fresh empty database.
-- DROP DATABASE your_db; CREATE DATABASE your_db; then run this.
-- =============================================================

BEGIN;

-- =============================================================
-- EXTENSIONS
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- =============================================================
-- ENUM TYPES
-- =============================================================

-- Organisation lifecycle
CREATE TYPE org_status AS ENUM (
    'pending',      -- registered, awaiting system_admin approval
    'active',       -- fully operational
    'suspended'     -- disabled by system_admin
);

-- Roles a user can hold within an organisation
CREATE TYPE org_role AS ENUM (
    'org_admin',    -- full control within their org
    'meet_manager', -- can manage events they are assigned to
    'referee',      -- can make rulings during a live meet
    'judge',        -- can submit scores
    'diver',        -- can submit dive lists
    'spectator'     -- authenticated read-only
);

-- Role request lifecycle
CREATE TYPE request_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);

-- Dive positions (unchanged from v1)
CREATE TYPE dive_position AS ENUM (
    'A',  -- straight
    'B',  -- pike
    'C',  -- tuck
    'D'   -- free
);

-- Event gender categories (unchanged from v1)
CREATE TYPE event_gender AS ENUM (
    'Male',
    'Female',
    'Mixed'
);

-- Event lifecycle (unchanged from v1)
CREATE TYPE event_status AS ENUM (
    'Upcoming',
    'Live',
    'Completed'
);

-- Board/platform heights
CREATE TYPE board_height AS ENUM (
    '1m',
    '3m',
    '5m',
    '7.5m',
    '10m'
);

-- Score audit actions
CREATE TYPE score_audit_action AS ENUM (
    'insert',
    'update',
    'delete'
);

-- Role audit actions
CREATE TYPE role_audit_action AS ENUM (
    'granted',
    'revoked'
);


-- =============================================================
-- ORGANISATIONS
-- Must be created before users since users reference it.
-- =============================================================

CREATE TABLE public.organisations (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name         varchar(255) NOT NULL,
    country_code char(3),                       -- ISO 3166-1 alpha-3 e.g. 'AUS'
    slug         varchar(100) UNIQUE NOT NULL,  -- url-safe e.g. 'swimming-aus'
    status       org_status DEFAULT 'pending' NOT NULL,
    created_at   timestamptz DEFAULT now()
);


-- =============================================================
-- USERS
-- =============================================================

-- =============================================================
-- CLUBS
-- A smaller organisational unit nested under organisations
-- (country federations). Each user belongs to one club within
-- their org. Optional — independent divers can have NULL club_id.
-- =============================================================

CREATE TABLE public.clubs (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name        varchar(255) NOT NULL,
    short_code  varchar(20),
    created_at  timestamptz DEFAULT now() NOT NULL
);


CREATE TABLE public.users (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    username        varchar(50) UNIQUE NOT NULL,
    password        varchar(255),
    full_name       varchar(100) NOT NULL,
    email           varchar(255),
    org_id          uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
    club_id         uuid REFERENCES public.clubs(id) ON DELETE SET NULL,
    is_system_admin boolean DEFAULT false NOT NULL,
    created_at      timestamptz DEFAULT now()
);


-- =============================================================
-- USER ORG ROLES
-- Replaces the old flat users.role[] array.
-- A user can hold multiple roles within their org.
-- =============================================================

CREATE TABLE public.user_org_roles (
    user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id     uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    role       org_role NOT NULL,
    granted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    granted_at timestamptz DEFAULT now(),
    PRIMARY KEY (user_id, org_id, role)
);


-- =============================================================
-- ROLE REQUESTS
-- Self-serve flow: user requests a role, org_admin approves.
-- =============================================================

CREATE TABLE public.role_requests (
    id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id         uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    requested_role org_role NOT NULL,
    status         request_status DEFAULT 'pending' NOT NULL,
    note           text,
    reviewed_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at    timestamptz,
    created_at     timestamptz DEFAULT now(),
    -- One pending request per user+org+role at a time
    UNIQUE (user_id, org_id, requested_role, status)
);


-- =============================================================
-- DIVE DIRECTORY
-- Global reference table — not org-scoped.
-- =============================================================

CREATE TABLE public.dive_directory (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    dive_code   varchar(10) NOT NULL,
    height      numeric(3,1) NOT NULL,
    position    dive_position NOT NULL,
    dd          numeric(3,1) NOT NULL,
    description text,
    UNIQUE (dive_code, height, position)
);


-- =============================================================
-- EVENTS
-- =============================================================

CREATE TABLE public.events (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id           uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    name             varchar(255) NOT NULL,
    gender           event_gender NOT NULL,
    height           board_height,
    number_of_judges integer NOT NULL,
    total_rounds     integer DEFAULT 6 NOT NULL,
    dd_limit_rounds  integer DEFAULT 0,
    dd_limit_value   numeric(3,1),
    status           event_status DEFAULT 'Upcoming' NOT NULL,
    created_at       timestamptz DEFAULT now(),
    CONSTRAINT events_number_of_judges_check
        CHECK (number_of_judges = ANY (ARRAY[3, 5, 7, 9, 11])),
    CONSTRAINT events_total_rounds_check
        CHECK (total_rounds > 0)
);


-- =============================================================
-- EVENT MANAGERS
-- Replaces single manager_id — multiple managers per event
-- for redundancy. The creator is inserted automatically by
-- the server when a new event is created.
-- =============================================================

CREATE TABLE public.event_managers (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    added_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    added_at timestamptz DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);


-- =============================================================
-- EVENT JUDGES
-- Which judges are assigned to score a specific event.
-- =============================================================

CREATE TABLE public.event_judges (
    event_id     uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    judge_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    judge_number integer,
    PRIMARY KEY (event_id, judge_id)
);


-- =============================================================
-- COMPETITOR DIVE LISTS
-- =============================================================

CREATE TABLE public.competitor_dive_lists (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id      uuid REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    dive_id       uuid REFERENCES public.dive_directory(id) ON DELETE RESTRICT,
    round_number  integer NOT NULL,
    UNIQUE (event_id, competitor_id, round_number),
    CONSTRAINT competitor_dive_lists_round_number_check
        CHECK (round_number > 0)
);


-- =============================================================
-- SCORES
-- =============================================================

CREATE TABLE public.scores (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id      uuid REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    judge_id      uuid REFERENCES public.users(id) ON DELETE CASCADE,
    dive_id       uuid REFERENCES public.dive_directory(id),
    round_number  integer NOT NULL,
    score         numeric(3,1) NOT NULL,
    status        varchar(20) DEFAULT 'active',
    created_at    timestamptz DEFAULT now(),
    UNIQUE (event_id, competitor_id, round_number, judge_id),
    CONSTRAINT scores_score_check
        CHECK (
            score >= 0.0
            AND score <= 10.0
            AND ((score * 2) % 1) = 0  -- must be a 0.5 increment
        ),
    FOREIGN KEY (event_id, competitor_id, round_number)
        REFERENCES public.competitor_dive_lists(event_id, competitor_id, round_number)
        ON DELETE CASCADE
);


-- =============================================================
-- SCORE AUDIT LOG
-- Append-only log of every score insert/update/delete so meet
-- managers can resolve disputes with a complete history of who
-- submitted what, from where, and when.
-- =============================================================

-- =============================================================
-- ROLE AUDIT LOG
-- Append-only history of role grants / revokes. user_org_roles
-- only holds current state; this table preserves the full
-- timeline so admins can answer "who had what role when".
-- =============================================================

CREATE TABLE public.role_audit_log (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
    role        org_role NOT NULL,
    action      role_audit_action NOT NULL,
    actor_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    note        text,
    created_at  timestamptz DEFAULT now() NOT NULL
);


CREATE TABLE public.score_audit_log (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    score_id        uuid,                                            -- nullable after delete
    event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    competitor_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    judge_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    round_number    integer NOT NULL,
    action          score_audit_action NOT NULL,
    old_score       numeric(3,1),                                    -- null for insert
    new_score       numeric(3,1),                                    -- null for delete
    actor_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    ip_address      inet,
    user_agent      text,
    created_at      timestamptz DEFAULT now() NOT NULL
);


-- =============================================================
-- WORLD AQUATICS DIVE POINTS FUNCTION
-- Returns dive points for a panel of judge scores. Trim rules:
--    3j keep 3, 5j keep middle 3, 7j keep middle 3,
--    9j keep middle 5 × 0.6, 11j keep middle 5 × 0.6
--   dive_points = (sum of counted scores) × DD × scaling
-- Used by every standings / breakdown / archive query.
-- =============================================================

CREATE OR REPLACE FUNCTION public.calc_dive_points(
    scores      numeric[],
    num_judges  integer,
    dd          numeric
) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    sorted       numeric[];
    n            integer;
    drop_count   integer;
    scaling      numeric;
    counted_sum  numeric;
BEGIN
    IF scores IS NULL OR array_length(scores, 1) IS NULL THEN
        RETURN 0;
    END IF;
    SELECT array_agg(s ORDER BY s) INTO sorted FROM unnest(scores) AS s;
    n := array_length(sorted, 1);
    drop_count := CASE
        WHEN num_judges = 5  THEN 1
        WHEN num_judges = 7  THEN 2
        WHEN num_judges = 9  THEN 2
        WHEN num_judges = 11 THEN 3
        ELSE 0
    END;
    scaling := CASE WHEN num_judges IN (9, 11) THEN 0.6 ELSE 1.0 END;
    IF drop_count > 0 AND n > drop_count * 2 THEN
        SELECT SUM(s) INTO counted_sum
        FROM unnest(sorted[(drop_count + 1) : (n - drop_count)]) AS s;
    ELSE
        SELECT SUM(s) INTO counted_sum FROM unnest(sorted) AS s;
    END IF;
    RETURN COALESCE(counted_sum, 0) * COALESCE(dd, 1.0) * scaling;
END
$$;


-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX idx_users_org              ON public.users (org_id);
CREATE INDEX idx_user_org_roles_user    ON public.user_org_roles (user_id);
CREATE INDEX idx_user_org_roles_org     ON public.user_org_roles (org_id);
CREATE INDEX idx_role_requests_org      ON public.role_requests (org_id, status);
CREATE INDEX idx_events_org             ON public.events (org_id);
CREATE INDEX idx_events_status          ON public.events (status);
CREATE INDEX idx_event_managers_event   ON public.event_managers (event_id);
CREATE INDEX idx_event_managers_user    ON public.event_managers (user_id);
CREATE INDEX idx_event_judges_event     ON public.event_judges (event_id);
CREATE INDEX idx_dive_lists_event       ON public.competitor_dive_lists (event_id);
CREATE INDEX idx_dive_lists_competitor  ON public.competitor_dive_lists (competitor_id);
CREATE INDEX idx_scores_event           ON public.scores (event_id);
CREATE INDEX idx_scores_competitor      ON public.scores (competitor_id);
CREATE INDEX idx_score_audit_event_round   ON public.score_audit_log (event_id, round_number);
CREATE INDEX idx_score_audit_event_created ON public.score_audit_log (event_id, created_at DESC);
CREATE INDEX idx_score_audit_competitor    ON public.score_audit_log (competitor_id);
CREATE INDEX idx_score_audit_judge         ON public.score_audit_log (judge_id);
CREATE INDEX idx_clubs_org                 ON public.clubs (org_id);
CREATE INDEX idx_users_club                ON public.users (club_id);
CREATE INDEX idx_role_audit_user           ON public.role_audit_log (user_id, created_at DESC);
CREATE INDEX idx_role_audit_org            ON public.role_audit_log (org_id, created_at DESC);
CREATE INDEX idx_role_audit_actor          ON public.role_audit_log (actor_id);


COMMIT;


-- =============================================================
-- AFTER RUNNING THIS SCRIPT
-- 1. Register your org via POST /api/auth/register-org
-- 2. In psql, activate it and promote yourself to system_admin:
--
--    UPDATE organisations SET status = 'active'
--    WHERE slug = 'your-org-slug';
--
--    UPDATE users SET is_system_admin = true
--    WHERE username = 'your_username';
--
-- 3. Log in — you will have full access.
-- 4. Use the user manager to assign roles to other users.
-- 5. Run the dive directory seed script (dive_directory_seed.sql).
-- =============================================================
