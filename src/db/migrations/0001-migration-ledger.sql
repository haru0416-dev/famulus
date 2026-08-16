CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY CHECK (version > 0),
  name       TEXT NOT NULL UNIQUE,
  checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER schema_migrations_immutable
BEFORE UPDATE ON schema_migrations BEGIN
  SELECT RAISE(ABORT, 'schema migrations are immutable');
END;

CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations BEGIN
  SELECT RAISE(ABORT, 'schema migrations are immutable');
END;
