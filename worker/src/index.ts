// エントリ。OAuthProvider が /mcp を守り、それ以外は siteHandler へ流す。
export { AthleteGraph } from './do.js';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { mcpHandler } from './mcp.ts';
import { siteHandler } from './site.ts';
import { shouldBypass, DEV_IDENTITY } from './auth/identity.ts';
import type { Env, Identity } from './env.d.ts';

// env が要るので初回リクエストで組み立てる（isolate ごとに1回）
let provider: OAuthProvider | null = null;
function getProvider(env: Env): OAuthProvider {
  if (provider) return provider;
  provider = new OAuthProvider({
    apiHandlers: { '/mcp': mcpHandler },
    defaultHandler: siteHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    // ★両方を有効にする。MCP 2026-07-28 は CIMD だが、DCR で来るクライアントがまだある
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['coach.read', 'coach.write'],
    resourceMetadata: { resource: `${env.ISSUER}/mcp` },   // RFC 9728
    allowPlainPKCE: false,
    allowImplicitFlow: false,
  });
  return provider;
}

// ctx は ExecutionContext。props だけ足した薄いラッパを渡す。
const withProps = (ctx: ExecutionContext, props: Identity) => ({
  props,
  waitUntil: ctx.waitUntil.bind(ctx),
  passThroughOnException: ctx.passThroughOnException.bind(ctx),
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 判定は auth/identity.js の shouldBypass に集約（テスト対象）
    if (shouldBypass(request, env)) {
      console.warn('[auth] DEV BYPASS: /mcp を認証なしで処理している');
      return mcpHandler.fetch(request, env, withProps(ctx, DEV_IDENTITY));
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};
