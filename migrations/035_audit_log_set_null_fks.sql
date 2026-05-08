-- 035_audit_log_set_null_fks.sql
--
-- Audit-log integrity hardening.
--
-- Before this migration:
--   score_audit_log.event_id      → events(id)            ON DELETE CASCADE
--   score_audit_log.competitor_id → users(id)             ON DELETE CASCADE
--   score_audit_log.judge_id      → users(id)             ON DELETE CASCADE
--   role_audit_log.user_id        → users(id)             ON DELETE CASCADE
--   role_audit_log.org_id         → organisations(id)     ON DELETE CASCADE
--
-- An org_admin (or sysadmin) deleting an event silently took
-- every audit row for that event with it. Same shape on user
-- delete. For a federation-grade product that's the worst
-- possible audit-integrity hole: a corrupt actor can launder a
-- scoring dispute by removing the evidence in one DELETE.
--
-- After this migration the FKs SET NULL instead, preserving the
-- audit trail past parent-row deletion. The score_audit_log row
-- still carries score_id (already nullable), action, old/new
-- score, actor, IP, user agent, reason, and timestamp, so
-- post-deletion forensics still works.
--
-- For event delete specifically the right long-term answer is
-- soft-delete (events.deleted_at), but that's a larger schema
-- change — this migration just plugs the FK loophole. The
-- DELETE /api/events/:id handler should also be hardened to
-- refuse delete once any score has been recorded; that's a
-- code-side change in the same commit.

BEGIN;

ALTER TABLE public.score_audit_log
  DROP CONSTRAINT IF EXISTS score_audit_log_event_id_fkey,
  ADD  CONSTRAINT score_audit_log_event_id_fkey
       FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;

ALTER TABLE public.score_audit_log
  ALTER COLUMN event_id DROP NOT NULL;

ALTER TABLE public.score_audit_log
  DROP CONSTRAINT IF EXISTS score_audit_log_competitor_id_fkey,
  ADD  CONSTRAINT score_audit_log_competitor_id_fkey
       FOREIGN KEY (competitor_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.score_audit_log
  ALTER COLUMN competitor_id DROP NOT NULL;

ALTER TABLE public.score_audit_log
  DROP CONSTRAINT IF EXISTS score_audit_log_judge_id_fkey,
  ADD  CONSTRAINT score_audit_log_judge_id_fkey
       FOREIGN KEY (judge_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.score_audit_log
  ALTER COLUMN judge_id DROP NOT NULL;

ALTER TABLE public.role_audit_log
  DROP CONSTRAINT IF EXISTS role_audit_log_user_id_fkey,
  ADD  CONSTRAINT role_audit_log_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.role_audit_log
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.role_audit_log
  DROP CONSTRAINT IF EXISTS role_audit_log_org_id_fkey,
  ADD  CONSTRAINT role_audit_log_org_id_fkey
       FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE SET NULL;

ALTER TABLE public.role_audit_log
  ALTER COLUMN org_id DROP NOT NULL;

-- audit_log was already SET NULL on org_id and actor_id (per
-- init.sql:570-571), but its existing reference to events(id) is
-- via the metadata jsonb (no FK at all), so nothing to touch.

COMMIT;
