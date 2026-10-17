-- Fields the pipeline needs to re-evaluate an expense from stored facts alone.

ALTER TABLE expenses
  ADD COLUMN inbound_message_id    uuid REFERENCES inbound_messages(id),
  ADD COLUMN sender_auth           text CHECK (sender_auth IN ('dkim_aligned','platform_signed','none')),
  ADD COLUMN card_last4            char(4) CHECK (card_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN tender                text NOT NULL DEFAULT 'UNKNOWN' CHECK (tender IN ('CARD','CASH','UNKNOWN')),
  ADD COLUMN has_vat_invoice       boolean NOT NULL DEFAULT false,
  ADD COLUMN receipt_number        text,
  ADD COLUMN uncertain_fields      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN stated_payment_source text CHECK (stated_payment_source IN ('CORPORATE','PERSONAL')),
  ADD COLUMN match_choice          text,
  ADD COLUMN last_decision_id      uuid REFERENCES policy_decisions(id);

CREATE INDEX expenses_duplicate_probe ON expenses (organisation_id, expense_date, amount_minor);

-- Cumulative limits are computed from reimbursements under a per-organisation advisory lock,
-- which is simpler to prove correct than separately maintained counters.
DROP TABLE spend_counters;

-- ---------------------------------------------------------------------------
-- Simulated payout provider ("MockPay"). This stands in for an external provider's own ledger;
-- Swipeback's records (reimbursements, payout_attempts) never read it except via the provider API.
-- No real funds move.
-- ---------------------------------------------------------------------------
CREATE SCHEMA mockpay;
CREATE TABLE mockpay.payouts (
  idempotency_key text PRIMARY KEY,
  provider_ref    text NOT NULL UNIQUE,
  destination_ref text NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        char(3) NOT NULL,
  reference       text NOT NULL,
  status          text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE mockpay.calls (
  id              bigserial PRIMARY KEY,
  operation       text NOT NULL CHECK (operation IN ('create','get')),
  idempotency_key text NOT NULL,
  outcome         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE outbound_messages
  ADD COLUMN kind        text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','approval_request')),
  ADD COLUMN reply_token text,
  ADD COLUMN review_url  text;
CREATE INDEX outbound_messages_recipient_time ON outbound_messages (organisation_id, recipient_address, created_at);
