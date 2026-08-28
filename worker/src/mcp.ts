// 保護された /mcp。OAuthProvider が検証済みの identity を ctx.props に入れて呼ぶ。
import { TOOLS, dispatch, RESOURCES, readResource } from '../../core/tools.ts';
import { doStore } from './do-store.ts';
import { fromProps, graphFor, unauthorized } from './auth/identity.ts';
import type { Env } from './env.d.ts';

interface JsonRpc { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any }

const J = (x: unknown, s = 200): Response => new Response(JSON.stringify(x),
  { status: s, headers: { 'content-type': 'application/json' } });

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: { props?: any }): Promise<Response> {
    const identity = fromProps(ctx);
    if (!identity) return unauthorized(env, 'no verified identity on request');
    if (request.method !== 'POST')
      return new Response('MCP endpoint. POST JSON-RPC here.', { status: 405 });

    const msg = await request.json() as JsonRpc;
    const reply = (result: unknown) => J({ jsonrpc: '2.0', id: msg.id, result });

    if (msg.method === 'initialize') return reply({
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {}, resources: {} },   // ★schema 層を公開する
      serverInfo: {
        name: 'coach-memory',
        title: 'コーチの記憶',
        version: '0.5.0',
        websiteUrl: env.ISSUER,
        // MCP SEP-973（2025-11-25 以降）の icons。
        // claude.ai のカスタムコネクタは 2026-08 時点で未対応（常に地球儀）だが、
        // 対応クライアントでは表示される。data URI にして外部取得を不要にしてある。
        icons: [
          { src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIxMCIgZmlsbD0iIzBmMTExNSIvPjxnIHN0cm9rZT0iIzJmNmJkOCIgc3Ryb2tlLXdpZHRoPSIxLjYiIG9wYWNpdHk9Ii44NSI+PHBhdGggZD0iTTI0IDE1IEwxNSAyNyBNMjQgMTUgTDMzIDI3IE0xNSAyNyBMMjQgMzYgTTMzIDI3IEwyNCAzNiBNMTUgMjcgTDMzIDI3Ii8+PC9nPjxnIGZpbGw9IiM1YjhkZWUiPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTUiIHI9IjQiLz48Y2lyY2xlIGN4PSIxNSIgY3k9IjI3IiByPSIzLjIiLz48Y2lyY2xlIGN4PSIzMyIgY3k9IjI3IiByPSIzLjIiLz48Y2lyY2xlIGN4PSIyNCIgY3k9IjM2IiByPSIzLjIiLz48L2c+PGNpcmNsZSBjeD0iMzMiIGN5PSIyNyIgcj0iMy4yIiBmaWxsPSIjMjJjNTVlIi8+PGNpcmNsZSBjeD0iMTUiIGN5PSIyNyIgcj0iMy4yIiBmaWxsPSIjZWY0NDQ0Ii8+PC9zdmc+',
            mimeType: 'image/svg+xml', sizes: ['any'] },
          { src: `${env.ISSUER}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
        ],
      } });
    if (msg.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: TOOLS });
    if (msg.method === 'resources/list') return reply({ resources: RESOURCES });
    if (msg.method === 'resources/read') {
      const store = doStore(graphFor(env, identity));
      try {
        return reply({ contents: [{ uri: msg.params.uri, mimeType: 'text/markdown',
          text: await readResource(store, msg.params.uri) }] });
      } catch (e: any) {
        return J({ jsonrpc: '2.0', id: msg.id,
          error: { code: -32002, message: e.message } });
      }
    }
    if (msg.method === 'tools/call') {
      const store = doStore(graphFor(env, identity));
      try {
        return reply({ content: [{ type: 'text',
          text: await dispatch(store, msg.params.name, msg.params.arguments ?? {}) }] });
      } catch (e: any) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    return J({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  },
};
