-- ============================================================
-- GridHand AI — Cross-Sell Scanner Schema
-- Run in Supabase SQL editor
-- ============================================================

-- Agency configurations (one row per insurance agency client)
CREATE TABLE IF NOT EXISTS css_agencies (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             TEXT UNIQUE NOT NULL,          -- e.g. "wilson-insurance"
    name             TEXT NOT NULL,
    ams_type         TEXT NOT NULL,                 -- 'hawksoft' | 'applied_epic' | 'manual'
    ams_credentials  JSONB,                         -- encrypted at rest via Supabase Vault
    twilio_number    TEXT,
    agent_phone      TEXT,                          -- where SMS alerts go
    twilio_account_sid TEXT,
    twilio_auth_token  TEXT,
    anthropic_api_key  TEXT,
    settings         JSONB DEFAULT '{}',
    active           BOOLEAN DEFAULT true,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Clients imported from AMS (insureds / policyholders)
CREATE TABLE IF NOT EXISTS css_clients (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    ams_client_id    TEXT NOT NULL,                 -- AMS system's own ID
    full_name        TEXT NOT NULL,
    email            TEXT,
    phone            TEXT,
    address          JSONB,                         -- {street, city, state, zip}
    date_of_birth    DATE,
    client_since     DATE,
    household_size   INT,
    annual_income    NUMERIC,
    ams_raw          JSONB,                         -- full AMS payload, unmodified
    last_synced_at   TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agency_id, ams_client_id)
);

-- Policies pulled from AMS
CREATE TABLE IF NOT EXISTS css_policies (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    client_id        UUID REFERENCES css_clients(id) ON DELETE CASCADE,
    ams_policy_id    TEXT NOT NULL,
    line_of_business TEXT NOT NULL,                 -- 'auto' | 'home' | 'life' | 'umbrella' | 'flood' | 'commercial' | etc.
    carrier          TEXT,
    policy_number    TEXT,
    effective_date   DATE,
    expiration_date  DATE,
    annual_premium   NUMERIC,
    coverage_limit   NUMERIC,
    deductible       NUMERIC,
    status           TEXT DEFAULT 'active',         -- 'active' | 'lapsed' | 'cancelled'
    coverage_details JSONB,                         -- full coverage breakdown from AMS
    ams_raw          JSONB,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agency_id, ams_policy_id)
);

-- Coverage gaps identified by the analyzer
CREATE TABLE IF NOT EXISTS css_coverage_gaps (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    client_id        UUID REFERENCES css_clients(id) ON DELETE CASCADE,
    gap_type         TEXT NOT NULL,                 -- 'missing_umbrella' | 'missing_flood' | 'low_life_coverage' | etc.
    description      TEXT NOT NULL,
    existing_line    TEXT,                          -- the policy line they DO have
    missing_line     TEXT NOT NULL,                 -- what they're missing
    severity         TEXT DEFAULT 'medium',         -- 'low' | 'medium' | 'high' | 'critical'
    dismissed        BOOLEAN DEFAULT false,
    dismissed_at     TIMESTAMPTZ,
    dismissed_reason TEXT,
    detected_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_id, gap_type)
);

-- Scored cross-sell / upsell opportunities
CREATE TABLE IF NOT EXISTS css_opportunities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id           UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    client_id           UUID REFERENCES css_clients(id) ON DELETE CASCADE,
    gap_id              UUID REFERENCES css_coverage_gaps(id),
    opportunity_type    TEXT NOT NULL,              -- e.g. 'umbrella', 'flood', 'life', 'commercial_auto'
    title               TEXT NOT NULL,
    estimated_premium   NUMERIC,                    -- estimated new annual premium
    conversion_score    NUMERIC,                    -- 0-100 likelihood score
    revenue_score       NUMERIC,                    -- 0-100 revenue potential score
    composite_score     NUMERIC,                    -- final ranked score
    scoring_factors     JSONB,                      -- breakdown of what drove the score
    status              TEXT DEFAULT 'open',        -- 'open' | 'outreach_sent' | 'converted' | 'dismissed' | 'lost'
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Life events that trigger cross-sell opportunities
CREATE TABLE IF NOT EXISTS css_life_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    client_id        UUID REFERENCES css_clients(id) ON DELETE CASCADE,
    event_type       TEXT NOT NULL,                 -- 'new_home' | 'new_vehicle' | 'marriage' | 'new_baby' | 'retirement'
    detected_source  TEXT,                          -- 'ams_new_policy' | 'ams_endorsement' | 'manual'
    event_date       DATE,
    details          JSONB,
    opportunities_triggered JSONB,                  -- array of opportunity_ids created from this event
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Outreach messages sent to clients
CREATE TABLE IF NOT EXISTS css_outreach_log (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    opportunity_id   UUID REFERENCES css_opportunities(id),
    client_id        UUID REFERENCES css_clients(id) ON DELETE CASCADE,
    channel          TEXT DEFAULT 'sms',            -- 'sms' | 'email' (future)
    message_body     TEXT NOT NULL,
    sent_to          TEXT,                          -- agent phone or client phone
    sent_at          TIMESTAMPTZ DEFAULT NOW(),
    delivered        BOOLEAN,
    opened           BOOLEAN DEFAULT false,
    opened_at        TIMESTAMPTZ,
    replied          BOOLEAN DEFAULT false,
    replied_at       TIMESTAMPTZ,
    twilio_sid       TEXT                           -- Twilio message SID for delivery tracking
);

-- Conversion tracking (when a cross-sell actually closes)
CREATE TABLE IF NOT EXISTS css_conversions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    opportunity_id   UUID REFERENCES css_opportunities(id),
    outreach_id      UUID REFERENCES css_outreach_log(id),
    client_id        UUID REFERENCES css_clients(id) ON DELETE CASCADE,
    policy_written   TEXT,                          -- new line of business written
    premium_written  NUMERIC,                       -- actual premium booked
    converted_at     TIMESTAMPTZ DEFAULT NOW(),
    notes            TEXT
);

-- Weekly opportunity reports
CREATE TABLE IF NOT EXISTS css_weekly_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    week_start       DATE NOT NULL,
    week_end         DATE NOT NULL,
    top_opportunities JSONB,                        -- top 10 ranked opportunities
    total_open       INT DEFAULT 0,
    total_outreach   INT DEFAULT 0,
    total_converted  INT DEFAULT 0,
    estimated_pipeline NUMERIC DEFAULT 0,
    report_text      TEXT,
    generated_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agency_id, week_start)
);

-- Monthly revenue attribution reports
CREATE TABLE IF NOT EXISTS css_monthly_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id        UUID REFERENCES css_agencies(id) ON DELETE CASCADE,
    month            DATE NOT NULL,                 -- first day of month
    new_premium_written NUMERIC DEFAULT 0,
    policies_written INT DEFAULT 0,
    outreach_sent    INT DEFAULT 0,
    outreach_converted INT DEFAULT 0,
    conversion_rate  NUMERIC DEFAULT 0,
    top_lines        JSONB,                         -- breakdown by line of business
    report_text      TEXT,
    generated_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agency_id, month)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_css_clients_agency    ON css_clients(agency_id);
CREATE INDEX IF NOT EXISTS idx_css_policies_client   ON css_policies(client_id);
CREATE INDEX IF NOT EXISTS idx_css_policies_lob      ON css_policies(line_of_business);
CREATE INDEX IF NOT EXISTS idx_css_gaps_client       ON css_coverage_gaps(client_id);
CREATE INDEX IF NOT EXISTS idx_css_opps_status       ON css_opportunities(status);
CREATE INDEX IF NOT EXISTS idx_css_opps_score        ON css_opportunities(composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_css_outreach_opp      ON css_outreach_log(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_css_conversions_opp   ON css_conversions(opportunity_id);

-- ============================================================
-- Row-level security: restrict to agency slug
-- ============================================================

ALTER TABLE css_agencies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_clients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_policies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_coverage_gaps    ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_opportunities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_outreach_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_conversions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_life_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_weekly_reports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE css_monthly_reports  ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (used by this worker)
-- Client-facing policies would be added here when building a portal
