-- ─── GRIDHAND No-Show Nurse — Database Schema ────────────────────────────────
-- Run once against your Supabase project.
-- All tables are prefixed nsn_ to avoid collisions with other workers.

-- ─── 1. Connections ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nsn_connections (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                 VARCHAR(100) UNIQUE NOT NULL,
    practice_name               VARCHAR(200) NOT NULL,
    staff_phone                 VARCHAR(30) NOT NULL,          -- primary SMS recipient
    front_desk_phone            VARCHAR(30),                   -- alert destination for no-shows
    ehr_type                    VARCHAR(20) NOT NULL CHECK (ehr_type IN ('epic', 'cerner')),
    ehr_base_url                TEXT NOT NULL,                 -- e.g. https://fhir.epic.com/interconnect-fhir-oauth
    ehr_client_id               TEXT NOT NULL,
    ehr_client_secret           TEXT NOT NULL,
    no_show_threshold_minutes   INT NOT NULL DEFAULT 15,       -- minutes past appt start before flagging no-show
    slot_offer_expiry_minutes   INT NOT NULL DEFAULT 120,      -- minutes waitlist patient has to respond
    reminder_24hr_enabled       BOOLEAN NOT NULL DEFAULT true,
    reminder_2hr_enabled        BOOLEAN NOT NULL DEFAULT true,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nsn_connections_client_slug ON nsn_connections (client_slug);

-- ─── 2. No-Shows ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nsn_no_shows (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         VARCHAR(100) NOT NULL REFERENCES nsn_connections (client_slug) ON DELETE CASCADE,
    appointment_id      VARCHAR(200) NOT NULL,                 -- EHR appointment resource ID
    patient_id          VARCHAR(200) NOT NULL,
    patient_name        VARCHAR(200),
    patient_phone       VARCHAR(30),
    scheduled_at        TIMESTAMPTZ NOT NULL,
    appointment_type    VARCHAR(200),
    provider_name       VARCHAR(200),
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    status              VARCHAR(30) NOT NULL DEFAULT 'detected'
                            CHECK (status IN ('detected', 'followup_sent', 'rescheduled', 'no_response', 'opted_out')),
    followup_count      INT NOT NULL DEFAULT 0,
    last_followup_at    TIMESTAMPTZ,
    rescheduled_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nsn_no_shows_client_slug   ON nsn_no_shows (client_slug);
CREATE INDEX IF NOT EXISTS idx_nsn_no_shows_status        ON nsn_no_shows (status);
CREATE INDEX IF NOT EXISTS idx_nsn_no_shows_scheduled_at  ON nsn_no_shows (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_nsn_no_shows_appointment   ON nsn_no_shows (client_slug, appointment_id);

-- ─── 3. Waitlist ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nsn_waitlist (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         VARCHAR(100) NOT NULL REFERENCES nsn_connections (client_slug) ON DELETE CASCADE,
    patient_id          VARCHAR(200),
    patient_name        VARCHAR(200) NOT NULL,
    patient_phone       VARCHAR(30) NOT NULL,
    appointment_type    VARCHAR(200) NOT NULL,
    preferred_days      JSONB NOT NULL DEFAULT '[]',           -- e.g. ["Monday","Wednesday","Friday"]
    preferred_times     JSONB NOT NULL DEFAULT '[]',           -- e.g. ["morning","afternoon"]
    notes               TEXT,
    added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    status              VARCHAR(20) NOT NULL DEFAULT 'waiting'
                            CHECK (status IN ('waiting', 'offered', 'booked', 'withdrawn', 'expired')),
    offer_sent_at       TIMESTAMPTZ,
    offer_expires_at    TIMESTAMPTZ,
    booked_at           TIMESTAMPTZ,
    slot_id             VARCHAR(200),
    priority            INT NOT NULL DEFAULT 0,                -- higher = higher priority; 0 = FIFO
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nsn_waitlist_client_slug      ON nsn_waitlist (client_slug);
CREATE INDEX IF NOT EXISTS idx_nsn_waitlist_status           ON nsn_waitlist (status);
CREATE INDEX IF NOT EXISTS idx_nsn_waitlist_appt_type        ON nsn_waitlist (client_slug, appointment_type);
CREATE INDEX IF NOT EXISTS idx_nsn_waitlist_phone            ON nsn_waitlist (client_slug, patient_phone);

-- ─── 4. Slot Fills ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nsn_slot_fills (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             VARCHAR(100) NOT NULL REFERENCES nsn_connections (client_slug) ON DELETE CASCADE,
    slot_id                 VARCHAR(200) NOT NULL,
    appointment_date        TIMESTAMPTZ NOT NULL,
    appointment_type        VARCHAR(200),
    waitlist_id             UUID REFERENCES nsn_waitlist (id),
    patient_id              VARCHAR(200),
    patient_name            VARCHAR(200),
    offers_sent             INT NOT NULL DEFAULT 1,
    time_to_fill_minutes    INT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nsn_slot_fills_client_slug ON nsn_slot_fills (client_slug);
CREATE INDEX IF NOT EXISTS idx_nsn_slot_fills_date        ON nsn_slot_fills (appointment_date);
CREATE INDEX IF NOT EXISTS idx_nsn_slot_fills_waitlist_id ON nsn_slot_fills (waitlist_id);

-- ─── 5. SMS Log ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nsn_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     VARCHAR(100) NOT NULL REFERENCES nsn_connections (client_slug) ON DELETE CASCADE,
    patient_id      VARCHAR(200),
    appointment_id  VARCHAR(200),
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    message_body    TEXT NOT NULL,
    twilio_sid      VARCHAR(100),
    status          VARCHAR(30),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nsn_sms_log_client_slug     ON nsn_sms_log (client_slug);
CREATE INDEX IF NOT EXISTS idx_nsn_sms_log_patient_id      ON nsn_sms_log (patient_id);
CREATE INDEX IF NOT EXISTS idx_nsn_sms_log_appointment_id  ON nsn_sms_log (appointment_id);
CREATE INDEX IF NOT EXISTS idx_nsn_sms_log_created_at      ON nsn_sms_log (created_at);

-- ─── 6. Daily Stats ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nsn_daily_stats (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         VARCHAR(100) NOT NULL REFERENCES nsn_connections (client_slug) ON DELETE CASCADE,
    stat_date           DATE NOT NULL,
    UNIQUE (client_slug, stat_date),
    appointments_total  INT NOT NULL DEFAULT 0,
    no_show_count       INT NOT NULL DEFAULT 0,
    cancellations       INT NOT NULL DEFAULT 0,
    confirmations       INT NOT NULL DEFAULT 0,
    no_show_rate        NUMERIC GENERATED ALWAYS AS (
                            no_show_count::numeric / NULLIF(appointments_total, 0) * 100
                        ) STORED,
    slots_filled        INT NOT NULL DEFAULT 0,
    reminders_sent      INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nsn_daily_stats_client_slug ON nsn_daily_stats (client_slug);
CREATE INDEX IF NOT EXISTS idx_nsn_daily_stats_stat_date   ON nsn_daily_stats (stat_date);
