-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Refill Runner — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Veterinary practice connections with Vetsource pharmacy credentials
CREATE TABLE IF NOT EXISTS vet_refill_connections (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug           TEXT NOT NULL UNIQUE,
    evet_base_url         TEXT NOT NULL,               -- eVetPractice API base URL
    evet_api_key          TEXT NOT NULL,               -- eVetPractice API key
    vetsource_api_key     TEXT NOT NULL,               -- Vetsource pharmacy API key
    vetsource_practice_id TEXT NOT NULL,               -- Vetsource practice identifier
    owner_phone           TEXT NOT NULL,               -- practice phone for SMS / contact number in messages
    practice_name         TEXT NOT NULL,               -- displayed in SMS messages
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Prescription tracker (one row per active prescription)
-- Tracks reminder state, approval, and Vetsource processing status
CREATE TABLE IF NOT EXISTS prescription_tracker (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug       TEXT NOT NULL,
    prescription_id   TEXT NOT NULL,                   -- eVetPractice prescription ID
    patient_id        TEXT NOT NULL,                   -- eVetPractice patient ID
    patient_name      TEXT NOT NULL,
    medication_name   TEXT NOT NULL,
    owner_phone       TEXT,                            -- owner SMS contact
    last_fill_date    DATE,                            -- date of last dispensed fill
    days_supply       INT,                             -- days this fill covers
    refills_remaining INT DEFAULT 0,                   -- from the Rx
    status            TEXT NOT NULL DEFAULT 'active',  -- active | pending_reminder | approved | processing | completed | failed
    reminder_sent_at  TIMESTAMPTZ,                     -- last time a refill reminder was sent
    approved_at       TIMESTAMPTZ,                     -- when owner replied YES
    processed_at      TIMESTAMPTZ,                     -- when Vetsource order was submitted
    tracking_url      TEXT,                            -- Vetsource order tracking URL
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, prescription_id)
);

-- Alert log (every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS refill_alerts (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug      TEXT NOT NULL,
    alert_type       TEXT NOT NULL,    -- refill_reminder | refill_submitted | refill_failed
    recipient        TEXT NOT NULL,    -- owner phone number
    message_body     TEXT NOT NULL,
    prescription_id  TEXT,             -- links to prescription_tracker if relevant
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rx_tracker_client_status
    ON prescription_tracker (client_slug, status);

CREATE INDEX IF NOT EXISTS idx_rx_tracker_owner_phone
    ON prescription_tracker (owner_phone, status);

CREATE INDEX IF NOT EXISTS idx_rx_tracker_reminder_sent
    ON prescription_tracker (client_slug, reminder_sent_at DESC)
    WHERE status IN ('active', 'pending_reminder');

CREATE INDEX IF NOT EXISTS idx_rx_tracker_approved
    ON prescription_tracker (client_slug, approved_at)
    WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_refill_alerts_client_type
    ON refill_alerts (client_slug, alert_type, created_at DESC);
