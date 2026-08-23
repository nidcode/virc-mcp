// 本番版アダプタ: Durable Object を Store 契約に合わせる。
// 全メソッドを DO への RPC に流すだけなので Proxy で足りる。
import type { Store } from '../../core/types.ts';

type Stub = { fetch(url: string, init?: RequestInit): Promise<Response> };

export const doStore = (stub: Stub): Store => {
  const call = async (fn: string, ...args: unknown[]) =>
    (await stub.fetch('http://do/call', { method: 'POST', body: JSON.stringify({ fn, args }) })).json();
  // DO 側に同名のメソッドがある前提。契約は Store 型が保証する。
  return new Proxy({}, { get: (_t, fn: string) => (...args: unknown[]) => call(fn, ...args) }) as Store;
};
