DROP TRIGGER events_immutable_except_redact;

CREATE TRIGGER events_immutable_except_redact
BEFORE UPDATE ON events
WHEN
  NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.at IS NOT OLD.at OR NEW.kind IS NOT OLD.kind
  OR NEW.source IS NOT OLD.source OR NEW.taint IS NOT OLD.taint OR NEW.exposure IS NOT OLD.exposure
  OR NEW.supersedes IS NOT OLD.supersedes OR NEW.provenance IS NOT OLD.provenance
  OR NEW.origin_kind IS NOT OLD.origin_kind OR NEW.origin_id IS NOT OLD.origin_id
  OR NEW.belief_slot IS NOT OLD.belief_slot OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.invalidated_reason IS NOT OLD.invalidated_reason OR NEW.evidence_event_id IS NOT OLD.evidence_event_id
  OR (NEW.evidence_quote IS NOT OLD.evidence_quote AND NEW.evidence_quote IS NOT NULL)
  OR NOT (
    (NEW.content IS NULL AND NEW.search_text IS NULL)
    OR (OLD.evidence_quote IS NOT NULL AND NEW.evidence_quote IS NULL
        AND NEW.content IS OLD.content AND NEW.search_text IS OLD.search_text)
  )
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: only content/search_text or evidence_quote redaction is permitted');
END;

-- 抹消済みeventの引用だけを消し、参照関係と参照元の本文は残す。
UPDATE events SET evidence_quote = NULL
WHERE evidence_quote IS NOT NULL
  AND (content IS NULL OR evidence_event_id IN (SELECT id FROM events WHERE content IS NULL));
