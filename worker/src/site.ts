import type { AuthRequest, GrantSummary, ClientInfo } from '@cloudflare/workers-oauth-provider';
import type { Env, Identity } from './env.d.ts';

// 非保護ルート: 認可UI、Google コールバック、ブラウザ用 API、静的アセット。
import * as google from './auth/google.ts';
import * as session from './auth/session.ts';
import { resolveAthlete } from './users.ts';
import { autoApprove, isKnownPlatform } from './auth/clients.ts';
import { doStore } from './do-store.ts';
import { graphFor } from './auth/identity.ts';
import { devBypassEnabled, DEV_IDENTITY } from './auth/identity.ts';

const J = (x: unknown, s = 200): Response => new Response(JSON.stringify(x),
  { status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));

const page = (title: string, body: string): Response => new Response(
`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{background:#0f1115;color:#e6e6e6;font:14px/1.7 -apple-system,"Hiragino Sans",sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#151821;border:1px solid #2a2f3a;border-radius:14px;padding:32px 36px;max-width:460px}
h1{font-size:17px;margin:0 0 14px}p{color:#a8aeb9;margin:.5em 0}
code{background:#0f1115;padding:2px 6px;border-radius:4px;font-size:12px}
ul{color:#a8aeb9;padding-left:20px}li{margin:.3em 0}
button,a.btn{display:inline-block;background:#5b8dee;color:#fff;border:0;border-radius:8px;
padding:11px 22px;font-size:14px;cursor:pointer;text-decoration:none;margin-top:18px}
.sub{background:#252a35}</style><div class="card">${body}</div>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } });

/** Authorization: Bearer を OAuthProvider に検証させて identity に変える。 */
async function bearerIdentity(env: Env, request: Request): Promise<Identity | null> {
  const h = request.headers.get('authorization');
  if (!h?.startsWith('Bearer ')) return null;
  try {
    const t = await env.OAUTH_PROVIDER.unwrapToken<Partial<Identity>>(h.slice(7).trim());
    const p = t?.grant?.props;   // props は grant の下にある
    if (!p?.athleteId || !p.provider || !p.subject) return null;
    return { provider: p.provider, subject: p.subject, email: p.email ?? null,
      athleteId: p.athleteId, displayName: p.displayName };
  } catch { return null; }
}

export const siteHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const u = new URL(request.url);

    // ── OAuth: 認可エンドポイント ──────────────────────────────────
    if (u.pathname === '/authorize') {
      let authReq: AuthRequest;
      try { authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
      catch (e: any) { return page('エラー', `<h1>認可リクエストが不正です</h1><p>${esc(e.message)}</p>`); }

      const sess = await session.read(env, request);
      if (!sess) {                                   // 未ログイン → Google へ
        if (!google.configured(env))
          return page('未設定', `<h1>Google OAuth が未設定です</h1>
            <p><code>GOOGLE_CLIENT_ID</code> と <code>GOOGLE_CLIENT_SECRET</code> を
            <code>wrangler secret put</code> で設定してください。</p>`);
        const state = crypto.randomUUID();
        await env.OAUTH_KV.put(`login:${state}`, JSON.stringify({ authReq, url: request.url }),
          { expirationTtl: 600 });
        return Response.redirect(google.authUrl(env, state), 302);
      }

      // 許可を出す共通処理
      const grant = async (why: string): Promise<Response> => {
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq, userId: sess.athleteId,
          scope: authReq.scope?.length ? authReq.scope : ['coach.read', 'coach.write'],
          metadata: { grantedAt: new Date().toISOString(), why },
          props: { provider: sess.provider, subject: sess.subject, email: sess.email,
                   athleteId: sess.athleteId, displayName: sess.displayName },
        });
        return Response.redirect(redirectTo, 302);
      };

      // ★既知プラットフォーム、または一度許可したクライアントは無画面で通す
      const auto = await autoApprove(env, sess.athleteId, authReq);
      if (auto) return grant(auto);

      if (request.method === 'POST') {
        const form = await request.formData();
        if (form.get('approve') !== 'yes') {
          const back = new URL(authReq.redirectUri);
          back.searchParams.set('error', 'access_denied');
          if (authReq.state) back.searchParams.set('state', authReq.state);
          return Response.redirect(back.toString(), 302);
        }
        return grant('user-consent');
      }

      // ここに来るのは未知のクライアントの初回だけ
      const client: ClientInfo | null = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId).catch(() => null);
      const name = client?.clientName || authReq.clientId;
      return page('接続の許可', `<h1>${esc(name)} を接続しますか</h1>
        <p>${esc(sess.email ?? sess.displayName ?? '')} としてログイン中です。</p>
        <p>許可すること: コーチウィキの閲覧、判断・予測・分析の記録と更新</p>
        <p style="font-size:12px;color:#f0a">⚠ <b>見覚えのないアプリです。</b>
        リダイレクト先: <code>${esc(authReq.redirectUri)}</code><br>
        Claude・ChatGPT・Gemini からの接続でこの画面が出た場合は、許可しないでください。</p>
        <form method="POST">
          <button name="approve" value="yes">許可する</button>
          <button name="approve" value="no" class="sub">拒否</button>
        </form>
        <p style="margin-top:20px"><a href="/connections" style="color:#5b8dee;font-size:12px">接続中のアプリを見る</a></p>`);
    }

    // ── 接続中のアプリ（確認と取り消し） ─────────────────────────
    if (u.pathname === '/connections') {
      const sess = await session.read(env, request);
      if (!sess) return Response.redirect(`${env.ISSUER}/login`, 302);

      if (request.method === 'POST') {
        const form = await request.formData();
        const id = form.get('revoke');   // FormDataEntryValue: string | File
        if (typeof id === 'string' && id) await env.OAUTH_PROVIDER.revokeGrant(id, sess.athleteId)
          .catch((e: any) => console.warn('revoke:', e.message));
        return Response.redirect(`${env.ISSUER}/connections`, 302);
      }

      const res = await env.OAUTH_PROVIDER.listUserGrants(sess.athleteId).catch(() => null);
      const grants: GrantSummary[] = Array.isArray(res) ? res : (res?.items ?? []);
      const rows = await Promise.all(grants.map(async (g) => {
        const cid = g.clientId;
        const c: ClientInfo | null = await env.OAUTH_PROVIDER.lookupClient(cid).catch(() => null);
        return `<li style="margin:10px 0">
          <b>${esc(c?.clientName || cid)}</b><br>
          <span style="font-size:12px;color:#8b8f98">${esc((c?.redirectUris ?? [])[0] ?? '')}</span>
          <form method="POST" style="display:inline">
            <button name="revoke" value="${esc(g.id)}" class="sub"
              style="padding:4px 12px;font-size:12px;margin-left:10px">取り消す</button>
          </form></li>`;
      }));
      return page('接続中のアプリ', `<h1>接続中のアプリ</h1>
        <p>${esc(sess.email ?? '')}</p>
        ${rows.length ? `<ul style="list-style:none;padding:0">${rows.join('')}</ul>`
                      : '<p>まだありません。</p>'}
        <p style="font-size:12px;color:#8b8f98">Claude・ChatGPT・Gemini からの接続は同意画面なしで許可されます。
        身に覚えのないものがあれば取り消してください。</p>
        <a class="btn sub" href="/logout">ログアウト</a>`);
    }

    // ── Google からの戻り ──────────────────────────────────────────
    if (u.pathname === '/callback') {
      const state = u.searchParams.get('state'), code = u.searchParams.get('code');
      const stash = state && await env.OAUTH_KV.get(`login:${state}`);
      if (!stash) return page('エラー', `<h1>ログインの状態が失効しました</h1><p>やり直してください。</p>`);
      await env.OAUTH_KV.delete(`login:${state}`);
      if (!code) return page('エラー', `<h1>認可されませんでした</h1>`);

      let who;
      try { who = await google.exchange(env, code); }
      catch (e: any) { return page('エラー', `<h1>ログインに失敗しました</h1><p>${esc(e.message)}</p>`); }

      const athleteId = await resolveAthlete(env.USERS_DB, who);
      const sid = await session.create(env, { ...who, athleteId });
      const { url } = JSON.parse(stash);
      return new Response(null, { status: 302,
        headers: { location: url, 'set-cookie': session.cookie(sid, request.url) } });
    }

    if (u.pathname === '/logout') {
      await session.destroy(env, request);
      return new Response(null, { status: 302, headers: { location: '/' } });
    }

    // ── 読み取り API ────────────────────────────────────────────
    //   ブラウザは Cookie セッション、CLI や外部ツールは Bearer トークン。
    //   どちらも同じ identity に解決する。ローカルのみバイパス可。
    if (u.pathname.startsWith('/api/')) {
      const identity = devBypassEnabled(request, env)
        ? DEV_IDENTITY
        : (await bearerIdentity(env, request)) ?? (await session.read(env, request));
      if (!identity) return J({ error: 'unauthorized', login: '/login' }, 401);
      const store = doStore(graphFor(env, identity));
      if (u.pathname === '/api/graph') return J(await store.graph());
      if (u.pathname === '/api/node') {
        const id = u.searchParams.get('id');
        if (!id) return J({ error: 'id が必要です' }, 400);
        return J(await store.get(id));
      }
      if (u.pathname === '/api/stats') return J(await store.stats());
      if (u.pathname === '/api/me')    return J({ athleteId: identity.athleteId, email: identity.email });
      if (u.pathname === '/api/seed' && request.method === 'POST') {
        const stub = graphFor(env, identity);
        return J(await (await stub.fetch('http://do/seed', { method: 'POST', body: await request.text() })).json());
      }
      return J({ error: 'not found' }, 404);
    }

    // ブラウザのログイン導線（/authorize を経由せず単独でログインしたいとき）
    if (u.pathname === '/login') {
      if (!google.configured(env)) return page('未設定', `<h1>Google OAuth が未設定です</h1>`);
      const state = crypto.randomUUID();
      await env.OAUTH_KV.put(`login:${state}`, JSON.stringify({ url: '/' }), { expirationTtl: 600 });
      return Response.redirect(google.authUrl(env, state), 302);
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('not found', { status: 404 });
  },
};
