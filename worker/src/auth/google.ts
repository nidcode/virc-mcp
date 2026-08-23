import type { Env } from '../env.d.ts';

// 上流の身元確認。ユーザーが押すのは「Googleでログイン」の1回だけ。
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

export const configured = (env: Pick<Env,'GOOGLE_CLIENT_ID'|'GOOGLE_CLIENT_SECRET'>): boolean => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function authUrl(env: Env, state: string): string {
  const u = new URL(AUTH);
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
  u.searchParams.set('redirect_uri', `${env.ISSUER}/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/**
 * 認可コードを交換して身元を得る。
 * id_token の署名検証は行わない — トークンエンドポイントから TLS 直で、
 * かつクライアント認証つきで受け取っているため（OIDC Core 3.1.3.7 が許容する経路）。
 * iss / aud / exp は検証する。
 */
export interface UpstreamIdentity {
  provider: 'google'; subject: string; email: string | null; displayName: string | null;
}

export async function exchange(env: Env, code: string): Promise<UpstreamIdentity> {
  const res = await fetch(TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${env.ISSUER}/callback`, grant_type: 'authorization_code' }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  const { id_token } = await res.json() as { id_token?: string };
  if (!id_token) throw new Error('id_token が返らなかった');

  const claims = JSON.parse(atob(id_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as
    { iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? ''))
    throw new Error(`想定外の iss: ${claims.iss}`);
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('aud が一致しない');
  if ((claims.exp ?? 0) * 1000 < Date.now()) throw new Error('id_token の期限切れ');
  if (!claims.sub) throw new Error('sub が無い');

  return { provider: 'google', subject: claims.sub!,
    email: claims.email_verified ? (claims.email ?? null) : null,   // 未検証メールで統合しない
    displayName: claims.name ?? null };
}
