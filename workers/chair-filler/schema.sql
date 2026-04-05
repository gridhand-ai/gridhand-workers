-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Chair Filler — Supabase Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Salon booking + Instagram connections (one per client)
CREATE TABLE IF NOT EXISTS chair_connections (
    id                          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug                 TEXT NOT NULL UNIQUE,
    booking_system              TEXT NOT NULL DEFAULT 'boulevard', -- boulevard | square
    boulevard_api_key           TEXT,
    boulevard_business_id       TEXT,
    square_access_token         TEXT,
    square_location_id          TEXT,
    instagram_access_token      TEXT,                             -- long-lived Graph API token
    instagram_account_id        TEXT,                             -- IG user/business account ID
    instagram_token_expires_at  TIMESTAMPTZ,                      -- long-lived tokens last ~60 days
    owner_phone                 TEXT,
    salon_name                  TEXT NOT NULL,
    booking_url                 TEXT,                             -- booking link in posts/texts
    default_post_image          TEXT,                             -- URL for Instagram post image
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Open appointment slots (upserted each scan, status updated when booked)
CREATE TABLE IF NOT EXISTS open_slots (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug  TEXT NOT NULL,
    slot_id      TEXT NOT NULL,                                   -- external ID from booking system
    service_type TEXT,
    stylist_name TEXT,
    start_time   TIMESTAMPTZ NOT NULL,
    end_time     TIMESTAMPTZ,
    date         DATE NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',                    -- open | booked | expired
    post_id      TEXT,                                            -- Instagram post ID if posted
    texts_sent   INT DEFAULT 0,                                   -- count of SMS sent for this slot
    booked_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, slot_id)
);

-- Alert log (every SMS and Instagram post tracked here)
CREATE TABLE IF NOT EXISTS chair_alerts (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_slug  TEXT NOT NULL,
    alert_type   TEXT NOT NULL,   -- last_minute_text | instagram_post | slot_booked | opt_out
    recipient    TEXT NOT NULL,   -- phone number or instagram account id
    message_body TEXT NOT NULL,
    slot_id      UUID,            -- references open_slots.id if relevant
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chair_connections_slug  ON chair_connections (client_slug);
CREATE INDEX IF NOT EXISTS idx_open_slots_client_date  ON open_slots (client_slug, date, status);
CREATE INDEX IF NOT EXISTS idx_open_slots_status       ON open_slots (client_slug, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_chair_alerts_client     ON chair_alerts (client_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chair_alerts_slot       ON chair_alerts (slot_id) WHERE slot_id IS NOT NULL;
