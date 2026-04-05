-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Intake Accelerator — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Clio OAuth connections + PracticePanther API key (one row per law firm)
CREATE TABLE IF NOT EXISTS clio_connections (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug           TEXT NOT NULL UNIQUE,
    access_token          TEXT,
    refresh_token         TEXT,
    expires_at            TIMESTAMPTZ,
    clio_user_id          TEXT,
    owner_phone           TEXT NOT NULL,           -- firm owner / managing attorney
    attorney_phone        TEXT,                    -- intake attorney on duty
    practice_name         TEXT,
    practicepanther_key   TEXT,                    -- API key for PracticePanther (alternative PMS)
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- New client inquiries — one row per inbound lead
CREATE TABLE IF NOT EXISTS inquiries (
    id                       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug              TEXT NOT NULL,
    contact_name             TEXT,
    contact_phone            TEXT NOT NULL,
    contact_email            TEXT,
    practice_area            TEXT,                 -- personal_injury | family_law | criminal | business | estate
    inquiry_source           TEXT NOT NULL DEFAULT 'web_form', -- web_form | phone | referral | sms
    inquiry_text             TEXT,                 -- raw message or notes
    status                   TEXT NOT NULL DEFAULT 'new', -- new | in_progress | completed | scheduled | declined
    questionnaire_step       INT NOT NULL DEFAULT 0,
    questionnaire_answers    JSONB DEFAULT '[]'::jsonb,
    clio_contact_id          TEXT,                 -- Clio contact record ID (set after intake completes)
    clio_matter_id           TEXT,                 -- Clio matter record ID
    consultation_scheduled_at TIMESTAMPTZ,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Individual questionnaire exchanges (one row per question/answer pair)
CREATE TABLE IF NOT EXISTS questionnaire_sessions (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    inquiry_id    UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    step          INT NOT NULL,
    question_text TEXT NOT NULL,
    answer_text   TEXT,
    answered_at   TIMESTAMPTZ
);

-- Alert log (every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS intake_alerts (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug   TEXT NOT NULL,
    alert_type    TEXT NOT NULL,  -- new_inquiry | questionnaire_step | intake_complete | consultation_scheduled | follow_up | human_escalation | daily_report | weekly_report
    recipient     TEXT NOT NULL,  -- phone number
    message_body  TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_inquiries_client_status
    ON inquiries (client_slug, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inquiries_phone
    ON inquiries (contact_phone);

CREATE INDEX IF NOT EXISTS idx_questionnaire_inquiry
    ON questionnaire_sessions (inquiry_id, step);

CREATE INDEX IF NOT EXISTS idx_intake_alerts_client
    ON intake_alerts (client_slug, alert_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clio_connections_slug
    ON clio_connections (client_slug);
