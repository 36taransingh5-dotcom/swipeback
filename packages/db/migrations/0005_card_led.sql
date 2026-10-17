-- Card-led expenses: created from a card transaction before any receipt exists.
ALTER TABLE expenses DROP CONSTRAINT expenses_state_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_state_check
  CHECK (state IN ('RECEIVED','EXTRACTING','NEEDS_MATCH','NEEDS_INFO','POLICY_CHECK',
                   'AUTO_CLEARED','REVIEW_REQUIRED','APPROVED','REJECTED','EXPORTED','MERGED'));
ALTER TABLE expenses ADD COLUMN merged_into_expense_id uuid REFERENCES expenses(id);

-- Provider-neutral card ingestion: any card feed (simulator today, issuer webhooks later).
ALTER TABLE transactions ADD COLUMN feed_event jsonb;

-- Our own RFC 5322 Message-ID for each sent message, so later messages can thread onto it.
ALTER TABLE outbound_messages ADD COLUMN rfc_message_id text;
