-- ============================================================================
-- GRIDHAND Lead Incubator — Database Schema
-- Run this once against your Supabase project to initialize all tables.
-- All tables prefixed with li_ to avoid collisions with other workers.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Clients ─────────────────────────────────────────────────────────────────
-- One row per real estate agent / team using Lead Incubator.
-- Stores all API credentials for external services.

CREATE TABLE IF NOT EXISTS li_clients (
    id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug    TEXT        UNIQUE NOT NULL,
    agent_name     TEXT        NOT NULL,
    agent_phone    TEXT        NOT NULL,
    fub_api_key    TEXT,                         -- Follow Up Boss API key (Basic auth username)
    fub_team_id    TEXT,                         -- FUB team/system ID for webhook routing
    zillow_wsid    TEXT,                         -- Zillow Web Services ID
    twilio_from    TEXT,                         -- Override Twilio from number per client
    anthropic_key  TEXT,                         -- Per-client Anthropic API key (overrides operator key)
    timezone       TEXT        DEFAULT 'America/Chicago',
    active         BOOLEAN     DEFAULT true,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Leads ────────────────────────────────────────────────────────────────────
-- Central lead record. One row per unique (client_id, phone) pair.
-- Status tracks progression through the sales pipeline.
-- JSONB columns store raw API data without schema constraints.

CREATE TABLE IF NOT EXISTS li_leads (
    id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id            UUID        REFERENCES li_clients(id) ON DELETE CASCADE,
    fub_person_id        TEXT,                    -- Follow Up Boss person ID
    name                 TEXT        NOT NULL,
    phone                TEXT        NOT NULL,
    email                TEXT,
    source               TEXT,                    -- Lead source (Zillow, Realtor.com, referral, etc.)
    inquiry              TEXT,                    -- Original inquiry / message from lead
    budget_min           NUMERIC,
    budget_max           NUMERIC,
    timeline             TEXT,                    -- Buying timeline (immediately, 1-3 months, etc.)
    desired_location     TEXT,                    -- City, neighborhood, or zip code
    bedrooms             INTEGER,
    status               TEXT        DEFAULT 'new'
                             CHECK (status IN (
                                 'new',
                                 'contacted',
                                 'qualifying',
                                 'qualified',
                                 'scheduled',
                                 'converted',
                                 'cold',
                                 'unsubscribed'
                             )),
    score                INTEGER     DEFAULT 0,   -- AI qualification score 1-100
    tier                 TEXT        DEFAULT 'cold'
                             CHECK (tier IN ('hot', 'warm', 'cold')),
    drip_step            INTEGER     DEFAULT 0,   -- Last completed drip step (0 = not started)
    drip_active          BOOLEAN     DEFAULT false,
    last_contact         TIMESTAMPTZ,             -- Last outbound contact timestamp
    last_inbound         TIMESTAMPTZ,             -- Last inbound SMS timestamp
    showing_scheduled_at TIMESTAMPTZ,
    fub_raw              JSONB,                   -- Full FUB person payload for reference
    zillow_data          JSONB,                   -- Zillow enrichment data
    ai_summary           TEXT,                    -- Claude's qualification summary
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_id, phone)
);

-- ─── Conversations ────────────────────────────────────────────────────────────
-- Full message history for every lead — both inbound and outbound SMS.
-- intent field captures what Claude detected about the message purpose.

CREATE TABLE IF NOT EXISTS li_conversations (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_id    UUID        REFERENCES li_leads(id) ON DELETE CASCADE,
    client_id  UUID        REFERENCES li_clients(id) ON DELETE CASCADE,
    direction  TEXT        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    message    TEXT        NOT NULL,
    intent     TEXT,                   -- schedule | question | not_interested | more_info | drip_step_N | initial_contact
    twilio_sid TEXT,                   -- Twilio message SID for delivery tracking
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Drip Log ─────────────────────────────────────────────────────────────────
-- Records which drip steps have been sent per lead.
-- UNIQUE (lead_id, step) prevents duplicate sends across worker restarts.

CREATE TABLE IF NOT EXISTS li_drip_log (
    id        UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_id   UUID        REFERENCES li_leads(id) ON DELETE CASCADE,
    step      INTEGER     NOT NULL,      -- 1-5
    sent_at   TIMESTAMPTZ DEFAULT NOW(),
    message   TEXT,
    UNIQUE (lead_id, step)
);

-- ─── SMS Log ──────────────────────────────────────────────────────────────────
-- Complete audit log of every SMS sent or received.
-- Separate from conversations for billing/compliance tracking.

CREATE TABLE IF NOT EXISTS li_sms_log (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id   UUID        REFERENCES li_clients(id),
    lead_id     UUID        REFERENCES li_leads(id),
    direction   TEXT        CHECK (direction IN ('outbound', 'inbound')),
    to_number   TEXT,
    from_number TEXT,
    body        TEXT,
    twilio_sid  TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Lead lookups by client (most common query)
CREATE INDEX IF NOT EXISTS idx_li_leads_client
    ON li_leads(client_id);

-- Lead status filtering (pipeline views)
CREATE INDEX IF NOT EXISTS idx_li_leads_status
    ON li_leads(status);

-- Phone number lookup for inbound SMS routing
CREATE INDEX IF NOT EXISTS idx_li_leads_phone
    ON li_leads(phone);

-- Tier filtering for hot lead alerts
CREATE INDEX IF NOT EXISTS idx_li_leads_tier
    ON li_leads(tier);

-- FUB person ID lookup for webhook deduplication
CREATE INDEX IF NOT EXISTS idx_li_leads_fub_person
    ON li_leads(fub_person_id)
    WHERE fub_person_id IS NOT NULL;

-- Drip candidates: leads that need drip start check
CREATE INDEX IF NOT EXISTS idx_li_leads_drip
    ON li_leads(drip_active, drip_step, status);

-- Last contact for cold re-engagement cron
CREATE INDEX IF NOT EXISTS idx_li_leads_last_contact
    ON li_leads(last_contact);

-- Conversation history per lead (conversation view)
CREATE INDEX IF NOT EXISTS idx_li_conversations_lead
    ON li_conversations(lead_id);

-- Conversation history per client (admin view)
CREATE INDEX IF NOT EXISTS idx_li_conversations_client
    ON li_conversations(client_id);

-- SMS log per client (billing view)
CREATE INDEX IF NOT EXISTS idx_li_sms_log_client
    ON li_sms_log(client_id);

-- SMS log per lead (audit trail)
CREATE INDEX IF NOT EXISTS idx_li_sms_log_lead
    ON li_sms_log(lead_id)
    WHERE lead_id IS NOT NULL;

-- ─── Updated At Trigger ───────────────────────────────────────────────────────
-- Automatically update updated_at on li_leads and li_clients rows.

CREATE OR REPLACE FUNCTION li_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS li_leads_updated_at ON li_leads;
CREATE TRIGGER li_leads_updated_at
    BEFORE UPDATE ON li_leads
    FOR EACH ROW EXECUTE FUNCTION li_set_updated_at();

DROP TRIGGER IF EXISTS li_clients_updated_at ON li_clients;
CREATE TRIGGER li_clients_updated_at
    BEFORE UPDATE ON li_clients
    FOR EACH ROW EXECUTE FUNCTION li_set_updated_at();
