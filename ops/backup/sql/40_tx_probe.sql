-- ops/backup/sql/40_tx_probe.sql
-- Probe table for the failure-injection drill.
--
-- The restore drill answers "can we go back in time?". This table answers the
-- complementary question: "when the machine dies mid-write, is what the client
-- was told 'committed' still there afterwards?"
--
-- One row per client-confirmed transaction. The drill knows exactly how many
-- transactions returned COMMIT, so after an unclean kill the count must match
-- exactly -- no more, no less.

CREATE TABLE IF NOT EXISTS tx_probe (
  id           BIGSERIAL PRIMARY KEY,
  payload      TEXT NOT NULL,
  note         TEXT,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_tx_probe_note ON tx_probe(note);
