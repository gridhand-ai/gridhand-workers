-- ============================================================
-- GRIDHAND Shift Genie — Database Schema
-- ============================================================

-- ─── Connection Config ────────────────────────────────────────────────────────
-- Stores all credentials and configuration per client restaurant.

CREATE TABLE IF NOT EXISTS genie_connections (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                 TEXT NOT NULL UNIQUE,

    -- 7shifts OAuth2
    seven_shifts_access_token   TEXT,
    seven_shifts_refresh_token  TEXT,
    seven_shifts_expires_at     TIMESTAMPTZ,
    seven_shifts_company_id     TEXT,

    -- HotSchedules (SOAP/REST, legacy)
    hotschedules_username       TEXT,
    hotschedules_password       TEXT,
    hotschedules_concept_id     TEXT,
    hotschedules_establishment_id TEXT,

    -- Which scheduling system is active for this client
    active_scheduling_system    TEXT NOT NULL DEFAULT '7shifts'
                                    CHECK (active_scheduling_system IN ('7shifts', 'hotschedules')),

    -- Toast POS OAuth2
    toast_client_id             TEXT,
    toast_client_secret         TEXT,
    toast_restaurant_guid       TEXT,
    toast_access_token          TEXT,
    toast_token_expires_at      TIMESTAMPTZ,

    -- Square POS
    square_access_token         TEXT,
    square_location_id          TEXT,

    -- Which POS is active for this client
    active_pos_system           TEXT NOT NULL DEFAULT 'toast'
                                    CHECK (active_pos_system IN ('toast', 'square')),

    -- Contacts
    manager_phone               TEXT,       -- receives daily summaries + coverage alerts
    gm_phone                    TEXT,       -- receives weekly labor reports

    -- Restaurant metadata
    restaurant_name             TEXT NOT NULL DEFAULT '',
    timezone                    TEXT NOT NULL DEFAULT 'America/Chicago',

    -- Labor cost target as a decimal (0.30 = 30%)
    labor_cost_target           NUMERIC(4,2) NOT NULL DEFAULT 0.30,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Scheduled Shifts ─────────────────────────────────────────────────────────
-- Mirror of the scheduling system's shift records. Kept in sync via API.

CREATE TABLE IF NOT EXISTS scheduled_shifts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         TEXT NOT NULL REFERENCES genie_connections(client_slug) ON DELETE CASCADE,

    external_shift_id   TEXT NOT NULL,          -- ID from 7shifts or HotSchedules
    UNIQUE (client_slug, external_shift_id),

    employee_id         TEXT NOT NULL,          -- external employee ID
    employee_name       TEXT NOT NULL,
    employee_phone      TEXT,                   -- for SMS swap offers

    role                TEXT NOT NULL,          -- 'Server', 'Cook', 'Host', 'Bartender', etc.
    department          TEXT,                   -- 'FOH', 'BOH', 'Bar'

    shift_date          DATE NOT NULL,
    start_time          TIME NOT NULL,
    end_time            TIME NOT NULL,
    scheduled_hours     NUMERIC(4,2),

    hourly_rate         NUMERIC(6,2),           -- from employee record
    shift_cost          NUMERIC(8,2),           -- scheduled_hours * hourly_rate

    status              TEXT NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled', 'swapped', 'dropped', 'covered', 'no_show')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_client_date
    ON scheduled_shifts(client_slug, shift_date);

CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_employee
    ON scheduled_shifts(client_slug, employee_id);

-- ─── Swap Requests ────────────────────────────────────────────────────────────
-- Tracks employee-initiated shift swap and drop requests.

CREATE TABLE IF NOT EXISTS swap_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             TEXT NOT NULL REFERENCES genie_connections(client_slug) ON DELETE CASCADE,

    requester_id            TEXT NOT NULL,      -- employee_id initiating swap
    requester_phone         TEXT NOT NULL,

    shift_id                UUID REFERENCES scheduled_shifts(id),
    target_date             DATE,               -- used when swap is by date+shift name
    target_shift_start      TIME,

    status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'offered', 'accepted', 'declined', 'cancelled')),

    offered_to_employee_id  TEXT,               -- employee offered the shift
    offered_at              TIMESTAMPTZ,
    accepted_at             TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swap_requests_client_status
    ON swap_requests(client_slug, status);

-- ─── Labor Snapshots ──────────────────────────────────────────────────────────
-- Daily labor cost summary for reporting and trend analysis.

CREATE TABLE IF NOT EXISTS labor_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         TEXT NOT NULL REFERENCES genie_connections(client_slug) ON DELETE CASCADE,

    snapshot_date       DATE NOT NULL,
    UNIQUE (client_slug, snapshot_date),

    total_shifts        INT NOT NULL DEFAULT 0,
    total_hours         NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_labor_cost    NUMERIC(10,2) NOT NULL DEFAULT 0,
    projected_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0,
    labor_pct           NUMERIC(5,2) NOT NULL DEFAULT 0,    -- labor_cost / projected_revenue * 100

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_labor_snapshots_client_date
    ON labor_snapshots(client_slug, snapshot_date DESC);

-- ─── Schedule Alerts ──────────────────────────────────────────────────────────
-- Audit log of every SMS sent by the worker.

CREATE TABLE IF NOT EXISTS schedule_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL REFERENCES genie_connections(client_slug) ON DELETE CASCADE,

    alert_type      TEXT NOT NULL,      -- 'daily_summary', 'coverage_gap', 'swap_offer', 'swap_confirmed',
                                        --  'labor_report', 'schedule_optimization'
    recipient       TEXT NOT NULL,      -- phone number
    message_body    TEXT NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedule_alerts_client
    ON schedule_alerts(client_slug, created_at DESC);

-- ─── Employee Availability ────────────────────────────────────────────────────
-- Tracks dates employees mark themselves as available for pickup shifts.

CREATE TABLE IF NOT EXISTS employee_availability (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     TEXT NOT NULL REFERENCES genie_connections(client_slug) ON DELETE CASCADE,
    employee_id     TEXT NOT NULL,
    employee_phone  TEXT NOT NULL,
    available_date  DATE NOT NULL,
    UNIQUE (client_slug, employee_id, available_date),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
