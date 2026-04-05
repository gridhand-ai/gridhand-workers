-- ============================================================
-- GRIDHAND AI — Waste Watcher Worker Schema
-- Run this against your Supabase project
-- ============================================================

-- ─── Client Connections ───────────────────────────────────────────────────────
-- Stores credentials for MarketMan/BlueCart (inventory) + Toast/Square (POS)

CREATE TABLE IF NOT EXISTS watcher_connections (
    id                      SERIAL PRIMARY KEY,
    client_slug             TEXT NOT NULL UNIQUE,
    restaurant_name         TEXT NOT NULL,

    -- MarketMan credentials
    marketman_api_key       TEXT,
    marketman_guid          TEXT,

    -- BlueCart credentials
    bluecart_api_key        TEXT,

    -- Which inventory system is active for this client
    active_inventory_system TEXT NOT NULL DEFAULT 'marketman'
        CHECK (active_inventory_system IN ('marketman', 'bluecart')),

    -- Toast POS credentials (OAuth client credentials)
    toast_client_id         TEXT,
    toast_client_secret     TEXT,
    toast_restaurant_guid   TEXT,
    toast_access_token      TEXT,
    toast_token_expires_at  TIMESTAMPTZ,

    -- Square POS credentials (OAuth)
    square_access_token     TEXT,
    square_location_id      TEXT,

    -- Which POS is active for this client
    active_pos_system       TEXT NOT NULL DEFAULT 'toast'
        CHECK (active_pos_system IN ('toast', 'square')),

    -- Alert recipients
    manager_phone           TEXT,
    chef_phone              TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Inventory Items ──────────────────────────────────────────────────────────
-- Current state of every tracked inventory item per client

CREATE TABLE IF NOT EXISTS inventory_items (
    id                  SERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    external_item_id    TEXT NOT NULL,
    item_name           TEXT NOT NULL,
    category            TEXT,
    current_qty         NUMERIC(10,3) NOT NULL DEFAULT 0,
    unit                TEXT NOT NULL DEFAULT 'each',
    par_level           NUMERIC(10,3),
    unit_cost           NUMERIC(8,2) NOT NULL DEFAULT 0,
    expiry_date         DATE,
    storage_location    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, external_item_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_client ON inventory_items (client_slug);
CREATE INDEX IF NOT EXISTS idx_inventory_items_expiry ON inventory_items (expiry_date)
    WHERE expiry_date IS NOT NULL;

-- ─── Inventory Snapshots ──────────────────────────────────────────────────────
-- Daily summary of inventory state — used for trending and cost reporting

CREATE TABLE IF NOT EXISTS inventory_snapshots (
    id                      SERIAL PRIMARY KEY,
    client_slug             TEXT NOT NULL,
    snapshot_date           DATE NOT NULL,
    total_items             INT NOT NULL DEFAULT 0,
    low_stock_count         INT NOT NULL DEFAULT 0,
    expiring_count          INT NOT NULL DEFAULT 0,
    total_inventory_value   NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_client_date ON inventory_snapshots (client_slug, snapshot_date DESC);

-- ─── Daily Sales ──────────────────────────────────────────────────────────────
-- Per-item daily sales pulled from POS — drives usage rate calculations

CREATE TABLE IF NOT EXISTS daily_sales (
    id              SERIAL PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    sale_date       DATE NOT NULL,
    item_name       TEXT NOT NULL,
    quantity_sold   NUMERIC(10,3) NOT NULL DEFAULT 0,
    revenue         NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, sale_date, item_name)
);

CREATE INDEX IF NOT EXISTS idx_daily_sales_client_date ON daily_sales (client_slug, sale_date DESC);

-- ─── Waste Predictions ────────────────────────────────────────────────────────
-- Per-item predictions of waste. Actual waste filled in after the fact for model accuracy.

CREATE TABLE IF NOT EXISTS waste_predictions (
    id                      SERIAL PRIMARY KEY,
    client_slug             TEXT NOT NULL,
    item_name               TEXT NOT NULL,
    prediction_date         DATE NOT NULL,
    predicted_waste_qty     NUMERIC(10,3) NOT NULL DEFAULT 0,
    predicted_waste_cost    NUMERIC(8,2)  NOT NULL DEFAULT 0,
    risk_score              NUMERIC(5,2)  NOT NULL DEFAULT 0,
    alerted                 BOOLEAN NOT NULL DEFAULT false,
    actual_waste_qty        NUMERIC(10,3),          -- filled in after the fact
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waste_predictions_client ON waste_predictions (client_slug, prediction_date DESC);

-- ─── Waste Alerts ─────────────────────────────────────────────────────────────
-- Log of every SMS alert sent — for audit, deduplication, and reporting

CREATE TABLE IF NOT EXISTS waste_alerts (
    id              SERIAL PRIMARY KEY,
    client_slug     TEXT NOT NULL,
    alert_type      TEXT NOT NULL,   -- 'expiry_alert' | 'low_stock' | 'prep_briefing' | 'weekly_report'
    recipient       TEXT NOT NULL,   -- phone number
    message_body    TEXT NOT NULL,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waste_alerts_client ON waste_alerts (client_slug, sent_at DESC);

-- ─── Triggers: updated_at ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_watcher_connections_updated
    BEFORE UPDATE ON watcher_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_inventory_items_updated
    BEFORE UPDATE ON inventory_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
