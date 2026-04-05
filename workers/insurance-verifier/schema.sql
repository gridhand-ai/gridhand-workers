-- ============================================================
-- GRIDHAND AI — Insurance Verifier
-- Database Schema
-- ============================================================

-- Practice connections (one row per dental practice)
CREATE TABLE IF NOT EXISTS iv_connections (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                     TEXT NOT NULL UNIQUE,
    practice_name                   TEXT NOT NULL,
    owner_phone                     TEXT,
    front_desk_phone                TEXT,

    -- PMS (Practice Management Software)
    pms_type                        TEXT NOT NULL CHECK (pms_type IN ('dentrix', 'open_dental')),
    pms_api_key                     TEXT,
    pms_api_base_url                TEXT,

    -- Eligibility provider
    eligibility_provider            TEXT NOT NULL CHECK (eligibility_provider IN ('vyne', 'dentalxchange')),
    eligibility_api_key             TEXT,
    eligibility_npi                 TEXT,   -- Billing NPI for eligibility requests

    -- Behavior settings
    notify_staff_on_flag            BOOLEAN NOT NULL DEFAULT true,
    cost_estimate_sms_enabled       BOOLEAN NOT NULL DEFAULT true,
    hours_before_appointment_to_verify INT NOT NULL DEFAULT 48,

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Verifications — one row per appointment verification run
-- ============================================================
CREATE TABLE IF NOT EXISTS iv_verifications (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                 TEXT NOT NULL REFERENCES iv_connections(client_slug) ON DELETE CASCADE,
    appointment_id              TEXT NOT NULL,       -- PMS appointment ID
    patient_id                  TEXT NOT NULL,       -- PMS patient ID
    patient_name                TEXT,
    patient_phone               TEXT,
    appointment_date            DATE NOT NULL,
    procedures                  JSONB DEFAULT '[]',  -- Array of { ada_code, description }

    -- Insurance details at time of verification
    insurance_carrier           TEXT,
    member_id                   TEXT,
    group_number                TEXT,
    subscriber_name             TEXT,

    -- Verification result
    status                      TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'verified', 'flagged', 'inactive', 'error')),
    eligible                    BOOLEAN,
    deductible_remaining        NUMERIC(10, 2),
    annual_max_remaining        NUMERIC(10, 2),
    coverage_percent            NUMERIC(5, 2),
    estimated_patient_portion   NUMERIC(10, 2),
    flags                       JSONB NOT NULL DEFAULT '[]',
    raw_response                JSONB,

    -- Tracking
    cost_estimate_sent_at       TIMESTAMPTZ,
    verified_at                 TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Flag log — granular record of each flagged issue
-- ============================================================
CREATE TABLE IF NOT EXISTS iv_flag_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         TEXT NOT NULL REFERENCES iv_connections(client_slug) ON DELETE CASCADE,
    verification_id     UUID NOT NULL REFERENCES iv_verifications(id) ON DELETE CASCADE,
    flag_type           TEXT NOT NULL,          -- e.g. 'inactive_coverage', 'waiting_period', 'freq_limit'
    flag_description    TEXT NOT NULL,
    resolved            BOOLEAN NOT NULL DEFAULT false,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SMS log — inbound and outbound messages
-- ============================================================
CREATE TABLE IF NOT EXISTS iv_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL REFERENCES iv_connections(client_slug) ON DELETE CASCADE,
    patient_id      TEXT,
    appointment_id  TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_body    TEXT NOT NULL,
    twilio_sid      TEXT,
    status          TEXT,           -- delivered, failed, etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Daily stats — one row per (client_slug, stat_date)
-- ============================================================
CREATE TABLE IF NOT EXISTS iv_daily_stats (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT NOT NULL REFERENCES iv_connections(client_slug) ON DELETE CASCADE,
    stat_date               DATE NOT NULL,
    appointments_verified   INT NOT NULL DEFAULT 0,
    flagged_count           INT NOT NULL DEFAULT 0,
    inactive_count          INT NOT NULL DEFAULT 0,
    estimates_sent          INT NOT NULL DEFAULT 0,
    avg_patient_portion     NUMERIC(10, 2),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (client_slug, stat_date)
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_iv_verifications_client_slug     ON iv_verifications (client_slug);
CREATE INDEX IF NOT EXISTS idx_iv_verifications_appointment_date ON iv_verifications (appointment_date);
CREATE INDEX IF NOT EXISTS idx_iv_verifications_status          ON iv_verifications (status);
CREATE INDEX IF NOT EXISTS idx_iv_verifications_appointment_id  ON iv_verifications (appointment_id);

CREATE INDEX IF NOT EXISTS idx_iv_flag_log_client_slug          ON iv_flag_log (client_slug);
CREATE INDEX IF NOT EXISTS idx_iv_flag_log_verification_id      ON iv_flag_log (verification_id);
CREATE INDEX IF NOT EXISTS idx_iv_flag_log_resolved             ON iv_flag_log (resolved);

CREATE INDEX IF NOT EXISTS idx_iv_sms_log_client_slug           ON iv_sms_log (client_slug);
CREATE INDEX IF NOT EXISTS idx_iv_sms_log_appointment_id        ON iv_sms_log (appointment_id);

CREATE INDEX IF NOT EXISTS idx_iv_daily_stats_client_slug       ON iv_daily_stats (client_slug);
CREATE INDEX IF NOT EXISTS idx_iv_daily_stats_stat_date         ON iv_daily_stats (stat_date);

-- ============================================================
-- Auto-update updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION iv_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_iv_connections_updated_at
    BEFORE UPDATE ON iv_connections
    FOR EACH ROW EXECUTE FUNCTION iv_set_updated_at();

CREATE TRIGGER trg_iv_verifications_updated_at
    BEFORE UPDATE ON iv_verifications
    FOR EACH ROW EXECUTE FUNCTION iv_set_updated_at();
