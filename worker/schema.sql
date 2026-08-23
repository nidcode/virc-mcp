-- 横断テーブル。選手ごとのデータは Durable Object 側にある。
-- ★DO の鍵は provider/sub ではなく athlete_id(UUID)。IdP を足しても到達性を失わないため。
CREATE TABLE IF NOT EXISTS athletes (
  athlete_id   TEXT PRIMARY KEY,          -- UUID。DO 名 = athlete-{athlete_id}
  created_at   TEXT NOT NULL,
  display_name TEXT,
  stripe_customer_id TEXT                 -- 課金の受け皿を最初から空けておく
);

CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,               -- 'google' | 'github' | ...
  subject    TEXT NOT NULL,               -- IdP 側の安定 id
  athlete_id TEXT NOT NULL REFERENCES athletes(athlete_id),
  email      TEXT,                        -- 検証済みメール。アカウント統合の手がかり
  linked_at  TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_athlete ON identities(athlete_id);
CREATE INDEX IF NOT EXISTS idx_identities_email   ON identities(email);
