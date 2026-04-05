-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Weather Watcher — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Jobber OAuth connections for weather-watcher (one per client)
-- Separate table from route-optimizer to keep workers fully independent
CREATE TABLE IF NOT EXISTS jobber_connections_weather (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL UNIQUE,
    access_token        TEXT NOT NULL,
    refresh_token       TEXT NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    owner_phone         TEXT NOT NULL,                        -- SMS destination for owner summary alerts
    openweather_api_key TEXT,                                 -- Per-client key; falls back to env var
    service_area_lat    NUMERIC(10,6),                        -- Default lat for weather lookups
    service_area_lon    NUMERIC(10,6),                        -- Default lon for weather lookups
    business_name       TEXT,                                 -- Display name used in client SMS messages
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Postponed jobs (tracks every job that weather caused us to defer)
CREATE TABLE IF NOT EXISTS postponed_jobs (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug      TEXT NOT NULL,
    jobber_job_id    TEXT NOT NULL,
    client_name      TEXT NOT NULL,
    client_phone     TEXT,                                    -- Null if Jobber has no phone on file
    original_date    DATE NOT NULL,                          -- The date the job was originally scheduled
    postpone_reason  TEXT NOT NULL,                          -- Human-readable reason: "rain, high winds"
    postpone_count   INT NOT NULL DEFAULT 1,                 -- How many times this job has been postponed
    status           TEXT NOT NULL DEFAULT 'postponed',      -- postponed | rescheduled | cancelled
    rescheduled_date DATE,                                    -- Set once a new date is confirmed in Jobber
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, jobber_job_id)
);

-- Weather alert log (tracks every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS weather_alerts (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug  TEXT NOT NULL,
    alert_type   TEXT NOT NULL,   -- postponement_notice | reschedule_confirmation | postponement_summary
    recipient    TEXT NOT NULL,   -- phone number
    message_body TEXT NOT NULL,
    status       TEXT DEFAULT 'sent',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_postponed_jobs_client_status  ON postponed_jobs (client_slug, status);
CREATE INDEX IF NOT EXISTS idx_postponed_jobs_original_date  ON postponed_jobs (client_slug, original_date DESC);
CREATE INDEX IF NOT EXISTS idx_weather_alerts_client_type    ON weather_alerts (client_slug, alert_type, created_at DESC);
