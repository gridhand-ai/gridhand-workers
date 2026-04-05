-- GRIDHAND Compliance Watchdog — Supabase Schema
-- Tracks insurance agent licenses, CE credits, and carrier appointments

-- ─── Agency Connections ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_connections (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL UNIQUE,
    ams_type            TEXT NOT NULL DEFAULT 'applied_epic',  -- 'applied_epic' | 'hawksoft'
    ams_api_key         TEXT,
    ams_api_secret      TEXT,
    ams_base_url        TEXT,
    agency_name         TEXT,
    owner_phone         TEXT,
    state_codes         TEXT[],          -- states the agency operates in (e.g., ['WI', 'IL', 'MN'])
    alert_days_ahead    INT[] NOT NULL DEFAULT '{90,60,30,14}',  -- alert thresholds in days before expiry
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Agent Licenses ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_licenses (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ams_agent_id        TEXT NOT NULL,
    agent_name          TEXT NOT NULL,
    agent_email         TEXT,
    agent_phone         TEXT,
    license_number      TEXT NOT NULL,
    license_type        TEXT NOT NULL,   -- 'property_casualty' | 'life_health' | 'surplus_lines' | etc.
    state_code          TEXT NOT NULL,
    issue_date          DATE,
    expiration_date     DATE NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'suspended' | 'cancelled'
    last_checked_at     TIMESTAMPTZ,
    doi_verified        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ams_agent_id, license_number, state_code)
);

CREATE INDEX IF NOT EXISTS idx_agent_licenses_expiry
    ON agent_licenses (client_slug, expiration_date, status);

CREATE INDEX IF NOT EXISTS idx_agent_licenses_agent
    ON agent_licenses (client_slug, ams_agent_id);

-- ─── CE Requirements ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ce_requirements (
    id                      BIGSERIAL PRIMARY KEY,
    client_slug             TEXT NOT NULL,
    ams_agent_id            TEXT NOT NULL,
    agent_name              TEXT NOT NULL,
    state_code              TEXT NOT NULL,
    license_type            TEXT NOT NULL,
    renewal_period_end      DATE NOT NULL,     -- when CE must be complete by
    hours_required          NUMERIC(5,1) NOT NULL,
    hours_completed         NUMERIC(5,1) NOT NULL DEFAULT 0,
    hours_remaining         NUMERIC(5,1) GENERATED ALWAYS AS (GREATEST(hours_required - hours_completed, 0)) STORED,
    ethics_hours_required   NUMERIC(5,1) NOT NULL DEFAULT 0,
    ethics_hours_completed  NUMERIC(5,1) NOT NULL DEFAULT 0,
    status                  TEXT NOT NULL DEFAULT 'in_progress',  -- 'in_progress' | 'completed' | 'overdue'
    last_synced_at          TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ams_agent_id, state_code, renewal_period_end)
);

CREATE INDEX IF NOT EXISTS idx_ce_requirements_deadline
    ON ce_requirements (client_slug, renewal_period_end, status);

-- ─── Carrier Appointments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carrier_appointments (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ams_agent_id        TEXT NOT NULL,
    agent_name          TEXT NOT NULL,
    carrier_name        TEXT NOT NULL,
    carrier_naic        TEXT,
    state_code          TEXT NOT NULL,
    appointment_type    TEXT,           -- 'property_casualty' | 'life' | 'health' | etc.
    effective_date      DATE,
    expiration_date     DATE,           -- NULL = no set expiry
    renewal_date        DATE,
    status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'terminated' | 'pending'
    termination_reason  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ams_agent_id, carrier_name, state_code, appointment_type)
);

CREATE INDEX IF NOT EXISTS idx_carrier_appointments_expiry
    ON carrier_appointments (client_slug, expiration_date, status);

-- ─── Compliance Alerts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_alerts (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ams_agent_id        TEXT,
    alert_type          TEXT NOT NULL,  -- 'license_expiring' | 'license_expired' | 'ce_behind' | 'appointment_expiring' | 'doi_mismatch'
    days_until_expiry   INT,
    item_id             TEXT,           -- license number, carrier name, etc.
    item_description    TEXT,
    recipient           TEXT NOT NULL,
    message_body        TEXT NOT NULL,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ams_agent_id, alert_type, item_id, sent_at::DATE)
);

CREATE INDEX IF NOT EXISTS idx_compliance_alerts_client
    ON compliance_alerts (client_slug, alert_type, sent_at DESC);
