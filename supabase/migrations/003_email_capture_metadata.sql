-- Migration 003: enrich email_captures with calculation + segment + A/B metadata
--
-- Prior state: email_captures only stored email, trade, tool_slug, source_url,
-- marketing_consent. The frontend already sent a full calculationResults
-- object + segment + A/B variant; email-capture.ts was using them to build
-- the results email body but discarding them on insert.
--
-- This migration adds three columns so the full submission can be persisted
-- and surfaced in the admin portal deep-dive view for per-tool analysis.
--
--   calculation_data : full input snapshot + result values for this capture.
--                      JSONB for flexibility (new fields can be added to the
--                      payload without future migrations).
--   segment          : 'home' | 'customer' | NULL. Captured via the "Who's
--                      this for?" gate between Calculate and the email gate.
--   ab_variant       : 'A' | 'B' | 'C' | NULL. A/B/C test arm for the email
--                      gate copy experiment.
--
-- Existing rows stay as-is (all three new columns default to NULL). The
-- admin view should treat NULL as "captured before this migration, no
-- enriched data available".
--
-- Safe to run once. If re-run, the IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- guards make it idempotent.

ALTER TABLE email_captures
  ADD COLUMN IF NOT EXISTS calculation_data jsonb,
  ADD COLUMN IF NOT EXISTS segment text,
  ADD COLUMN IF NOT EXISTS ab_variant text;

-- Index on tool_slug so the mini-split admin deep-dive filters fast even as
-- the table grows.
CREATE INDEX IF NOT EXISTS idx_email_captures_tool_slug ON email_captures(tool_slug);

-- Index on created_at so the date filters in the admin page scan efficiently.
CREATE INDEX IF NOT EXISTS idx_email_captures_created_at ON email_captures(created_at DESC);

-- Index on segment so the segment filter in the admin page is cheap.
CREATE INDEX IF NOT EXISTS idx_email_captures_segment ON email_captures(segment)
  WHERE segment IS NOT NULL;
