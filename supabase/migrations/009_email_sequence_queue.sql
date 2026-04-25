-- Migration 009: email sequence queue + unsubscribe suppression list
--
-- Purpose: power the persona-1 nurture sequence (and future personas).
-- One row per scheduled send. The /api/email-scheduler endpoint runs every
-- 15 min via GitHub Actions cron, claims due rows, hydrates Liquid templates
-- with the user's calculation_data, and sends via Resend.
--
-- Apply order: run this BEFORE deploying the Tier B code that references
-- these tables. Per the 2026-04-19 incident, schema drift in Cloudflare
-- Functions silently drops INSERTs and we lose data.
--
-- Apply via Supabase SQL Editor against project toovnncuvzqzurugmiib.

-- ---------------------------------------------------------------------------
-- 1. The queue itself
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_sequence_queue (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  persona         TEXT NOT NULL,
  -- 0-indexed within the sequence; persona1 has email_number 0 (Day 0),
  -- 1 (Day 3), 2 (Day 7), 3 (Day 14). NOT a calendar day-of-sequence —
  -- the actual fire time lives in scheduled_at.
  email_number    INT NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  sent_at         TIMESTAMPTZ,
  claimed_at      TIMESTAMPTZ,
  resend_email_id TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_sequence_queue_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unsubscribed', 'cancelled')),
  CONSTRAINT email_sequence_queue_number_check
    CHECK (email_number >= 0)
);

-- One row per (email, persona, email_number) — re-enrollment for the same
-- persona is a no-op via ON CONFLICT DO NOTHING in the enrollment helper.
CREATE UNIQUE INDEX IF NOT EXISTS email_sequence_queue_unique
  ON email_sequence_queue (email, persona, email_number);

-- Hot path for the scheduler: "what's due to send right now?"
CREATE INDEX IF NOT EXISTS email_sequence_queue_due
  ON email_sequence_queue (scheduled_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. Unsubscribe suppression list
-- ---------------------------------------------------------------------------
-- Checked at enrollment time AND at send time. A user who unsubscribes
-- and then submits the calculator again does NOT get re-enrolled.

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email          TEXT PRIMARY KEY,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Free-form. e.g. 'persona1_email_2', 'list_unsubscribe_header', 'manual'.
  source         TEXT
);

-- ---------------------------------------------------------------------------
-- 3. claim_due_email_sequence_rows(limit_n)
-- ---------------------------------------------------------------------------
-- Atomically claims due rows in a single SQL roundtrip so two concurrent
-- scheduler invocations don't both grab the same row. Uses FOR UPDATE
-- SKIP LOCKED so a long-running claim doesn't block other claims.
--
-- Returns the rows it claimed (now with status='sending', claimed_at=NOW).
-- The worker is then responsible for transitioning each to 'sent' or
-- 'failed' before it returns.

CREATE OR REPLACE FUNCTION claim_due_email_sequence_rows(limit_n INT DEFAULT 10)
RETURNS SETOF email_sequence_queue
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM email_sequence_queue
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC
    LIMIT limit_n
    FOR UPDATE SKIP LOCKED
  )
  UPDATE email_sequence_queue q
  SET status = 'sending',
      claimed_at = NOW()
  FROM due
  WHERE q.id = due.id
  RETURNING q.*;
END;
$$;

-- Service role only — never call from the browser.
REVOKE ALL ON FUNCTION claim_due_email_sequence_rows(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_email_sequence_rows(INT) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. recover_stuck_email_sequence_rows()
-- ---------------------------------------------------------------------------
-- Releases rows stuck in 'sending' for >10 min back to 'pending'. Covers
-- the case where the scheduler crashed mid-row (Resend timeout, OOM, etc.).
-- Called at the top of every scheduler run before claiming new work.

CREATE OR REPLACE FUNCTION recover_stuck_email_sequence_rows()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  recovered INT;
BEGIN
  UPDATE email_sequence_queue
  SET status = 'pending',
      claimed_at = NULL
  WHERE status = 'sending'
    AND claimed_at < NOW() - INTERVAL '10 minutes';
  GET DIAGNOSTICS recovered = ROW_COUNT;
  RETURN recovered;
END;
$$;

REVOKE ALL ON FUNCTION recover_stuck_email_sequence_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recover_stuck_email_sequence_rows() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. RLS — tables are service-role-only
-- ---------------------------------------------------------------------------
-- These tables are written from the Cloudflare Function (service role) and
-- read by the admin RPC and the scheduler. Never directly accessed from the
-- browser. So RLS is enabled with no policies = denied to anon by default.

ALTER TABLE email_sequence_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;

-- Done.
