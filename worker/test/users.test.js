// users.ts の単体テスト。D1 は最小のフェイクで置き換える（本物のDBは不要）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAthlete } from '../src/users.ts';

function fakeD1() {
  const athletes = [], identities = [];
  const run = (sql, b) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT athlete_id FROM identities WHERE provider'))
      return identities.find(i => i.provider === b[0] && i.subject === b[1]) ?? null;
    if (q.startsWith('SELECT athlete_id FROM identities WHERE email'))
      return identities.find(i => i.email === b[0]) ?? null;
    if (q.startsWith('INSERT INTO athletes')) {
      athletes.push({ athlete_id: b[0], created_at: b[1], display_name: b[2] }); return null; }
    if (q.startsWith('INSERT INTO identities')) {
      const ex = identities.find(i => i.provider === b[0] && i.subject === b[1]);
      if (ex) ex.email = b[3];
      else identities.push({ provider: b[0], subject: b[1], athlete_id: b[2], email: b[3], linked_at: b[4] });
      return null; }
    throw new Error('未対応のクエリ: ' + q);
  };
  return { _athletes: athletes, _identities: identities,
    prepare: (sql) => ({ bind: (...b) => ({ first: async () => run(sql, b), run: async () => run(sql, b) }) }) };
}

test('初回ログインで athlete が1件作られる', async () => {
  const db = fakeD1();
  const id = await resolveAthlete(db, { provider:'google', subject:'g1', email:'a@x.com', displayName:'A' });
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(db._athletes.length, 1);
  assert.equal(db._identities.length, 1);
});

test('同じ subject で再ログインしても増えない・同じ id を返す', async () => {
  const db = fakeD1();
  const a = await resolveAthlete(db, { provider:'google', subject:'g1', email:'a@x.com' });
  const b = await resolveAthlete(db, { provider:'google', subject:'g1', email:'a@x.com' });
  assert.equal(a, b);
  assert.equal(db._athletes.length, 1);
});

test('別プロバイダでも検証済みメールが同じなら同じ athlete に束ねる', async () => {
  const db = fakeD1();
  const a = await resolveAthlete(db, { provider:'google', subject:'g1', email:'a@x.com' });
  const b = await resolveAthlete(db, { provider:'github', subject:'h9', email:'a@x.com' });
  assert.equal(a, b, 'アカウント統合されるべき');
  assert.equal(db._athletes.length, 1, 'athlete は増えない');
  assert.equal(db._identities.length, 2, 'identity は2件');
});

test('メールが無い（未検証）場合は束ねず別 athlete になる', async () => {
  const db = fakeD1();
  const a = await resolveAthlete(db, { provider:'google', subject:'g1', email:null });
  const b = await resolveAthlete(db, { provider:'github', subject:'h9', email:null });
  assert.notEqual(a, b, '未検証メールで統合してはいけない');
  assert.equal(db._athletes.length, 2);
});

test('メールが違えば別 athlete', async () => {
  const db = fakeD1();
  const a = await resolveAthlete(db, { provider:'google', subject:'g1', email:'a@x.com' });
  const b = await resolveAthlete(db, { provider:'google', subject:'g2', email:'b@x.com' });
  assert.notEqual(a, b);
  assert.equal(db._athletes.length, 2);
});

test('provider か subject が欠けたら例外', async () => {
  const db = fakeD1();
  await assert.rejects(() => resolveAthlete(db, { provider:'google' }), /必須/);
  await assert.rejects(() => resolveAthlete(db, { subject:'x' }), /必須/);
});
