-- GRIDHAND Open House Brain — Database Schema
-- Run this once against your Supabase project.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS oh_clients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_slug TEXT UNIQUE NOT NULL,
  agent_name TEXT NOT NULL,
  agent_phone TEXT NOT NULL,
  fub_api_key TEXT,
  crm_type TEXT DEFAULT 'followupboss',
  google_refresh_token TEXT,
  google_calendar_id TEXT DEFAULT 'primary',
  twilio_from TEXT,
  anthropic_key TEXT,
  timezone TEXT DEFAULT 'America/Chicago',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oh_open_houses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES oh_clients(id) ON DELETE CASCADE,
  listing_id TEXT,
  listing_address TEXT NOT NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  google_event_id TEXT,
  calendar_link TEXT,
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','cancelled')),
  visitor_count INTEGER DEFAULT 0,
  invites_sent INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oh_visitors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  open_house_id UUID REFERENCES oh_open_houses(id) ON DELETE CASCADE,
  client_id UUID REFERENCES oh_clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  crm_contact_id TEXT,
  interest_level TEXT DEFAULT 'unknown' CHECK (interest_level IN ('high','medium','low','unknown','not_interested')),
  followup_status TEXT DEFAULT 'pending' CHECK (followup_status IN ('pending','thankyou_sent','day_after_sent','week_sent','converted','opted_out')),
  agent_notes TEXT,
  ai_notes TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (open_house_id, phone)
);

CREATE TABLE IF NOT EXISTS oh_invites (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  open_house_id UUID REFERENCES oh_open_houses(id) ON DELETE CASCADE,
  client_id UUID REFERENCES oh_clients(id) ON DELETE CASCADE,
  crm_contact_id TEXT,
  name TEXT,
  phone TEXT NOT NULL,
  message TEXT,
  sent_at TIMESTAMPTZ,
  replied BOOLEAN DEFAULT false,
  reply_intent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oh_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visitor_id UUID REFERENCES oh_visitors(id) ON DELETE CASCADE,
  open_house_id UUID REFERENCES oh_open_houses(id),
  client_id UUID REFERENCES oh_clients(id),
  direction TEXT CHECK (direction IN ('outbound','inbound')),
  message TEXT NOT NULL,
  intent TEXT,
  twilio_sid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oh_sms_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES oh_clients(id),
  visitor_id UUID REFERENCES oh_visitors(id),
  open_house_id UUID REFERENCES oh_open_houses(id),
  direction TEXT CHECK (direction IN ('outbound','inbound')),
  to_number TEXT,
  from_number TEXT,
  body TEXT,
  twilio_sid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oh_open_houses_client ON oh_open_houses(client_id);
CREATE INDEX IF NOT EXISTS idx_oh_open_houses_date ON oh_open_houses(date);
CREATE INDEX IF NOT EXISTS idx_oh_open_houses_status ON oh_open_houses(status);
CREATE INDEX IF NOT EXISTS idx_oh_visitors_open_house ON oh_visitors(open_house_id);
CREATE INDEX IF NOT EXISTS idx_oh_visitors_phone ON oh_visitors(phone);
CREATE INDEX IF NOT EXISTS idx_oh_invites_open_house ON oh_invites(open_house_id);
CREATE INDEX IF NOT EXISTS idx_oh_conversations_visitor ON oh_conversations(visitor_id);
