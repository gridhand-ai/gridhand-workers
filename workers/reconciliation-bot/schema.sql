-- ============================================================
-- GRIDHAND AI — Reconciliation Bot Schema
-- Supabase / PostgreSQL
-- ============================================================

-- Enable pgcrypto for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ─── rb_clients ────────────────────────────────────────────────────────────────
-- Stores accounting firm / business client config per connected platform.

create table if not exists rb_clients (
    id                  uuid primary key default gen_random_uuid(),
    client_slug         text unique not null,
    business_name       text not null,
    accounting_platform text not null check (accounting_platform in ('qbo', 'xero', 'both')),

    -- QuickBooks Online
    qbo_realm_id        text,
    qbo_access_token    text,
    qbo_refresh_token   text,
    qbo_expires_at      timestamptz,

    -- Xero
    xero_tenant_id      text,
    xero_access_token   text,
    xero_refresh_token  text,
    xero_expires_at     timestamptz,

    -- Plaid bank feed
    plaid_access_token  text,
    plaid_item_id       text,

    -- Notifications
    owner_phone         text,
    twilio_sid          text,
    twilio_token        text,
    twilio_number       text,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ─── rb_transactions ───────────────────────────────────────────────────────────
-- Normalized transactions pulled from QBO, Xero, and Plaid.

create table if not exists rb_transactions (
    id                      uuid primary key default gen_random_uuid(),
    client_id               uuid not null references rb_clients(id) on delete cascade,
    source                  text not null check (source in ('qbo', 'xero', 'plaid')),
    source_transaction_id   text not null,
    date                    date not null,
    amount                  numeric(15, 2) not null,
    description             text,
    merchant_name           text,
    category                text,
    category_confidence     numeric(4, 3) default 0,
    account_id              text,
    account_name            text,
    currency                text not null default 'USD',
    is_reconciled           boolean not null default false,
    matched_transaction_id  text,
    discrepancy_flag        boolean not null default false,
    discrepancy_reason      text,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    unique (client_id, source, source_transaction_id)
);

-- ─── rb_reconciliation_runs ────────────────────────────────────────────────────
-- Monthly reconciliation snapshots — one per client per period.

create table if not exists rb_reconciliation_runs (
    id                  uuid primary key default gen_random_uuid(),
    client_id           uuid not null references rb_clients(id) on delete cascade,
    period_start        date not null,
    period_end          date not null,
    status              text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
    total_transactions  int not null default 0,
    reconciled_count    int not null default 0,
    unreconciled_count  int not null default 0,
    discrepancy_count   int not null default 0,
    total_amount        numeric(15, 2) not null default 0,
    discrepancy_amount  numeric(15, 2) not null default 0,
    report_data         jsonb,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ─── rb_discrepancies ──────────────────────────────────────────────────────────
-- Flagged issues found during reconciliation.

create table if not exists rb_discrepancies (
    id                  uuid primary key default gen_random_uuid(),
    client_id           uuid not null references rb_clients(id) on delete cascade,
    run_id              uuid not null references rb_reconciliation_runs(id) on delete cascade,
    transaction_id      uuid references rb_transactions(id) on delete set null,
    discrepancy_type    text not null check (discrepancy_type in (
                            'amount_mismatch',
                            'missing_in_bank',
                            'missing_in_books',
                            'duplicate',
                            'uncategorized',
                            'unusual_amount'
                        )),
    description         text,
    qbo_amount          numeric(15, 2),
    bank_amount         numeric(15, 2),
    status              text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
    resolved_at         timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ─── rb_alerts ─────────────────────────────────────────────────────────────────
-- Log of all SMS alerts sent.

create table if not exists rb_alerts (
    id           uuid primary key default gen_random_uuid(),
    client_id    uuid not null references rb_clients(id) on delete cascade,
    alert_type   text not null,
    recipient    text not null,
    message_body text not null,
    sent_at      timestamptz,
    created_at   timestamptz not null default now()
);

-- ─── Indexes ───────────────────────────────────────────────────────────────────

create index if not exists idx_rb_transactions_client_date
    on rb_transactions (client_id, date desc);

create index if not exists idx_rb_transactions_source
    on rb_transactions (client_id, source);

create index if not exists idx_rb_transactions_reconciled
    on rb_transactions (client_id, is_reconciled);

create index if not exists idx_rb_transactions_discrepancy
    on rb_transactions (client_id, discrepancy_flag)
    where discrepancy_flag = true;

create index if not exists idx_rb_runs_client_status
    on rb_reconciliation_runs (client_id, status);

create index if not exists idx_rb_runs_period
    on rb_reconciliation_runs (client_id, period_start desc);

create index if not exists idx_rb_discrepancies_client_status
    on rb_discrepancies (client_id, status);

create index if not exists idx_rb_discrepancies_run
    on rb_discrepancies (run_id);

create index if not exists idx_rb_alerts_client
    on rb_alerts (client_id, created_at desc);

-- ─── updated_at Trigger Function ───────────────────────────────────────────────

create or replace function rb_set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

-- Apply trigger to all tables with updated_at

create trigger rb_clients_updated_at
    before update on rb_clients
    for each row execute function rb_set_updated_at();

create trigger rb_transactions_updated_at
    before update on rb_transactions
    for each row execute function rb_set_updated_at();

create trigger rb_runs_updated_at
    before update on rb_reconciliation_runs
    for each row execute function rb_set_updated_at();

create trigger rb_discrepancies_updated_at
    before update on rb_discrepancies
    for each row execute function rb_set_updated_at();
