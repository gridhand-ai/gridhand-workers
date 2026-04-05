-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Vaccine Reminder — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Veterinary practice connections (one per client)
CREATE TABLE IF NOT EXISTS vet_connections (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug      TEXT NOT NULL UNIQUE,
    evet_base_url    TEXT NOT NULL,                     -- eVetPractice API base URL
    evet_api_key     TEXT NOT NULL,                     -- eVetPractice API key
    petdesk_api_key  TEXT,                              -- PetDesk API key (optional)
    owner_phone      TEXT NOT NULL,                     -- practice phone for SMS replies / as practice contact
    practice_name    TEXT NOT NULL,                     -- displayed in SMS messages
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Vaccine reminder tracker (one row per patient + vaccine combination)
-- Drives throttling — prevents sending the same reminder twice within 14 days
CREATE TABLE IF NOT EXISTS vaccine_reminders (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    patient_id          TEXT NOT NULL,                   -- eVetPractice patient ID
    patient_name        TEXT NOT NULL,
    owner_phone         TEXT,                            -- owner SMS contact
    vaccine_name        TEXT NOT NULL,
    due_date            DATE,
    days_overdue        INT DEFAULT 0,
    reminder_type       TEXT NOT NULL,                   -- due_soon | overdue_mild | overdue_serious | critical
    reminder_count      INT DEFAULT 0,                   -- total reminders ever sent for this vaccine/patient
    last_reminder_sent  TIMESTAMPTZ,
    status              TEXT DEFAULT 'due_soon',         -- due_soon | overdue | completed
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, patient_id, vaccine_name)
);

-- Alert log (every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS vaccine_alerts (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug  TEXT NOT NULL,
    alert_type   TEXT NOT NULL,    -- vaccine_reminder | booking_confirmation | critical_overdue
    recipient    TEXT NOT NULL,    -- owner phone number
    message_body TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vet_reminders_client_status
    ON vaccine_reminders (client_slug, status);

CREATE INDEX IF NOT EXISTS idx_vet_reminders_due_date
    ON vaccine_reminders (due_date)
    WHERE status IN ('due_soon', 'overdue');

CREATE INDEX IF NOT EXISTS idx_vet_reminders_owner_phone
    ON vaccine_reminders (owner_phone, last_reminder_sent DESC);

CREATE INDEX IF NOT EXISTS idx_vet_alerts_client_type
    ON vaccine_alerts (client_slug, alert_type, created_at DESC);
