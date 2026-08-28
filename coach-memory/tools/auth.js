// 本番の MCP サーバーから、正規の OAuth 経路でアクセストークンを取る。
// 裏口（x-athlete-id など）は作らない。DCR → 認可 → PKCE 交換 の実物を通す。
//
//   node coach-memory/tools/auth.js [https://host]
//
// 取れたトークンは .coach-token（git 管理外）に保存する。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HOST = process.argv[2] || process.env.COACH_HOST || 'https://coach-graph.nidstyle3.workers.dev';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.coach-token');
const b64 = (b) => b.toString('base64url');
const verifier = b64(crypto.randomBytes(32));
const challenge = b64(crypto.createHash('sha256').update(verifier).digest());

const server = http.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const redirectUri = `http://127.0.0.1:${port}/callback`;

// 1. クライアントを自己登録（DCR）
const reg = await fetch(`${HOST}/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'coach-memory CLI', redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'] }),
});
if (!reg.ok) { console.error('DCR 失敗:', reg.status, await reg.text()); process.exit(1); }
const { client_id } = await reg.json();

// 2. 認可
const state = crypto.randomUUID();
const url = `${HOST}/authorize?` + new URLSearchParams({
  response_type: 'code', client_id, redirect_uri: redirectUri,
  code_challenge: challenge, code_challenge_method: 'S256',
  scope: 'coach.read coach.write', state });

console.log('ブラウザで認可します。既にログイン済みならクリック不要で戻ります。\n');
console.log(url + '\n');
spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('5分待っても戻ってこなかった')), 300_000);
  server.on('request', (req, res) => {
    const q = new URL(req.url, `http://127.0.0.1:${port}`).searchParams;
    const ok = q.get('code') && q.get('state') === state;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
      ${ok ? '✅ 取得しました。ターミナルに戻ってください。' : '❌ 失敗: ' + (q.get('error') ?? 'state 不一致')}</body>`);
    clearTimeout(timer);
    ok ? resolve(q.get('code')) : reject(new Error(q.get('error') ?? 'state 不一致'));
  });
});
server.close();

// 3. トークン交換（PKCE）
const tok = await fetch(`${HOST}/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id,
    redirect_uri: redirectUri, code_verifier: verifier }),
});
if (!tok.ok) { console.error('トークン交換 失敗:', tok.status, await tok.text()); process.exit(1); }
const t = await tok.json();

fs.writeFileSync(OUT, JSON.stringify({ host: HOST, ...t, obtained_at: new Date().toISOString() }, null, 1), { mode: 0o600 });
const me = await (await fetch(`${HOST}/api/me`, { headers: { authorization: `Bearer ${t.access_token}` } })).json();
console.log(`✅ トークンを取得しました（scope: ${t.scope} / ${t.expires_in}秒）`);
console.log(`   athlete_id: ${me.athleteId}`);
console.log(`   email     : ${me.email}`);
console.log(`   保存先    : ${path.relative(process.cwd(), OUT)}（git 管理外）`);
