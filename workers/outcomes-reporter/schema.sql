-- GRIDHAND Outcomes Reporter — Supabase Schema
-- Tracks patient functional improvements and generates insurance outcome reports

-- ─── EHR Connections ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outcome_connections (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL UNIQUE,
    ehr_type            TEXT NOT NULL DEFAULT 'webpt',  -- 'webpt' | 'prompt'
    api_key             TEXT,
    api_secret          TEXT,
    access_token        TEXT,
    refresh_token       TEXT,
    token_expires_at    TIMESTAMPTZ,
    location_id         TEXT,
    clinic_name         TEXT,
    owner_phone         TEXT,
    report_frequency    TEXT NOT NULL DEFAULT 'monthly',  -- 'weekly' | 'biweekly' | 'monthly'
    auto_send_reports   BOOLEAN NOT NULL DEFAULT FALSE,
    report_recipient_email TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Patient Outcome Records ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_outcomes (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT NOT NULL,
    patient_name        TEXT NOT NULL,
    patient_dob         DATE,
    insurance_company   TEXT,
    claim_number        TEXT,
    injury_date         DATE,
    diagnosis_code      TEXT,
    diagnosis_label     TEXT,
    initial_pain_score  INT,   -- 0-10 numeric pain scale
    current_pain_score  INT,
    initial_function_score NUMERIC(5,2),  -- e.g., Oswestry, Neck Disability Index
    current_function_score NUMERIC(5,2),
    outcome_measure     TEXT,  -- 'oswestry' | 'ndi' | 'dash' | 'groc' | 'psfs'
    visits_at_eval      INT,
    goals_met           TEXT,  -- JSON array of goals with achieved status
    discharge_ready     BOOLEAN NOT NULL DEFAULT FALSE,
    last_eval_date      DATE,
    next_eval_due       DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ehr_patient_id)
);

CREATE INDEX IF NOT EXISTS idx_patient_outcomes_client
    ON patient_outcomes (client_slug, last_eval_date DESC);

CREATE INDEX IF NOT EXISTS idx_patient_outcomes_insurance
    ON patient_outcomes (client_slug, insurance_company);

CREATE INDEX IF NOT EXISTS idx_patient_outcomes_next_eval
    ON patient_outcomes (client_slug, next_eval_due);

-- ─── Functional Score History ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS functional_score_history (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT NOT NULL,
    eval_date           DATE NOT NULL,
    visits_completed    INT,
    pain_score          INT,
    function_score      NUMERIC(5,2),
    outcome_measure     TEXT,
    percent_improvement NUMERIC(5,2),  -- calculated vs initial
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ehr_patient_id, eval_date)
);

CREATE INDEX IF NOT EXISTS idx_functional_scores_patient
    ON functional_score_history (client_slug, ehr_patient_id, eval_date DESC);

-- ─── Generated Outcome Reports ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outcome_reports (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT NOT NULL,
    report_date         DATE NOT NULL,
    report_type         TEXT NOT NULL,  -- 'progress_report' | 'discharge_summary' | 'functional_capacity'
    insurance_company   TEXT,
    claim_number        TEXT,
    report_body         TEXT NOT NULL,  -- full report text
    sent_to             TEXT,
    sent_at             TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'generated',  -- 'generated' | 'sent' | 'failed'
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, ehr_patient_id, report_date, report_type)
);

CREATE INDEX IF NOT EXISTS idx_outcome_reports_client
    ON outcome_reports (client_slug, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_outcome_reports_status
    ON outcome_reports (client_slug, status);

-- ─── Alert Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outcome_alerts (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    ehr_patient_id      TEXT,
    alert_type          TEXT NOT NULL,  -- 'eval_due' | 'report_generated' | 'report_sent' | 'improvement_milestone'
    recipient           TEXT NOT NULL,
    message_body        TEXT NOT NULL,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outcome_alerts_client
    ON outcome_alerts (client_slug, alert_type, sent_at DESC);
