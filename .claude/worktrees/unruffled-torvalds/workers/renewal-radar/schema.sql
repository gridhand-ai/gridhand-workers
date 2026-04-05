-- ============================================================
-- RENEWAL RADAR — Supabase Schema
-- Run in Supabase SQL editor
-- ============================================================

-- Policies synced from EZLynx
CREATE TABLE IF NOT EXISTS rr_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         TEXT NOT NULL,                     -- GRIDHAND client identifier
    ezlynx_policy_id    TEXT NOT NULL,                     -- EZLynx internal policy ID
    ezlynx_customer_id  TEXT,                              -- EZLynx customer/account ID
    policy_number       TEXT NOT NULL,
    carrier             TEXT NOT NULL,
    line_of_business    TEXT NOT NULL,                     -- auto, home, commercial, life, etc.
    status              TEXT DEFAULT 'active',             -- active, cancelled, lapsed, renewed
    insured_name        TEXT NOT NULL,
    insured_email       TEXT,
    insured_phone       TEXT,
    effective_date      DATE NOT NULL,
    expiration_date     DATE NOT NULL,
    annual_premium      NUMERIC(10,2),
    monthly_premium     NUMERIC(10,2),
    coverage_summary    JSONB DEFAULT '{}',                -- deductibles, limits, endorsements
    raw_data            JSONB DEFAULT '{}',                -- Full EZLynx response
    last_synced_at      TIMESTAMPTZ DEFAULT now(),
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(client_slug, ezlynx_policy_id)
);

CREATE INDEX IF NOT EXISTS idx_rr_policies_client ON rr_policies(client_slug);
CREATE INDEX IF NOT EXISTS idx_rr_policies_expiration ON rr_policies(expiration_date);
CREATE INDEX IF NOT EXISTS idx_rr_policies_status ON rr_policies(status);

-- Renewals pipeline (policies renewing within 60 days)
CREATE TABLE IF NOT EXISTS rr_renewals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         TEXT NOT NULL,
    policy_id           UUID NOT NULL REFERENCES rr_policies(id) ON DELETE CASCADE,
    renewal_date        DATE NOT NULL,
    days_until_renewal  INTEGER GENERATED ALWAYS AS (renewal_date - CURRENT_DATE) STORED,
    stage               TEXT DEFAULT 'detected',
    -- stages: detected → quotes_pulled → outreach_sent → agent_alerted → renewed | lost | unknown
    current_premium     NUMERIC(10,2),
    best_quote_premium  NUMERIC(10,2),                     -- Best alternative found
    best_quote_carrier  TEXT,
    savings_potential   NUMERIC(10,2) GENERATED ALWAYS AS (current_premium - best_quote_premium) STORED,
    outreach_count      INTEGER DEFAULT 0,
    agent_alerted       BOOLEAN DEFAULT false,
    outcome             TEXT,                              -- renewed_same, renewed_new_carrier, lost, pending
    outcome_premium     NUMERIC(10,2),                     -- Final premium after renewal
    outcome_carrier     TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(policy_id, renewal_date)
);

CREATE INDEX IF NOT EXISTS idx_rr_renewals_client ON rr_renewals(client_slug);
CREATE INDEX IF NOT EXISTS idx_rr_renewals_date ON rr_renewals(renewal_date);
CREATE INDEX IF NOT EXISTS idx_rr_renewals_stage ON rr_renewals(stage);

-- Carrier quotes pulled for renewals
CREATE TABLE IF NOT EXISTS rr_quotes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    renewal_id      UUID NOT NULL REFERENCES rr_renewals(id) ON DELETE CASCADE,
    policy_id       UUID NOT NULL REFERENCES rr_policies(id) ON DELETE CASCADE,
    client_slug     TEXT NOT NULL,
    carrier         TEXT NOT NULL,
    carrier_code    TEXT,                                  -- Internal carrier identifier
    quote_number    TEXT,
    annual_premium  NUMERIC(10,2),
    monthly_premium NUMERIC(10,2),
    status          TEXT DEFAULT 'success',               -- success, failed, declined, timeout
    error_message   TEXT,
    coverage_match  NUMERIC(3,2),                          -- 0.00-1.00, how close to current coverage
    raw_quote       JSONB DEFAULT '{}',                    -- Full carrier response
    pulled_at       TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rr_quotes_renewal ON rr_quotes(renewal_id);
CREATE INDEX IF NOT EXISTS idx_rr_quotes_client ON rr_quotes(client_slug);
CREATE INDEX IF NOT EXISTS idx_rr_quotes_carrier ON rr_quotes(carrier);

-- All outreach sent to clients and agents
CREATE TABLE IF NOT EXISTS rr_outreach_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    renewal_id      UUID REFERENCES rr_renewals(id) ON DELETE SET NULL,
    client_slug     TEXT NOT NULL,
    recipient_type  TEXT NOT NULL,                        -- client, agent
    recipient_name  TEXT,
    recipient_phone TEXT,
    recipient_email TEXT,
    channel         TEXT NOT NULL,                        -- sms, email
    template        TEXT,                                 -- which template was used
    message_body    TEXT,
    status          TEXT DEFAULT 'sent',                  -- sent, delivered, failed, bounced
    twilio_sid      TEXT,
    error_message   TEXT,
    sent_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rr_outreach_renewal ON rr_outreach_log(renewal_id);
CREATE INDEX IF NOT EXISTS idx_rr_outreach_client ON rr_outreach_log(client_slug);

-- Retention stats (aggregate, updated after each renewal resolves)
CREATE TABLE IF NOT EXISTS rr_retention_stats (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT NOT NULL,
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    total_renewals          INTEGER DEFAULT 0,
    renewed_same_carrier    INTEGER DEFAULT 0,
    renewed_new_carrier     INTEGER DEFAULT 0,
    lost                    INTEGER DEFAULT 0,
    pending                 INTEGER DEFAULT 0,
    retention_rate          NUMERIC(5,2),                 -- percentage retained
    total_premium_at_risk   NUMERIC(12,2),
    total_premium_retained  NUMERIC(12,2),
    total_premium_lost      NUMERIC(12,2),
    total_savings_achieved  NUMERIC(12,2),                -- how much clients saved vs current rate
    avg_days_to_outreach    NUMERIC(5,1),
    created_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE(client_slug, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_rr_stats_client ON rr_retention_stats(client_slug);

-- Weekly pipeline report snapshots
CREATE TABLE IF NOT EXISTS rr_weekly_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL,
    report_date     DATE NOT NULL,
    pipeline_data   JSONB NOT NULL,                       -- Full pipeline sorted by premium
    summary         TEXT,
    sent_to_agent   BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(client_slug, report_date)
);

-- ============================================================
-- Row Level Security (enable after setup)
-- ============================================================

ALTER TABLE rr_policies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE rr_renewals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE rr_quotes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE rr_outreach_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rr_retention_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE rr_weekly_reports  ENABLE ROW LEVEL SECURITY;

-- Service role bypass (server-side calls use service role key)
CREATE POLICY "service_role_all" ON rr_policies        FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON rr_renewals        FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON rr_quotes          FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON rr_outreach_log    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON rr_retention_stats FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON rr_weekly_reports  FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- Helper functions
-- ============================================================

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rr_policies_updated_at
    BEFORE UPDATE ON rr_policies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER rr_renewals_updated_at
    BEFORE UPDATE ON rr_renewals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
