-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Route Optimizer — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Jobber OAuth connections for route-optimizer (one per client)
-- Separate table from weather-watcher to keep workers fully independent
CREATE TABLE IF NOT EXISTS jobber_connections_route (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL UNIQUE,
    access_token        TEXT NOT NULL,
    refresh_token       TEXT NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    owner_phone         TEXT NOT NULL,                        -- SMS destination for owner alerts
    depot_address       TEXT,                                 -- Starting point for all crews (shop/yard address)
    google_maps_api_key TEXT,                                 -- Per-client key; falls back to env var
    business_name       TEXT,                                 -- Display name for SMS messages
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Daily optimized routes (one row per client per crew per day)
CREATE TABLE IF NOT EXISTS daily_routes (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug             TEXT NOT NULL,
    route_date              DATE NOT NULL,
    crew_id                 TEXT NOT NULL,
    crew_name               TEXT NOT NULL,
    crew_lead_phone         TEXT,                             -- SMS target for morning briefing
    stops                   JSONB NOT NULL DEFAULT '[]',      -- Ordered array of stop objects
    total_distance_km       NUMERIC(8,2) DEFAULT 0,
    estimated_drive_minutes INT DEFAULT 0,
    optimized               BOOLEAN DEFAULT FALSE,            -- TRUE once Google Maps has processed it
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, route_date, crew_id)
);

-- Route alert log (tracks every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS route_alerts (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug  TEXT NOT NULL,
    alert_type   TEXT NOT NULL,   -- morning_briefing | route_update | error_alert
    recipient    TEXT NOT NULL,   -- phone number
    message_body TEXT NOT NULL,
    status       TEXT DEFAULT 'sent',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_daily_routes_client_date     ON daily_routes (client_slug, route_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_routes_crew            ON daily_routes (client_slug, crew_id, route_date DESC);
CREATE INDEX IF NOT EXISTS idx_route_alerts_client_type     ON route_alerts (client_slug, alert_type, created_at DESC);
