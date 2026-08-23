import type { Env, Identity } from '../env.d.ts';

// 認証の唯一の入口。ここ以外で athlete を決めない。
//
// 本番: OAuthProvider が検証済みの props を ctx.props に注入する。
// ローカル: DEV_AUTH_BYPASS=1 かつ localhost のときだけ、固定の開発ユーザーを返す。

export const DEV_IDENTITY: Identity = Object.freeze({
  provider: 'dev', subject: 'dev-user', email: 'dev@localhost',
  athleteId: '00000000-0000-4000-8000-000000000000', displayName: 'Dev Athlete',
});

const LOCAL_HOSTS = new Set<string>(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * バイパスが有効か。**2条件の両方**を満たすときだけ true。
 * 環境変数が誤って本番に入っても、ホスト名が localhost でなければ効かない。
 */
export function devBypassEnabled(request: Request, env: Pick<Env, 'DEV_AUTH_BYPASS'>): boolean {
  if (env.DEV_AUTH_BYPASS !== '1') return false;
  const host = new URL(request.url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    console.warn(`[auth] DEV_AUTH_BYPASS=1 だが host=${host} のため無効化した`);
    return false;
  }
  return true;
}

/**
 * /mcp をバイパスしてよいか。**3条件すべて**を満たすときだけ true。
 *   1. DEV_AUTH_BYPASS=1
 *   2. ホストが localhost（環境変数が本番に漏れても効かない）
 *   3. 認証情報が付いていない（付いていれば本物の検証経路を通す）
 */
export function shouldBypass(request: Request, env: Pick<Env, 'DEV_AUTH_BYPASS'>): boolean {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return false;
  if (new URL(request.url).pathname !== '/mcp') return false;
  return devBypassEnabled(request, env);
}

/** ctx.props（OAuthProvider 由来）から identity を取り出す。無ければ null。 */
export function fromProps(ctx: { props?: Partial<Identity> } | undefined): Identity | null {
  const p = ctx?.props;
  if (!p?.athleteId || !p.provider || !p.subject) return null;
  return { provider: p.provider, subject: p.subject, email: p.email ?? null,
    athleteId: p.athleteId, displayName: p.displayName };
}

/** identity → Durable Object のスタブ。鍵は athlete_id(UUID) のみ。 */
export function graphFor(env: Pick<Env, 'GRAPH'>, identity: Identity | null): DurableObjectStub {
  if (!identity?.athleteId) throw new Error('identity なしで DO を引かない');
  return env.GRAPH.get(env.GRAPH.idFromName(`athlete-${identity.athleteId}`));
}

/** MCP 仕様の 401。クライアントはこのヘッダから認可サーバを発見する。 */
export function unauthorized(env: Pick<Env, 'ISSUER'>, detail = 'authorization required'): Response {
  const meta = `${env.ISSUER}/.well-known/oauth-protected-resource`;
  return new Response(JSON.stringify({ error: 'unauthorized', error_description: detail }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'WWW-Authenticate': `Bearer realm="coach", resource_metadata="${meta}"`,
    },
  });
}
