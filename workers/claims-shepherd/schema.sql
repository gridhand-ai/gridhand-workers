-- ============================================================
-- GRIDHAND AI — Claims Shepherd
-- Supabase Schema v1.0
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CLIENTS — Insurance agencies using Claims Shepherd
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_clients (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            TEXT UNIQUE NOT NULL,
    agency_name     TEXT NOT NULL,
    ams_type        TEXT NOT NULL CHECK (ams_type IN ('hawksoft', 'applied_epic', 'manual')),
    ams_api_key     TEXT,
    ams_agency_id   TEXT,
    twilio_number   TEXT NOT NULL,
    agent_phone     TEXT NOT NULL,         -- Primary agent to alert
    anthropic_key   TEXT,
    twilio_sid      TEXT,
    twilio_token    TEXT,
    settings        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLAIMS — Core claims table
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_claims (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID REFERENCES cs_clients(id) ON DELETE CASCADE,

    -- Identifiers
    claim_number        TEXT,                    -- Carrier-assigned after FNOL
    internal_ref        TEXT UNIQUE NOT NULL,    -- Our internal reference
    ams_claim_id        TEXT,                    -- AMS system ID
    policy_number       TEXT NOT NULL,
    policy_id           TEXT,                    -- AMS policy ID

    -- Carrier info
    carrier_code        TEXT NOT NULL,           -- e.g. 'state_farm', 'progressive'
    carrier_name        TEXT NOT NULL,
    carrier_claim_url   TEXT,                    -- Direct link to carrier portal

    -- Insured
    insured_name        TEXT NOT NULL,
    insured_phone       TEXT NOT NULL,
    insured_email       TEXT,
    insured_address     TEXT,

    -- Loss details
    loss_type           TEXT NOT NULL,           -- 'auto', 'property', 'liability', 'workers_comp'
    loss_date           DATE NOT NULL,
    loss_description    TEXT NOT NULL,
    loss_address        TEXT,
    police_report_num   TEXT,
    estimated_damage    NUMERIC(12,2),

    -- Status tracking
    status              TEXT NOT NULL DEFAULT 'detected' CHECK (
                            status IN (
                                'detected',      -- New claim identified
                                'fnol_pending',  -- About to file FNOL
                                'fnol_filed',    -- FNOL submitted to carrier
                                'acknowledged',  -- Carrier acknowledged
                                'assigned',      -- Adjuster assigned
                                'investigating', -- Under investigation
                                'docs_requested',-- Waiting on documents
                                'docs_received', -- Documents received
                                'appraised',     -- Appraisal complete
                                'negotiating',   -- Settlement negotiation
                                'approved',      -- Settlement approved
                                'paid',          -- Payment issued
                                'closed',        -- Claim closed
                                'denied',        -- Claim denied
                                'disputed',      -- Under dispute
                                'on_hold'        -- On hold / needs agent action
                            )
                        ),
    sub_status          TEXT,                    -- Free-form sub-status from carrier
    adjuster_name       TEXT,
    adjuster_phone      TEXT,
    adjuster_email      TEXT,

    -- Metrics
    fnol_filed_at       TIMESTAMPTZ,
    last_status_check   TIMESTAMPTZ,
    last_client_update  TIMESTAMPTZ,
    last_agent_alert    TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    client_satisfaction INT CHECK (client_satisfaction BETWEEN 1 AND 5),
    resolution_days     INT GENERATED ALWAYS AS (
                            CASE WHEN resolved_at IS NOT NULL
                            THEN EXTRACT(DAY FROM resolved_at - fnol_filed_at)::INT
                            ELSE NULL END
                        ) STORED,

    -- Source detection
    source              TEXT DEFAULT 'manual' CHECK (
                            source IN ('ams_sync', 'email_parse', 'sms_intake', 'manual', 'webhook')
                        ),
    raw_source_data     JSONB,

    -- Flags
    needs_agent_action  BOOLEAN DEFAULT FALSE,
    action_reason       TEXT,
    is_complex          BOOLEAN DEFAULT FALSE,

    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLAIM EVENTS — Full audit log of every status change / action
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_claim_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id        UUID REFERENCES cs_claims(id) ON DELETE CASCADE,
    client_id       UUID REFERENCES cs_clients(id),

    event_type      TEXT NOT NULL CHECK (
                        event_type IN (
                            'status_change',
                            'fnol_filed',
                            'carrier_response',
                            'document_requested',
                            'document_received',
                            'client_sms_sent',
                            'client_sms_received',
                            'agent_alert_sent',
                            'adjuster_assigned',
                            'note_added',
                            'ams_sync',
                            'api_error',
                            'manual_action'
                        )
                    ),
    event_data      JSONB NOT NULL DEFAULT '{}',
    prev_status     TEXT,
    new_status      TEXT,
    actor           TEXT DEFAULT 'system',    -- 'system', 'agent', 'client', 'carrier'
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLAIM DOCUMENTS — Document tracking and collection
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_claim_documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id        UUID REFERENCES cs_claims(id) ON DELETE CASCADE,
    client_id       UUID REFERENCES cs_clients(id),

    doc_type        TEXT NOT NULL CHECK (
                        doc_type IN (
                            'photos',
                            'police_report',
                            'repair_estimate',
                            'medical_records',
                            'receipts',
                            'witness_statement',
                            'signed_form',
                            'proof_of_ownership',
                            'other'
                        )
                    ),
    doc_name        TEXT NOT NULL,
    status          TEXT DEFAULT 'requested' CHECK (
                        status IN ('requested', 'received', 'submitted_to_carrier', 'rejected')
                    ),

    requested_at    TIMESTAMPTZ DEFAULT NOW(),
    received_at     TIMESTAMPTZ,
    submitted_at    TIMESTAMPTZ,

    -- SMS request tracking
    request_sent_to TEXT,                   -- Phone number doc was requested from
    sms_request_count INT DEFAULT 0,
    last_sms_request  TIMESTAMPTZ,

    -- Storage
    file_url        TEXT,                   -- Supabase storage URL
    carrier_doc_id  TEXT,                   -- Carrier's document reference

    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CARRIER CONFIG — Carrier API credentials and endpoints
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_carrier_configs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID REFERENCES cs_clients(id) ON DELETE CASCADE,

    carrier_code    TEXT NOT NULL,           -- 'state_farm', 'progressive', etc.
    carrier_name    TEXT NOT NULL,
    portal_url      TEXT,
    api_endpoint    TEXT,
    api_key         TEXT,
    api_secret      TEXT,
    username        TEXT,
    password        TEXT,                    -- Encrypted in production
    integration_type TEXT DEFAULT 'manual' CHECK (
                        integration_type IN ('api', 'portal_scrape', 'email', 'manual')
                    ),
    is_active       BOOLEAN DEFAULT TRUE,
    last_sync_at    TIMESTAMPTZ,
    sync_error      TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, carrier_code)
);

-- ============================================================
-- WEEKLY REPORT SNAPSHOTS
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_weekly_reports (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id               UUID REFERENCES cs_clients(id) ON DELETE CASCADE,

    report_week_start       DATE NOT NULL,
    report_week_end         DATE NOT NULL,

    total_open_claims       INT DEFAULT 0,
    new_claims_this_week    INT DEFAULT 0,
    claims_closed_this_week INT DEFAULT 0,
    claims_denied_this_week INT DEFAULT 0,
    pending_docs_count      INT DEFAULT 0,
    needs_action_count      INT DEFAULT 0,

    avg_resolution_days     NUMERIC(6,1),
    avg_satisfaction        NUMERIC(3,2),
    total_settled_amount    NUMERIC(12,2),

    top_carriers            JSONB DEFAULT '[]',
    top_loss_types          JSONB DEFAULT '[]',
    open_claims_detail      JSONB DEFAULT '[]',
    recently_closed_detail  JSONB DEFAULT '[]',

    sent_to_agent           BOOLEAN DEFAULT FALSE,
    sent_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SMS CONVERSATIONS — Track incoming client texts about claims
-- ============================================================
CREATE TABLE IF NOT EXISTS cs_sms_conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID REFERENCES cs_clients(id) ON DELETE CASCADE,
    claim_id        UUID REFERENCES cs_claims(id) ON DELETE SET NULL,

    phone_number    TEXT NOT NULL,
    direction       TEXT CHECK (direction IN ('inbound', 'outbound')),
    body            TEXT NOT NULL,
    media_urls      JSONB DEFAULT '[]',      -- Photos sent by client
    twilio_sid      TEXT,

    intent          TEXT,                   -- AI-detected intent
    handled_by      TEXT,                   -- Which handler processed this
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_cs_claims_client     ON cs_claims(client_id);
CREATE INDEX IF NOT EXISTS idx_cs_claims_status     ON cs_claims(status);
CREATE INDEX IF NOT EXISTS idx_cs_claims_policy     ON cs_claims(policy_number);
CREATE INDEX IF NOT EXISTS idx_cs_claims_carrier    ON cs_claims(carrier_code);
CREATE INDEX IF NOT EXISTS idx_cs_claims_action     ON cs_claims(needs_agent_action) WHERE needs_agent_action = TRUE;
CREATE INDEX IF NOT EXISTS idx_cs_events_claim      ON cs_claim_events(claim_id);
CREATE INDEX IF NOT EXISTS idx_cs_events_type       ON cs_claim_events(event_type);
CREATE INDEX IF NOT EXISTS idx_cs_docs_claim        ON cs_claim_documents(claim_id);
CREATE INDEX IF NOT EXISTS idx_cs_docs_status       ON cs_claim_documents(status);
CREATE INDEX IF NOT EXISTS idx_cs_sms_phone         ON cs_sms_conversations(phone_number);
CREATE INDEX IF NOT EXISTS idx_cs_sms_claim         ON cs_sms_conversations(claim_id);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION cs_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cs_claims_updated_at
    BEFORE UPDATE ON cs_claims
    FOR EACH ROW EXECUTE FUNCTION cs_update_updated_at();

CREATE TRIGGER cs_clients_updated_at
    BEFORE UPDATE ON cs_clients
    FOR EACH ROW EXECUTE FUNCTION cs_update_updated_at();

-- ============================================================
-- SAMPLE CARRIER CODES (reference)
-- ============================================================
-- state_farm, allstate, progressive, geico, nationwide,
-- travelers, liberty_mutual, usaa, farmers, hartford,
-- chubb, aig, zurich, erie, auto_club, safeco,
-- american_family, mercury, kemper, bristol_west
