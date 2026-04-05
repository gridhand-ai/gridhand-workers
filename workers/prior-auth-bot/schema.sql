-- ============================================================
-- GRIDHAND AI — Prior Auth Bot
-- Database Schema
-- ============================================================

-- Practice connections
CREATE TABLE IF NOT EXISTS pab_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug         VARCHAR(100) UNIQUE NOT NULL,
    practice_name       VARCHAR(255) NOT NULL,
    staff_phone         VARCHAR(20),
    billing_phone       VARCHAR(20),

    -- EHR integration
    ehr_type            VARCHAR(10) NOT NULL CHECK (ehr_type IN ('epic', 'cerner')),
    ehr_base_url        TEXT NOT NULL,
    ehr_client_id       TEXT NOT NULL,
    ehr_client_secret   TEXT NOT NULL,

    -- Practice identifiers
    npi                 VARCHAR(10),
    tax_id              VARCHAR(9),

    -- Workflow settings
    auto_appeal         BOOLEAN DEFAULT false,
    default_urgency     VARCHAR(20) DEFAULT 'routine',

    -- Anthropic key (per-client override)
    anthropic_key       TEXT,

    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Prior authorization records
CREATE TABLE IF NOT EXISTS pab_auths (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             VARCHAR(100) NOT NULL REFERENCES pab_connections(client_slug) ON DELETE CASCADE,

    -- EHR reference
    order_id                VARCHAR(255),

    -- Patient info
    patient_id              VARCHAR(255),
    patient_name            VARCHAR(255),

    -- Payer info
    payer_id                VARCHAR(50) NOT NULL,
    payer_name              VARCHAR(255),
    member_id               VARCHAR(100),
    group_number            VARCHAR(100),

    -- Clinical data
    procedure_codes         JSONB DEFAULT '[]',
    diagnosis_codes         JSONB DEFAULT '[]',
    clinical_notes          TEXT,

    -- Request details
    urgency                 VARCHAR(20) DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'emergent')),

    -- Status lifecycle
    status                  VARCHAR(30) DEFAULT 'draft' CHECK (status IN (
        'draft', 'submitted', 'pending', 'approved', 'denied',
        'appealing', 'appeal_approved', 'appeal_denied', 'expired', 'cancelled'
    )),

    -- Payer reference numbers
    reference_number        VARCHAR(100),
    auth_number             VARCHAR(100),

    -- Timestamps
    submitted_at            TIMESTAMPTZ,
    decision_at             TIMESTAMPTZ,
    expiration_date         DATE,

    -- Denial / appeal data
    denial_reason           TEXT,
    denial_codes            JSONB DEFAULT '[]',
    appeal_submitted_at     TIMESTAMPTZ,
    appeal_letter           TEXT,

    -- Status tracking
    status_check_count      INT DEFAULT 0,
    last_status_check_at    TIMESTAMPTZ,

    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Full audit timeline for each auth
CREATE TABLE IF NOT EXISTS pab_timeline (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug VARCHAR(100) NOT NULL,
    auth_id     UUID NOT NULL REFERENCES pab_auths(id) ON DELETE CASCADE,
    event_type  VARCHAR(100) NOT NULL,
    event_data  JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- SMS log
CREATE TABLE IF NOT EXISTS pab_sms_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug     VARCHAR(100) NOT NULL,
    auth_id         UUID REFERENCES pab_auths(id) ON DELETE SET NULL,
    direction       VARCHAR(10) DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
    recipient_phone VARCHAR(20),
    message_body    TEXT,
    twilio_sid      VARCHAR(100),
    status          VARCHAR(30),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Daily aggregate stats
CREATE TABLE IF NOT EXISTS pab_daily_stats (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug             VARCHAR(100) NOT NULL,
    stat_date               DATE NOT NULL,
    submitted_count         INT DEFAULT 0,
    approved_count          INT DEFAULT 0,
    denied_count            INT DEFAULT 0,
    appealed_count          INT DEFAULT 0,
    appeal_approved_count   INT DEFAULT 0,
    avg_turnaround_hours    NUMERIC(10, 2),
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_slug, stat_date)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_pab_auths_client_slug     ON pab_auths(client_slug);
CREATE INDEX IF NOT EXISTS idx_pab_auths_status          ON pab_auths(status);
CREATE INDEX IF NOT EXISTS idx_pab_auths_payer_id        ON pab_auths(payer_id);
CREATE INDEX IF NOT EXISTS idx_pab_auths_submitted_at    ON pab_auths(submitted_at);
CREATE INDEX IF NOT EXISTS idx_pab_auths_order_id        ON pab_auths(order_id);
CREATE INDEX IF NOT EXISTS idx_pab_timeline_auth_id      ON pab_timeline(auth_id);
CREATE INDEX IF NOT EXISTS idx_pab_timeline_client_slug  ON pab_timeline(client_slug);
CREATE INDEX IF NOT EXISTS idx_pab_sms_log_client_slug   ON pab_sms_log(client_slug);
CREATE INDEX IF NOT EXISTS idx_pab_sms_log_auth_id       ON pab_sms_log(auth_id);
CREATE INDEX IF NOT EXISTS idx_pab_daily_stats_slug_date ON pab_daily_stats(client_slug, stat_date);

-- ============================================================
-- updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION pab_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER pab_connections_updated_at
    BEFORE UPDATE ON pab_connections
    FOR EACH ROW EXECUTE FUNCTION pab_set_updated_at();

CREATE OR REPLACE TRIGGER pab_auths_updated_at
    BEFORE UPDATE ON pab_auths
    FOR EACH ROW EXECUTE FUNCTION pab_set_updated_at();
