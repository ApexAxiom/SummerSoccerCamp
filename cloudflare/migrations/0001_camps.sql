PRAGMA foreign_keys = ON;
CREATE TABLE camps (
  id TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL CHECK (capacity >= 1),
  status TEXT NOT NULL CHECK (status IN ('open','closed','archived')),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE TABLE signup_groups (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  child_count INTEGER NOT NULL CHECK (child_count BETWEEN 1 AND 8),
  status TEXT NOT NULL CHECK (status IN ('pending_checkout','checkout_started','paid','expired','checkout_failed','payment_review')),
  stripe_session_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payment TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payment)),
  checkout_params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkout_params)),
  fulfillment_event_id TEXT
);
CREATE INDEX groups_by_camp ON signup_groups(camp_id,status);
CREATE INDEX groups_pending ON signup_groups(status,created_at);
CREATE TABLE registrations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES signup_groups(id),
  camp_id TEXT NOT NULL REFERENCES camps(id),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX registrations_by_group ON registrations(group_id);
CREATE INDEX registrations_by_camp ON registrations(camp_id);
CREATE TABLE webhook_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES signup_groups(id),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','delivery_unknown')),
  created_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  last_error TEXT
);
CREATE INDEX email_pending ON email_deliveries(state,lease_until);
-- Enforce capacity inside SQLite, including concurrent API calls and imports.
CREATE TRIGGER reserve_capacity BEFORE INSERT ON signup_groups
WHEN NEW.status IN ('pending_checkout','checkout_started','paid')
BEGIN
  SELECT CASE WHEN
    NEW.child_count + COALESCE((SELECT SUM(child_count) FROM signup_groups
      WHERE camp_id=NEW.camp_id AND status IN ('pending_checkout','checkout_started','paid')),0)
       > (SELECT capacity FROM camps WHERE id=NEW.camp_id)
    THEN RAISE(ABORT,'camp_capacity') END;
END;
CREATE TRIGGER update_capacity BEFORE UPDATE OF status,child_count,camp_id ON signup_groups
WHEN NEW.status IN ('pending_checkout','checkout_started','paid')
BEGIN
  SELECT CASE WHEN NEW.child_count + COALESCE((SELECT SUM(child_count) FROM signup_groups
    WHERE camp_id=NEW.camp_id AND id!=NEW.id AND status IN ('pending_checkout','checkout_started','paid')),0)
      > (SELECT capacity FROM camps WHERE id=NEW.camp_id)
    THEN RAISE(ABORT,'camp_capacity') END;
END;
CREATE TRIGGER reduce_capacity BEFORE UPDATE OF capacity ON camps
BEGIN
  SELECT CASE WHEN NEW.capacity < COALESCE((SELECT SUM(child_count) FROM signup_groups
    WHERE camp_id=NEW.id AND status IN ('pending_checkout','checkout_started','paid')),0)
    THEN RAISE(ABORT,'camp_capacity') END;
END;
