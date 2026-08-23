// Worker のバインディングと環境変数。
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  GRAPH: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  USERS_DB: D1Database;
  ASSETS?: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;
  ISSUER: string;
  DEV_AUTH_BYPASS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/** ログイン済みの本人。ここ以外で athlete を決めない。 */
export interface Identity {
  provider: string;
  subject: string;
  email: string | null;
  athleteId: string;
  displayName?: string | null;
}
