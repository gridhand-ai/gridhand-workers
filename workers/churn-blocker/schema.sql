-- ============================================================
-- GRIDHAND Churn Blocker — Supabase Schema
-- ============================================================
-- Run this in your Supabase SQL editor to initialize all tables.
-- ============================================================

-- Enable pgcrypto for gen_random_uuid() if not already enabled
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── cb_clients ───────────────────────────────────────────────────────────────
-- One row per gym/fitness studio client using Churn Blocker.

CREATE TABLE IF NOT EXISTS cb_clients (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                 TEXT UNIQUE NOT NULL,
    business_name               TEXT NOT NULL,
    mindbody_site_id            TEXT NOT NULL,
    mindbody_api_key            TEXT NOT NULL,
    twilio_sid                  TEXT,
    twilio_token                TEXT,
    twilio_number               TEXT,
    owner_phone                 TEXT NOT NULL,
    inactivity_threshold_days   INTEGER NOT NULL DEFAULT 7,
    is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── cb_members ───────────────────────────────────────────────────────────────
-- Member data synced from Mindbody. Refreshed on schedule.

CREATE TABLE IF NOT EXISTS cb_members (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES cb_clients(id) ON DELETE CASCADE,
    mindbody_client_id  TEXT NOT NULL,
    first_name          TEXT,
    last_name           TEXT,
    email               TEXT,
    phone               TEXT,
    last_visit_date     DATE,
    visit_count_30d     INTEGER NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, mindbody_client_id)
);

CREATE INDEX IF NOT EXISTS idx_cb_members_client_visit
    ON cb_members (client_id, last_visit_date);

CREATE INDEX IF NOT EXISTS idx_cb_members_phone
    ON cb_members (client_id, phone);

-- ─── cb_churn_alerts ──────────────────────────────────────────────────────────
-- Tracks every re-engagement SMS sent to a member.

CREATE TABLE IF NOT EXISTS cb_churn_alerts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES cb_clients(id) ON DELETE CASCADE,
    member_id           UUID NOT NULL REFERENCES cb_members(id) ON DELETE CASCADE,
    days_since_visit    INTEGER NOT NULL,
    message_body        TEXT NOT NULL,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    twilio_sid          TEXT,
    status              TEXT NOT NULL DEFAULT 'sent',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cb_churn_alerts_client_sent
    ON cb_churn_alerts (client_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_cb_churn_alerts_member
    ON cb_churn_alerts (member_id);

-- ─── cb_reengagement_responses ────────────────────────────────────────────────
-- Inbound SMS replies from members (captured via Twilio webhook).

CREATE TABLE IF NOT EXISTS cb_reengagement_responses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID REFERENCES cb_clients(id) ON DELETE SET NULL,
    member_id       UUID REFERENCES cb_members(id) ON DELETE SET NULL,
    phone_number    TEXT NOT NULL,
    body            TEXT NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cb_responses_member
    ON cb_reengagement_responses (member_id);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cb_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cb_clients_updated_at
    BEFORE UPDATE ON cb_clients
    FOR EACH ROW EXECUTE FUNCTION cb_set_updated_at();

CREATE TRIGGER cb_members_updated_at
    BEFORE UPDATE ON cb_members
    FOR EACH ROW EXECUTE FUNCTION cb_set_updated_at();
