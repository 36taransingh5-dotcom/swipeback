-- Authenticated review: per-person one-time action challenges, reviewer questions, sessions.

-- A challenge is minted for one named person; a forwarded link is useless to anyone else.
ALTER TABLE approval_challenges
  ADD COLUMN intended_member_id uuid REFERENCES members(id),
  ADD COLUMN purpose text NOT NULL DEFAULT 'EXPENSE_REVIEW' CHECK (purpose IN ('EXPENSE_REVIEW','PAYMENT_AUTHORISATION'));
CREATE INDEX approval_challenges_expense ON approval_challenges (expense_id, created_at);

-- Reviewers can ask the employee a free-text question; the answer goes back to the reviewer.
ALTER TABLE open_questions DROP CONSTRAINT open_questions_kind_check;
ALTER TABLE open_questions ADD CONSTRAINT open_questions_kind_check
  CHECK (kind IN ('BUSINESS_PURPOSE','PAYMENT_SOURCE','MATCH_CONFIRMATION','RECEIPT','VAT_INVOICE','REVIEWER_QUESTION'));
ALTER TABLE open_questions
  ADD COLUMN question_text text,
  ADD COLUMN answer_text text,
  ADD COLUMN asked_by uuid REFERENCES members(id);

ALTER TABLE login_tokens ADD COLUMN next_path text;
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz;
