-- 041_dive_list_lock.sql
--
-- Post-advance dive-list lock — World Aquatics Rule 2.1.3
-- (dive-list submission window): divers can change their list
-- up to 30 minutes before the next stage begins. Past that
-- window, the inherited list locks. Rule 2.1.6 governs the
-- advancement itself (next-ranked diver fills the slot when a
-- qualifier withdraws).
--
-- New columns:
--
--   events.dive_list_locks_at  — when the dive-list editor
--     closes for THIS event. Set automatically by
--     POST /api/events/:id/advance to
--     (child.scheduled_at - lock_minutes) when a scheduled
--     start exists, falling back to (NOW() + lock_minutes)
--     otherwise. Default lock_minutes = 30. NULL = no auto-lock.
--
--   competitor_dive_lists.confirmed_at — when the diver
--     explicitly confirmed (or re-submitted) their list for
--     this event. NULL = inherited from the parent stage and
--     untouched. Distinguishes "diver actively confirmed"
--     from "diver took the default" so the operator can audit
--     who responded vs. who let the default ride.

BEGIN;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS dive_list_locks_at timestamptz;

ALTER TABLE public.competitor_dive_lists
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_events_dive_list_locks_at
  ON public.events(dive_list_locks_at);

COMMIT;
