-- Statements `drizzle-kit push` cannot express. Run by hand, in two halves —
-- the order matters, and getting it wrong breaks a fresh deploy.
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
