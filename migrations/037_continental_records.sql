-- 037_continental_records.sql
--
-- Continental record scope.
--
-- World Aquatics tracks Oceania, European, Pan-American, Asian,
-- and African records alongside national records — and a junior
-- setting an Oceania record at a Pacific Junior Champs has had
-- no place to land them in DiveRecorder until now. This
-- migration adds:
--
--   * organisations.continent — short ISO-ish region code on
--     each federation. Sysadmin populates manually (one-time
--     setup per federation); rows without a continent stay
--     ineligible for continental records.
--
--   * records_continental + records_continental_history —
--     mirrors records_federation's shape with `continent`
--     replacing `org_id` as the scope key. Both tables get the
--     same UNIQUE / FK semantics + history archive logic that
--     the existing scope tables use.
--
-- The records-application logic in lib/records.js gains a
-- fourth scope alongside personal / club / federation; when a
-- diver's home federation has a continent set, the dive is
-- compared against the continental record book and may upsert
-- there too. No code path changes for federations without a
-- continent — they simply skip the continental check.

BEGIN;

-- Continent codes mirror IOC's continent split. NULL means the
-- federation hasn't been classified yet (sysadmin task) and is
-- excluded from continental record application.
ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS continent varchar(20);

-- Optional sanity constraint — keeps typos from sneaking in.
-- Update the list when WA adds a region (none planned).
ALTER TABLE public.organisations
  DROP CONSTRAINT IF EXISTS organisations_continent_check;
ALTER TABLE public.organisations
  ADD CONSTRAINT organisations_continent_check
    CHECK (continent IS NULL OR continent IN
      ('africa','americas','asia','europe','oceania'));

CREATE INDEX IF NOT EXISTS idx_organisations_continent
  ON public.organisations (continent);

CREATE TABLE IF NOT EXISTS public.records_continental (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    -- continent string is the scope key. Rows here are NEVER
    -- written by a federation that doesn't have a continent set.
    continent   varchar(20) NOT NULL,
    holder_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    height      board_height NOT NULL,
    dive_code   varchar(10) NOT NULL,
    position    dive_position NOT NULL,
    score       numeric(8,2) NOT NULL,
    event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
    set_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (continent, height, dive_code, position)
);

CREATE TABLE IF NOT EXISTS public.records_continental_history (
    id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    continent     varchar(20) NOT NULL,
    holder_id     uuid,
    height        board_height NOT NULL,
    dive_code     varchar(10) NOT NULL,
    position      dive_position NOT NULL,
    score         numeric(8,2) NOT NULL,
    event_id      uuid,
    set_at        timestamptz NOT NULL,
    superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_records_continental_lookup
  ON public.records_continental (continent, height, dive_code, position);

COMMIT;
