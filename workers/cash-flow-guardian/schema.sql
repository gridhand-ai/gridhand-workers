-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Cash Flow Guardian — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- QuickBooks OAuth connections (one per client)
CREATE TABLE IF NOT EXISTS qb_connections (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL UNIQUE,
    realm_id        TEXT NOT NULL,                   -- QuickBooks company ID
    access_token    TEXT NOT NULL,
    refresh_token   TEXT NOT NULL,
    token_type      TEXT NOT NULL DEFAULT 'Bearer',
    expires_at      TIMESTAMPTZ NOT NULL,
    scope           TEXT,
    owner_phone     TEXT NOT NULL,                   -- SMS destination for owner alerts
    low_cash_threshold  NUMERIC(12,2) DEFAULT 5000, -- Alert when cash drops below this
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Daily cash flow snapshots (one row per client per day)
CREATE TABLE IF NOT EXISTS cash_flow_snapshots (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    snapshot_date   DATE NOT NULL,
    total_income    NUMERIC(12,2) DEFAULT 0,
    total_expenses  NUMERIC(12,2) DEFAULT 0,
    net_cash_flow   NUMERIC(12,2) GENERATED ALWAYS AS (total_income - total_expenses) STORED,
    cash_balance    NUMERIC(12,2) DEFAULT 0,
    ar_balance      NUMERIC(12,2) DEFAULT 0,         -- accounts receivable (open invoices)
    ap_balance      NUMERIC(12,2) DEFAULT 0,         -- accounts payable (bills owed)
    overdue_count   INT DEFAULT 0,
    overdue_amount  NUMERIC(12,2) DEFAULT 0,
    raw_data        JSONB,                           -- full QB API response for debugging
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, snapshot_date)
);

-- Invoice tracker (monitors status changes, drives reminder sends)
CREATE TABLE IF NOT EXISTS invoice_tracker (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    qb_invoice_id       TEXT NOT NULL,
    invoice_number      TEXT,
    customer_name       TEXT,
    customer_phone      TEXT,                        -- pulled from QB customer record
    customer_email      TEXT,
    amount              NUMERIC(12,2) NOT NULL,
    balance_due         NUMERIC(12,2) NOT NULL,
    due_date            DATE,
    status              TEXT NOT NULL DEFAULT 'Open', -- Open | Overdue | Paid | Voided
    days_overdue        INT DEFAULT 0,
    reminder_count      INT DEFAULT 0,               -- how many SMS reminders sent
    last_reminder_sent  TIMESTAMPTZ,
    payment_received_at TIMESTAMPTZ,                 -- null until paid
    qb_last_updated     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, qb_invoice_id)
);

-- Alert log (tracks every SMS sent by this worker)
CREATE TABLE IF NOT EXISTS cash_flow_alerts (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- daily_report | invoice_reminder | payment_received | low_cash | weekly_forecast | anomaly
    recipient       TEXT NOT NULL,   -- phone number
    message_body    TEXT NOT NULL,
    invoice_id      TEXT,            -- links to invoice_tracker if relevant
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Weekly forecast log
CREATE TABLE IF NOT EXISTS cash_flow_forecasts (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    forecast_week_start DATE NOT NULL,
    expected_inflow     NUMERIC(12,2) DEFAULT 0,     -- open invoices due this week
    expected_outflow    NUMERIC(12,2) DEFAULT 0,     -- known bills due this week
    projected_balance   NUMERIC(12,2) DEFAULT 0,
    confidence          TEXT DEFAULT 'medium',        -- low | medium | high
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, forecast_week_start)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_snapshots_client_date ON cash_flow_snapshots (client_slug, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_client_status ON invoice_tracker (client_slug, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoice_tracker (due_date) WHERE status IN ('Open', 'Overdue');
CREATE INDEX IF NOT EXISTS idx_alerts_client_type ON cash_flow_alerts (client_slug, alert_type, created_at DESC);
