-- ============================================================
-- GRIDHAND AI — Recall Commander
-- Database Schema
-- ============================================================

-- ============================================================
-- TABLE: rc_connections
-- Dental practice connection config
-- ============================================================

CREATE TABLE IF NOT EXISTS rc_connections (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                     TEXT NOT NULL UNIQUE,
    practice_name                   TEXT NOT NULL,
    owner_phone                     TEXT NOT NULL,
    front_desk_phone                TEXT NOT NULL,
    twilio_number                   TEXT,

    -- PMS integration
    pms_type                        TEXT NOT NULL CHECK (pms_type IN ('dentrix', 'open_dental')),
    api_key                         TEXT,
    api_secret                      TEXT,
    api_base_url                    TEXT,

    -- Recall intervals (months)
    recall_hygiene_interval_months  INTEGER NOT NULL DEFAULT 6,
    recall_exam_interval_months     INTEGER NOT NULL DEFAULT 12,

    -- Metadata
    active                          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rc_connections_client_slug ON rc_connections (client_slug);
CREATE INDEX IF NOT EXISTS idx_rc_connections_active ON rc_connections (active);

-- ============================================================
-- TABLE: rc_recall_queue
-- Patients due for recall
-- ============================================================

CREATE TABLE IF NOT EXISTS rc_recall_queue (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT NOT NULL REFERENCES rc_connections (client_slug) ON DELETE CASCADE,

    -- Patient identity
    patient_id              TEXT NOT NULL,
    patient_name            TEXT NOT NULL,
    patient_phone           TEXT NOT NULL,
    patient_email           TEXT,

    -- Recall details
    last_visit_date         DATE,
    recall_type             TEXT NOT NULL CHECK (recall_type IN ('hygiene', 'exam', 'xray')),
    days_overdue            INTEGER NOT NULL DEFAULT 0,

    -- Workflow status
    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'contacted', 'scheduled', 'declined', 'no_response', 'opted_out')),
    reminder_count          INTEGER NOT NULL DEFAULT 0,
    last_reminder_sent_at   TIMESTAMPTZ,
    booked_at               TIMESTAMPTZ,

    -- Timestamps
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One active recall per patient+type per practice
    UNIQUE (client_slug, patient_id, recall_type)
);

CREATE INDEX IF NOT EXISTS idx_rc_recall_queue_client_slug    ON rc_recall_queue (client_slug);
CREATE INDEX IF NOT EXISTS idx_rc_recall_queue_status         ON rc_recall_queue (status);
CREATE INDEX IF NOT EXISTS idx_rc_recall_queue_patient_id     ON rc_recall_queue (patient_id);
CREATE INDEX IF NOT EXISTS idx_rc_recall_queue_last_visit     ON rc_recall_queue (last_visit_date);
CREATE INDEX IF NOT EXISTS idx_rc_recall_queue_days_overdue   ON rc_recall_queue (days_overdue DESC);

-- ============================================================
-- TABLE: rc_sms_log
-- All SMS messages sent and received
-- ============================================================

CREATE TABLE IF NOT EXISTS rc_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL REFERENCES rc_connections (client_slug) ON DELETE CASCADE,
    patient_id      TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    message_body    TEXT NOT NULL,
    twilio_sid      TEXT,
    status          TEXT NOT NULL DEFAULT 'sent',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rc_sms_log_client_slug  ON rc_sms_log (client_slug);
CREATE INDEX IF NOT EXISTS idx_rc_sms_log_patient_id   ON rc_sms_log (patient_id);
CREATE INDEX IF NOT EXISTS idx_rc_sms_log_created_at   ON rc_sms_log (created_at DESC);

-- ============================================================
-- TABLE: rc_escalations
-- Front desk escalation log
-- ============================================================

CREATE TABLE IF NOT EXISTS rc_escalations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL REFERENCES rc_connections (client_slug) ON DELETE CASCADE,
    patient_count   INTEGER NOT NULL DEFAULT 0,
    message_body    TEXT NOT NULL,
    sent_to_phone   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rc_escalations_client_slug  ON rc_escalations (client_slug);
CREATE INDEX IF NOT EXISTS idx_rc_escalations_created_at   ON rc_escalations (created_at DESC);

-- ============================================================
-- TABLE: rc_daily_stats
-- Daily booking rate tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS rc_daily_stats (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT NOT NULL REFERENCES rc_connections (client_slug) ON DELETE CASCADE,
    stat_date               DATE NOT NULL,
    recalls_sent            INTEGER NOT NULL DEFAULT 0,
    responses_received      INTEGER NOT NULL DEFAULT 0,
    appointments_booked     INTEGER NOT NULL DEFAULT 0,
    booking_rate            NUMERIC GENERATED ALWAYS AS (
                                appointments_booked::NUMERIC / NULLIF(recalls_sent, 0) * 100
                            ) STORED,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (client_slug, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_rc_daily_stats_client_slug  ON rc_daily_stats (client_slug);
CREATE INDEX IF NOT EXISTS idx_rc_daily_stats_stat_date    ON rc_daily_stats (stat_date DESC);

-- ============================================================
-- TRIGGERS: updated_at auto-maintenance
-- ============================================================

CREATE OR REPLACE FUNCTION rc_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rc_connections_updated_at  ON rc_connections;
DROP TRIGGER IF EXISTS rc_recall_queue_updated_at ON rc_recall_queue;

CREATE TRIGGER rc_connections_updated_at
    BEFORE UPDATE ON rc_connections
    FOR EACH ROW EXECUTE FUNCTION rc_set_updated_at();

CREATE TRIGGER rc_recall_queue_updated_at
    BEFORE UPDATE ON rc_recall_queue
    FOR EACH ROW EXECUTE FUNCTION rc_set_updated_at();
