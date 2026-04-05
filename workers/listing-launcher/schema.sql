-- ============================================================
-- GRIDHAND Listing Launcher — Supabase Schema
-- All tables use UUID primary keys and JSONB for flexible data.
-- Run this in the Supabase SQL editor.
-- ============================================================

-- Enable UUID extension (already enabled on Supabase, but safe to run)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── updated_at trigger function (reused across all tables) ──────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── ll_clients ───────────────────────────────────────────────────────────────
-- One row per real estate agent / client onboarded to Listing Launcher.

CREATE TABLE IF NOT EXISTS ll_clients (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_slug             TEXT NOT NULL UNIQUE,

    -- Agent contact
    agent_name              TEXT,
    agent_phone             TEXT,
    agent_email             TEXT,
    business_name           TEXT,

    -- MLS Grid credentials
    mls_token               TEXT,            -- Bearer token for MLS Grid API
    mls_agent_id            TEXT,            -- MemberKey to filter agent's own listings
    mls_originating_system  TEXT,            -- e.g. 'MiRealSource', 'MRED'

    -- Social media credentials (stored per-client)
    facebook_page_id        TEXT,
    facebook_access_token   TEXT,
    instagram_account_id    TEXT,            -- Instagram Business Account linked to FB page
    twitter_api_key         TEXT,
    twitter_api_secret      TEXT,
    twitter_access_token    TEXT,
    twitter_access_secret   TEXT,

    -- Distribution config
    enabled_platforms       TEXT[] DEFAULT ARRAY['facebook', 'instagram', 'twitter'],
    auto_distribute         BOOLEAN DEFAULT FALSE,   -- auto-post on new listing detection
    auto_generate_content   BOOLEAN DEFAULT TRUE,    -- auto-run content generation on new listing

    -- Status
    active                  BOOLEAN DEFAULT TRUE,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ll_clients_slug ON ll_clients(client_slug);
CREATE INDEX IF NOT EXISTS idx_ll_clients_active ON ll_clients(active);

CREATE TRIGGER trg_ll_clients_updated_at
    BEFORE UPDATE ON ll_clients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── ll_listings ──────────────────────────────────────────────────────────────
-- One row per unique MLS listing per client.
-- Upserted on conflict (client_id, mls_key) so price/status changes update in place.

CREATE TABLE IF NOT EXISTS ll_listings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       UUID NOT NULL REFERENCES ll_clients(id) ON DELETE CASCADE,

    -- MLS identifiers
    mls_key         TEXT NOT NULL,           -- ListingKey (MLS Grid primary identifier)
    mls_number      TEXT,                    -- ListingId (human-readable MLS#)

    -- Property details
    address         TEXT NOT NULL,
    city            TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'IL',
    zip             TEXT,
    price           NUMERIC(12, 2) NOT NULL,
    beds            INTEGER DEFAULT 0,
    baths           NUMERIC(4, 1) DEFAULT 0,
    sqft            INTEGER,
    year_built      INTEGER,

    -- Listing metadata
    status          TEXT NOT NULL DEFAULT 'Active',   -- Active, Pending, Closed, Withdrawn
    list_date       DATE,
    days_on_market  INTEGER DEFAULT 0,

    -- Content fields (raw from MLS)
    description     TEXT,                    -- PublicRemarks from MLS
    features        JSONB DEFAULT '[]'::JSONB,  -- Array of feature strings
    photos          JSONB DEFAULT '[]'::JSONB,  -- Array of photo URLs

    -- Raw MLS data for reference
    raw_data        JSONB DEFAULT '{}'::JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (client_id, mls_key)
);

CREATE INDEX IF NOT EXISTS idx_ll_listings_client   ON ll_listings(client_id);
CREATE INDEX IF NOT EXISTS idx_ll_listings_mls_key  ON ll_listings(client_id, mls_key);
CREATE INDEX IF NOT EXISTS idx_ll_listings_status   ON ll_listings(status);
CREATE INDEX IF NOT EXISTS idx_ll_listings_city     ON ll_listings(city);
CREATE INDEX IF NOT EXISTS idx_ll_listings_price    ON ll_listings(price);

CREATE TRIGGER trg_ll_listings_updated_at
    BEFORE UPDATE ON ll_listings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── ll_content ───────────────────────────────────────────────────────────────
-- AI-generated content for each listing. One row per listing (upserted on conflict).

CREATE TABLE IF NOT EXISTS ll_content (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id          UUID NOT NULL UNIQUE REFERENCES ll_listings(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES ll_clients(id) ON DELETE CASCADE,

    -- AI-generated copy
    mls_description     TEXT,               -- 250-300 word professional MLS description
    facebook_post       TEXT,               -- Hook + features + CTA + hashtags (max 500 chars)
    instagram_caption   TEXT,               -- Aspirational caption + hashtags (formatted string)
    twitter_post        TEXT,               -- Max 280 chars

    -- Canva design output
    canva_design_url    TEXT,               -- URL to edit the design in Canva
    canva_export_url    TEXT,               -- Direct image URL for social posting

    generated_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ll_content_listing ON ll_content(listing_id);
CREATE INDEX IF NOT EXISTS idx_ll_content_client  ON ll_content(client_id);

CREATE TRIGGER trg_ll_content_updated_at
    BEFORE UPDATE ON ll_content
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── ll_distribution_log ─────────────────────────────────────────────────────
-- One row per platform post. Multiple rows per listing (one per platform per campaign).

CREATE TABLE IF NOT EXISTS ll_distribution_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id  UUID NOT NULL REFERENCES ll_listings(id) ON DELETE CASCADE,
    client_id   UUID NOT NULL REFERENCES ll_clients(id) ON DELETE CASCADE,

    platform    TEXT NOT NULL,              -- 'facebook' | 'instagram' | 'twitter'
    post_id     TEXT,                       -- Platform-specific post/media/tweet ID
    content     TEXT,                       -- The exact text posted
    image_url   TEXT,                       -- Image attached to the post

    posted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ll_distribution_listing  ON ll_distribution_log(listing_id);
CREATE INDEX IF NOT EXISTS idx_ll_distribution_client   ON ll_distribution_log(client_id);
CREATE INDEX IF NOT EXISTS idx_ll_distribution_platform ON ll_distribution_log(platform);
CREATE INDEX IF NOT EXISTS idx_ll_distribution_post_id  ON ll_distribution_log(post_id);
CREATE INDEX IF NOT EXISTS idx_ll_distribution_posted   ON ll_distribution_log(posted_at);

-- ─── ll_performance_metrics ───────────────────────────────────────────────────
-- Engagement metrics per distribution record, tracked 24h after posting.

CREATE TABLE IF NOT EXISTS ll_performance_metrics (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id       UUID NOT NULL REFERENCES ll_listings(id) ON DELETE CASCADE,
    distribution_id  UUID UNIQUE REFERENCES ll_distribution_log(id) ON DELETE CASCADE,

    platform         TEXT NOT NULL,

    -- Engagement metrics
    views            INTEGER NOT NULL DEFAULT 0,
    likes            INTEGER NOT NULL DEFAULT 0,
    comments         INTEGER NOT NULL DEFAULT 0,
    shares           INTEGER NOT NULL DEFAULT 0,
    link_clicks      INTEGER NOT NULL DEFAULT 0,

    checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_metrics      JSONB DEFAULT '{}'::JSONB,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ll_perf_listing      ON ll_performance_metrics(listing_id);
CREATE INDEX IF NOT EXISTS idx_ll_perf_dist         ON ll_performance_metrics(distribution_id);
CREATE INDEX IF NOT EXISTS idx_ll_perf_platform     ON ll_performance_metrics(platform);
CREATE INDEX IF NOT EXISTS idx_ll_perf_checked_at   ON ll_performance_metrics(checked_at);

CREATE TRIGGER trg_ll_perf_updated_at
    BEFORE UPDATE ON ll_performance_metrics
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── ll_sms_log ───────────────────────────────────────────────────────────────
-- Every SMS sent by Listing Launcher, for audit and de-duplication.

CREATE TABLE IF NOT EXISTS ll_sms_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_slug   TEXT NOT NULL,
    to_phone      TEXT NOT NULL,
    message_body  TEXT NOT NULL,
    message_type  TEXT NOT NULL,    -- 'new_listing_alert' | 'content_ready' | 'distribution_summary'
                                    -- | 'price_drop_campaign' | 'weekly_performance' | 'low_engagement_alert'
    listing_id    UUID REFERENCES ll_listings(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ll_sms_client     ON ll_sms_log(client_slug);
CREATE INDEX IF NOT EXISTS idx_ll_sms_listing    ON ll_sms_log(listing_id);
CREATE INDEX IF NOT EXISTS idx_ll_sms_type       ON ll_sms_log(message_type);
CREATE INDEX IF NOT EXISTS idx_ll_sms_created    ON ll_sms_log(created_at);

-- ─── Row-Level Security (enable in production) ────────────────────────────────
-- Uncomment and configure after testing. Service key bypasses RLS.

-- ALTER TABLE ll_clients            ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ll_listings           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ll_content            ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ll_distribution_log   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ll_performance_metrics ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ll_sms_log            ENABLE ROW LEVEL SECURITY;
