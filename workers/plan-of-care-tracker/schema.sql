-- GRIDHAND Plan of Care Tracker — Supabase Schema
-- Tracks chiropractic/PT patients against their treatment plans

-- ─── EHR Connections ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poc_connections (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL UNIQUE,
    ehr_type            TEXT NOT NULL DEFAULT 'webpt',  -- 'webpt' | 'jane'
    api_key             TEXT,
    api_secret          TEXT,
    access_token        TEXT,
    refresh_token       TEXT,
    token_expires_at    TIMESTAMPTZ,
    location_id         TEXT,
    clinic_name         TEXT,
    owner_phone         TEXT,
    provider_phone      TEXT,
    reminder_hours      INT NOT NULL DEFAULT 24,   -- how many hours before visit to send reminder
    dropoff_threshold   INT NOT NULL DEFAULT 14,   -- days without visit before flagging as dropoff
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Treatment Plans ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treatment_plans (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT NOT NULL,
    patient_name        TEXT NOT NULL,
    patient_phone       TEXT,
    patient_email       TEXT,
    diagnosis_code      TEXT,
    diagnosis_label     TEXT,
    total_visits        INT,            -- number of visits prescribed
    visits_completed    INT NOT NULL DEFAULT 0,
    frequency_per_week  NUMERIC(4,1),   -- e.g., 2.5 visits/week
    plan_start_date     DATE,
    plan_end_date       DATE,
    status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'completed' | 'discharged' | 'dropoff'
    last_visit_date     DATE,
    next_scheduled_date DATE,
    dropoff_flagged     BOOLEAN NOT NULL DEFAULT FALSE,
    dropoff_flagged_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ehr_patient_id)
);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_client_status
    ON treatment_plans (client_slug, status);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_next_visit
    ON treatment_plans (client_slug, next_scheduled_date);

CREATE INDEX IF NOT EXISTS idx_treatment_plans_last_visit
    ON treatment_plans (client_slug, last_visit_date);

-- ─── Visit Records ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poc_visit_records (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT NOT NULL,
    ehr_appointment_id  TEXT NOT NULL,
    visit_date          DATE NOT NULL,
    visit_type          TEXT,           -- 'initial' | 'follow_up' | 'discharge'
    status              TEXT NOT NULL,  -- 'scheduled' | 'completed' | 'cancelled' | 'no_show'
    provider_name       TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ehr_appointment_id)
);

CREATE INDEX IF NOT EXISTS idx_poc_visits_patient
    ON poc_visit_records (client_slug, ehr_patient_id, visit_date DESC);

-- ─── Alert Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poc_alerts (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT,
    alert_type          TEXT NOT NULL,  -- 'visit_reminder' | 'dropoff_warning' | 'plan_complete' | 'provider_summary'
    recipient           TEXT NOT NULL,
    message_body        TEXT NOT NULL,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_poc_alerts_client_type
    ON poc_alerts (client_slug, alert_type, sent_at DESC);
