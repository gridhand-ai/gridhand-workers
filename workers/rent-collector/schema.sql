-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Rent Collector — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Buildium + QuickBooks connections (one per client)
CREATE TABLE IF NOT EXISTS rc_connections (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug             TEXT NOT NULL UNIQUE,
    -- Buildium API
    buildium_client_id      TEXT,
    buildium_client_secret  TEXT,
    buildium_access_token   TEXT,
    buildium_refresh_token  TEXT,
    buildium_expires_at     TIMESTAMPTZ,
    -- QuickBooks
    qb_realm_id             TEXT,
    qb_access_token         TEXT,
    qb_refresh_token        TEXT,
    qb_expires_at           TIMESTAMPTZ,
    -- Settings
    owner_phone             TEXT NOT NULL,
    owner_email             TEXT,
    business_name           TEXT,
    late_fee_amount         NUMERIC(10,2) DEFAULT 50,
    late_fee_days           INT DEFAULT 5,             -- days past due before late fee initiates
    reminder_days_before    INT DEFAULT 3,             -- send reminder X days before due date
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Lease/tenant rent tracker
CREATE TABLE IF NOT EXISTS rc_rent_tracker (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    buildium_lease_id   TEXT NOT NULL,
    buildium_tenant_id  TEXT,
    -- Property
    property_address    TEXT,
    unit_number         TEXT,
    -- Tenant
    tenant_name         TEXT NOT NULL,
    tenant_phone        TEXT,
    tenant_email        TEXT,
    -- Rent
    rent_amount         NUMERIC(10,2) NOT NULL,
    due_day             INT NOT NULL DEFAULT 1,        -- day of month rent is due
    -- Current Month Status
    current_month       TEXT NOT NULL,                 -- YYYY-MM format
    amount_paid         NUMERIC(10,2) DEFAULT 0,
    paid_at             TIMESTAMPTZ,
    balance_due         NUMERIC(10,2) GENERATED ALWAYS AS (rent_amount - amount_paid) STORED,
    status              TEXT DEFAULT 'pending',        -- pending | partial | paid | late | late_fee_issued
    -- Reminder tracking
    reminder_sent_count INT DEFAULT 0,
    last_reminder_sent  TIMESTAMPTZ,
    late_fee_issued     BOOLEAN DEFAULT FALSE,
    late_fee_issued_at  TIMESTAMPTZ,
    -- QB Sync
    qb_invoice_id       TEXT,
    -- Timestamps
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, buildium_lease_id, current_month)
);

-- Owner reports log
CREATE TABLE IF NOT EXISTS rc_owner_reports (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    report_month    TEXT NOT NULL,                     -- YYYY-MM
    total_expected  NUMERIC(10,2) DEFAULT 0,
    total_collected NUMERIC(10,2) DEFAULT 0,
    total_outstanding NUMERIC(10,2) DEFAULT 0,
    tenant_count    INT DEFAULT 0,
    paid_count      INT DEFAULT 0,
    late_count      INT DEFAULT 0,
    report_text     TEXT,
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, report_month)
);

-- Alert / SMS log
CREATE TABLE IF NOT EXISTS rc_alerts (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- reminder | payment_received | late_fee | owner_report | overdue_notice
    recipient       TEXT NOT NULL,
    message_body    TEXT NOT NULL,
    lease_id        TEXT,
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rc_tracker_client_month ON rc_rent_tracker (client_slug, current_month);
CREATE INDEX IF NOT EXISTS idx_rc_tracker_status ON rc_rent_tracker (client_slug, status);
CREATE INDEX IF NOT EXISTS idx_rc_alerts_client ON rc_alerts (client_slug, alert_type, created_at DESC);
