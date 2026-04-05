-- GRIDHAND Deadline Sentinel — Database Schema
-- Run against your Supabase project.

-- ─── Connections ──────────────────────────────────────────────────────────────
-- One row per law firm client. Stores credentials for Clio or MyCase.

CREATE TABLE IF NOT EXISTS sentinel_connections (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT        NOT NULL UNIQUE,
    -- Clio OAuth2 tokens
    clio_access_token   TEXT,
    clio_refresh_token  TEXT,
    clio_expires_at     TIMESTAMPTZ,
    -- MyCase API key auth
    mycase_api_key      TEXT,
    -- Which system this firm uses
    active_system       TEXT        NOT NULL DEFAULT 'clio' CHECK (active_system IN ('clio', 'mycase')),
    -- Alert recipients
    attorney_phone      TEXT,           -- primary attorney on-call phone
    partner_phone       TEXT,           -- managing partner — receives missed-deadline escalations
    firm_name           TEXT,
    -- Timezone (IANA name, e.g. 'America/Chicago')
    timezone            TEXT        NOT NULL DEFAULT 'America/Chicago',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Tracked Deadlines ────────────────────────────────────────────────────────
-- One row per deadline per matter. Updated on every scan.

CREATE TABLE IF NOT EXISTS tracked_deadlines (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT        NOT NULL REFERENCES sentinel_connections(client_slug) ON DELETE CASCADE,
    matter_id           TEXT        NOT NULL,
    matter_name         TEXT,
    client_name         TEXT,
    attorney_name       TEXT,
    deadline_date       DATE        NOT NULL,
    deadline_type       TEXT        NOT NULL CHECK (deadline_type IN (
                            'statute_of_limitations',
                            'filing_deadline',
                            'court_date',
                            'discovery_cutoff',
                            'response_due',
                            'general_task'
                        )),
    description         TEXT,
    urgency             TEXT        NOT NULL DEFAULT 'normal' CHECK (urgency IN ('critical', 'urgent', 'warning', 'normal')),
    status              TEXT        NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'completed', 'missed', 'extended')),
    last_alerted_at     TIMESTAMPTZ,
    alert_count         INT         NOT NULL DEFAULT 0,
    external_task_id    TEXT,           -- Clio task ID or MyCase task ID
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate rows for the same external task
    UNIQUE (client_slug, external_task_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_deadlines_client_date
    ON tracked_deadlines (client_slug, deadline_date);

CREATE INDEX IF NOT EXISTS idx_tracked_deadlines_status
    ON tracked_deadlines (client_slug, status, urgency);

-- ─── Deadline Alerts ──────────────────────────────────────────────────────────
-- Immutable log of every SMS sent for audit and dedup.

CREATE TABLE IF NOT EXISTS deadline_alerts (
    id              BIGSERIAL PRIMARY KEY,
    client_slug     TEXT        NOT NULL REFERENCES sentinel_connections(client_slug) ON DELETE CASCADE,
    deadline_id     BIGINT      REFERENCES tracked_deadlines(id) ON DELETE SET NULL,
    alert_type      TEXT        NOT NULL,   -- 'warning' | 'urgent' | 'critical' | 'day_of_morning' | 'day_of_noon' | 'missed' | 'weekly_report'
    urgency_level   TEXT        NOT NULL,   -- 'critical' | 'urgent' | 'warning' | 'normal'
    recipient       TEXT        NOT NULL,   -- phone number
    message_body    TEXT        NOT NULL,
    twilio_sid      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deadline_alerts_client
    ON deadline_alerts (client_slug, created_at DESC);

-- ─── Compliance Log ───────────────────────────────────────────────────────────
-- Weekly compliance snapshot per firm for reporting.

CREATE TABLE IF NOT EXISTS compliance_log (
    id              BIGSERIAL PRIMARY KEY,
    client_slug     TEXT        NOT NULL REFERENCES sentinel_connections(client_slug) ON DELETE CASCADE,
    matter_id       TEXT,               -- NULL = firm-wide aggregate
    check_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
    total_deadlines INT         NOT NULL DEFAULT 0,
    on_track        INT         NOT NULL DEFAULT 0,
    missed          INT         NOT NULL DEFAULT 0,
    extended        INT         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (client_slug, matter_id, check_date)
);

-- ─── Trigger: auto-update updated_at ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sentinel_connections_updated_at ON sentinel_connections;
CREATE TRIGGER trg_sentinel_connections_updated_at
    BEFORE UPDATE ON sentinel_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_tracked_deadlines_updated_at ON tracked_deadlines;
CREATE TRIGGER trg_tracked_deadlines_updated_at
    BEFORE UPDATE ON tracked_deadlines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
