-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Rebook Reminder — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Salon booking system connections (one per client)
CREATE TABLE IF NOT EXISTS salon_connections (
    id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug            TEXT NOT NULL UNIQUE,
    booking_system         TEXT NOT NULL DEFAULT 'boulevard', -- boulevard | square
    boulevard_api_key      TEXT,
    boulevard_business_id  TEXT,
    square_access_token    TEXT,
    square_location_id     TEXT,
    owner_phone            TEXT,                             -- SMS destination for owner alerts
    salon_name             TEXT NOT NULL,
    booking_url            TEXT,                             -- link in reminder SMS
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Salon clients with rebook tracking (upserted on each sync)
CREATE TABLE IF NOT EXISTS salon_clients (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    external_client_id  TEXT NOT NULL,                       -- ID from Boulevard or Square
    name                TEXT NOT NULL,
    phone               TEXT,
    email               TEXT,
    last_visit_date     DATE,
    last_service_type   TEXT,                                -- e.g. "Haircut", "Color + Blowout"
    visit_count         INT DEFAULT 0,
    avg_rebook_days     INT DEFAULT 0,                       -- average days between visits
    overdue_days        INT DEFAULT 0,                       -- days past their expected return
    reminder_count      INT DEFAULT 0,                       -- total SMS reminders sent
    last_reminder_sent  TIMESTAMPTZ,
    opted_out           BOOLEAN DEFAULT FALSE,               -- STOP reply
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, external_client_id)
);

-- Alert log (tracks every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS rebook_alerts (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug  TEXT NOT NULL,
    alert_type   TEXT NOT NULL,   -- rebook_reminder | sync_complete | confirmation | opt_out
    recipient    TEXT NOT NULL,   -- phone number or 'system'
    message_body TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_salon_connections_slug     ON salon_connections (client_slug);
CREATE INDEX IF NOT EXISTS idx_salon_clients_slug_overdue ON salon_clients (client_slug, overdue_days DESC);
CREATE INDEX IF NOT EXISTS idx_salon_clients_phone        ON salon_clients (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_salon_clients_last_visit   ON salon_clients (client_slug, last_visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_rebook_alerts_client       ON rebook_alerts (client_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rebook_alerts_type         ON rebook_alerts (client_slug, alert_type, created_at DESC);
