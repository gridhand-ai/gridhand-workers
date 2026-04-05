-- ============================================================
-- GRIDHAND AI — Claims Cleaner
-- Schema: Medical claims scrubbing, submission, denial tracking
-- ============================================================

-- Practice connections (one row per medical practice client)
CREATE TABLE IF NOT EXISTS cc_connections (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug               VARCHAR(100) UNIQUE NOT NULL,
    practice_name             VARCHAR(255) NOT NULL,
    billing_phone             VARCHAR(20),
    staff_phone               VARCHAR(20),

    -- Practice Management System
    pms_type                  VARCHAR(20) NOT NULL CHECK (pms_type IN ('athena', 'ecw', 'kareo')),
    pms_api_key               TEXT,
    pms_api_base_url          VARCHAR(500),
    pms_practice_id           VARCHAR(100),

    -- Clearinghouse
    clearinghouse_type        VARCHAR(30) NOT NULL CHECK (clearinghouse_type IN ('availity', 'change_healthcare', 'waystar')),
    clearinghouse_api_key     TEXT,
    clearinghouse_submitter_id VARCHAR(50),

    -- Provider identity
    npi                       VARCHAR(10),
    tax_id                    VARCHAR(9),
    taxonomy_code             VARCHAR(10),

    -- Operational settings
    timely_filing_days        INT DEFAULT 90,
    auto_correct_enabled      BOOLEAN DEFAULT true,

    created_at                TIMESTAMPTZ DEFAULT NOW(),
    updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Claims — one row per claim, tracks full lifecycle
CREATE TABLE IF NOT EXISTS cc_claims (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug            VARCHAR(100) NOT NULL REFERENCES cc_connections(client_slug) ON DELETE CASCADE,
    claim_id               VARCHAR(100),                          -- PMS reference ID
    patient_id             VARCHAR(100),
    patient_name           VARCHAR(255),

    dos                    DATE,                                  -- Date of Service
    payer_id               VARCHAR(50),
    payer_name             VARCHAR(255),
    member_id              VARCHAR(100),

    procedure_codes        JSONB DEFAULT '[]',                    -- [{cpt, modifier, units, charge}]
    diagnosis_codes        JSONB DEFAULT '[]',                    -- ICD-10 codes in order

    billed_amount          NUMERIC(10,2) DEFAULT 0,
    paid_amount            NUMERIC(10,2) DEFAULT 0,

    status                 VARCHAR(30) DEFAULT 'pending_scrub'
                           CHECK (status IN (
                               'pending_scrub','scrubbed','submitted','accepted',
                               'rejected','paid','denied','resubmitted','written_off'
                           )),

    -- Scrub results
    scrub_score            INT,
    scrub_errors           JSONB DEFAULT '[]',
    scrub_warnings         JSONB DEFAULT '[]',
    auto_corrections       JSONB DEFAULT '[]',

    -- Clearinghouse tracking
    tracking_id            VARCHAR(100),
    clearinghouse_status   VARCHAR(50),

    -- Denial info
    denial_code            VARCHAR(20),
    denial_reason          TEXT,

    -- Timestamps
    submitted_at           TIMESTAMPTZ,
    paid_at                TIMESTAMPTZ,
    denied_at              TIMESTAMPTZ,
    resubmission_count     INT DEFAULT 0,
    last_resubmit_at       TIMESTAMPTZ,

    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Denial log — one row per denial event
CREATE TABLE IF NOT EXISTS cc_denial_log (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug      VARCHAR(100) NOT NULL,
    claim_id         UUID REFERENCES cc_claims(id) ON DELETE SET NULL,
    denial_code      VARCHAR(20),
    denial_reason    TEXT,

    dos              DATE,
    payer_id         VARCHAR(50),
    procedure_code   VARCHAR(10),
    amount           NUMERIC(10,2),

    action_taken     VARCHAR(20) DEFAULT 'pending'
                     CHECK (action_taken IN ('resubmitted','appealed','written_off','pending')),
    action_at        TIMESTAMPTZ,
    recovered_amount NUMERIC(10,2),

    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ERA log — received Electronic Remittance Advice records
CREATE TABLE IF NOT EXISTS cc_era_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         VARCHAR(100) NOT NULL,
    era_date            DATE,
    clearinghouse_ref   VARCHAR(100),

    total_claims        INT DEFAULT 0,
    paid_count          INT DEFAULT 0,
    denied_count        INT DEFAULT 0,
    total_paid          NUMERIC(12,2) DEFAULT 0,

    raw_data            JSONB,
    processed_at        TIMESTAMPTZ,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- SMS log — outbound/inbound messages
CREATE TABLE IF NOT EXISTS cc_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     VARCHAR(100) NOT NULL,
    direction       VARCHAR(10) DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
    recipient_phone VARCHAR(20),
    message_body    TEXT,
    twilio_sid      VARCHAR(100),
    status          VARCHAR(30),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Weekly statistics — one row per client per week
CREATE TABLE IF NOT EXISTS cc_weekly_stats (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug           VARCHAR(100) NOT NULL,
    week_start            DATE NOT NULL,

    claims_scrubbed       INT DEFAULT 0,
    clean_claim_rate      NUMERIC(5,2) DEFAULT 0,   -- percentage
    auto_corrections_count INT DEFAULT 0,

    claims_submitted      INT DEFAULT 0,
    claims_paid           INT DEFAULT 0,
    claims_denied         INT DEFAULT 0,

    denial_rate           NUMERIC(5,2) DEFAULT 0,   -- percentage
    revenue_billed        NUMERIC(12,2) DEFAULT 0,
    revenue_collected     NUMERIC(12,2) DEFAULT 0,

    top_denial_codes      JSONB DEFAULT '[]',        -- [{code, reason, count}]

    created_at            TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (client_slug, week_start)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_cc_claims_client_slug      ON cc_claims(client_slug);
CREATE INDEX IF NOT EXISTS idx_cc_claims_status           ON cc_claims(status);
CREATE INDEX IF NOT EXISTS idx_cc_claims_dos              ON cc_claims(dos);
CREATE INDEX IF NOT EXISTS idx_cc_claims_payer_id         ON cc_claims(payer_id);
CREATE INDEX IF NOT EXISTS idx_cc_claims_tracking_id      ON cc_claims(tracking_id);
CREATE INDEX IF NOT EXISTS idx_cc_claims_denial_code      ON cc_claims(denial_code);
CREATE INDEX IF NOT EXISTS idx_cc_claims_patient_id       ON cc_claims(patient_id);

CREATE INDEX IF NOT EXISTS idx_cc_denial_log_client_slug  ON cc_denial_log(client_slug);
CREATE INDEX IF NOT EXISTS idx_cc_denial_log_claim_id     ON cc_denial_log(claim_id);
CREATE INDEX IF NOT EXISTS idx_cc_denial_log_denial_code  ON cc_denial_log(denial_code);
CREATE INDEX IF NOT EXISTS idx_cc_denial_log_payer_id     ON cc_denial_log(payer_id);

CREATE INDEX IF NOT EXISTS idx_cc_era_log_client_slug     ON cc_era_log(client_slug);
CREATE INDEX IF NOT EXISTS idx_cc_era_log_era_date        ON cc_era_log(era_date);

CREATE INDEX IF NOT EXISTS idx_cc_sms_log_client_slug     ON cc_sms_log(client_slug);

CREATE INDEX IF NOT EXISTS idx_cc_weekly_stats_client     ON cc_weekly_stats(client_slug);
CREATE INDEX IF NOT EXISTS idx_cc_weekly_stats_week       ON cc_weekly_stats(week_start);

-- ============================================================
-- TRIGGERS: keep updated_at current
-- ============================================================

CREATE OR REPLACE FUNCTION cc_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cc_connections_updated_at
    BEFORE UPDATE ON cc_connections
    FOR EACH ROW EXECUTE FUNCTION cc_set_updated_at();

CREATE TRIGGER cc_claims_updated_at
    BEFORE UPDATE ON cc_claims
    FOR EACH ROW EXECUTE FUNCTION cc_set_updated_at();
