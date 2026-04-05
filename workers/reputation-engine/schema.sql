-- GRIDHAND Reputation Engine — Supabase Schema
-- Monitors reviews across Google and Yelp, tracks responses, alerts on negatives

-- ─── Business Connections ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reputation_connections (
    id                          BIGSERIAL PRIMARY KEY,
    client_slug                 TEXT NOT NULL UNIQUE,
    business_name               TEXT NOT NULL,
    owner_phone                 TEXT,
    manager_phone               TEXT,
    -- Google Business Profile
    google_place_id             TEXT,
    google_access_token         TEXT,
    google_refresh_token        TEXT,
    google_token_expires_at     TIMESTAMPTZ,
    -- Yelp Fusion API
    yelp_business_id            TEXT,
    yelp_api_key                TEXT,
    -- Response Settings
    auto_respond_google         BOOLEAN NOT NULL DEFAULT TRUE,
    auto_respond_yelp           BOOLEAN NOT NULL DEFAULT FALSE,  -- Yelp API doesn't allow auto-responses
    negative_threshold          INT NOT NULL DEFAULT 3,           -- stars: alert if at or below this
    alert_on_negative           BOOLEAN NOT NULL DEFAULT TRUE,
    response_tone               TEXT NOT NULL DEFAULT 'professional',  -- 'professional' | 'friendly' | 'formal'
    response_signature          TEXT,                             -- e.g., "— The Team at Joe's Brake Shop"
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Reviews ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    platform            TEXT NOT NULL,      -- 'google' | 'yelp'
    platform_review_id  TEXT NOT NULL,
    reviewer_name       TEXT,
    reviewer_photo_url  TEXT,
    star_rating         INT NOT NULL,       -- 1-5
    review_text         TEXT,
    review_date         TIMESTAMPTZ,
    reply_text          TEXT,
    replied_at          TIMESTAMPTZ,
    reply_status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'auto_responded' | 'manually_responded' | 'skipped'
    is_negative         BOOLEAN GENERATED ALWAYS AS (star_rating <= 3) STORED,
    alert_sent          BOOLEAN NOT NULL DEFAULT FALSE,
    alert_sent_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, platform, platform_review_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_client_platform
    ON reviews (client_slug, platform, review_date DESC);

CREATE INDEX IF NOT EXISTS idx_reviews_negative_unreplied
    ON reviews (client_slug, is_negative, reply_status);

CREATE INDEX IF NOT EXISTS idx_reviews_rating
    ON reviews (client_slug, star_rating, review_date DESC);

-- ─── Review Responses ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_responses (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    review_id           BIGINT NOT NULL REFERENCES reviews(id),
    platform            TEXT NOT NULL,
    platform_review_id  TEXT NOT NULL,
    response_text       TEXT NOT NULL,
    response_type       TEXT NOT NULL DEFAULT 'auto',   -- 'auto' | 'manual' | 'draft'
    posted_successfully BOOLEAN NOT NULL DEFAULT FALSE,
    posted_at           TIMESTAMPTZ,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_responses_client
    ON review_responses (client_slug, created_at DESC);

-- ─── Reputation Stats (weekly snapshots) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS reputation_stats (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    platform            TEXT NOT NULL,
    stat_date           DATE NOT NULL,
    total_reviews       INT NOT NULL DEFAULT 0,
    avg_rating          NUMERIC(3,2),
    new_reviews_7d      INT NOT NULL DEFAULT 0,
    positive_7d         INT NOT NULL DEFAULT 0,   -- 4-5 stars
    negative_7d         INT NOT NULL DEFAULT 0,   -- 1-3 stars
    response_rate_7d    NUMERIC(5,2),             -- percentage
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_slug, platform, stat_date)
);

-- ─── Alert Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reputation_alerts (
    id                  BIGSERIAL PRIMARY KEY,
    client_slug         TEXT NOT NULL,
    review_id           BIGINT,
    alert_type          TEXT NOT NULL,  -- 'negative_review' | 'weekly_digest' | 'response_posted' | 'rating_drop'
    platform            TEXT,
    star_rating         INT,
    recipient           TEXT NOT NULL,
    message_body        TEXT NOT NULL,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_alerts_client
    ON reputation_alerts (client_slug, alert_type, sent_at DESC);
