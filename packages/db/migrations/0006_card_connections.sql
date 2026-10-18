-- A card feed is a connection, but it must never replace the finance email transport.
ALTER TABLE channel_connections DROP CONSTRAINT channel_connections_channel_check;
ALTER TABLE channel_connections ADD CONSTRAINT channel_connections_channel_check
  CHECK (channel IN ('email','card','slack','whatsapp','telegram','imessage','synthetic'));
