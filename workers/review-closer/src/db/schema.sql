-- ─────────────────────────────────────────────────────────────────────────────
-- GRIDHAND Review Closer — Supabase Schema
-- Run this in your Supabase SQL editor to set up the required tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ─── shops ───────────────────────────────────────────────────────────────────
-- One row per shop using the Review Closer
create table if not exists shops (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  tekmetric_shop_id   text unique not null,       -- Tekmetric shop ID
  google_account_id   text,                        -- e.g. "accounts/1234567890"
  google_location_id  text,                        -- e.g. "accounts/.../locations/..."
  google_place_id     text,                        -- Google Maps place_id
  google_review_url   text,                        -- Short review link for SMS
  owner_phone         text not null,               -- E.164 format, e.g. "+15551234567"
  owner_name          text,
  twilio_from_number  text,                        -- Override system default if needed
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table shops is 'Auto/trades shops using the GRIDHAND Review Closer worker';

-- ─── review_requests ─────────────────────────────────────────────────────────
-- Tracks every review request SMS sent to a customer after RO completion
create table if not exists review_requests (
  id               uuid primary key default uuid_generate_v4(),
  shop_id          uuid not null references shops(id) on delete cascade,
  ro_id            text not null,                  -- Tekmetric Repair Order ID
  customer_name    text not null,
  customer_phone   text not null,                  -- E.164 format
  vehicle          text,                           -- e.g. "2019 Toyota Camry"
  service_summary  text,                           -- Brief description of work done
  sent_at          timestamptz,                    -- When SMS was actually sent (null = pending)
  review_received  boolean not null default false, -- Did a review come in from this customer?
  review_rating    smallint check (review_rating between 1 and 5),
  review_id        text,                           -- Google review ID if matched
  job_id           text,                           -- Bull job ID for tracking
  error            text,                           -- Error message if SMS failed
  created_at       timestamptz not null default now(),

  -- Prevent duplicate requests for the same RO
  unique (shop_id, ro_id)
);

comment on table review_requests is 'Review request SMS records sent after Tekmetric RO completion';
create index on review_requests (shop_id);
create index on review_requests (customer_phone);
create index on review_requests (sent_at);
create index on review_requests (review_received);

-- ─── review_monitoring ───────────────────────────────────────────────────────
-- Every Google Business review detected by the monitor, with response tracking
create table if not exists review_monitoring (
  id              uuid primary key default uuid_generate_v4(),
  shop_id         uuid not null references shops(id) on delete cascade,
  review_id       text not null,                   -- Google review ID (unique per location)
  reviewer_name   text,
  rating          smallint not null check (rating between 1 and 5),
  review_text     text,
  review_url      text,
  published_at    timestamptz,                     -- When Google says the review was posted
  detected_at     timestamptz not null default now(), -- When our monitor first saw it
  responded       boolean not null default false,
  response_text   text,
  responded_at    timestamptz,
  alerted_owner   boolean not null default false,  -- Was owner SMS-alerted (for low stars)?
  alerted_at      timestamptz,
  created_at      timestamptz not null default now(),

  -- Each Google review ID is unique per shop location
  unique (shop_id, review_id)
);

comment on table review_monitoring is 'Google Business reviews detected and response/alert tracking';
create index on review_monitoring (shop_id);
create index on review_monitoring (rating);
create index on review_monitoring (responded);
create index on review_monitoring (alerted_owner);
create index on review_monitoring (detected_at);

-- ─── Automatic updated_at trigger for shops ───────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists shops_updated_at on shops;
create trigger shops_updated_at
  before update on shops
  for each row execute procedure set_updated_at();

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- Enable RLS (service role key bypasses these, so the worker still has full access)
alter table shops enable row level security;
alter table review_requests enable row level security;
alter table review_monitoring enable row level security;

-- Service role has unrestricted access (used by the worker)
-- Add additional policies here if you expose these tables to end users via anon key
