-- Bay Boss — Supabase Schema
-- Run this in your Supabase SQL editor to set up Bay Boss tables
-- All tables are prefixed with bay_boss_ to avoid conflicts

-- ─── Shop Configs ─────────────────────────────────────────────────────────────
-- Stores per-shop Bay Boss configuration (extends the main client config)
CREATE TABLE IF NOT EXISTS bay_boss_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id             TEXT NOT NULL UNIQUE,       -- Tekmetric shop ID
    client_slug         TEXT,                       -- Links to main client config
    owner_phone         TEXT,                       -- SMS destination for alerts
    total_bays          INT  NOT NULL DEFAULT 6,
    timezone            TEXT NOT NULL DEFAULT 'America/Chicago',

    -- Tekmetric
    tekmetric_api_key   TEXT,                       -- Encrypted in production

    -- Google Calendar
    tech_calendar_map   JSONB DEFAULT '{}',         -- { techId: calendarId, ... }
    google_refresh_token TEXT,                      -- OAuth refresh token
    google_service_account_key_path TEXT,           -- Alternative: service account path

    -- Schedule timings (cron strings)
    morning_briefing_cron TEXT DEFAULT '0 7 * * 1-6',
    eod_summary_cron      TEXT DEFAULT '0 18 * * 1-6',
    schedule_check_cron   TEXT DEFAULT '*/30 7-18 * * 1-6',

    -- Alert thresholds
    underutil_threshold   INT DEFAULT 40,           -- % below which alert fires
    overbook_threshold    INT DEFAULT 95,           -- % above which alert fires
    overrun_threshold_min INT DEFAULT 30,           -- minutes over estimate

    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Daily Schedule Snapshots ─────────────────────────────────────────────────
-- Stores a point-in-time view of the shop schedule for each day
CREATE TABLE IF NOT EXISTS bay_boss_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id         TEXT NOT NULL,
    snapshot_date   DATE NOT NULL,
    taken_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Bay state
    total_bays      INT,
    occupied_bays   INT,
    free_bays       INT,
    utilization_pct INT,

    -- Job counts
    total_orders       INT DEFAULT 0,
    wip_orders         INT DEFAULT 0,
    completed_orders   INT DEFAULT 0,
    appointments       INT DEFAULT 0,

    -- Full raw snapshot payload
    raw_snapshot    JSONB,

    UNIQUE (shop_id, snapshot_date, taken_at)
);

CREATE INDEX IF NOT EXISTS idx_bay_boss_snapshots_shop_date
    ON bay_boss_snapshots (shop_id, snapshot_date DESC);

-- ─── Tech Efficiency Metrics ──────────────────────────────────────────────────
-- Daily per-tech efficiency record
CREATE TABLE IF NOT EXISTS bay_boss_tech_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id         TEXT NOT NULL,
    technician_id   TEXT NOT NULL,
    technician_name TEXT,
    metric_date     DATE NOT NULL,

    assigned_orders  INT     DEFAULT 0,
    completed_orders INT     DEFAULT 0,
    billed_hours     NUMERIC(5,2) DEFAULT 0,
    available_hours  NUMERIC(5,2) DEFAULT 8,
    efficiency_pct   INT     DEFAULT 0,  -- billed/available * 100
    workload_pct     INT     DEFAULT 0,  -- estimated_hours/available * 100

    idle_hours       NUMERIC(5,2) DEFAULT 0,
    overrun_jobs     INT     DEFAULT 0,  -- jobs that ran over estimate

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (shop_id, technician_id, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_bay_boss_tech_metrics_shop_tech
    ON bay_boss_tech_metrics (shop_id, technician_id, metric_date DESC);

-- ─── Alerts Log ───────────────────────────────────────────────────────────────
-- Tracks every alert fired and whether it was acknowledged
CREATE TABLE IF NOT EXISTS bay_boss_alerts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id     TEXT NOT NULL,
    alert_type  TEXT NOT NULL,  -- 'underutilized', 'overbooked', 'overrun', 'idle_tech', 'manual'
    severity    TEXT NOT NULL DEFAULT 'medium',  -- 'low', 'medium', 'high'
    message     TEXT NOT NULL,
    details     JSONB,

    sent_to     TEXT,           -- phone number it was SMS'd to
    sent_at     TIMESTAMPTZ,
    sms_sid     TEXT,           -- Twilio message SID

    acknowledged        BOOLEAN NOT NULL DEFAULT false,
    acknowledged_at     TIMESTAMPTZ,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bay_boss_alerts_shop
    ON bay_boss_alerts (shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bay_boss_alerts_unacked
    ON bay_boss_alerts (shop_id, acknowledged)
    WHERE acknowledged = false;

-- ─── Schedule Adjustments ─────────────────────────────────────────────────────
-- Logs every AI-generated schedule recommendation and whether it was applied
CREATE TABLE IF NOT EXISTS bay_boss_adjustments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id         TEXT NOT NULL,
    adjustment_date DATE NOT NULL,

    adjustment_type TEXT NOT NULL,  -- 'reassign', 'reschedule', 'add_appointment', 'block_time'
    recommendation  TEXT NOT NULL,  -- Human-readable description
    details         JSONB,          -- Structured data (from/to tech, job ID, times, etc.)

    applied         BOOLEAN NOT NULL DEFAULT false,
    applied_at      TIMESTAMPTZ,
    applied_by      TEXT,           -- 'auto' | owner name

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bay_boss_adjustments_shop_date
    ON bay_boss_adjustments (shop_id, adjustment_date DESC);

-- ─── Morning Briefings & EOD Summaries ───────────────────────────────────────
-- Stores every briefing sent so owner can review history
CREATE TABLE IF NOT EXISTS bay_boss_briefings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id         TEXT NOT NULL,
    briefing_date   DATE NOT NULL,
    briefing_type   TEXT NOT NULL,  -- 'morning' | 'eod'

    body            TEXT NOT NULL,  -- The SMS text that was sent
    sent_to         TEXT,
    sent_at         TIMESTAMPTZ,
    sms_sid         TEXT,

    -- Key metrics at time of briefing
    utilization_pct INT,
    total_jobs      INT,
    completed_jobs  INT,
    appointments    INT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (shop_id, briefing_date, briefing_type)
);

CREATE INDEX IF NOT EXISTS idx_bay_boss_briefings_shop
    ON bay_boss_briefings (shop_id, briefing_date DESC);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Enable RLS so each shop only sees its own data (when using Supabase auth)
ALTER TABLE bay_boss_configs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bay_boss_snapshots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bay_boss_tech_metrics     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bay_boss_alerts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bay_boss_adjustments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bay_boss_briefings        ENABLE ROW LEVEL SECURITY;

-- Service role bypass (for the Bay Boss server using service key)
-- These policies allow the Bay Boss backend (service role) full access
CREATE POLICY "service_role_all" ON bay_boss_configs
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON bay_boss_snapshots
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON bay_boss_tech_metrics
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON bay_boss_alerts
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON bay_boss_adjustments
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON bay_boss_briefings
    FOR ALL USING (auth.role() = 'service_role');

-- ─── Helper: Auto-update updated_at ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bay_boss_configs_updated_at
    BEFORE UPDATE ON bay_boss_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Views ────────────────────────────────────────────────────────────────────

-- Today's shop summary (most recent snapshot per shop)
CREATE OR REPLACE VIEW bay_boss_today AS
SELECT DISTINCT ON (shop_id)
    shop_id,
    snapshot_date,
    taken_at,
    total_bays,
    occupied_bays,
    free_bays,
    utilization_pct,
    total_orders,
    wip_orders,
    completed_orders,
    appointments
FROM bay_boss_snapshots
WHERE snapshot_date = CURRENT_DATE
ORDER BY shop_id, taken_at DESC;

-- Tech leaderboard — last 7 days
CREATE OR REPLACE VIEW bay_boss_tech_leaderboard AS
SELECT
    shop_id,
    technician_id,
    technician_name,
    COUNT(*)                          AS days_worked,
    SUM(completed_orders)             AS total_jobs,
    ROUND(AVG(efficiency_pct))        AS avg_efficiency_pct,
    ROUND(SUM(billed_hours)::numeric, 1) AS total_billed_hours,
    SUM(overrun_jobs)                 AS total_overruns
FROM bay_boss_tech_metrics
WHERE metric_date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY shop_id, technician_id, technician_name
ORDER BY avg_efficiency_pct DESC;

-- Unacknowledged alerts
CREATE OR REPLACE VIEW bay_boss_open_alerts AS
SELECT *
FROM bay_boss_alerts
WHERE acknowledged = false
ORDER BY created_at DESC;
