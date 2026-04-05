-- ============================================================
-- GRIDHAND AI — Doc Chaser Schema
-- Accounting industry: auto-request missing docs from tax clients
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Accounting firm config ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dc_clients (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug                     TEXT UNIQUE NOT NULL,
    firm_name                       TEXT NOT NULL,
    taxdome_api_key                 TEXT,
    taxdome_firm_id                 TEXT,
    twilio_sid                      TEXT,
    twilio_token                    TEXT,
    twilio_number                   TEXT,
    email_host                      TEXT,
    email_port                      INT DEFAULT 587,
    email_user                      TEXT,
    email_pass                      TEXT,
    email_from                      TEXT,
    owner_phone                     TEXT,
    default_reminder_interval_days  INT DEFAULT 3,
    max_reminders                   INT DEFAULT 4,
    created_at                      TIMESTAMPTZ DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Document requests (tracked per tax client) ───────────────────────────────

CREATE TABLE IF NOT EXISTS dc_document_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES dc_clients(id) ON DELETE CASCADE,
    taxdome_client_id       TEXT NOT NULL,
    taxdome_job_id          TEXT,
    taxdome_request_id      TEXT,
    client_name             TEXT NOT NULL,
    client_email            TEXT,
    client_phone            TEXT,
    document_name           TEXT NOT NULL,
    document_type           TEXT,
    due_date                DATE,
    status                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'received', 'overdue', 'cancelled')),
    reminder_count          INT NOT NULL DEFAULT 0,
    last_reminder_sent_at   TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Reminder log (every SMS or email sent) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS dc_reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES dc_clients(id) ON DELETE CASCADE,
    request_id      UUID NOT NULL REFERENCES dc_document_requests(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
    recipient       TEXT NOT NULL,
    subject         TEXT,
    body            TEXT NOT NULL,
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    status          TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent', 'failed', 'bounced')),
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Weekly outstanding report snapshots ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS dc_weekly_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES dc_clients(id) ON DELETE CASCADE,
    report_date     DATE NOT NULL,
    total_requests  INT NOT NULL DEFAULT 0,
    received_count  INT NOT NULL DEFAULT 0,
    pending_count   INT NOT NULL DEFAULT 0,
    overdue_count   INT NOT NULL DEFAULT 0,
    report_data     JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_dc_requests_client_status
    ON dc_document_requests (client_id, status);

CREATE INDEX IF NOT EXISTS idx_dc_requests_taxdome_client
    ON dc_document_requests (client_id, taxdome_client_id);

CREATE INDEX IF NOT EXISTS idx_dc_reminders_request_sent
    ON dc_reminders (request_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_reminders_client
    ON dc_reminders (client_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_weekly_reports_client_date
    ON dc_weekly_reports (client_id, report_date DESC);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION dc_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dc_clients_updated_at
    BEFORE UPDATE ON dc_clients
    FOR EACH ROW EXECUTE FUNCTION dc_set_updated_at();

CREATE TRIGGER dc_document_requests_updated_at
    BEFORE UPDATE ON dc_document_requests
    FOR EACH ROW EXECUTE FUNCTION dc_set_updated_at();
