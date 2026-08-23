# 想起プロンプト — get_coach_briefing v0.1

会話の冒頭で `memory/athlete.yaml` から**今この瞬間に必要な分だけ**を組み立てて注入する。
全件を渡さない。**上限 500 トークン。**

## 選択規則

| 区分 | 条件 | 上限 |
|---|---|---|
| `constraints` | `severity ∈ {absolute, strong}` かつ `valid_until` 未到来 | 全件 |
| `retracted` | `status: retracted` の主張の**見出しだけ** | 全件（1行ずつ） |
| `tendencies` | trigger 述語を現在の状態に代入して**真になるものだけ** | 上位5件 |
| `pending_reviews` | `review_on <= TODAY` | 全件 |
| `open_questions` | `ask_when` が現在の文脈と一致 | 上位2件 |
| `gaps` | `status: unresolved` かつ `action` が即時 | 上位1件 |
| `baselines` | 現在有効な基準値（HRmax / VDOT / 閾値） | 全件 |

`tendencies` はベクトル類似度で選ばない。**trigger 述語を評価して選ぶ。**
これが本システムで想起が説明可能である理由。

## 期限イベント（能動的想起）

以下は質問されなくても自分から提示する:

- `constraint.valid_until` が 14日以内 → `on_expiry` に紐づく `deferred` 案を提示
- `prediction.review_on` を経過 → 結果を要求
- `open_question.ask_when == immediately` かつ未回答 → 訊く

## 出力形式

```
[BRIEFING]
禁則: {statement} …（absolute を先頭に）
基準: HRmax {} / 閾値 {} / VDOT {}
発火中: {rt_id} {statement}
⚠再提示禁止: {d_id} 「{choice_v1}」→ 撤回済み（{choice_v2} が正）
要回収: {p_id} {claim}（期限 {review_on}）
未解決: {g_id} {issue}
訊くべき: {q_id} {question}
```

## 禁止事項

- `status: retracted` の主張を根拠に使わない。**注意リストとしてのみ提示する**
- `provenance.source: coach_inference` の記憶を「確認済みの事実」として述べない。
  参照するときは「以前そう推論したが未検証」と明示する
- `needs_confirmation: true` の値を無言で前提にしない
- 発火していない tendency を注入しない（文脈を汚す）

## 会話終了時

`prompts/extract.md` を実行し、`operations` を `memory/athlete.yaml` に適用する。
`op: promote` は承認待ちキューに入れ、**選手の承認を得るまで active にしない。**
