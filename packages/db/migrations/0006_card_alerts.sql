-- Card-provider payment notification emails ("card alerts") as a card-transaction source.

-- Senders allowed to report company-card payments by email. A message counts only when its From
-- address (or domain) is listed here AND Google's own DKIM/DMARC verdict is aligned with it.
CREATE TABLE card_alert_senders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  address         text CHECK (address = lower(address) AND position('@' in address) > 1),
  domain          text CHECK (domain = lower(domain) AND position('@' in domain) = 0 AND position('.' in domain) > 1),
  issuer_name     text NOT NULL,
  is_synthetic    boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by      uuid REFERENCES members(id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((address IS NULL) <> (domain IS NULL))
);
CREATE UNIQUE INDEX card_alert_senders_live ON card_alert_senders (organisation_id, coalesce(address, '@' || domain)) WHERE status = 'ACTIVE';

-- One row per alert email (keyed by the inbound message, itself unique per Gmail message id).
CREATE TABLE card_alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations(id),
  inbound_message_id uuid NOT NULL UNIQUE REFERENCES inbound_messages(id),
  sender_id          uuid NOT NULL REFERENCES card_alert_senders(id),
  status             text NOT NULL CHECK (status IN ('TRANSACTION_CREATED','NOT_A_PAYMENT','UNREADABLE','UNKNOWN_CARD','SENDER_IS_CARDHOLDER')),
  reader             text NOT NULL CHECK (reader IN ('llm','baseline')),
  model              text,
  llm_fallback_reason text,
  facts              jsonb,
  transaction_id     uuid REFERENCES transactions(id),
  llm_call_id        uuid REFERENCES llm_calls(id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Merchant location exactly as the alert stated it (never inferred). Advisory risk signal only.
ALTER TABLE transactions
  ADD COLUMN merchant_location_text text,
  ADD COLUMN merchant_city          text,
  ADD COLUMN merchant_country       char(2) CHECK (merchant_country ~ '^[A-Z]{2}$');

-- Where a member normally spends: home and work areas (one or more towns each).
CREATE TABLE member_areas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  member_id       uuid NOT NULL REFERENCES members(id),
  kind            text NOT NULL CHECK (kind IN ('HOME','WORK')),
  city            text NOT NULL CHECK (length(btrim(city)) > 0),
  country         char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX member_areas_member ON member_areas (member_id);

-- Declared business trips: spending at the destination during the trip is expected.
CREATE TABLE member_trips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  member_id       uuid NOT NULL REFERENCES members(id),
  city            text CHECK (city IS NULL OR length(btrim(city)) > 0),
  country         char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  purpose         text,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELED')),
  declared_by     uuid REFERENCES members(id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX member_trips_member ON member_trips (member_id, starts_on);
