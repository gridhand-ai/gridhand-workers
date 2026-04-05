-- ============================================================
-- GRIDHAND Class Optimizer — Supabase Schema
-- ============================================================
-- All tables use UUID PKs, created_at/updated_at timestamps.
-- Run this in the Supabase SQL editor for each project.
-- ============================================================

-- ─── Updated At Trigger Function ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── co_clients ───────────────────────────────────────────────────────────────
-- One row per fitness business using Class Optimizer.

CREATE TABLE IF NOT EXISTS co_clients (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug               TEXT NOT NULL UNIQUE,
    business_name             TEXT NOT NULL,
    mindbody_site_id          TEXT NOT NULL,
    mindbody_api_key          TEXT NOT NULL,
    google_calendar_id        TEXT,
    google_service_account_json TEXT,
    min_attendance_threshold  INT  NOT NULL DEFAULT 3,
    cancellation_notice_hours INT  NOT NULL DEFAULT 2,
    owner_phone               TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_co_clients_updated_at
    BEFORE UPDATE ON co_clients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── co_classes ───────────────────────────────────────────────────────────────
-- Recurring class schedule pulled from Mindbody class schedules.

CREATE TABLE IF NOT EXISTS co_classes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id          UUID NOT NULL REFERENCES co_clients(id) ON DELETE CASCADE,
    mindbody_class_id  TEXT NOT NULL,
    class_name         TEXT NOT NULL,
    instructor_name    TEXT,
    day_of_week        INT  CHECK (day_of_week BETWEEN 0 AND 6),
    start_time         TIME,
    duration_minutes   INT,
    max_capacity       INT,
    google_event_id    TEXT,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, mindbody_class_id)
);

CREATE INDEX IF NOT EXISTS idx_co_classes_client_active
    ON co_classes (client_id, is_active);

CREATE TRIGGER trg_co_classes_updated_at
    BEFORE UPDATE ON co_classes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── co_attendance_records ────────────────────────────────────────────────────
-- One row per class session (a specific date an instance ran).

CREATE TABLE IF NOT EXISTS co_attendance_records (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id      UUID NOT NULL REFERENCES co_clients(id) ON DELETE CASCADE,
    class_id       UUID NOT NULL REFERENCES co_classes(id) ON DELETE CASCADE,
    class_date     DATE NOT NULL,
    enrolled_count INT  NOT NULL DEFAULT 0,
    attended_count INT  NOT NULL DEFAULT 0,
    capacity       INT  NOT NULL DEFAULT 0,
    fill_rate      NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (class_id, class_date)
);

CREATE INDEX IF NOT EXISTS idx_co_attendance_client_date
    ON co_attendance_records (client_id, class_date DESC);

CREATE INDEX IF NOT EXISTS idx_co_attendance_class_date
    ON co_attendance_records (class_id, class_date DESC);

-- ─── co_recommendations ───────────────────────────────────────────────────────
-- AI-generated schedule optimization recommendations.

CREATE TABLE IF NOT EXISTS co_recommendations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES co_clients(id) ON DELETE CASCADE,
    class_id            UUID REFERENCES co_classes(id) ON DELETE SET NULL,
    recommendation_type TEXT NOT NULL CHECK (recommendation_type IN (
        'cancel_class',
        'reschedule',
        'add_capacity',
        'reduce_capacity',
        'add_class'
    )),
    reason              TEXT NOT NULL,
    data                JSONB,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'accepted',
        'rejected',
        'applied'
    )),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_co_recommendations_client_status
    ON co_recommendations (client_id, status);

CREATE TRIGGER trg_co_recommendations_updated_at
    BEFORE UPDATE ON co_recommendations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── co_cancellations ─────────────────────────────────────────────────────────
-- Audit log for every class that was auto-cancelled by the worker.

CREATE TABLE IF NOT EXISTS co_cancellations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id             UUID NOT NULL REFERENCES co_clients(id) ON DELETE CASCADE,
    class_id              UUID REFERENCES co_classes(id) ON DELETE SET NULL,
    class_date            DATE NOT NULL,
    cancellation_reason   TEXT NOT NULL,
    notified_count        INT  NOT NULL DEFAULT 0,
    google_event_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_co_cancellations_client_date
    ON co_cancellations (client_id, class_date DESC);

-- ─── Row Level Security (optional — enable if using per-client Supabase auth) --
-- ALTER TABLE co_clients ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE co_classes ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE co_attendance_records ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE co_recommendations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE co_cancellations ENABLE ROW LEVEL SECURITY;
