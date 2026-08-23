import type { Env, Identity } from '../env.d.ts';

// ブラウザ用セッション。OAUTH_KV に置き、Cookie は id だけ。失効させられる。
const TTL = 60 * 60 * 24 * 30;
const NAME = 'coach_session';

export async function create(env: Pick<Env,'OAUTH_KV'>, identity: Identity): Promise<string> {
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(`sess:${id}`, JSON.stringify(identity), { expirationTtl: TTL });
  return id;
}

export async function read(env: Pick<Env,'OAUTH_KV'>, request: Request): Promise<Identity | null> {
  const raw = request.headers.get('cookie') ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${NAME}=([^;]+)`));
  if (!m?.[1]) return null;
  const v = await env.OAUTH_KV.get(`sess:${m[1]}`);
  return v ? JSON.parse(v) as Identity : null;
}

export async function destroy(env: Pick<Env,'OAUTH_KV'>, request: Request): Promise<void> {
  const raw = request.headers.get('cookie') ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${NAME}=([^;]+)`));
  if (m?.[1]) await env.OAUTH_KV.delete(`sess:${m[1]}`);
}

export const cookie = (id: string, url: string): string => {
  const secure = new URL(url).protocol === 'https:' ? '; Secure' : '';   // localhost は http
  return `${NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}${secure}`;
};
