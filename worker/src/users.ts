import type { UpstreamIdentity } from './auth/google.ts';

// (provider, subject) → athlete_id(UUID) の解決。D1。
// ★DO の鍵に subject を使わないための間接層。IdP を足しても到達性を失わない。

const now = () => new Date().toISOString();

export interface AthleteRow {
  athlete_id: string; created_at: string;
  display_name: string | null; stripe_customer_id: string | null;
}

export async function resolveAthlete(
  db: D1Database,
  { provider, subject, email, displayName }: Partial<UpstreamIdentity> & { provider?: string },
): Promise<string> {
  if (!provider || !subject) throw new Error('provider と subject は必須');

  const hit = await db.prepare(
    `SELECT athlete_id FROM identities WHERE provider=? AND subject=?`)
    .bind(provider, subject).first<{ athlete_id: string }>();
  if (hit) return hit.athlete_id;

  // 検証済みメールが既存の identity と一致すれば、同じ選手として束ねる（アカウント統合）
  let athleteId: string | null = null;
  if (email) {
    const linked = await db.prepare(
      `SELECT athlete_id FROM identities WHERE email=? LIMIT 1`)
      .bind(email).first<{ athlete_id: string }>();
    if (linked) athleteId = linked.athlete_id;
  }

  if (!athleteId) {
    athleteId = crypto.randomUUID();
    await db.prepare(`INSERT INTO athletes (athlete_id, created_at, display_name) VALUES (?,?,?)`)
      .bind(athleteId, now(), displayName ?? null).run();
  }

  await db.prepare(
    `INSERT INTO identities (provider, subject, athlete_id, email, linked_at) VALUES (?,?,?,?,?)
     ON CONFLICT(provider, subject) DO UPDATE SET email=excluded.email`)
    .bind(provider, subject, athleteId, email ?? null, now()).run();

  return athleteId;
}

export const getAthlete = (db: D1Database, id: string) =>
  db.prepare(`SELECT * FROM athletes WHERE athlete_id=?`).bind(id).first<AthleteRow>();

export const listIdentities = (db: D1Database, id: string) =>
  db.prepare(`SELECT provider, subject, email, linked_at FROM identities WHERE athlete_id=?`)
    .bind(id).all().then((r) => r.results);
