-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Sub-Scheduler — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Client connections (Buildertrend + Google Calendar)
CREATE TABLE IF NOT EXISTS ss_connections (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug             TEXT NOT NULL UNIQUE,
    -- Buildertrend
    buildertrend_api_key    TEXT,                     -- BT uses API key auth
    buildertrend_company_id TEXT,
    -- Google Calendar OAuth
    google_access_token     TEXT,
    google_refresh_token    TEXT,
    google_expires_at       TIMESTAMPTZ,
    google_calendar_id      TEXT DEFAULT 'primary',
    -- Settings
    owner_phone             TEXT NOT NULL,
    business_name           TEXT,
    reminder_hours_before   INT DEFAULT 24,           -- send SMS reminder this many hours ahead
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Subcontractors (vendor directory)
CREATE TABLE IF NOT EXISTS ss_subcontractors (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    name            TEXT NOT NULL,
    company         TEXT,
    phone           TEXT NOT NULL,
    email           TEXT,
    trade           TEXT,                             -- electrical | plumbing | framing | etc.
    bt_sub_id       TEXT,                             -- Buildertrend sub ID if known
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, phone)
);

-- Scheduled work events (pulled from Buildertrend, mirrored to Google Cal)
CREATE TABLE IF NOT EXISTS ss_schedules (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    bt_schedule_id      TEXT NOT NULL,
    project_id          TEXT,
    project_name        TEXT,
    title               TEXT NOT NULL,
    start_date          DATE NOT NULL,
    start_time          TEXT,                         -- HH:MM or null if all-day
    end_date            DATE,
    sub_phone           TEXT,                         -- subcontractor's phone
    sub_name            TEXT,
    trade               TEXT,
    google_event_id     TEXT,                         -- GCal event ID
    -- Tracking
    reminder_sent_at    TIMESTAMPTZ,
    confirmed           BOOLEAN DEFAULT FALSE,
    confirmed_at        TIMESTAMPTZ,
    showed_up           BOOLEAN,                      -- null = unknown, true/false after date
    no_show_alerted     BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, bt_schedule_id)
);

-- Alert / SMS log
CREATE TABLE IF NOT EXISTS ss_alerts (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- reminder | confirmation | no_show | new_schedule | daily_brief
    recipient       TEXT NOT NULL,
    message_body    TEXT NOT NULL,
    schedule_id     TEXT,
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ss_schedules_client_date ON ss_schedules (client_slug, start_date);
CREATE INDEX IF NOT EXISTS idx_ss_schedules_sub ON ss_schedules (client_slug, sub_phone);
CREATE INDEX IF NOT EXISTS idx_ss_alerts_client ON ss_alerts (client_slug, alert_type, created_at DESC);
