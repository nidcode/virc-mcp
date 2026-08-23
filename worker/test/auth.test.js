// devBypassEnabled / shouldBypass のガード。
// ★環境変数が本番に漏れても効かないことを確かめる。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { devBypassEnabled, shouldBypass, graphFor, unauthorized } from '../src/auth/identity.ts';

const req = (url) => new Request(url, { method: 'POST' });
const quiet = (fn) => { const w = console.warn; console.warn = () => {};
  try { return fn(); } finally { console.warn = w; } };

describe('devBypassEnabled', () => {
  test('localhost + フラグ1 → 有効', () => {
    for (const h of ['localhost', '127.0.0.1', '0.0.0.0'])
      assert.equal(devBypassEnabled(req(`http://${h}:8787/mcp`), { DEV_AUTH_BYPASS:'1' }), true, h);
  });

  test('★本番ホストなら無効（環境変数が漏れても効かない）', () => quiet(() => {
    for (const h of ['coach.example.com','evil.test','localhost.attacker.com','sub.localhost.co'])
      assert.equal(devBypassEnabled(req(`https://${h}/mcp`), { DEV_AUTH_BYPASS:'1' }), false, h);
  }));

  test('フラグが 1 以外なら localhost でも無効', () => {
    for (const v of [undefined, '0', 'true', ''])
      assert.equal(devBypassEnabled(req('http://localhost:8787/mcp'), { DEV_AUTH_BYPASS:v }), false, String(v));
  });
});

describe('shouldBypass', () => {
  test('Bearer が付いていたらバイパスしない（本物の検証を通す）', () => {
    const withAuth = new Request('http://localhost:8787/mcp',
      { method:'POST', headers:{ authorization:'Bearer abc' } });
    assert.equal(shouldBypass(withAuth, { DEV_AUTH_BYPASS:'1' }), false);
    assert.equal(shouldBypass(req('http://localhost:8787/mcp'), { DEV_AUTH_BYPASS:'1' }), true);
  });

  test('/mcp 以外はバイパスしない', () => {
    for (const p of ['/authorize','/token','/register','/api/graph','/'])
      assert.equal(shouldBypass(req(`http://localhost:8787${p}`), { DEV_AUTH_BYPASS:'1' }), false, p);
  });

  test('本番ホストなら Bearer 無しでもバイパスしない', () => quiet(() =>
    assert.equal(shouldBypass(req('https://coach.example.com/mcp'), { DEV_AUTH_BYPASS:'1' }), false)));
});

describe('DO の鍵', () => {
  test('identity 無しで引こうとしたら例外', () => {
    assert.throws(() => graphFor({}, null), /identity なし/);
    assert.throws(() => graphFor({}, { email:'x' }), /identity なし/);
  });

  test('鍵は athlete_id のみ（subject を混ぜない）', () => {
    let seen = null;
    const env = { GRAPH: { idFromName: (n) => (seen = n), get: () => 'stub' } };
    graphFor(env, { athleteId:'uuid-1', subject:'google-sub-9', email:'a@x.com' });
    assert.equal(seen, 'athlete-uuid-1');
    assert.ok(!seen.includes('google-sub-9'), 'subject が鍵に混ざってはいけない');
  });
});

test('401 に WWW-Authenticate と resource_metadata が入る', () => {
  const r = unauthorized({ ISSUER:'https://coach.example.com' });
  assert.equal(r.status, 401);
  const h = r.headers.get('WWW-Authenticate');
  assert.match(h, /^Bearer /);
  assert.match(h, /resource_metadata="https:\/\/coach\.example\.com\/\.well-known\/oauth-protected-resource"/);
});
