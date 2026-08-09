-- Statements `drizzle-kit push` cannot express. The `db:deploy` script applies
-- them in two phases; the order matters, and getting it wrong breaks a fresh
-- deploy.
--
-- Everything that push *can* express stays in the Drizzle schema, including
-- CHECK constraints and the GENERATED ALWAYS AS tsvector columns. That is not a
-- style preference: push emits `DROP COLUMN` for anything it does not find in
-- the schema, so a column or constraint that lives only in this file survives
-- exactly until the next push.

-- ============================================================================
-- BEFORE the first `vp run db:push`
-- ============================================================================
-- Full-text search uses the generated `search_vector` columns and needs no
-- extension. pg_trgm is here for the fuzzy fallback in the search service
-- (similarity() over title/key), and because an index declared with
-- `gin_trgm_ops` makes push itself fail when the extension is missing — that
-- failure is at push time, not at query time, so the extension has to exist
-- before the first push rather than before the first query.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================================
-- AFTER the first `vp run db:push`
-- ============================================================================
-- `entity_revision` is the audit trail — there is deliberately no separate
-- audit_log table — which only holds if the rows are genuinely immutable. A
-- trigger is the one thing in this schema Drizzle cannot express, so this is the
-- single, deliberate exception to "nothing lives only in manual.sql".
--
-- It must run after push, because push creates the table the trigger attaches
-- to. Unlike a column it is not at risk from a later push: push diffs tables,
-- columns, indexes and constraints, and a trigger is none of those. Re-running
-- this half is therefore only needed when the trigger body changes, and both
-- statements are idempotent so re-running is safe.
--
-- TRUNCATE deliberately still works: it is not a row-level DELETE, so it does
-- not fire this trigger. An operator wiping the table must therefore choose
-- TRUNCATE consciously rather than reaching it through an ordinary row delete.
--
-- Verified side effect, by design: once a workspace has revisions,
-- `DELETE FROM workspace` fails. The ON DELETE CASCADE reaches entity_revision
-- as a row DELETE and this trigger rejects it, rolling the statement back. A
-- hard delete must not be able to erase the audit trail as a side effect. To
-- remove a tenant on purpose, TRUNCATE the tables or disable this trigger inside
-- an explicit maintenance transaction.
CREATE OR REPLACE FUNCTION entity_revision_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'entity_revision is append-only: % is not allowed (revision % of % %)',
    TG_OP, OLD.revision, OLD.entity_type, OLD.entity_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS entity_revision_append_only ON entity_revision;
CREATE TRIGGER entity_revision_append_only
  BEFORE UPDATE OR DELETE ON entity_revision
  FOR EACH ROW EXECUTE FUNCTION entity_revision_append_only();
