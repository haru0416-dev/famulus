CREATE TABLE sandbox_network_uses (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
  used_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER sandbox_network_uses_no_update
BEFORE UPDATE ON sandbox_network_uses BEGIN
  SELECT RAISE(ABORT, 'sandbox network approval use is immutable');
END;

CREATE TRIGGER sandbox_network_uses_no_delete
BEFORE DELETE ON sandbox_network_uses BEGIN
  SELECT RAISE(ABORT, 'sandbox network approval use is immutable');
END;
