// 既知プラットフォーム判定。★サフィックス一致のバグ（claude.ai.evil.com）を通さないこと。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isKnownPlatform, autoApprove } from '../src/auth/clients.ts';

describe('isKnownPlatform', () => {
  test('Claude / ChatGPT / Gemini のコールバックは既知', () => {
    for (const u of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://chat.openai.com/aip/callback',
      'https://gemini.google.com/oauth/callback',
      'http://localhost:6274/oauth/callback',
      'http://127.0.0.1:33418/callback',
    ]) assert.equal(isKnownPlatform(u), true, u);
  });

  test('★紛らわしいホストは既知にしない', () => {
    for (const u of [
      'https://claude.ai.evil.com/cb',
      'https://notclaude.ai/cb',
      'https://evil.com/?x=claude.ai',
      'https://claude.ai@evil.com/cb',
      'https://xn--claude-ai.com/cb',
      'https://chatgpt.com.attacker.net/cb',
    ]) assert.equal(isKnownPlatform(u), false, u);
  });

  test('壊れた URI は false', () => {
    for (const u of ['', 'not-a-url', null, undefined, 'javascript:alert(1)'])
      assert.equal(isKnownPlatform(u), false, String(u));
  });

  test('サブドメインは許可する', () => {
    assert.equal(isKnownPlatform('https://api.claude.ai/cb'), true);
    assert.equal(isKnownPlatform('https://foo.bar.chatgpt.com/cb'), true);
  });
});

describe('autoApprove', () => {
  test('既知プラットフォームは listUserGrants を見ずに通す', async () => {
    let called = false;
    const env = { OAUTH_PROVIDER: { listUserGrants: async () => { called = true; return []; } } };
    assert.equal(await autoApprove(env, 'a1', { redirectUri:'https://claude.ai/cb', clientId:'c1' }), 'known-platform');
    assert.equal(called, false);
  });

  test('未知でも許可済みなら記憶で通す', async () => {
    const env = { OAUTH_PROVIDER: { listUserGrants: async () => [{ clientId:'c1' }] } };
    assert.equal(await autoApprove(env, 'a1', { redirectUri:'https://x.test/cb', clientId:'c1' }), 'remembered');
    assert.equal(await autoApprove(env, 'a1', { redirectUri:'https://x.test/cb', clientId:'c2' }), null);
  });

  test('listUserGrants が落ちたら安全側（画面を出す）', async () => {
    const w = console.warn; console.warn = () => {};
    const env = { OAUTH_PROVIDER: { listUserGrants: async () => { throw new Error('kv down'); } } };
    assert.equal(await autoApprove(env, 'a1', { redirectUri:'https://x.test/cb', clientId:'c1' }), null);
    console.warn = w;
  });
});
