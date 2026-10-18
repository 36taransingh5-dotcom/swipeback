-- Email-first workspace onboarding. Only token hashes are stored; addresses are
-- verified before a workspace or session is created.
CREATE TABLE signup_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  token_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signup_tokens_email_created ON signup_tokens (email, created_at DESC);
