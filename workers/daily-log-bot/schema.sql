-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Daily Log Bot — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Procore + CompanyCam OAuth connections (one per client)
CREATE TABLE IF NOT EXISTS dlb_connections (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL UNIQUE,
    -- Procore
    procore_company_id  TEXT,
    procore_access_token  TEXT,
    procore_refresh_token TEXT,
    procore_expires_at    TIMESTAMPTZ,
    -- CompanyCam
    companycam_api_key  TEXT,                     -- CompanyCam uses API key auth
    -- Settings
    owner_phone         TEXT NOT NULL,
    owner_email         TEXT,
    business_name       TEXT,
    openweather_city    TEXT DEFAULT 'Chicago,US', -- default weather location
    report_time         TEXT DEFAULT '17:00',      -- time to generate EOD report
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Daily job site reports (one per project per day)
CREATE TABLE IF NOT EXISTS dlb_daily_reports (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    procore_project_id  TEXT NOT NULL,
    project_name    TEXT,
    report_date     DATE NOT NULL,
    -- Weather
    weather_temp_f  NUMERIC(5,1),
    weather_desc    TEXT,
    weather_wind_mph NUMERIC(5,1),
    weather_precip_in NUMERIC(5,2) DEFAULT 0,
    weather_suitable_for_work BOOLEAN DEFAULT TRUE,
    -- Crew
    crew_checkin_count  INT DEFAULT 0,
    crew_names          JSONB DEFAULT '[]',       -- array of checked-in names
    -- Photos
    photo_count         INT DEFAULT 0,
    photo_urls          JSONB DEFAULT '[]',       -- array of CompanyCam photo URLs
    photo_summary       TEXT,                     -- AI-generated photo summary
    -- Report
    report_text         TEXT,                     -- full generated daily log text
    procore_log_id      TEXT,                     -- ID if posted back to Procore
    status              TEXT DEFAULT 'generated', -- generated | posted | failed
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, procore_project_id, report_date)
);

-- Alert log
CREATE TABLE IF NOT EXISTS dlb_alerts (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- daily_report | weather_warning | no_photos | no_checkins
    recipient       TEXT NOT NULL,
    message_body    TEXT NOT NULL,
    project_id      TEXT,
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dlb_reports_client_date ON dlb_daily_reports (client_slug, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_dlb_reports_project ON dlb_daily_reports (client_slug, procore_project_id);
CREATE INDEX IF NOT EXISTS idx_dlb_alerts_client ON dlb_alerts (client_slug, alert_type, created_at DESC);
