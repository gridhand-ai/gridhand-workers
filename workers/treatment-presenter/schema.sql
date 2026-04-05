-- ============================================================
-- GRIDHAND AI — Treatment Presenter
-- Database Schema
-- ============================================================

-- ============================================================
-- 1. tp_connections
-- Dental practice configuration and PMS credentials
-- ============================================================

CREATE TABLE IF NOT EXISTS tp_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT UNIQUE NOT NULL,
    practice_name           TEXT NOT NULL,
    owner_phone             TEXT NOT NULL,
    front_desk_phone        TEXT NOT NULL,

    -- PMS integration
    pms_type                TEXT NOT NULL CHECK (pms_type IN ('dentrix', 'open_dental')),
    pms_api_key             TEXT NOT NULL,
    pms_api_base_url        TEXT NOT NULL,

    -- Patient-facing content
    financing_options_text  TEXT,               -- e.g. "CareCredit and Sunbit financing available"
    schedule_link           TEXT,               -- online booking URL for SMS links

    -- Feature flags
    followup_enabled        BOOLEAN NOT NULL DEFAULT true,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tp_connections_client_slug ON tp_connections (client_slug);

-- ============================================================
-- 2. tp_plans
-- Treatment plans being tracked through the presentation flow
-- ============================================================

CREATE TABLE IF NOT EXISTS tp_plans (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT NOT NULL REFERENCES tp_connections (client_slug) ON DELETE CASCADE,

    -- PMS identifiers
    plan_id                 TEXT NOT NULL,              -- PMS-assigned treatment plan ID
    patient_id              TEXT NOT NULL,              -- PMS patient ID
    patient_name            TEXT NOT NULL,
    patient_phone           TEXT NOT NULL,

    -- Procedure data (JSON array from PMS)
    -- Each element: { ada_code, description, fee, insurance_est, patient_portion, tooth, surface }
    procedures              JSONB NOT NULL DEFAULT '[]',

    -- Financial totals
    total_fee               NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_insurance_est     NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_patient_portion   NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- AI-generated plain language summary
    plain_summary           TEXT,

    -- Workflow status
    status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN (
                                    'pending',      -- fetched from PMS, not yet texted
                                    'contacted',    -- initial SMS sent, awaiting response
                                    'interested',   -- patient replied positively
                                    'accepted',     -- patient scheduled / confirmed
                                    'declined',     -- patient replied no
                                    'stale',        -- 30+ days no response, removed from active follow-up
                                    'opted_out'     -- patient replied STOP
                                )),

    -- Contact tracking
    contact_count           INT NOT NULL DEFAULT 0,
    last_contact_at         TIMESTAMPTZ,

    -- Outcome timestamps
    accepted_at             TIMESTAMPTZ,
    declined_at             TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tp_plans_client_slug   ON tp_plans (client_slug);
CREATE INDEX IF NOT EXISTS idx_tp_plans_status        ON tp_plans (status);
CREATE INDEX IF NOT EXISTS idx_tp_plans_patient_id    ON tp_plans (patient_id);
CREATE INDEX IF NOT EXISTS idx_tp_plans_plan_id       ON tp_plans (plan_id);

-- Unique constraint: one DB row per PMS plan per practice
CREATE UNIQUE INDEX IF NOT EXISTS idx_tp_plans_client_plan
    ON tp_plans (client_slug, plan_id);

-- ============================================================
-- 3. tp_sms_log
-- All SMS messages sent and received
-- ============================================================

CREATE TABLE IF NOT EXISTS tp_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL,
    plan_id         UUID REFERENCES tp_plans (id) ON DELETE SET NULL,   -- FK to tp_plans.id (our UUID, not PMS plan_id)
    patient_id      TEXT,                                                -- PMS patient ID (for context)
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_body    TEXT NOT NULL,
    twilio_sid      TEXT,
    status          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tp_sms_log_client_slug ON tp_sms_log (client_slug);
CREATE INDEX IF NOT EXISTS idx_tp_sms_log_plan_id     ON tp_sms_log (plan_id);
CREATE INDEX IF NOT EXISTS idx_tp_sms_log_patient_id  ON tp_sms_log (patient_id);

-- ============================================================
-- 4. tp_weekly_stats
-- Weekly acceptance rate and revenue pipeline snapshots
-- ============================================================

CREATE TABLE IF NOT EXISTS tp_weekly_stats (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         TEXT NOT NULL,
    week_start          DATE NOT NULL,          -- Monday date of the reporting week

    -- Plan counts for the week
    plans_presented     INT NOT NULL DEFAULT 0,
    plans_accepted      INT NOT NULL DEFAULT 0,
    plans_declined      INT NOT NULL DEFAULT 0,
    plans_pending       INT NOT NULL DEFAULT 0,

    -- Computed acceptance rate (stored for query performance)
    -- plans_accepted / NULLIF(plans_presented, 0) * 100
    acceptance_rate     NUMERIC(5,2) GENERATED ALWAYS AS (
                            plans_accepted::numeric / NULLIF(plans_presented, 0) * 100
                        ) STORED,

    -- Revenue metrics (patient portion estimates)
    revenue_pipeline    NUMERIC(12,2) NOT NULL DEFAULT 0,    -- all plans presented
    revenue_accepted    NUMERIC(12,2) NOT NULL DEFAULT 0,    -- accepted plans only

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tp_weekly_stats_client_week
    ON tp_weekly_stats (client_slug, week_start);

CREATE INDEX IF NOT EXISTS idx_tp_weekly_stats_client_slug ON tp_weekly_stats (client_slug);
CREATE INDEX IF NOT EXISTS idx_tp_weekly_stats_week_start  ON tp_weekly_stats (week_start);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION tp_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tp_connections_updated_at
    BEFORE UPDATE ON tp_connections
    FOR EACH ROW EXECUTE FUNCTION tp_set_updated_at();

CREATE TRIGGER tp_plans_updated_at
    BEFORE UPDATE ON tp_plans
    FOR EACH ROW EXECUTE FUNCTION tp_set_updated_at();
