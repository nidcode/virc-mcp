# 認証

## 構成

```
Claude / ChatGPT ──OAuth 2.1──▶ /mcp        Bearer トークン（OAuthProvider が検証）
ブラウザ         ──Cookie────▶ /api/*      セッション（OAUTH_KV）
                                  │
                          上流: Google OIDC（ユーザーが押すのは1回）
                                  │
                          D1: identities → athlete_id(UUID) → DO
```

## ユーザーの手順は2つ

1. `https://<host>/mcp` を貼る
2. 「Googleでログイン」

以上。APIキーもアプリ登録も同意画面もありません。
クライアントは **CIMD または DCR** で自己登録します。

## 同意画面を出す条件

無条件の自動許可は、DCR で誰でもクライアント登録できる以上、
**ログイン中のユーザーを細工した `/authorize` に踏ませてトークンを奪う**（ドライブバイ認可）を許します。
そこで、出す条件を2つに絞っています。

| クライアント | 挙動 |
|---|---|
| Claude · ChatGPT · Gemini · localhost | **常に無画面**（`auth/clients.js` の既知ホスト） |
| 一度許可した相手 | **無画面**（グラントが記憶されている） |
| それ以外の初回 | 同意画面を1回だけ。以後は記憶される |

判定は `isKnownPlatform()` で、**ホスト名の完全一致かドット区切りのサブドメインのみ**。
`claude.ai.evil.com` や `https://claude.ai@evil.com/cb` は通しません（テスト済み）。

`listUserGrants` が失敗したときは安全側に倒して同意画面を出します。

## /connections

接続中のアプリの一覧と取り消し。`revokeGrant(grantId, userId)` は**引数が2つ**です。
取り消すと、そのクライアントは次回また同意画面に戻ります。

## エンドポイント

| パス | 用途 |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728。401 の `WWW-Authenticate` から辿られる |
| `/.well-known/oauth-authorization-server` | RFC 8414 |
| `/authorize` | 同意画面（アプリ所有） |
| `/token` | トークン発行・失効（ライブラリ所有） |
| `/register` | DCR (RFC 7591) |
| `/callback` | Google からの戻り |
| `/mcp` | 保護。Bearer 必須 |
| `/api/*` | 保護。Cookie セッション |

CIMD（`clientIdMetadataDocumentEnabled`）と DCR を**両方**有効にしています。
MCP 2026-07-28 は CIMD ですが、DCR で来るクライアントがまだあるためです。

## ローカルのバイパス

`shouldBypass()` が **3条件すべて**を満たすときだけ `/mcp` を素通しします。

1. `DEV_AUTH_BYPASS=1`
2. ホストが `localhost` / `127.0.0.1` / `[::1]` / `0.0.0.0`
3. **`Authorization: Bearer` が付いていない**

3 があるので、ローカルでも Bearer を付ければ本物のトークン検証経路を試せます。
2 があるので、環境変数が誤って本番に入っても効きません（テスト済み）。

```bash
npm test          # users 6 + auth 9 + clients 7 = 22件
```

## DO の鍵

**`athlete-{athlete_id(UUID)}`。subject を混ぜない。**

IdP を足したり替えたりすると subject が変わるため、直結にすると過去のデータに到達できなくなります。
`identities (provider, subject) → athlete_id` の間接層が D1 にあります。
検証済みメールが一致する場合は同じ athlete に束ねます（未検証メールでは束ねません）。

## デプロイ

### 済み（2026-08-23）

```
URL       https://connect.virc.run
KV        OAUTH_KV   594d33ece479464ba9f0ee7ef235a1b9
D1        coach-users e700a6a2-d890-42d8-b12c-7dc601bd2924（athletes / identities 作成済み）
ISSUER    https://connect.virc.run
```

Google OAuth 設定済み（2026-08-28）。ログイン → 選手作成 → ウィキ移行まで確認済み。

入口は `connect.virc.run` だけです（2026-09-12）。`workers_dev` とバージョンの
プレビューURLは閉じてあります —— `redirect_uri` は `${ISSUER}/callback` 固定なので、
別オリジンから入るとログインが戻ってこられないためです。

### CLI から本番を触る

裏口は無いので、正規の OAuth 経路でトークンを取ります。

```bash
node coach-memory/tools/auth.js          # DCR → 認可 → PKCE 交換
                                          # ブラウザにセッションがあればクリック不要
COACH_PROD=1 node coach-memory/tools/seed.js   # 本番の自分の DO に投入
```

トークンは `.coach-token`（git 管理外・0600）に保存されます。1時間で失効するので、
切れたら `auth.js` を再実行してください。

`/api/*` は Cookie セッションと Bearer の両方を受けます。
ブラウザはセッション、CLI や外部ツールは Bearer。どちらも同じ identity に解決します。

### 参考: Google OAuth の設定手順

これが無いと `/mcp` は 401 のまま、`/authorize` は「未設定」画面になります。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) で
   「OAuth クライアント ID を作成」→ **ウェブアプリケーション**
2. **承認済みのリダイレクト URI** に次を登録（末尾のスラッシュ無し）:
   ```
   https://connect.virc.run/callback
   ```
3. OAuth 同意画面: 外部 / スコープは `openid` `email` `profile` の3つだけ
4. 発行された値を Secrets に入れる:
   ```bash
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   Secrets は即時反映されるので再デプロイは不要です。

### 環境変数の置き場

**`env.production` は使いません。** wrangler は `vars` を環境に継承しないため、
`DEV_AUTH_BYPASS` のようなローカル専用フラグが本番に紛れ込む事故を招きます。

| | 置き場 | デプロイされるか |
|---|---|---|
| `ISSUER`（本番） | `wrangler.jsonc` の `vars` | される |
| `ISSUER`（ローカル）· `DEV_AUTH_BYPASS` | `.dev.vars` | **されない** |
| `GOOGLE_CLIENT_*` | `wrangler secret` | 暗号化して保管 |

`.dev.vars` は git 管理外です。`.dev.vars.example` を複製して使ってください。

### カスタムドメインに移すとき

1. `wrangler.jsonc` の `vars.ISSUER` を新ホストに変更
2. `routes` を追加（`{ "pattern": "coach.example.com", "custom_domain": true }`）
3. Google の承認済みリダイレクト URI に `https://<新ホスト>/callback` を追加
4. `npx wrangler deploy`

**ISSUER と実際のホストが一致していないと OAuth のディスカバリが壊れます。**

## 未実装

- リフレッシュトークンの回転ポリシーはライブラリ既定のまま
- レート制限
- GitHub / Apple の上流（`google.js` と同じ形で足せる）
- 既知ホスト一覧の更新手段（今は `auth/clients.js` のハードコード）
