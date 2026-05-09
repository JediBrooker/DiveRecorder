-- 041_dive_list_lock.sql
--
-- Post-advance dive-list lock — World Aquatics rule DD 7.4
-- (and DD 7.5 for the prelim → semi variant): divers must
-- submit the next stage's dive list to the Referee within
-- 30 minutes of the prior stage's official results being
-- announced. Past that window, the inherited list locks.
--
-- New columns:
--
--   events.dive_list_locks_at  — when the dive-list editor
--     closes for THIS event. Set automatically by
--     POST /api/events/:id/advance to (NOW() + lock_minutes,
--     default 30). NULL = no auto-lock (legacy / standalone
--     events fall back to entries_close_at).
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
