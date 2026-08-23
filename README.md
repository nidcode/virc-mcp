# coach-memory

ランニングコーチAIのための**記憶と成長のレイヤー**。
Claude / ChatGPT から接続して使う MCP サーバー。

Karpathy の [LLM Wiki パターン](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
をコーチングという領域に具体化したもの。

## 構成

```
core/           ツール定義とハンドラの唯一の実装（2バックエンドが共有）
schema/         ★製品としての schema。全インスタンスに配られる既定テンプレート
coach-memory/   ローカル版エントリ（stdio MCP × markdown ファイル）
worker/         本番版エントリ（Cloudflare Worker + Durable Object + OAuth）

coach/          ★ローカルの開発用インスタンス。git 管理外
```

## coach/ は Durable Object 1つ分

`coach/` は**ランタイム状態**です。本番ではユーザーごとに Durable Object が
1つずつあり、リポジトリ側には存在しません。ローカルの `coach/` は
そのうちの1インスタンスをファイルで再現したもの — ローカルDBと同じ位置づけです。

したがって `.gitignore` で丸ごと除外しています。機微だからではなく、
**そもそもリポジトリに属さない**ためです。

| | 追跡 | 実体 |
|---|---|---|
| schema | `schema/CLAUDE.md`（既定テンプレート） | `coach/CLAUDE.md` / DO の `config.schema` |
| ウィキ | — | `coach/wiki/` / DO の `nodes` `edges` |
| 不変ソース | — | `coach/raw/` |

schema は**インスタンス側の live copy を優先**し、無ければ既定テンプレートに落ちます。
Karpathy の原文が「schema は選手と共進化させる」と述べている通り、
実体側で書き換わることを許す設計です。

## 動かす

```bash
npm install && (cd worker && npm install)
npx tsc --noEmit                      # 型検査（root）
cd worker && npx tsc -p . --noEmit    # 型検査（Workers 型）
cd worker && npm test                 # 単体テスト

node coach-memory/server.js --briefing   # ローカル版
cd worker && npx wrangler dev            # 本番版をローカルで
node coach-memory/tools/seed.js          # ウィキ → DO に投入
```

詳細は [`core/README.md`](core/README.md) / [`worker/AUTH.md`](worker/AUTH.md) /
[`coach/CLAUDE.md`](coach/CLAUDE.md)。
