import type { AuthRequest, GrantSummary } from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env.d.ts';

// どのクライアントを無画面で許可するか。
//
// DCR が有効なので誰でもクライアント登録できる。無条件の自動許可は
// 「ログイン中のユーザーを細工した /authorize に踏ませてトークンを奪う」を許すため、
// リダイレクト先が既知プラットフォームのときだけ無画面にする。

const HOSTS: string[] = [
  'claude.ai', 'claude.com',                    // Claude / Claude Code
  'chatgpt.com', 'openai.com', 'chat.openai.com', // ChatGPT
  'google.com', 'gemini.google.com',            // Gemini
  'localhost', '127.0.0.1', '[::1]',            // ローカルのMCPクライアント・Inspector
];

/** ★ホスト名の完全一致かドット区切りのサブドメインのみ。'claude.ai.evil.com' を通さない。 */
export function isKnownPlatform(redirectUri: string | null | undefined): boolean {
  let h: string;
  try { h = new URL(redirectUri!).hostname.toLowerCase(); } catch { return false; }
  return HOSTS.some(k => h === k || h.endsWith(`.${k}`));
}

/** この選手がこのクライアントに既に許可を出しているか（＝記憶されているか）。 */
export async function alreadyGranted(env: Pick<Env,'OAUTH_PROVIDER'>, userId: string, clientId: string): Promise<boolean> {
  try {
    const res = await env.OAUTH_PROVIDER.listUserGrants(userId);
    const grants: GrantSummary[] = Array.isArray(res) ? res : (res?.items ?? []);
    return grants.some((g) => g.clientId === clientId);
  } catch (e: any) {
    console.warn('[auth] listUserGrants 失敗、同意画面にフォールバック:', e.message);
    return false;   // 判断できないときは安全側（画面を出す）
  }
}

/** 無画面で許可してよいか。既知プラットフォーム、または記憶済み。 */
export async function autoApprove(env: Pick<Env,'OAUTH_PROVIDER'>, userId: string,
  authReq: Pick<AuthRequest, 'redirectUri' | 'clientId'>): Promise<'known-platform' | 'remembered' | null> {
  if (isKnownPlatform(authReq.redirectUri)) return 'known-platform';
  if (await alreadyGranted(env, userId, authReq.clientId)) return 'remembered';
  return null;
}
