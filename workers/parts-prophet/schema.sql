-- GRIDHAND Parts Prophet — Supabase Schema
-- Pre-orders parts based on tomorrow's schedule, compares prices across suppliers

-- ─── Shop Connections ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parts_connections (
    id                      BIGSERIAL PRIMARY KEY,
    client_slug             TEXT NOT NULL UNIQUE,
    tekmetric_shop_id       TEXT NOT NULL,
    tekmetric_api_key       TEXT NOT NULL,
    worldpac_account_id     TEXT,
    worldpac_api_key        TEXT,
    autozone_account_id     TEXT,
    autozone_api_key        TEXT,
    owner_phone             TEXT,
    shop_name               TEXT,
    preferred_supplier      TEXT NOT NULL DEFAULT 'worldpac',  -- 'worldpac' | 'autozone' | 'cheapest'
    auto_order_enabled      BOOLEAN NOT NULL DEFAULT FALSE,    -- if true, auto-place orders; if false, send SMS only
    order_cutoff_hour       INT NOT NULL DEFAULT 16,           -- 4pm — last time to order for next-day delivery
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Schedule Scans ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_scans (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    scan_date           DATE NOT NULL,   -- the date we scanned for
    target_date         DATE NOT NULL,   -- the date of the appointments we looked at
    appointments_found  INT NOT NULL DEFAULT 0,
    parts_identified    INT NOT NULL DEFAULT 0,
    total_savings_est   NUMERIC(10,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, scan_date, target_date)
);

-- ─── Parts Needed (per job) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parts_needed (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    tekmetric_job_id    TEXT NOT NULL,
    tekmetric_ro_number TEXT,
    appointment_date    DATE NOT NULL,
    vehicle_year        INT,
    vehicle_make        TEXT,
    vehicle_model       TEXT,
    vehicle_engine      TEXT,
    part_number         TEXT,
    part_description    TEXT NOT NULL,
    quantity_needed     INT NOT NULL DEFAULT 1,
    status              TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'quoted' | 'ordered' | 'received' | 'skipped'
    chosen_supplier     TEXT,
    chosen_price        NUMERIC(10,2),
    order_id            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, tekmetric_job_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_parts_needed_client_date
    ON parts_needed (client_slug, appointment_date, status);

-- ─── Price Comparisons ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_comparisons (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    part_number         TEXT NOT NULL,
    part_description    TEXT,
    vehicle_year        INT,
    vehicle_make        TEXT,
    vehicle_model       TEXT,
    worldpac_price      NUMERIC(10,2),
    worldpac_available  BOOLEAN,
    worldpac_eta        TEXT,
    autozone_price      NUMERIC(10,2),
    autozone_available  BOOLEAN,
    autozone_eta        TEXT,
    best_supplier       TEXT,
    savings_vs_worst    NUMERIC(10,2),
    quoted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, part_number, quoted_at::DATE)
);

CREATE INDEX IF NOT EXISTS idx_price_comparisons_client_part
    ON price_comparisons (client_slug, part_number, quoted_at DESC);

-- ─── Parts Orders ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parts_orders (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    supplier            TEXT NOT NULL,  -- 'worldpac' | 'autozone'
    order_id            TEXT,
    order_date          DATE NOT NULL,
    delivery_date       DATE,
    total_parts         INT NOT NULL DEFAULT 0,
    total_cost          NUMERIC(10,2),
    status              TEXT NOT NULL DEFAULT 'placed',  -- 'placed' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'
    line_items          JSONB,           -- array of { partNumber, description, qty, price }
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parts_orders_client
    ON parts_orders (client_slug, order_date DESC, status);

-- ─── Alert Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parts_alerts (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    alert_type          TEXT NOT NULL,  -- 'parts_recommendation' | 'order_placed' | 'order_confirmed' | 'savings_summary'
    recipient           TEXT NOT NULL,
    message_body        TEXT NOT NULL,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parts_alerts_client
    ON parts_alerts (client_slug, alert_type, sent_at DESC);
