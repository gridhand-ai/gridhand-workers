-- GRIDHAND Transaction Tracker — Supabase Schema
-- All tables use UUID primary keys, JSONB for flexible data, timestamps on every table.
-- Run this in the Supabase SQL Editor.

-- ─── Enable UUID Extension ────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── tt_clients ───────────────────────────────────────────────────────────────
-- One row per real estate agent / brokerage connected to Transaction Tracker.

CREATE TABLE IF NOT EXISTS tt_clients (
    id                       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_slug              TEXT        NOT NULL UNIQUE,
    agent_name               TEXT,
    agent_phone              TEXT,

    -- Dotloop credentials
    dotloop_access_token     TEXT,
    dotloop_webhook_secret   TEXT,

    -- DocuSign credentials
    docusign_account_id      TEXT,
    docusign_access_token    TEXT,
    docusign_webhook_key     TEXT,
    docusign_base_url        TEXT        DEFAULT 'https://demo.docusign.net/restapi/v2.1',

    active                   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── tt_transactions ─────────────────────────────────────────────────────────
-- Each row is one real estate transaction (buy, sell, or lease).

CREATE TABLE IF NOT EXISTS tt_transactions (
    id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id            TEXT        NOT NULL REFERENCES tt_clients(client_slug) ON DELETE CASCADE,

    -- External system IDs
    dotloop_loop_id      TEXT,
    docusign_envelope_id TEXT,

    -- Property info
    address              TEXT,
    mls_number           TEXT,
    type                 TEXT        NOT NULL DEFAULT 'buy'
                             CHECK (type IN ('buy', 'sell', 'lease')),

    -- Status lifecycle
    status               TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'under_contract', 'closing', 'closed', 'cancelled')),

    -- Key dates
    closing_date         DATE,
    contract_date        DATE,

    -- Financials
    list_price           NUMERIC(12, 2),
    sale_price           NUMERIC(12, 2),

    -- Parties
    buyer_name           TEXT,
    buyer_phone          TEXT,
    seller_name          TEXT,
    seller_phone         TEXT,

    -- Agent internal notes
    agent_notes          TEXT,

    -- Raw data from Dotloop/DocuSign for full fidelity
    raw_data             JSONB,

    -- Risk assessment
    risk_level           TEXT        NOT NULL DEFAULT 'low'
                             CHECK (risk_level IN ('low', 'medium', 'high')),

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tt_transactions_client_id
    ON tt_transactions (client_id);

CREATE INDEX IF NOT EXISTS idx_tt_transactions_status
    ON tt_transactions (status);

CREATE INDEX IF NOT EXISTS idx_tt_transactions_closing_date
    ON tt_transactions (closing_date);

CREATE INDEX IF NOT EXISTS idx_tt_transactions_dotloop_loop_id
    ON tt_transactions (dotloop_loop_id)
    WHERE dotloop_loop_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tt_transactions_docusign_envelope_id
    ON tt_transactions (docusign_envelope_id)
    WHERE docusign_envelope_id IS NOT NULL;

-- ─── tt_milestones ────────────────────────────────────────────────────────────
-- Transaction milestone checklist items with due dates and completion status.

CREATE TABLE IF NOT EXISTS tt_milestones (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID        NOT NULL REFERENCES tt_transactions(id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    due_date       DATE,
    completed_at   TIMESTAMPTZ,
    required       BOOLEAN     NOT NULL DEFAULT TRUE,
    category       TEXT        NOT NULL DEFAULT 'contract'
                       CHECK (category IN ('contract', 'inspection', 'financing', 'title', 'closing')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tt_milestones_transaction_id
    ON tt_milestones (transaction_id);

CREATE INDEX IF NOT EXISTS idx_tt_milestones_due_date
    ON tt_milestones (due_date)
    WHERE completed_at IS NULL;

-- ─── tt_documents ─────────────────────────────────────────────────────────────
-- Documents associated with a transaction — Dotloop uploads or DocuSign envelopes.

CREATE TABLE IF NOT EXISTS tt_documents (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id   UUID        NOT NULL REFERENCES tt_transactions(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    required         BOOLEAN     NOT NULL DEFAULT FALSE,
    uploaded_at      TIMESTAMPTZ,
    docusign_status  TEXT,       -- sent, delivered, completed, declined, voided
    envelope_id      TEXT,
    raw_data         JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tt_documents_transaction_id
    ON tt_documents (transaction_id);

CREATE INDEX IF NOT EXISTS idx_tt_documents_envelope_id
    ON tt_documents (envelope_id)
    WHERE envelope_id IS NOT NULL;

-- ─── tt_participants ──────────────────────────────────────────────────────────
-- People involved in a transaction (buyer, seller, agent, lender, inspector, attorney).

CREATE TABLE IF NOT EXISTS tt_participants (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID        NOT NULL REFERENCES tt_transactions(id) ON DELETE CASCADE,
    role           TEXT        NOT NULL DEFAULT 'agent'
                       CHECK (role IN ('buyer', 'seller', 'agent', 'lender', 'inspector', 'attorney', 'other')),
    name           TEXT,
    phone          TEXT,
    email          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tt_participants_transaction_id
    ON tt_participants (transaction_id);

-- ─── tt_sms_log ───────────────────────────────────────────────────────────────
-- Every outbound SMS sent by this worker for audit and dedup purposes.

CREATE TABLE IF NOT EXISTS tt_sms_log (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id      TEXT        NOT NULL,
    transaction_id UUID        REFERENCES tt_transactions(id) ON DELETE SET NULL,
    recipient      TEXT        NOT NULL,
    message_body   TEXT        NOT NULL,
    message_type   TEXT        NOT NULL,  -- milestone_alert, deadline_warning, missing_docs_alert, etc.
    twilio_sid     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tt_sms_log_client_id
    ON tt_sms_log (client_id);

CREATE INDEX IF NOT EXISTS idx_tt_sms_log_transaction_id
    ON tt_sms_log (transaction_id)
    WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tt_sms_log_created_at
    ON tt_sms_log (created_at DESC);

-- ─── updated_at Triggers ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tt_clients_updated_at
    BEFORE UPDATE ON tt_clients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tt_transactions_updated_at
    BEFORE UPDATE ON tt_transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Row Level Security (optional — enable per environment) ───────────────────
-- Uncomment and configure if using RLS. Service key bypasses RLS by default.

-- ALTER TABLE tt_clients       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tt_transactions  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tt_milestones    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tt_documents     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tt_participants  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tt_sms_log       ENABLE ROW LEVEL SECURITY;
