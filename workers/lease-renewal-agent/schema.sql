-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Lease Renewal Agent — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- PMS + DocuSign + Email connections (one per client)
CREATE TABLE IF NOT EXISTS lra_connections (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug             TEXT NOT NULL UNIQUE,
    -- PMS: AppFolio or Buildium
    pms_type                TEXT DEFAULT 'appfolio',  -- appfolio | buildium
    appfolio_database_name  TEXT,
    appfolio_api_username   TEXT,
    appfolio_api_password   TEXT,
    buildium_client_id      TEXT,
    buildium_client_secret  TEXT,
    buildium_access_token   TEXT,
    buildium_expires_at     TIMESTAMPTZ,
    -- DocuSign
    docusign_account_id     TEXT,
    docusign_access_token   TEXT,
    docusign_refresh_token  TEXT,
    docusign_expires_at     TIMESTAMPTZ,
    docusign_template_id    TEXT,                     -- DocuSign template ID for lease renewal
    -- Email
    smtp_host               TEXT,
    smtp_port               INT DEFAULT 587,
    smtp_user               TEXT,
    smtp_pass               TEXT,
    from_email              TEXT,
    -- Settings
    owner_phone             TEXT NOT NULL,
    owner_email             TEXT,
    business_name           TEXT,
    renewal_notice_days     INT DEFAULT 60,           -- days before expiry to send renewal offer
    rent_increase_pct       NUMERIC(5,4) DEFAULT 0.03, -- default 3% rent increase on renewal
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Lease renewal pipeline (one row per lease per renewal cycle)
CREATE TABLE IF NOT EXISTS lra_renewals (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    pms_lease_id        TEXT NOT NULL,
    -- Tenant / Property
    tenant_name         TEXT NOT NULL,
    tenant_email        TEXT,
    tenant_phone        TEXT,
    property_address    TEXT,
    unit_number         TEXT,
    -- Current Lease
    current_rent        NUMERIC(10,2) NOT NULL,
    lease_end_date      DATE NOT NULL,
    -- Renewal Offer
    offered_rent        NUMERIC(10,2),               -- rent being offered for renewal
    offered_term_months INT DEFAULT 12,
    new_lease_start     DATE,
    new_lease_end       DATE,
    -- Pipeline Status
    status              TEXT DEFAULT 'pending',       -- pending | offer_sent | negotiating | accepted | declined | expired | signed
    -- Communication Log
    offer_sent_at       TIMESTAMPTZ,
    offer_method        TEXT,                         -- email | sms | both
    response_received_at TIMESTAMPTZ,
    tenant_response     TEXT,                         -- accepted | declined | counter_offer
    counter_rent        NUMERIC(10,2),               -- if tenant countered
    -- DocuSign
    docusign_envelope_id TEXT,
    docusign_sent_at    TIMESTAMPTZ,
    docusign_signed_at  TIMESTAMPTZ,
    -- Tracking
    days_until_expiry   INT GENERATED ALWAYS AS (
        EXTRACT(DAY FROM (lease_end_date::TIMESTAMPTZ - NOW()))::INT
    ) STORED,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, pms_lease_id)
);

-- Communication log (all emails/SMS sent per renewal)
CREATE TABLE IF NOT EXISTS lra_communications (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    renewal_id      UUID REFERENCES lra_renewals(id),
    channel         TEXT NOT NULL,   -- email | sms | docusign
    direction       TEXT NOT NULL,   -- outbound | inbound
    recipient       TEXT NOT NULL,
    subject         TEXT,
    message_body    TEXT NOT NULL,
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lra_renewals_client_status ON lra_renewals (client_slug, status);
CREATE INDEX IF NOT EXISTS idx_lra_renewals_expiry ON lra_renewals (client_slug, lease_end_date);
CREATE INDEX IF NOT EXISTS idx_lra_comms_renewal ON lra_communications (renewal_id, created_at DESC);
