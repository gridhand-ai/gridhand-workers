-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Change Order Tracker — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Procore + QuickBooks connections (one per client)
CREATE TABLE IF NOT EXISTS cot_connections (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug           TEXT NOT NULL UNIQUE,
    -- Procore
    procore_company_id    TEXT,
    procore_access_token  TEXT,
    procore_refresh_token TEXT,
    procore_expires_at    TIMESTAMPTZ,
    -- QuickBooks
    qb_realm_id           TEXT,
    qb_access_token       TEXT,
    qb_refresh_token      TEXT,
    qb_expires_at         TIMESTAMPTZ,
    -- Settings
    owner_phone           TEXT NOT NULL,
    owner_email           TEXT,
    business_name         TEXT,
    markup_rate           NUMERIC(5,4) DEFAULT 0.15,  -- default 15% markup on COs
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Change order records (pulled from Procore, synced to QB)
CREATE TABLE IF NOT EXISTS cot_change_orders (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    procore_co_id       TEXT NOT NULL,
    procore_project_id  TEXT NOT NULL,
    project_name        TEXT,
    co_number           TEXT,
    title               TEXT,
    description         TEXT,
    status              TEXT,           -- pending | approved | rejected | void
    -- Financials
    original_amount     NUMERIC(12,2) DEFAULT 0,
    approved_amount     NUMERIC(12,2) DEFAULT 0,
    markup_amount       NUMERIC(12,2) DEFAULT 0,
    total_amount        NUMERIC(12,2) GENERATED ALWAYS AS (approved_amount + markup_amount) STORED,
    -- QB Sync
    qb_invoice_id       TEXT,          -- QB invoice created for this CO
    qb_synced_at        TIMESTAMPTZ,
    -- Summary
    client_summary      TEXT,          -- auto-generated client-facing summary
    -- Tracking
    procore_created_at  TIMESTAMPTZ,
    procore_updated_at  TIMESTAMPTZ,
    last_synced_at      TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, procore_co_id)
);

-- Project cost impact summaries (one per project)
CREATE TABLE IF NOT EXISTS cot_project_summaries (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    procore_project_id  TEXT NOT NULL,
    project_name        TEXT,
    original_contract   NUMERIC(12,2) DEFAULT 0,
    approved_cos_total  NUMERIC(12,2) DEFAULT 0,
    pending_cos_total   NUMERIC(12,2) DEFAULT 0,
    revised_contract    NUMERIC(12,2) GENERATED ALWAYS AS (original_contract + approved_cos_total) STORED,
    co_count_approved   INT DEFAULT 0,
    co_count_pending    INT DEFAULT 0,
    last_updated        TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, procore_project_id)
);

-- Alert log
CREATE TABLE IF NOT EXISTS cot_alerts (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- new_co | co_approved | co_rejected | qb_synced | weekly_summary
    recipient       TEXT NOT NULL,
    message_body    TEXT NOT NULL,
    co_id           TEXT,
    project_id      TEXT,
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cot_cos_client_project ON cot_change_orders (client_slug, procore_project_id);
CREATE INDEX IF NOT EXISTS idx_cot_cos_status ON cot_change_orders (client_slug, status);
CREATE INDEX IF NOT EXISTS idx_cot_alerts_client ON cot_alerts (client_slug, alert_type, created_at DESC);
