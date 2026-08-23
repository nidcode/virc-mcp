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
      serverInfo: { name: 'coach-memory', version: '0.4.0' } });
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
