-- Swipeback core schema.
-- Invariants that protect money live here as well as in application code (see docs/PLAN.md §2.4).
-- Custom SQLSTATEs: SBT01 illegal state transition, SBA01 append-only/immutable violation,
--                   SBI01 financial invariant violation.

-- ---------------------------------------------------------------------------
-- State machine tables (rows are synced from packages/domain by the migrator)
-- ---------------------------------------------------------------------------
CREATE TABLE state_machines (
  machine       text PRIMARY KEY,
  initial_state text NOT NULL
);

CREATE TABLE state_transitions (
  machine    text NOT NULL REFERENCES state_machines(machine) ON DELETE CASCADE,
  from_state text NOT NULL,
  to_state   text NOT NULL,
  PRIMARY KEY (machine, from_state, to_state)
);

CREATE FUNCTION enforce_state_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM state_machines WHERE machine = m AND initial_state = NEW.state) THEN
      RAISE EXCEPTION 'illegal initial % state %', m, NEW.state USING ERRCODE = 'SBT01';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT EXISTS (
      SELECT 1 FROM state_transitions
      WHERE machine = m AND from_state = OLD.state AND to_state = NEW.state
    ) THEN
      RAISE EXCEPTION 'illegal % transition % -> %', m, OLD.state, NEW.state USING ERRCODE = 'SBT01';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Optimistic concurrency: every update bumps version; callers update WHERE version = expected.
CREATE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only/immutable (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'SBA01';
END $$;

-- ---------------------------------------------------------------------------
-- Tenancy, people, policy
-- ---------------------------------------------------------------------------
CREATE TABLE organisations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  timezone                 text NOT NULL DEFAULT 'Europe/London',
  base_currency            char(3) NOT NULL DEFAULT 'GBP',
  active_policy_version_id uuid,
  designated_address       text,
  is_synthetic             boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE members (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id         uuid NOT NULL REFERENCES organisations(id),
  email                   text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  display_name            text NOT NULL,
  roles                   text[] NOT NULL DEFAULT ARRAY['employee']
                          CHECK (roles <@ ARRAY['employee','reviewer','payment_approver','admin']::text[]
                                 AND cardinality(roles) > 0),
  payout_enrolment_status text NOT NULL DEFAULT 'NOT_ENROLLED'
                          CHECK (payout_enrolment_status IN ('NOT_ENROLLED','PENDING','VERIFIED','SUSPENDED')),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organisation_id, email),
  UNIQUE (organisation_id, id)
);

-- Pre-enrolled payout destinations. Never changed in place: a change is a new row created by a
-- separately authorised workflow; the only permitted update is revocation.
CREATE TABLE payout_destinations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations(id),
  member_id          uuid NOT NULL REFERENCES members(id),
  account_ref_masked text NOT NULL,
  provider_ref       text NOT NULL,
  verified_at        timestamptz,
  verified_by        uuid REFERENCES members(id),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  revoked_at         timestamptz,
  is_synthetic       boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX payout_destinations_one_active ON payout_destinations (member_id) WHERE status = 'ACTIVE';

CREATE FUNCTION payout_destinations_revoke_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organisation_id, NEW.member_id, NEW.account_ref_masked, NEW.provider_ref,
      NEW.verified_at, NEW.verified_by, NEW.is_synthetic, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organisation_id, OLD.member_id, OLD.account_ref_masked, OLD.provider_ref,
      OLD.verified_at, OLD.verified_by, OLD.is_synthetic, OLD.created_at)
     OR OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'payout destinations can only be revoked, never edited' USING ERRCODE = 'SBA01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_destinations_immutable BEFORE UPDATE ON payout_destinations
  FOR EACH ROW EXECUTE FUNCTION payout_destinations_revoke_only();
CREATE TRIGGER payout_destinations_no_delete BEFORE DELETE ON payout_destinations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE policy_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  version         integer NOT NULL CHECK (version > 0),
  rules           jsonb NOT NULL,
  source_text     text NOT NULL,
  content_hash    text NOT NULL,
  created_by      uuid REFERENCES members(id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organisation_id, version),
  UNIQUE (organisation_id, id)
);
CREATE TRIGGER policy_versions_immutable BEFORE UPDATE OR DELETE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

ALTER TABLE organisations
  ADD CONSTRAINT organisations_active_policy_fk
  FOREIGN KEY (id, active_policy_version_id) REFERENCES policy_versions (organisation_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Card feed
-- ---------------------------------------------------------------------------
CREATE TABLE cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  member_id       uuid NOT NULL REFERENCES members(id),
  last4           char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  label           text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  is_synthetic    boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX cards_active_last4 ON cards (organisation_id, last4) WHERE status = 'ACTIVE';

CREATE TABLE transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id         uuid NOT NULL REFERENCES organisations(id),
  provider                text NOT NULL,
  provider_transaction_id text NOT NULL,
  card_id                 uuid REFERENCES cards(id),
  member_id               uuid REFERENCES members(id),
  amount_minor            bigint NOT NULL,
  currency                char(3) NOT NULL,
  original_amount_minor   bigint,
  original_currency       char(3),
  merchant_descriptor     text NOT NULL,
  merchant_normalised     text NOT NULL,
  mcc                     text,
  transacted_at           timestamptz NOT NULL,
  received_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  raw                     jsonb,
  is_synthetic            boolean NOT NULL DEFAULT true,
  UNIQUE (organisation_id, provider, provider_transaction_id)
);
CREATE INDEX transactions_member_time ON transactions (organisation_id, member_id, transacted_at);

-- ---------------------------------------------------------------------------
-- Channels and messages
-- ---------------------------------------------------------------------------
CREATE TABLE channel_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations(id),
  channel            text NOT NULL CHECK (channel IN ('email','slack','whatsapp','telegram','imessage','synthetic')),
  provider           text NOT NULL,
  address            text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{}',
  token_ciphertext   text,
  token_key_id       text,
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','ACTIVE','RECONNECT_REQUIRED','DISCONNECTED')),
  cursor             text,
  consented_by       uuid REFERENCES members(id),
  consented_at       timestamptz,
  last_sync_at       timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX channel_connections_live ON channel_connections (organisation_id, channel, provider, address)
  WHERE status <> 'DISCONNECTED';

CREATE TABLE channel_identities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  member_id           uuid NOT NULL REFERENCES members(id),
  channel             text NOT NULL,
  channel_address     text NOT NULL,
  verification_method text NOT NULL,
  verified_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX channel_identities_live ON channel_identities (organisation_id, channel, lower(channel_address))
  WHERE status = 'ACTIVE';

CREATE TABLE evidence_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations(id),
  sha256            char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime              text NOT NULL,
  size_bytes        bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key       text NOT NULL,
  original_filename text,
  scan_status       text NOT NULL DEFAULT 'UNSCANNED' CHECK (scan_status IN ('UNSCANNED','CLEAN','REJECTED')),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organisation_id, sha256)
);
CREATE TRIGGER evidence_files_immutable BEFORE UPDATE OR DELETE ON evidence_files
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE inbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  connection_id       uuid REFERENCES channel_connections(id),
  channel             text NOT NULL,
  provider_event_id   text NOT NULL,
  dedupe_key          char(64) NOT NULL UNIQUE,
  thread_id           text,
  message_id          text,
  in_reply_to         text,
  sender_address      text NOT NULL,
  sender_display_name text,
  sender_auth         text NOT NULL CHECK (sender_auth IN ('dkim_aligned','platform_signed','none')),
  member_id           uuid REFERENCES members(id),
  subject             text,
  text_sanitised      text,
  intent              text CHECK (intent IN ('SUBMIT_RECEIPT','CONFIRM_PAYMENT_SOURCE','PROVIDE_BUSINESS_PURPOSE',
                                             'EXPENSE_STATUS','REVIEW_APPROVE','REVIEW_DECLINE',
                                             'REVIEW_REQUEST_INFO','HELP')),
  processing_state    text NOT NULL DEFAULT 'RECEIVED'
                      CHECK (processing_state IN ('RECEIVED','PROCESSING','PROCESSED','QUARANTINED','IGNORED','FAILED')),
  processing_note     text,
  envelope            jsonb NOT NULL,
  correlation_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  received_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at        timestamptz,
  UNIQUE (organisation_id, channel, provider_event_id)
);
CREATE INDEX inbound_messages_thread ON inbound_messages (organisation_id, channel, thread_id);

CREATE TABLE inbound_attachments (
  inbound_message_id uuid NOT NULL REFERENCES inbound_messages(id),
  evidence_file_id   uuid NOT NULL REFERENCES evidence_files(id),
  position           integer NOT NULL,
  PRIMARY KEY (inbound_message_id, position)
);

-- ---------------------------------------------------------------------------
-- Receipts, extraction, expenses
-- ---------------------------------------------------------------------------
CREATE TABLE receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations(id),
  inbound_message_id uuid REFERENCES inbound_messages(id),
  evidence_file_id   uuid REFERENCES evidence_files(id),
  source_kind        text NOT NULL CHECK (source_kind IN ('ATTACHMENT','EMAIL_BODY','CHAT_MEDIA')),
  file_hash          char(64) NOT NULL,
  store_ref          text,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX receipts_hash ON receipts (organisation_id, file_hash);

CREATE TABLE llm_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations(id),
  purpose         text NOT NULL,
  model           text NOT NULL,
  input_tokens    integer,
  output_tokens   integer,
  latency_ms      integer,
  cost_micros     bigint,
  outcome         text NOT NULL CHECK (outcome IN ('OK','INVALID_OUTPUT','TIMEOUT','PROVIDER_ERROR','REPLAYED')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE extractions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id  uuid NOT NULL REFERENCES receipts(id),
  attempt     integer NOT NULL CHECK (attempt > 0),
  extractor   text NOT NULL CHECK (extractor IN ('llm','baseline','stub','replay')),
  model       text,
  status      text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','INVALID')),
  fields      jsonb,
  flags       text[] NOT NULL DEFAULT '{}',
  error       text,
  llm_call_id uuid REFERENCES llm_calls(id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (receipt_id, attempt)
);
CREATE TRIGGER extractions_immutable BEFORE UPDATE OR DELETE ON extractions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE SEQUENCE expense_ref_seq START 1001;

CREATE TABLE expenses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL REFERENCES organisations(id),
  ref                    text NOT NULL UNIQUE DEFAULT ('SB-' || nextval('expense_ref_seq')),
  member_id              uuid NOT NULL REFERENCES members(id),
  source_type            text NOT NULL CHECK (source_type IN ('EMAIL','CARD_FEED','CHAT','SYNTHETIC')),
  source_channel         text,
  payment_type           text NOT NULL DEFAULT 'UNKNOWN' CHECK (payment_type IN ('UNKNOWN','CORPORATE','PERSONAL')),
  category               text,
  merchant               text,
  amount_minor           bigint,
  currency               char(3),
  expense_date           date,
  business_purpose       text,
  receipt_id             uuid REFERENCES receipts(id),
  current_extraction_id  uuid REFERENCES extractions(id),
  matched_transaction_id uuid REFERENCES transactions(id),
  policy_version_id      uuid REFERENCES policy_versions(id),
  state                  text NOT NULL,
  flags                  text[] NOT NULL DEFAULT '{}',
  version                integer NOT NULL DEFAULT 1,
  correlation_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state IN ('RECEIVED','EXTRACTING','NEEDS_MATCH','NEEDS_INFO','POLICY_CHECK',
                   'AUTO_CLEARED','REVIEW_REQUIRED','APPROVED','REJECTED','EXPORTED')),
  CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  FOREIGN KEY (organisation_id, member_id) REFERENCES members (organisation_id, id),
  FOREIGN KEY (organisation_id, policy_version_id) REFERENCES policy_versions (organisation_id, id)
);
-- One card transaction can back at most one expense.
CREATE UNIQUE INDEX expenses_one_per_transaction ON expenses (matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;
CREATE INDEX expenses_org_state ON expenses (organisation_id, state);
CREATE INDEX expenses_member ON expenses (organisation_id, member_id, expense_date);

CREATE TRIGGER expenses_state BEFORE INSERT OR UPDATE OF state ON expenses
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('expense');
CREATE TRIGGER expenses_version BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Once an expense is pinned to a policy version it never moves (decisions are reproducible).
CREATE FUNCTION expenses_pin_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.policy_version_id IS NOT NULL AND NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id THEN
    RAISE EXCEPTION 'expense % policy version is pinned', OLD.ref USING ERRCODE = 'SBI01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_policy_pinned BEFORE UPDATE OF policy_version_id ON expenses
  FOR EACH ROW EXECUTE FUNCTION expenses_pin_policy();

CREATE TABLE conversation_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  channel         text NOT NULL,
  thread_id       text NOT NULL,
  expense_id      uuid NOT NULL REFERENCES expenses(id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organisation_id, channel, thread_id, expense_id)
);

CREATE TABLE policy_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations(id),
  expense_id        uuid NOT NULL REFERENCES expenses(id),
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id),
  outcome           text NOT NULL CHECK (outcome IN ('CLEAR','REQUEST_INFO','HUMAN_REVIEW','REJECT_FOR_CORRECTION')),
  reason_codes      text[] NOT NULL,
  clause_ids        text[] NOT NULL,
  sources           jsonb NOT NULL,
  inputs_hash       char(64) NOT NULL,
  engine_version    text NOT NULL,
  decided_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX policy_decisions_expense ON policy_decisions (expense_id, decided_at);
CREATE TRIGGER policy_decisions_immutable BEFORE UPDATE OR DELETE ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- At most one open question per expense: no question spam.
CREATE TABLE open_questions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  expense_id          uuid NOT NULL REFERENCES expenses(id),
  kind                text NOT NULL CHECK (kind IN ('BUSINESS_PURPOSE','PAYMENT_SOURCE','MATCH_CONFIRMATION','RECEIPT')),
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ANSWERED','EXPIRED','CANCELED')),
  correlation_token   text NOT NULL UNIQUE,
  options             jsonb,
  outbound_message_id uuid,
  reminders_sent      integer NOT NULL DEFAULT 0,
  answer_inbound_id   uuid REFERENCES inbound_messages(id),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  answered_at         timestamptz
);
CREATE UNIQUE INDEX open_questions_one_open ON open_questions (expense_id) WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- Review and authenticated approvals
-- ---------------------------------------------------------------------------
CREATE TABLE approval_challenges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations(id),
  expense_id        uuid NOT NULL REFERENCES expenses(id),
  reimbursement_id  uuid,
  allowed_actions   text[] NOT NULL CHECK (cardinality(allowed_actions) > 0),
  required_role     text NOT NULL CHECK (required_role IN ('reviewer','payment_approver')),
  nonce_hash        char(64) NOT NULL UNIQUE,
  expense_version   integer NOT NULL,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  consumed_by       uuid REFERENCES members(id),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  expense_id      uuid NOT NULL REFERENCES expenses(id),
  reviewer_id     uuid NOT NULL REFERENCES members(id),
  action          text NOT NULL CHECK (action IN ('APPROVE','REQUEST_INFO','DECLINE','CORRECT')),
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  expense_version integer NOT NULL,
  challenge_id    uuid REFERENCES approval_challenges(id),
  corrections     jsonb,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reviews_immutable BEFORE UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Segregation of duties: nobody reviews their own expense.
CREATE FUNCTION reviews_not_own_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM expenses e WHERE e.id = NEW.expense_id AND e.member_id = NEW.reviewer_id) THEN
    RAISE EXCEPTION 'reviewer cannot review their own expense' USING ERRCODE = 'SBI01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.reviewer_id AND m.organisation_id = NEW.organisation_id
                 AND m.status = 'ACTIVE' AND m.roles && ARRAY['reviewer','admin']::text[]) THEN
    RAISE EXCEPTION 'reviewer lacks reviewer role' USING ERRCODE = 'SBI01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_sod BEFORE INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION reviews_not_own_expense();

-- ---------------------------------------------------------------------------
-- Reimbursement and simulated payout
-- ---------------------------------------------------------------------------
CREATE TABLE reimbursements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations(id),
  expense_id            uuid NOT NULL REFERENCES expenses(id),
  member_id             uuid NOT NULL REFERENCES members(id),
  payout_destination_id uuid NOT NULL REFERENCES payout_destinations(id),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  currency              char(3) NOT NULL,
  state                 text NOT NULL,
  idempotency_key       text NOT NULL UNIQUE,
  simulated_payout_ref  text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state IN ('DRAFT','ELIGIBILITY_CHECK','AUTHORIZED','PAYOUT_QUEUED','SIMULATED_PAID','FAILED','CANCELED'))
);
-- I2: at most one live reimbursement per expense.
CREATE UNIQUE INDEX reimbursements_one_live ON reimbursements (expense_id) WHERE state <> 'CANCELED';

CREATE TRIGGER reimbursements_state BEFORE INSERT OR UPDATE OF state ON reimbursements
  FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('reimbursement');
CREATE TRIGGER reimbursements_version BEFORE UPDATE ON reimbursements
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- I1: only personal, unmatched, cleared expenses can be reimbursed, to the claimant's own verified destination.
CREATE FUNCTION reimbursements_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e expenses%ROWTYPE;
BEGIN
  SELECT * INTO e FROM expenses WHERE id = NEW.expense_id FOR SHARE;
  IF e.id IS NULL OR e.organisation_id <> NEW.organisation_id THEN
    RAISE EXCEPTION 'reimbursement expense not found in organisation' USING ERRCODE = 'SBI01';
  END IF;
  IF e.payment_type <> 'PERSONAL' OR e.matched_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'expense % is not an unmatched personal expense; company-card spend is never reimbursed', e.ref
      USING ERRCODE = 'SBI01';
  END IF;
  IF e.state NOT IN ('AUTO_CLEARED','APPROVED') THEN
    RAISE EXCEPTION 'expense % is not cleared (state %)', e.ref, e.state USING ERRCODE = 'SBI01';
  END IF;
  IF e.member_id <> NEW.member_id THEN
    RAISE EXCEPTION 'payee must be the claimant' USING ERRCODE = 'SBI01';
  END IF;
  IF e.currency IS DISTINCT FROM NEW.currency OR NEW.amount_minor > e.amount_minor THEN
    RAISE EXCEPTION 'reimbursement exceeds expense amount or currency differs' USING ERRCODE = 'SBI01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payout_destinations d WHERE d.id = NEW.payout_destination_id
                 AND d.member_id = NEW.member_id AND d.status = 'ACTIVE' AND d.verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'payout destination is not the claimant''s active verified destination' USING ERRCODE = 'SBI01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reimbursements_guard BEFORE INSERT ON reimbursements
  FOR EACH ROW EXECUTE FUNCTION reimbursements_guard_insert();

-- An expense with a live reimbursement can never later become card-backed.
CREATE FUNCTION expenses_guard_reimbursed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.matched_transaction_id IS NOT NULL OR NEW.payment_type <> 'PERSONAL')
     AND EXISTS (SELECT 1 FROM reimbursements r WHERE r.expense_id = NEW.id AND r.state <> 'CANCELED') THEN
    RAISE EXCEPTION 'expense % has a live reimbursement; card match or payment-type change must go to review', NEW.ref
      USING ERRCODE = 'SBI01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_reimbursed_guard BEFORE UPDATE OF matched_transaction_id, payment_type ON expenses
  FOR EACH ROW EXECUTE FUNCTION expenses_guard_reimbursed();

-- Payment authorisation is a separate record from expense clearance (PRD §5 (a) vs (b)).
CREATE TABLE reimbursement_authorisations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reimbursement_id  uuid NOT NULL UNIQUE REFERENCES reimbursements(id),
  kind              text NOT NULL CHECK (kind IN ('AUTO','HUMAN')),
  authorised_by     uuid REFERENCES members(id),
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id),
  checks            jsonb NOT NULL,
  limits_snapshot   jsonb NOT NULL,
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'AUTO') = (authorised_by IS NULL))
);
CREATE TRIGGER reimbursement_authorisations_immutable BEFORE UPDATE OR DELETE ON reimbursement_authorisations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION reimbursement_authorisations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r reimbursements%ROWTYPE;
BEGIN
  SELECT * INTO r FROM reimbursements WHERE id = NEW.reimbursement_id;
  IF NEW.kind = 'HUMAN' THEN
    IF NEW.authorised_by = r.member_id THEN
      RAISE EXCEPTION 'claimant cannot authorise their own payment' USING ERRCODE = 'SBI01';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM members m WHERE m.id = NEW.authorised_by AND m.organisation_id = r.organisation_id
                   AND m.status = 'ACTIVE' AND 'payment_approver' = ANY (m.roles)) THEN
      RAISE EXCEPTION 'authoriser lacks payment_approver role' USING ERRCODE = 'SBI01';
    END IF;
    IF NEW.reason IS NULL OR length(btrim(NEW.reason)) = 0 THEN
      RAISE EXCEPTION 'human payment authorisation requires a reason' USING ERRCODE = 'SBI01';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reimbursement_authorisations_check BEFORE INSERT ON reimbursement_authorisations
  FOR EACH ROW EXECUTE FUNCTION reimbursement_authorisations_guard();

CREATE TABLE payout_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reimbursement_id uuid NOT NULL REFERENCES reimbursements(id),
  attempt          integer NOT NULL CHECK (attempt > 0),
  idempotency_key  text NOT NULL,
  provider         text NOT NULL,
  provider_ref     text,
  status           text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','UNKNOWN')),
  request          jsonb NOT NULL,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at     timestamptz,
  UNIQUE (reimbursement_id, attempt)
);
CREATE UNIQUE INDEX payout_attempts_one_success ON payout_attempts (reimbursement_id) WHERE status = 'SUCCEEDED';

-- Gate the money-relevant transitions on their evidence rows.
CREATE FUNCTION reimbursements_guard_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'AUTHORIZED' AND OLD.state <> 'AUTHORIZED'
     AND NOT EXISTS (SELECT 1 FROM reimbursement_authorisations a WHERE a.reimbursement_id = NEW.id) THEN
    RAISE EXCEPTION 'reimbursement cannot be AUTHORIZED without an authorisation record' USING ERRCODE = 'SBI01';
  END IF;
  IF NEW.state = 'SIMULATED_PAID' AND OLD.state <> 'SIMULATED_PAID'
     AND NOT EXISTS (SELECT 1 FROM payout_attempts p WHERE p.reimbursement_id = NEW.id
                     AND p.status = 'SUCCEEDED' AND p.idempotency_key = NEW.idempotency_key) THEN
    RAISE EXCEPTION 'reimbursement cannot be SIMULATED_PAID without a succeeded payout attempt' USING ERRCODE = 'SBI01';
  END IF;
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.payout_destination_id IS DISTINCT FROM OLD.payout_destination_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'reimbursement payee, amount and idempotency key are immutable' USING ERRCODE = 'SBI01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reimbursements_transition_guard BEFORE UPDATE ON reimbursements
  FOR EACH ROW EXECUTE FUNCTION reimbursements_guard_transition();

-- I8: cumulative spend counters, locked in the same transaction as authorisation.
CREATE TABLE spend_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  scope           text NOT NULL CHECK (scope IN ('MEMBER_DAY','MEMBER_WEEK','CATEGORY_MONTH','BUDGET_MONTH')),
  scope_key       text NOT NULL,
  period_start    date NOT NULL,
  currency        char(3) NOT NULL,
  amount_minor    bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  PRIMARY KEY (organisation_id, scope, scope_key, period_start, currency)
);

-- ---------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------
CREATE TABLE exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  kind            text NOT NULL CHECK (kind IN ('ACCOUNTING_CSV')),
  storage_key     text NOT NULL,
  row_count       integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE export_items (
  export_id  uuid NOT NULL REFERENCES exports(id),
  expense_id uuid NOT NULL UNIQUE REFERENCES expenses(id),
  PRIMARY KEY (export_id, expense_id)
);

-- ---------------------------------------------------------------------------
-- Outbound messages (outbox)
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  channel             text NOT NULL,
  connection_id       uuid REFERENCES channel_connections(id),
  expense_id          uuid REFERENCES expenses(id),
  recipient_member_id uuid REFERENCES members(id),
  recipient_address   text NOT NULL,
  template            text NOT NULL,
  idempotency_key     text NOT NULL UNIQUE,
  subject             text,
  body_text           text NOT NULL,
  thread_id           text,
  in_reply_to         text,
  references_ids      text[] NOT NULL DEFAULT '{}',
  provider_message_id text,
  delivery_state      text NOT NULL DEFAULT 'QUEUED'
                      CHECK (delivery_state IN ('QUEUED','SENDING','SENT','FAILED','SUPPRESSED')),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at             timestamptz
);
CREATE INDEX outbound_messages_expense ON outbound_messages (expense_id, created_at);

ALTER TABLE open_questions
  ADD CONSTRAINT open_questions_outbound_fk FOREIGN KEY (outbound_message_id) REFERENCES outbound_messages(id);

-- ---------------------------------------------------------------------------
-- Reviewer authentication (magic link + session)
-- ---------------------------------------------------------------------------
CREATE TABLE login_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES members(id),
  token_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES members(id),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- Durable jobs
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id              bigserial PRIMARY KEY,
  organisation_id uuid REFERENCES organisations(id),
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text UNIQUE,
  state           text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','DEAD')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_by       text,
  locked_until    timestamptz,
  last_error      text,
  correlation_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz
);
CREATE INDEX jobs_ready ON jobs (run_at, id) WHERE state = 'QUEUED';
CREATE INDEX jobs_running ON jobs (locked_until) WHERE state = 'RUNNING';

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained per organisation
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  seq             bigint NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('system','member','channel','simulator','provider')),
  actor_id        text,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  correlation_id  text,
  created_at      timestamptz NOT NULL,
  prev_hash       char(64),
  hash            char(64) NOT NULL,
  UNIQUE (organisation_id, seq)
);
CREATE INDEX audit_events_entity ON audit_events (organisation_id, entity_type, entity_id);

CREATE FUNCTION audit_event_hash(
  p_prev text, p_org uuid, p_seq bigint, p_actor_type text, p_actor_id text, p_action text,
  p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_correlation text, p_created timestamptz
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
    coalesce(p_prev, ''), p_org::text, p_seq::text, p_actor_type, coalesce(p_actor_id, ''), p_action,
    p_entity_type, coalesce(p_entity_id, ''), coalesce(p_before::text, 'null'), coalesce(p_after::text, 'null'),
    coalesce(p_correlation, ''), to_char(p_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8')), 'hex')
$$;

CREATE FUNCTION audit_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_seq  bigint;
  v_hash text;
BEGIN
  -- Serialise appends per organisation so the chain is linear.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.organisation_id::text, 0));
  SELECT seq, hash INTO v_seq, v_hash FROM audit_events
   WHERE organisation_id = NEW.organisation_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(v_seq, 0) + 1;
  NEW.prev_hash := v_hash;
  NEW.created_at := date_trunc('microseconds', clock_timestamp());
  NEW.hash := audit_event_hash(NEW.prev_hash, NEW.organisation_id, NEW.seq, NEW.actor_type, NEW.actor_id,
                               NEW.action, NEW.entity_type, NEW.entity_id, NEW.before, NEW.after,
                               NEW.correlation_id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_append BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Evaluation runs
-- ---------------------------------------------------------------------------
CREATE TABLE eval_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  split         text NOT NULL CHECK (split IN ('tune','heldout')),
  manifest_hash char(64) NOT NULL,
  config        jsonb NOT NULL,
  metrics       jsonb,
  report_md     text,
  git_sha       text,
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz
);
