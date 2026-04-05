-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Maintenance Dispatcher — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- AppFolio + client settings (one per client)
CREATE TABLE IF NOT EXISTS md_connections (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug             TEXT NOT NULL UNIQUE,
    appfolio_client_id      TEXT,                     -- AppFolio API client ID
    appfolio_database_name  TEXT,                     -- AppFolio database/subdomain
    appfolio_api_username   TEXT,
    appfolio_api_password   TEXT,
    owner_phone             TEXT NOT NULL,
    business_name           TEXT,
    emergency_vendors       JSONB DEFAULT '{}',       -- { "plumbing": "+1...", "electrical": "+1..." }
    sla_hours               JSONB DEFAULT '{"emergency":4,"urgent":24,"routine":72}',
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Vendor directory
CREATE TABLE IF NOT EXISTS md_vendors (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    name            TEXT NOT NULL,
    phone           TEXT NOT NULL,
    email           TEXT,
    trade           TEXT NOT NULL,   -- plumbing | electrical | hvac | appliance | general | roofing | pest
    rating          NUMERIC(3,2) DEFAULT 5.0,
    jobs_completed  INT DEFAULT 0,
    avg_response_min INT DEFAULT 60,
    active          BOOLEAN DEFAULT TRUE,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, phone)
);

-- Maintenance requests (pulled from AppFolio + inbound SMS)
CREATE TABLE IF NOT EXISTS md_requests (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    appfolio_request_id TEXT,                         -- AppFolio work order ID if sourced from there
    -- Property & Tenant
    property_address    TEXT,
    unit_number         TEXT,
    tenant_name         TEXT,
    tenant_phone        TEXT,
    -- Request Details
    category            TEXT,                         -- plumbing | electrical | hvac | appliance | general
    priority            TEXT DEFAULT 'routine',       -- emergency | urgent | routine
    description         TEXT NOT NULL,
    -- Vendor Assignment
    vendor_id           UUID REFERENCES md_vendors(id),
    vendor_name         TEXT,
    vendor_phone        TEXT,
    dispatched_at       TIMESTAMPTZ,
    -- Completion
    status              TEXT DEFAULT 'new',           -- new | triaged | dispatched | in_progress | completed | cancelled
    completed_at        TIMESTAMPTZ,
    completion_notes    TEXT,
    -- SLA
    sla_deadline        TIMESTAMPTZ,
    sla_breached        BOOLEAN DEFAULT FALSE,
    -- Tracking
    appfolio_synced     BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Alert / SMS log
CREATE TABLE IF NOT EXISTS md_alerts (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- new_request | dispatched | completed | sla_warning | tenant_update
    recipient       TEXT NOT NULL,
    message_body    TEXT NOT NULL,
    request_id      UUID,
    status          TEXT DEFAULT 'sent',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_md_requests_client_status ON md_requests (client_slug, status);
CREATE INDEX IF NOT EXISTS idx_md_requests_priority ON md_requests (client_slug, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_md_vendors_client_trade ON md_vendors (client_slug, trade, active);
CREATE INDEX IF NOT EXISTS idx_md_alerts_client ON md_alerts (client_slug, alert_type, created_at DESC);
