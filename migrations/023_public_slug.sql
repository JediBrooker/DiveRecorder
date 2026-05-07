-- =============================================================
-- MIGRATION 023 — STABLE OPAQUE public_slug FOR DIVERS
--
-- The existing publicId() helper produces per-event hashes — fine
-- for spectator-facing scoreboard chips, useless as a stable
-- "share my profile" URL because it changes per event. Username
-- is stable but it's a credential identifier we deliberately
-- redacted from cross-org payloads (Migration 021's audit).
--
-- This migration adds a third, purpose-built identifier:
-- users.public_slug. 16 random hex chars (~64 bits of entropy),
-- URL-safe, opaque (doesn't leak username or user_id), generated
-- at user creation. Existing rows are backfilled with one slug
-- each.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, backfill UPDATE only
-- touches rows where public_slug IS NULL. Re-running on a v23
-- DB is a no-op.
-- =============================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS public_slug varchar(32);

-- Default for NEW inserts. Without this, a future
-- "INSERT INTO users (...) VALUES (...)" that doesn't list
-- public_slug would crash on the NOT NULL we set below.
ALTER TABLE public.users
    ALTER COLUMN public_slug SET DEFAULT REPLACE(gen_random_uuid()::text, '-', '');

-- Backfill EXISTING rows. Uses gen_random_uuid() (already
-- enabled by init.sql via pgcrypto) truncated to 32 hex chars
-- (no dashes). WHERE public_slug IS NULL gates so a re-run
-- after a partial backfill picks up where it left off.
UPDATE public.users
   SET public_slug = REPLACE(gen_random_uuid()::text, '-', '')
 WHERE public_slug IS NULL;

ALTER TABLE public.users
    ALTER COLUMN public_slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_slug
    ON public.users (public_slug);

-- ---------- Schema version stamp ------------------------------

CREATE TABLE IF NOT EXISTS public.schema_meta (
    id           integer PRIMARY KEY DEFAULT 1,
    version      integer NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_meta_singleton CHECK (id = 1)
);
INSERT INTO public.schema_meta (id, version, applied_at)
VALUES (1, 23, now())
ON CONFLICT (id) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = EXCLUDED.applied_at;

COMMIT;
