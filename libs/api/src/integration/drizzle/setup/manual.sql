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
-- The web overlay's historical fuzzy rule is a tight ordered subsequence, not
-- trigram similarity. Keeping the exact predicate here preserves its explainable
-- six-rank contract while trigram indexes handle the much more common substring
-- branch. This function examines entity titles and projected fragment text;
-- source documents never cross the database boundary for fuzzy fallback.
CREATE OR REPLACE FUNCTION zpecs_tight_subsequence(haystack text, needle text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
DECLARE
  needle_length integer := length(needle);
  needle_position integer;
  search_start integer := 1;
  match_offset integer;
  match_position integer;
  first_match integer := 0;
  last_match integer := 0;
BEGIN
  IF needle_length < 3 THEN
    RETURN false;
  END IF;

  -- `substr(haystack, position, 1)` rescans a PostgreSQL text value from its
  -- beginning for every character, which makes long fragment text quadratic.
  -- Searching once per needle character keeps the same earliest-match greedy
  -- walk as the web search ranker while making the work linear for short queries.
  FOR needle_position IN 1..needle_length LOOP
    match_offset := strpos(
      substr(haystack, search_start),
      substr(needle, needle_position, 1)
    );
    IF match_offset = 0 THEN
      RETURN false;
    END IF;

    match_position := search_start + match_offset - 1;
    IF first_match = 0 THEN first_match := match_position; END IF;
    last_match := match_position;
    search_start := match_position + 1;
  END LOOP;

  RETURN last_match - first_match < needle_length * 2;
END;
$$;

-- `entity_revision` is the audit trail — there is deliberately no separate
-- audit_log table — which only holds if the rows are genuinely immutable.
-- `entity_revision_summary` is its compact history projection. Drizzle owns the
-- table; the triggers below are here because Drizzle cannot express either an
-- append-only guard or a transactional projection trigger.
--
-- It must run after push, because push creates the table the trigger attaches
-- to. Unlike a column it is not at risk from a later push: push diffs tables,
-- columns, indexes and constraints, and a trigger is none of those. Re-running
-- this half is therefore only needed when a trigger body changes, and every
-- statement is idempotent so re-running is safe.
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
-- Count every addressable array at the top two levels of `content`, plus Sources.
-- This is the same deliberately shallow definition used by the history UI: an
-- array inside an item belongs to that item rather than becoming a document
-- section of its own.
CREATE OR REPLACE FUNCTION entity_revision_section_counts(snapshot jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  WITH top_sections AS (
    SELECT entry.key AS section, entry.value
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(snapshot -> 'content') = 'object'
            THEN snapshot -> 'content'
          ELSE '{}'::jsonb
        END
      ) AS entry
  ),
  nested_sections AS (
    SELECT top.section || '.' || nested.key AS section, nested.value
      FROM top_sections AS top
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(top.value) = 'object' THEN top.value
          ELSE '{}'::jsonb
        END
      ) AS nested
  ),
  counts AS (
    SELECT section, jsonb_array_length(value) AS entry_count
      FROM top_sections
     WHERE jsonb_typeof(value) = 'array'
    UNION ALL
    SELECT section, jsonb_array_length(value) AS entry_count
      FROM nested_sections
     WHERE jsonb_typeof(value) = 'array'
    UNION ALL
    SELECT 'provenance.sources', jsonb_array_length(snapshot #> '{provenance,sources}')
     WHERE jsonb_typeof(snapshot #> '{provenance,sources}') = 'array'
  )
  SELECT coalesce(
    jsonb_object_agg(section, entry_count ORDER BY section),
    '{}'::jsonb
  )
  FROM counts;
$$;

-- Stable, compact structural difference between two count objects. Keeping this
-- beside the counter definition gives the live trigger and one-time backfill the
-- same classification algorithm.
CREATE OR REPLACE FUNCTION entity_revision_section_deltas(
  before_counts jsonb,
  after_counts jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'section', sections.section,
        'from', sections.before_count,
        'to', sections.after_count
      ) ORDER BY sections.section
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT
      coalesce(before.section, after.section) AS section,
      coalesce(before.entry_count::integer, 0) AS before_count,
      coalesce(after.entry_count::integer, 0) AS after_count
    FROM jsonb_each_text(coalesce(before_counts, '{}'::jsonb))
      AS before(section, entry_count)
    FULL JOIN jsonb_each_text(coalesce(after_counts, '{}'::jsonb))
      AS after(section, entry_count)
      USING (section)
    WHERE coalesce(before.entry_count::integer, 0)
       <> coalesce(after.entry_count::integer, 0)
  ) AS sections;
$$;

-- New audit rows project themselves inside the INSERT statement's transaction.
-- Keeping this at the database boundary avoids a second application/database
-- round trip for every entity changed in a change set.
CREATE OR REPLACE FUNCTION capture_entity_revision_summary() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_status text;
  revision_counts jsonb;
  previous_status text;
  previous_counts jsonb;
  section_deltas jsonb;
  has_previous boolean := false;
  status_changed boolean;
  revision_kind text;
BEGIN
  revision_status := CASE
    WHEN jsonb_typeof(NEW.document #> '{meta,status}') = 'string'
      THEN NEW.document #>> '{meta,status}'
    ELSE ''
  END;
  revision_counts := entity_revision_section_counts(NEW.document);

  SELECT summary.status, summary.section_counts
    INTO previous_status, previous_counts
    FROM entity_revision_summary AS summary
   WHERE summary.workspace_id = NEW.workspace_id
     AND summary.project_id = NEW.project_id
     AND summary.entity_type = NEW.entity_type
     AND summary.entity_id = NEW.entity_id
     AND summary.revision < NEW.revision
   ORDER BY summary.revision DESC
   LIMIT 1;
  has_previous := FOUND;

  status_changed := NEW.revision > 1
    AND has_previous
    AND revision_status IS DISTINCT FROM previous_status;
  section_deltas := CASE
    WHEN NEW.revision <= 1 OR NOT has_previous THEN '[]'::jsonb
    ELSE entity_revision_section_deltas(previous_counts, revision_counts)
  END;
  revision_kind := CASE
    WHEN NEW.revision <= 1 THEN 'created'
    WHEN NOT has_previous THEN 'text'
    WHEN status_changed THEN 'status'
    WHEN jsonb_array_length(section_deltas) > 0 THEN 'structure'
    ELSE 'text'
  END;

  INSERT INTO entity_revision_summary (
    entity_type,
    entity_id,
    revision,
    workspace_id,
    project_id,
    entity_key,
    title,
    status,
    kind,
    status_changed,
    section_deltas,
    section_counts,
    changed_by,
    change_reason,
    created_at
  ) VALUES (
    NEW.entity_type,
    NEW.entity_id,
    NEW.revision,
    NEW.workspace_id,
    NEW.project_id,
    CASE
      WHEN jsonb_typeof(NEW.document #> '{meta,key}') = 'string'
        THEN NEW.document #>> '{meta,key}'
      ELSE ''
    END,
    CASE
      WHEN jsonb_typeof(NEW.document #> '{meta,title}') = 'string'
        THEN NEW.document #>> '{meta,title}'
      ELSE ''
    END,
    revision_status,
    revision_kind,
    status_changed,
    section_deltas,
    revision_counts,
    NEW.changed_by,
    NEW.change_reason,
    NEW.created_at
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_revision_capture_summary ON entity_revision;
CREATE TRIGGER entity_revision_capture_summary
  AFTER INSERT ON entity_revision
  FOR EACH ROW EXECUTE FUNCTION capture_entity_revision_summary();

-- Populate the projection for revisions that predate the trigger. The source
-- documents are read once at deploy time; normal history requests never read
-- them. ON CONFLICT makes the setup safe to repeat without weakening either
-- table's append-only rule.
WITH projected AS (
  SELECT
    source.entity_type,
    source.entity_id,
    source.revision,
    source.workspace_id,
    source.project_id,
    CASE
      WHEN jsonb_typeof(source.document #> '{meta,key}') = 'string'
        THEN source.document #>> '{meta,key}'
      ELSE ''
    END AS entity_key,
    CASE
      WHEN jsonb_typeof(source.document #> '{meta,title}') = 'string'
        THEN source.document #>> '{meta,title}'
      ELSE ''
    END AS title,
    CASE
      WHEN jsonb_typeof(source.document #> '{meta,status}') = 'string'
        THEN source.document #>> '{meta,status}'
      ELSE ''
    END AS status,
    entity_revision_section_counts(source.document) AS section_counts,
    source.changed_by,
    source.change_reason,
    source.created_at
  FROM entity_revision AS source
), history AS (
  SELECT
    projected.*,
    lag(status) OVER entity_history AS previous_status,
    lag(section_counts) OVER entity_history AS previous_counts
  FROM projected
  WINDOW entity_history AS (
    PARTITION BY workspace_id, project_id, entity_type, entity_id
    ORDER BY revision
  )
), classified AS (
  SELECT
    history.*,
    revision > 1
      AND previous_status IS NOT NULL
      AND status IS DISTINCT FROM previous_status AS status_changed,
    CASE
      WHEN revision <= 1 OR previous_status IS NULL THEN '[]'::jsonb
      ELSE entity_revision_section_deltas(previous_counts, section_counts)
    END AS section_deltas
  FROM history
)
INSERT INTO entity_revision_summary (
  entity_type,
  entity_id,
  revision,
  workspace_id,
  project_id,
  entity_key,
  title,
  status,
  kind,
  status_changed,
  section_deltas,
  section_counts,
  changed_by,
  change_reason,
  created_at
)
SELECT
  classified.entity_type,
  classified.entity_id,
  classified.revision,
  classified.workspace_id,
  classified.project_id,
  classified.entity_key,
  classified.title,
  classified.status,
  CASE
    WHEN classified.revision <= 1 THEN 'created'
    WHEN classified.previous_status IS NULL THEN 'text'
    WHEN classified.status_changed THEN 'status'
    WHEN jsonb_array_length(classified.section_deltas) > 0 THEN 'structure'
    ELSE 'text'
  END,
  classified.status_changed,
  classified.section_deltas,
  classified.section_counts,
  classified.changed_by,
  classified.change_reason,
  classified.created_at
FROM classified
ON CONFLICT (entity_type, entity_id, revision) DO NOTHING;

CREATE OR REPLACE FUNCTION entity_revision_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not allowed (revision % of % %)',
    TG_TABLE_NAME, TG_OP, OLD.revision, OLD.entity_type, OLD.entity_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS entity_revision_append_only ON entity_revision;
CREATE TRIGGER entity_revision_append_only
  BEFORE UPDATE OR DELETE ON entity_revision
  FOR EACH ROW EXECUTE FUNCTION entity_revision_append_only();

DROP TRIGGER IF EXISTS entity_revision_summary_append_only ON entity_revision_summary;
CREATE TRIGGER entity_revision_summary_append_only
  BEFORE UPDATE OR DELETE ON entity_revision_summary
  FOR EACH ROW EXECUTE FUNCTION entity_revision_append_only();

-- Projection ownership is polymorphic, so PostgreSQL cannot express a foreign key
-- from owner_id to five current entity tables. Row triggers provide the missing
-- cascade. They also cover hierarchy FK cascades and remove Task backlink JSON in
-- the same transaction, including writes made outside the application repository.
CREATE OR REPLACE FUNCTION delete_project_fragment_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_ARGV[0] = 'task' THEN
    UPDATE project_fragment
       SET backlinks = coalesce((
         SELECT jsonb_agg(item)
           FROM jsonb_array_elements(backlinks) AS item
          WHERE item ->> 'id' <> OLD.id::text
       ), '[]'::jsonb)
     WHERE workspace_id = OLD.workspace_id
       AND backlinks @> jsonb_build_array(jsonb_build_object('id', OLD.id::text));
  END IF;

  DELETE FROM project_fragment
   WHERE workspace_id = OLD.workspace_id
     AND owner_type = TG_ARGV[0]
     AND owner_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS epic_delete_project_fragments ON epic;
CREATE TRIGGER epic_delete_project_fragments
  AFTER DELETE ON epic FOR EACH ROW EXECUTE FUNCTION delete_project_fragment_owner('epic');
DROP TRIGGER IF EXISTS stream_delete_project_fragments ON stream;
CREATE TRIGGER stream_delete_project_fragments
  AFTER DELETE ON stream FOR EACH ROW EXECUTE FUNCTION delete_project_fragment_owner('stream');
DROP TRIGGER IF EXISTS task_delete_project_fragments ON task;
CREATE TRIGGER task_delete_project_fragments
  AFTER DELETE ON task FOR EACH ROW EXECUTE FUNCTION delete_project_fragment_owner('task');
DROP TRIGGER IF EXISTS milestone_delete_project_fragments ON milestone;
CREATE TRIGGER milestone_delete_project_fragments
  AFTER DELETE ON milestone FOR EACH ROW EXECUTE FUNCTION delete_project_fragment_owner('milestone');
DROP TRIGGER IF EXISTS rule_delete_project_fragments ON rule;
CREATE TRIGGER rule_delete_project_fragments
  AFTER DELETE ON rule FOR EACH ROW EXECUTE FUNCTION delete_project_fragment_owner('rule');
