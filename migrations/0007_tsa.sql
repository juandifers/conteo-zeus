-- A neutral third party's clock on the seal (RFC 3161).
--
-- `session_hash` proves the sealed set is internally consistent; it says
-- nothing about *when* it existed, and a hash with no time on it is only as
-- trustworthy as the earliest copy that left the building. At seal time the
-- server sends the hash — just the hash, no count data — to a public
-- Timestamp Authority, which signs `hash + hora` with its own key. The DER
-- response lands here verbatim.
--
-- Best-effort, and that is the design: a TSA outage must not block a seal,
-- so these stay null when the request fails and can be filled later — the
-- token binds only `session_hash`, which never changes after the seal, so a
-- late timestamp is a weaker claim («existía el martes» instead of «el
-- lunes»), never a wrong one.

alter table sessions add column tsa_token text;
alter table sessions add column tsa_at timestamptz;
alter table sessions add column tsa_url text;
