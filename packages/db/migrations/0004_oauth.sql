-- OAuth connection attempts (state + PKCE verifier kept server-side, single use, short-lived).
CREATE TABLE oauth_states (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations(id),
  member_id          uuid NOT NULL REFERENCES members(id),
  provider           text NOT NULL,
  state_hash         char(64) NOT NULL UNIQUE,
  verifier_encrypted text NOT NULL,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE channel_connections
  ADD COLUMN access_expires_at timestamptz;
