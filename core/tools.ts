// ツール定義とハンドラの唯一の実装。ストレージは Store インターフェース越しに触る。
// 契約は core/types.ts の `Store`。2つのバックエンドが型で縛られている。
import type {
  Store, ToolDef, WikiNode, NodeType, Front, Prediction, EmbeddedPrediction,
  DownstreamRow, ProvenanceSource, DecisionFront,
} from './types.ts';

/** JSON-RPC から来る引数。ツールごとの必須項目は dispatch 内で検証する。 */
type Args = Record<string, any>;

export interface RecordDecisionArgs {
  question: string; choice: string; rationale: string;
  prediction: { claim: string; adjudication_criterion: string; review_on: string };
  constraints_reviewed: string[];
  constraint_compliance?: string;
  context?: Record<string, unknown>;
  applies?: string[];
  rejected_options?: Array<{ option: string; reason: string; deferred_until?: string }>;
  links?: string[];
}
export interface RetractClaimArgs {
  id: string; reason: string; corrected_value: string;
  derived_lesson?: string; downstream?: string[];
}
export interface RecordOutcomeArgs {
  prediction_id: string;
  status: 'confirmed' | 'refuted' | 'unadjudicable';
  observed: string; derived_lesson?: string;
  /** ★答え合わせが依存先の信念をどう動かすか。候補はサーバーが提示する。 */
  downstream?: OutcomeEffect[];
}
export interface OutcomeEffect {
  id: string;
  /** 何が変わるか。変わらないなら「変更なし: 理由」と明示する */
  effect: string;
  /** 反応モデルの確信度を動かす場合 */
  confidence?: number;
}

const cut = (s: unknown, n = 70): string => (s && String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
const plus = (d: string, n: number): string => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const L = (ids?: string[] | null): string => (ids || []).map((i) => `[[${i}]]`).join(' ');
const W_SLUG = (s: string): string =>
  String(s).replace(/[\/\\:*?"<>|\n#[\]]/g, '').trim().slice(0, 24);
const isDate = (s?: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

/**
 * ★record_outcome の refuted 誤用ガード（TASKS.md P2）。
 * 「そもそも実施・検証されなかった」ことを示す語を検知する。
 * 「できなかった」単体のような、正当な refuted（例: ペースを維持できなかった）にも
 * 現れる汎用語は含めない — 過検知で正しい refuted まで拒否してしまうため。
 * 「実施できなかった」「開催されなかった」のように、行為そのものが成立しなかった
 * ことを示す組み合わせだけを狙い撃ちする。
 */
const UNADJUDICABLE_HINTS: Array<string | RegExp> = [
  '延期', '中止', 'キャンセル', '順延', '見送り', '未実施', '欠場', '中断',
  /実施(?:でき(?:ず|なかった)|され(?:ず|なかった)|せず)/,
  /開催(?:でき(?:ず|なかった)|され(?:ず|なかった)|中止)/,
  /行(?:われ|え)なかった/,
  /\bDNS\b/i,
];
const looksUnadjudicable = (observed: string): boolean =>
  UNADJUDICABLE_HINTS.some((h) => (typeof h === 'string' ? observed.includes(h) : h.test(observed)));

// ★athlete_profile はここに含めない。record_memory() 内で個別に扱う固定id 'athlete'
//   のシングルトンであり、nextId による連番採番の対象ではないため。
const P: Record<string, string> = {
  constraint: 'c', response_tendency: 'rt', decision: 'd', analysis: 'an',
  entity: 'e', conflict: 'cf', note: 'n',
};
const DIR: Record<string, string> = {
  constraint: 'constraints', response_tendency: 'tendencies', decision: 'decisions',
  analysis: 'analysis', entity: 'entities', conflict: 'conflicts', note: 'notes',
  athlete_profile: '.',   // 選手カルテはウィキ直下（wiki/athlete.md）に置く唯一のページ
};
export const TYPE_DIR = DIR;

/**
 * ★コーチとしての振る舞い。briefing の返り値と instructions で運ぶ。
 * MCP にはシステムプロンプトを注入する経路が無く、確実に届くのは
 * ツールの description と返り値だけなので、ここに載せる。
 */
export const PROTOCOL = `あなたはこの選手の専属コーチです。一般論を述べる相手ではなく、
上の記憶を持っているコーチとして振る舞ってください。

## ⛔ 選手に見せてはいけないもの
**c_01 / rt_06 / d_11 のような記録IDを、返答の文章に書かないこと。**
IDはツールを呼ぶための道具であって、選手には無関係です。

  ✗「c_01 の禁則があるので火曜は避けます」
  ○「火木の夜は用事があるので、そこは外します」
  ✗「rt_03 より、暑熱下では…」
  ○「夏場は心拍が適正でもペースが保てなくなるので…」

内部の仕組みを尋ねられたときだけ例外です。

## 気づいたら、その場で remember を呼ぶ
選手が何か言うたびに、記録に値するかを考えてください。**会話の終わりまで待たない。**
生活の制約、好み、体の反応、練習環境、性格の癖、こちらの推測 — 迷ったら残す。
\`remember\` は検証なしで必ず通ります。1回の会話で何度呼んでもかまいません。

**指示されてから記録するのでは遅い。** 選手は記録を頼む役ではありません。

## 話題の切れ目・会話の終わりに log_session を呼ぶ
そのセッションのやり取りを、要約せずできるだけ生のまま \`log_session\` に渡してください。
選手の発言は原文のまま、コーチ側は要約でよい。今の型に当てはまらない言い回しや脱線も削らない
——それが後でオントロジーを見直すときに拾える唯一の記録です。\`<athlete>\`/\`<coach>\`/
\`<tool_result>\` で話者を分離すること。書き込み専用で、この会話中に読み返されることはありません。

## 処方する前に、過去を見る
\`get_history\` で、そのテーマについて過去に何を決め、何が起きたかを確認してください。
**直近のデータだけで判断しない。** 同じことを前に試していないか、そのとき何が起きたかを
知らずに提案しないこと。

## 手順
0. briefing の「直近のやり取り」を踏まえて始める。初対面のように振る舞わない。
   間が空いていれば自然に触れる（例:「前回から少し間が空きましたね」）
1. 期限の来た予測があれば、他の話題より先に結果を訊く
2. 現状を評価する（COROS / Strava。記憶の数値と食い違ったら黙って上書きせず明示する）
3. **\`get_history\` で経緯を確認する**
4. 処方する。提案は「何を狙うか」「何が起きたら誤りか」「いつ見直すか」を必ず含む
5. \`record_decision\` で記録する（反証条件と禁則の確認が必須）
6. 結果が出たら \`record_outcome\`。依存する信念を動かすところまでが1回の操作

## 出所の優先順位
実測 > 本人の申告 > 本人の経験則 > 代理データからの換算 > コーチの推論

- 本人が経験を根拠に数値を出したら、換算で覆さない。覆すには一次データが要る
- 自分の推論を「本人の申告」として記録しない。最も重大な事故です
- 「推論値」と付いた基準値を、確定事実として述べない

## してはいけないこと
- 記録IDを返答に書く
- 「再提示禁止」に載っている主張を持ち出す
- 反証条件を書けない提案をする
- 絶対禁則に抵触する提案をする
- 過去を見ずに直近のデータだけで処方する
- 断定の強さを根拠の強さより上げる

## 訊き方
質問は「訊くべき」に出たものだけ。それ以外は溜めて、必要な時期に訊く。`;



/** initialize の応答に載せる。仕様上「LLM の理解を助けるため」の欄。 */
export const INSTRUCTIONS = `このサーバーは、ひとりのランナーについての永続的なコーチング記憶です。

**会話の最初に必ず get_coach_briefing を呼んでください。** 禁則・基準値・撤回済みの主張・
回収すべき予測が返ります。これを読まずに記録系のツールを呼ぶと拒否されます。

${PROTOCOL}`;

/** claude.ai などがコネクタの入口として同期する。 */
export const PROMPTS = [
  { name: 'coach_session', title: '今日の練習を相談する',
    description: '記憶を読み込んでから、今日〜今週の練習を相談する。期限の来た予測があれば先に回収する。' },
  { name: 'report_result', title: '練習結果を報告する',
    description: '実施した練習の結果を報告し、予測の答え合わせと信念の更新まで行う。' },
  { name: 'weekly_review', title: '週次レビュー',
    description: '未回収の予測・撤回済みへの依存・孤立ページなどを点検し、記憶を健康に保つ。' },
];

export function getPrompt(name: string): { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } {
  const head = 'まず get_coach_briefing を呼んで、記憶を読み込んでください。\n\n';
  const body: Record<string, string> = {
    coach_session: head
      + '読み終えたら、期限の来た予測があれば先に結果を訊いてください。\n'
      + 'そのうえで COROS / Strava から直近の状態を取得し、今日〜今週の練習を提案してください。\n'
      + '提案したら record_decision で記録すること（反証条件と禁則の確認が必須）。',
    report_result: head
      + '読み終えたら、回収すべき予測を提示して、どれの結果かを確認してください。\n'
      + 'record_outcome で答え合わせをします。**記録して終わりではありません** — '
      + 'その結果が依存する反応モデルをどう動かすかまで述べてください（downstream 必須）。',
    weekly_review: head
      + 'そのあと lint_wiki を呼んで、記憶の健康状態を点検してください。\n'
      + '未回収の予測、撤回済みを根拠にしたままの記録、証拠のない反応モデル、\n'
      + '一度も使われていない反応モデル、未検証の基準値。\n'
      + '指摘ごとに、直すか・保留するか・なぜ保留するかを述べてください。',
  };
  const text = body[name];
  if (!text) throw new Error(`unknown prompt: ${name}`);
  return { description: PROMPTS.find((p) => p.name === name)!.description,
    messages: [{ role: 'user', content: { type: 'text', text } }] };
}

const PROVENANCE: ProvenanceSource[] = ['primary_measured', 'external_primary', 'athlete_report',
  'athlete_estimate', 'proxy_derived', 'coach_inference'];

export const TOOLS: ToolDef[] = [
  { name: 'get_coach_briefing',
    description: '会話の冒頭で必ず呼ぶ。禁則・基準値・反応モデル・撤回済みの主張・回収すべき予測・訊くべき質問を返す。読む前にコーチングを始めてはいけない。',
    inputSchema: { type: 'object', properties: {
      context: { type: 'string', description: '現在の話題。該当する保留質問が追加で返る' } } } },

  { name: 'record_decision',
    description: '練習内容・設定・戦略を提案したら必ず呼ぶ。反証条件と absolute 禁則の確認が無いと拒否される。'
      + 'severity: absolute の禁則が1件でも有効に存在する場合は constraint_compliance も必須になる。',
    inputSchema: { type: 'object', required: ['question','choice','rationale','prediction','constraints_reviewed'], properties: {
      question: { type: 'string' }, choice: { type: 'string' }, rationale: { type: 'string' },
      context: { type: 'object', description: '判断時点の状態スナップショット' },
      prediction: { type: 'object', required: ['claim','adjudication_criterion','review_on'], properties: {
        claim: { type: 'string' },
        adjudication_criterion: { type: 'string', description: '★何が観測されたら誤りと判定するか' },
        review_on: { type: 'string', description: 'YYYY-MM-DD' } } },
      applies: { type: 'array', items: { type: 'string' }, description: '根拠にした反応モデルの id' },
      rejected_options: { type: 'array', items: { type: 'object', properties: {
        option: { type: 'string' }, reason: { type: 'string' }, deferred_until: { type: 'string' } } } },
      links: { type: 'array', items: { type: 'string' }, description: '関連ページの id やページ名' },
      constraints_reviewed: { type: 'array', items: { type: 'string' },
        description: '★確認した absolute 禁則の id を全て列挙。漏れると拒否される。'
          + 'get_coach_briefing の「禁則:」欄で [!] が付いている id をそのまま使えばよい' },
      constraint_compliance: { type: 'string',
        description: '★absolute 禁則が1件でも有効に存在する場合は必須（無ければ省略可）。'
          + '各 absolute 禁則に対し、この判断がどう抵触しないかを具体的に述べる。id の列挙だけでは不十分。20文字未満は拒否される' } } } },

  { name: 'file_analysis',
    description: '★良い分析・導出・比較をウィキに残す。会話履歴に消えさせない。後から何度も参照する結論はここに置く。',
    inputSchema: { type: 'object', required: ['title','question','answer','body','provenance'], properties: {
      title: { type: 'string', description: 'ページ名（短く）' }, question: { type: 'string' },
      answer: { type: 'string' }, body: { type: 'string', description: 'markdown。一次データ・内訳・[[リンク]]を含める' },
      provenance: { type: 'string', enum: PROVENANCE }, confidence: { type: 'number' },
      supersedes: { type: 'array', items: { type: 'string' } } } } },

  { name: 'remember',
    description: '★選手について何か分かったら、その場で呼ぶ。会話の終わりまで待たない。'
      + '検証は一切なく、必ず記録される。判断や提案ではなく「分かったこと」を落とすためのもの。'
      + '生活の制約、好み、体の反応、練習環境、性格の癖、こちらの推測 — 迷ったら残す。'
      + '会話1回につき何度呼んでもよい。あとで週次レビューで正式な型に整理する。',
    inputSchema: { type: 'object', required: ['what'], properties: {
      what: { type: 'string', description: '分かったこと。選手の言葉に近い形で' },
      kind: { type: 'string', enum: ['observation','preference','constraint_hint','context'],
        description: 'observation=体や練習の反応 / preference=好み・やりやすさ / constraint_hint=制約になりそうなこと / context=生活・仕事・環境' },
      why: { type: 'string', description: 'なぜ残す価値があるか（任意）' } } } },

  { name: 'log_session',
    description: '★話題が大きく変わる・会話を切り上げる直前に呼ぶ。そのセッションのやり取りを、'
      + '要約・取捨選択せずできるだけ生のまま残す。選手の発言は原文のまま引用し、コーチ側の発言は要約でよい。'
      + '今のオントロジーの型（禁則・反応モデル・判断…）に当てはまらない言い回し・ためらい・脱線も削らないこと。'
      + 'それが後で拾える唯一の記録になる。書き込み専用 — この会話中に読み返されることはない。'
      + '各発言を `<athlete>` / `<coach>` / `<tool_result>` タグで話者分離すること（将来の再抽出プロンプトの入力形式）。',
    inputSchema: { type: 'object', required: ['transcript'], properties: {
      transcript: { type: 'string', description: '`<athlete>選手の発言（原文のまま）</athlete>` '
        + '`<coach>コーチの発言（要約可）</coach>` `<tool_result>ツール結果の要旨</tool_result>` の'
        + '繰り返しで、そのセッションのやり取りを時系列に並べたもの' } } } },

  { name: 'get_history',
    description: '★処方する前に呼ぶ。あるテーマについて過去に何を決め、何を予測し、実際どうなったかを時系列で返す。'
      + '直近のデータだけで判断しないため。「同じことを前にも試したか」「そのとき何が起きたか」を知らずに提案しない。',
    inputSchema: { type: 'object', required: ['topic'], properties: {
      topic: { type: 'string', description: 'テーマ（例: 閾値走、距離走の設定、渡航、故障、レース戦略）' } } } },

  { name: 'record_memory',
    description: '禁則・反応モデル・エンティティ・衝突（選手とコーチの主張が食い違った記録）・選手カルテ（athlete_profile）を新しいページとして記録する。provenance は必須。根拠にした記録がある場合は front.evidence_refs に id を列挙すること（根拠が撤回されたときに波及を検出できる）。'
      + ' ★athlete_profile はシングルトンで id は必ず athlete。まだ存在しないときの初回作成専用で、'
      + '既に athlete が存在する場合は拒否される（以後の更新・追記は update_page(id: "athlete") を使うこと）。'
      + ' body に基準値を書くときは、briefing がそのまま拾えるよう '
      + '`| goal_race | 値 | \\`provenance\\` | |` 形式の表行にする（goal_race / hr_max_effective / threshold_pace / vo2max）。',
    inputSchema: { type: 'object', required: ['type','title','body','provenance'], properties: {
      type: { type: 'string', enum: ['constraint','response_tendency','entity','conflict','athlete_profile'] },
      title: { type: 'string' }, body: { type: 'string' },
      provenance: { type: 'string', enum: PROVENANCE },
      front: { type: 'object', description: '型固有の frontmatter（severity, valid_until, confidence, trigger, borne_by 等）' } } } },

  { name: 'record_outcome',
    description: '★予測の答え合わせ。記録して終わりではなく、依存している信念を動かすところまでが1回の操作。downstream を省いて呼ぶと、更新すべき候補が返る。confirmed / refuted / unadjudicable（検証できなかった場合に refuted を使わない。observed に延期・中止など実施されなかったことを示す語があると refuted は拒否される）。',
    inputSchema: { type: 'object', required: ['prediction_id','status','observed'], properties: {
      prediction_id: { type: 'string' },
      status: { type: 'string', enum: ['confirmed','refuted','unadjudicable'] },
      observed: { type: 'string' }, derived_lesson: { type: 'string' },
      downstream: { type: 'array', description: '★この答え合わせが各依存先をどう変えるか。省略すると候補が返る。変わらない場合も「変更なし: 理由」を書くこと',
        items: { type: 'object', required: ['id','effect'], properties: {
          id: { type: 'string' },
          effect: { type: 'string', description: '何が変わるか。変わらないなら「変更なし: 理由」' },
          confidence: { type: 'number', description: '反応モデルの確信度を動かす場合の新しい値' } } } } } } },

  { name: 'retract_claim',
    description: '判断が誤りと判明したときに呼ぶ。削除せず status: retracted にし、なぜ間違えたかを残す。以後 briefing の再提示禁止に載る。',
    inputSchema: { type: 'object', required: ['id','reason','corrected_value'], properties: {
      id: { type: 'string' }, reason: { type: 'string', description: '★なぜ間違えたか' },
      corrected_value: { type: 'string' }, derived_lesson: { type: 'string' },
      downstream: { type: 'array', items: { type: 'string' }, description: '連鎖撤回する id。省略時は候補を提示するだけ' } } } },

  { name: 'update_page',
    description: '既存ページの frontmatter を更新し、任意で本文にセクションを追記する。',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, front: { type: 'object' }, append: { type: 'string' } } } },

  { name: 'graph_downstream',
    description: '★ある判断の誤りがどこまで波及しているかを辿る。汚染は順方向、依存は逆方向。撤回の影響範囲の特定に使う。',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, max_depth: { type: 'number' } } } },

  { name: 'tendency_record',
    description: '★反応モデルの実績。根拠に使った判断とその予測の結果を返す。外れ続けるモデルを見つける。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },

  { name: 'lint_wiki',
    description: '健康診断。未回収の予測・孤立ページ・失効した制約・証拠のない反応モデル・未検証の基準値を検出する。',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'search_wiki',
    description: 'ウィキ全文検索。★撤回済みのページは既定で除外される（撤回された知識を再利用しないため）。撤回の経緯を調べたいときだけ include_retracted を立てる。',
    inputSchema: { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, type: { type: 'string' },
      include_retracted: { type: 'boolean', description: '撤回済みも含める（既定 false）' } } } },

  { name: 'get_page',
    description: 'ページ本文と、入出両方向のリンクを返す。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
];

// --------------------------------------------------------------------------

/**
 * ★MCP resources。接続先の LLM に schema 層とナビゲーションを公開する。
 * これが無いと、リポジトリ外から MCP だけで繋いだ LLM は CLAUDE.md を読めず、
 * 「規律あるウィキ維持者」にする設定が届かない。
 */
export const RESOURCES = [
  { uri: 'coach://schema', name: 'コーチウィキの規約（CLAUDE.md）', mimeType: 'text/markdown',
    description: '★会話の最初に必ず読むこと。三層構造・provenance の規律・予測の反証条件・撤回の扱いが書かれている。これを読まずにコーチングを始めてはいけない。' },
  { uri: 'coach://index', name: 'index — 全ページの目録', mimeType: 'text/markdown',
    description: 'ウィキの全ページ。型別・一行要約つき。関連ページを探すときはまずここを読む。' },
  { uri: 'coach://lint', name: '直近の健康診断', mimeType: 'text/markdown',
    description: '未回収の予測・撤回済みへの依存・孤立ページ・未検証の基準値。' },
];

export async function readResource(store: Store, uri: string): Promise<string> {
  if (uri === 'coach://schema') {
    const md = await store.getSchema();
    if (!md) throw new Error('schema が未登録です（seed で送られていない可能性があります）');
    return md;
  }
  if (uri === 'coach://index') {
    const all = (await store.listAll?.()) ?? [];
    const by: Record<string, typeof all> = {};
    for (const n of all) (by[n.type] ||= []).push(n);
    const one = (n: (typeof all)[number]) => {
      const m = n.body.match(/^#[^\n]*\n+([^\n#>|][^\n]{4,})/m);   // 見出し直後の最初の実文
      return m ? cut(m[1]!.replace(/\[\[|\]\]|\*\*/g, ''), 72) : '';
    };
    const L = [`# index — ${all.length} ページ`, ''];
    for (const [t, ns] of Object.entries(by)) {
      L.push(`## ${t} (${ns.length})`, '');
      for (const n of ns.sort((x, y) => x.id.localeCompare(y.id))) {
        const tags = [];
        if (n.status && n.status !== 'active') tags.push(`\`${n.status}\``);
        if (n.front.confidence != null) tags.push(`conf ${n.front.confidence}`);
        L.push(`- \`${n.id}\` **${n.label}**${tags.length ? ' — ' + tags.join(' · ') : ''}`
          + (one(n) ? `\n  ${one(n)}` : ''));
      }
      L.push('');
    }
    return L.join('\n');
  }
  if (uri === 'coach://lint') {
    const n = (await store.listAll?.() ?? []).find((x) => x.id === 'lint');
    return n?.body ?? '（まだ lint を実行していません。lint_wiki を呼んでください）';
  }
  throw new Error(`unknown resource: ${uri}`);
}

/** 記憶を書き換えるツール。briefing を読んでいないと拒否する。 */
// ★remember は含めない。捕捉を止めてはいけない。
//   briefing 未読でも「分かったこと」は必ず残せるようにする。
const WRITE_TOOLS = new Set([
  'record_decision', 'record_outcome', 'retract_claim',
  'file_analysis', 'record_memory', 'update_page',
]);
const BRIEFING_TTL_MIN = 30;

export async function dispatch(store: Store, name: string, a: Args = {}): Promise<string> {
  const now = await store.today();
  const H: Record<string, () => Promise<string>> = {

  async get_coach_briefing() {
    const [cons, rts, all, preds, ath, qs] = await Promise.all([
      store.listByType('constraint'), store.listByType('response_tendency'),
      store.listAll?.() ?? [], store.listPredictions(),
      store.listByType('athlete_profile'), store.listByType('question_queue')]);
    const out = [
      `[BRIEFING ${now}]`,
      '⛔ 以下の記録ID（c_01 / rt_06 など）は道具です。選手への返答に書かないこと。',
    ];

    // ── ★初回体験。athlete_profile が1件も無ければ、まだ誰の記憶も無い。
    //    「専属コーチとして振る舞え」だけを渡して選手のプロフィールを聞き出す
    //    導線が無いと、新規ユーザーは一般的なコーチと区別がつかない状態から始まる。
    if (!ath.length) {
      out.push(
        '⚠ 初回セッション（athlete_profile 未登録・選手カルテが空）。',
        '一般論のコーチングを始める前に、まず次を聞き出すこと:',
        '  1. 目標レースと目標タイム（種目・日程・目標記録）',
        '  2. 現在の週あたり練習可能頻度と曜日・時間帯',
        '  3. 絶対禁則になりうる制約（既往症・持病、生活上動かせない予定）',
        '  4. 故障歴（過去の怪我・現在の違和感）',
        '聞き出せた内容は、その場で record_memory（type: "athlete_profile"）で選手カルテとして',
        '記録すること。athlete_profile はシングルトンで初回作成専用（id は自動的に athlete）。',
        '一度に全部揃える必要はない。訊けた分から記録し、残りは次回以降のセッションで埋める。',
      );
    }

    // ── 短期記憶。前回までに何があったかを、訊かれる前から把握しておく ──
    const recent = await store.recentLog(6);
    if (recent.length) {
      out.push(`直近のやり取り（新しい順・最後は ${recent[0]!.ts}）:`);
      for (const r of recent) out.push(`  [${r.ts}] ${r.kind} | ${cut(r.title, 60)}`);
    }

    // ── 季節の文脈。直近のデータだけで判断しないための足場 ──
    const goal = (ath[0]?.body ?? '').match(/goal_race[^|]*\|([^|]*)\|/)?.[1] ?? '';
    const raceDate = goal.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (raceDate) {
      const d = Math.round((Date.parse(raceDate) - Date.parse(now)) / 86400000);
      out.push(`目標: ${cut(goal.trim(), 52)}`);
      out.push(`  レースまで ${d}日（${Math.floor(d / 7)}週+${d % 7}日）`);
    }
    const planPage = (await store.listByType('plan'))[0];
    if (planPage) {
      for (const m of planPage.body.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d{1,2}\/\d{1,2})[^\d]+(\d{1,2}\/\d{1,2})\s*\|/gm)) {
        const y = now.slice(0, 4);
        const iso = (md: string) => `${y}-${md.split('/').map((v) => v.padStart(2, '0')).join('-')}`;
        if (iso(m[2]!) <= now && now <= iso(m[3]!)) {
          out.push(`  現在のフェーズ: ${m[1]!.trim()}（${m[2]}〜${m[3]}）`);
          break;
        }
      }
    }

    // ── 予測の実績。信念がどれだけ当たってきたか ──
    const allPreds = await store.listPredictions();
    const judged = allPreds.filter((x) => ['confirmed', 'refuted'].includes(x.status));
    if (judged.length) {
      const h = judged.filter((x) => x.status === 'confirmed').length;
      out.push(`  これまでの予測: ${h}/${judged.length} 的中`);
    }

    // ── 未整理のメモ ──
    const notes = (await store.listByType('note')).filter((n) => !n.front.filed);
    if (notes.length) {
      out.push(`未整理のメモ ${notes.length}件（週次レビューで正式な記録に整理する）:`);
      for (const n of notes.slice(0, 5)) out.push(`  ・${cut(n.label, 56)}`);
      if (notes.length > 5) out.push(`  ・ほか ${notes.length - 5}件`);
    }


    const active = cons.filter((c) => c.status !== 'retracted'
      && (!c.front?.valid_until || c.front.valid_until >= now))
      .sort((x, y) => (x.front?.severity === 'absolute' ? -1 : 1));
    out.push('禁則:');
    for (const c of active) out.push(`  [${c.front?.severity === 'absolute' ? '!' : '-'}] ${c.id} ${cut(c.label, 44)}`
      + (c.front?.valid_until ? `（〜${c.front.valid_until}）` : ''));

    const base = (ath[0]?.body ?? '').matchAll(
      /^\|\s*(hr_max_effective|threshold_pace|goal_race|vo2max)\s*\|\s*([^|]+)\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/gm);
    const rows = [...base];
    if (rows.length) {
      out.push('基準:');
      for (const [, k, v, src, warn] of rows)
        out.push(`  ${k} = ${v.trim()}${src === 'coach_inference' ? '（推論値）' : ''}${warn.trim() ? ' ' + warn.trim() : ''}`);
    }

    out.push('反応モデル:');
    for (const r of rts.filter((r) => r.status !== 'retracted')
      .sort((x, y) => (y.front?.confidence ?? 0) - (x.front?.confidence ?? 0)).slice(0, 5))
      out.push(`  ${r.id} ${cut(r.label, 46)} (${r.front?.confidence ?? '?'})`);

    const retr = (all.length ? all : [...cons, ...rts, ...await store.listByType('decision')])
      .filter((p) => p.status === 'retracted');
    if (retr.length) {
      out.push('⚠再提示禁止（撤回済み）:');
      for (const r of retr) out.push(`  ${r.id} ${cut(r.label, 40)}`
        + (r.front?.corrected ? ` → 正: ${cut(r.front.corrected, 28)}` : ''));
    }

    const pending = preds.filter((p) => p.status === 'pending');
    const due = pending.filter((p) => p.review_on <= now);
    const soon = pending.filter((p) => p.review_on > now && p.review_on <= plus(now, 7));
    if (due.length) {
      out.push('要回収（期限到来）:');
      for (const p of due) out.push(`  ${p.id} ${cut(p.claim, 46)} / 判定: ${cut(p.criterion, 44)}`);
    }
    if (soon.length) out.push(`予定: ${soon.map((p) => `${p.id}(${p.review_on})`).join(' ')}`);

    for (const c of cons) {
      const vu = c.front?.valid_until;
      if (vu && vu >= now && vu <= plus(now, 14)) {
        out.push(`⏳ ${c.id} が ${vu} に失効: ${cut(c.label, 40)}`);
        if (c.front.on_expiry) out.push(`   → ${c.front.on_expiry}`);
        for (const d of await store.listByType('decision'))
          for (const m of (d.body ?? '').matchAll(/- \*\*(.+?)\*\*\n\s+- 理由: (.+?)\n\s+- 再検討: `(.+?)`/g))
            if (m[3] === vu) out.push(`   保留案 (${d.id}): ${cut(m[1], 50)}`);
      }
    }

    const q = qs[0];
    if (q) {
      const open = [...(q.body ?? '').matchAll(/### `(q_\d+)` (.+?)\n- なぜ: (.+?)\n- 訊く時期: `(.+?)`/g)]
        .filter(([, , , , when]) => when === 'immediately' || (a.context && a.context.includes(when)));
      if (open.length) {
        out.push('訊くべき:');
        for (const [, id, qq, why] of open.slice(0, 3)) out.push(`  ${id} ${cut(qq, 44)}（${cut(why, 38)}）`);
      }
    }
    await store.markBriefing();   // ★読んだ時刻を記録。書き込み系ツールがこれを見る
    return out.join('\n') + '\n\n---\n' + PROTOCOL;
  },

  async record_decision() {
    const args = a as RecordDecisionArgs;
    const p = args.prediction ?? ({} as RecordDecisionArgs['prediction']);
    if (!p.claim || !p.adjudication_criterion || !p.review_on)
      throw new Error('拒否: prediction.claim / adjudication_criterion / review_on は必須です。反証条件を書けない提案は記録できません。');
    if (!isDate(p.review_on)) throw new Error('拒否: review_on は YYYY-MM-DD 形式で指定してください。');

    const abs = (await store.listByType('constraint')).filter((c) =>
      c.front?.severity === 'absolute' && c.status !== 'retracted'
      && (!c.front.valid_until || c.front.valid_until >= now));
    const seen = new Set(args.constraints_reviewed ?? []);
    const missed = abs.filter((c) => !seen.has(c.id));
    if (missed.length) throw new Error('拒否: 未確認の absolute 禁則があります。内容を確認し id を constraints_reviewed に含めて再送してください。\n'
      + missed.map((c) => `  ${c.id}: ${c.label}`).join('\n'));
    // ★id の列挙だけでは通さない。どう抵触しないかを言わせる。
    // （意味的な照合ではない。違反の有無ではなく、violation が記録に残ることを担保する）
    if (abs.length && (args.constraint_compliance ?? '').trim().length < 20)
      throw new Error('拒否: constraint_compliance が必要です。id を並べるだけでは不十分で、'
        + `この判断が次の禁則にどう抵触しないかを具体的に述べてください。\n`
        + abs.map((c) => `  ${c.id}: ${c.label}`).join('\n'));

    const did = await store.nextId('d'), pid = await store.nextId('p');
    await store.put({
      id: did, type: 'decision', label: args.question, status: 'active',
      front: { id: did, type: 'decision', aliases: [did], date: now, status: 'active',
        applies: args.applies ?? [], constraints_reviewed: [...seen],
      constraint_compliance: args.constraint_compliance ?? null, context: args.context ?? null,
        prediction: { id: pid, claim: p.claim, adjudication_criterion: p.adjudication_criterion,
          review_on: p.review_on, status: 'pending', observed: null }, source: 'session' },
      body: `# ${args.question}\n\n## 判断\n${args.choice}\n\n## 根拠\n${args.rationale}\n`
        + (args.rejected_options?.length ? `\n## 却下した案\n${args.rejected_options.map((o) =>
            `- **${o.option}**\n  - 理由: ${o.reason}\n  - 再検討: \`${o.deferred_until ?? '—'}\``).join('\n')}\n` : '')
        + `\n## 予測 \`${pid}\`\n- 主張: ${p.claim}\n- **反証条件**: ${p.adjudication_criterion}\n- 検証日: \`${p.review_on}\` · 状態 \`pending\`\n`
        + (a.applies?.length ? `\n## 根拠にした反応モデル\n${L(a.applies)}\n` : '')
        + (seen.size ? `\n## 確認した禁則\n${L([...seen])}\n`
            + (args.constraint_compliance ? `\n${args.constraint_compliance}\n` : '') : '')
        + (args.links?.length ? `\n## 関連\n${L(args.links)}\n` : ''),
    });
    await store.putPrediction({ id: pid, owner: did, claim: p.claim,
      criterion: p.adjudication_criterion, review_on: p.review_on, status: 'pending' });
    await store.log('decision', `${did} ${args.question}`, `- ${cut(args.choice, 120)}\n- 予測 \`${pid}\` → ${p.review_on}`);
    // ★id を返さない（record_decision/record_memory/retract_claim/update_page 共通の方針）。
    //   ツール呼び出しパネルでID付きの戻り値がそのまま選手に見える経路があるため、
    //   人間可読な情報（質問文・回収予定日）だけを返す。
    return `記録しました: 「${args.question}」（${p.review_on} に回収）`;
  },

  async file_analysis() {
    const id = await store.nextId('an');
    await store.put({
      id, type: 'analysis', label: a.title, status: 'active',
      front: { id, type: 'analysis', aliases: [a.title, id], question: a.question, answer: a.answer,
        confidence: a.confidence ?? null, provenance: { source: a.provenance },
        supersedes: a.supersedes ?? [], resolved_on: now, source: 'session' },
      body: `# ${a.title}\n\n> **${a.answer}**\n\n${a.body}`,
    }, { name: a.title });
    await store.log('analysis', `${id} ${a.title}`, `- ${a.question}\n- → ${a.answer}`);
    return `分析を残しました: ${id}「${a.title}」\n以後 [[${a.title}]] で参照できます。`;
  },

  async remember() {
    const id = await store.nextId('n');
    const kind = a.kind ?? 'observation';
    await store.put({
      id, type: 'note', label: cut(a.what, 60), status: 'active',
      front: { id, type: 'note', kind, filed: false, date: now,
        provenance: { source: 'athlete_report' }, source: 'session' },
      body: `# ${a.what}\n\n分類: ${kind}\n記録: ${now}\n`
        + (a.why ? `\n## なぜ残すか\n${a.why}\n` : ''),
    }, { name: `${id}-${W_SLUG(a.what)}` });
    await store.log('note', cut(a.what, 60), a.why ?? null);
    return `覚えました。`;   // ★id を返さない。返すとそのまま選手に伝えられてしまう
  },

  async log_session() {
    const transcript = String(a.transcript ?? '').trim();
    if (!transcript) throw new Error('拒否: transcript が空です。');
    await store.putRaw({ date: now, transcript });
    // ★log() には書かない。recentLog（briefingの「直近のやり取り」）を生ダンプで埋めないため。
    return `セッションの記録を残しました。`;
  },

  async get_history() {
    const decs = await store.listByType('decision');
    const preds = await store.listPredictions();
    const q = String(a.topic).toLowerCase();
    const hit = decs.filter((d) =>
      (d.label + d.body).toLowerCase().includes(q))
      .sort((x, y) => String(x.front.date ?? '').localeCompare(String(y.front.date ?? '')));
    if (!hit.length) return `「${a.topic}」に関する過去の判断はまだありません。`;

    const L = [`「${a.topic}」の経緯（古い順に ${hit.length} 件）`, ''];
    for (const d of hit) {
      const p = preds.find((x) => x.owner === d.id);
      const mark = d.status === 'retracted' ? '⛔ 撤回済み — ' : '';
      L.push(`${d.front.date ?? '日付不明'}  ${mark}${d.label}`);
      const choice = (d.body.match(/## 判断\n([\s\S]*?)(?:\n##|$)/) ?? [, ''])[1]
        .replace(/~~/g, '').replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' / ').trim();
      if (choice) L.push(`  決めたこと: ${cut(choice, 100)}`);
      if (p) {
        L.push(`  予測: ${cut(p.claim, 80)}`);
        L.push(`  結果: ${p.status === 'pending' ? `未回収（${p.review_on} 期限）`
          : `${p.status}${p.observed ? ' — ' + cut(p.observed, 70) : ''}`}`);
      }
      const lesson = (d.body.match(/## 教訓\n([\s\S]*?)(?:\n##|$)/) ?? [, ''])[1].trim();
      if (lesson) L.push(`  教訓: ${cut(lesson, 100)}`);
      L.push('');
    }
    const done = hit.map((d) => preds.find((x) => x.owner === d.id))
      .filter((p) => p && ['confirmed','refuted'].includes(p.status));
    if (done.length) {
      const hitn = done.filter((p) => p!.status === 'confirmed').length;
      L.push(`このテーマでの的中: ${hitn}/${done.length}`);
    }
    return L.join('\n');
  },

  async record_memory() {
    // ★athlete_profile はシングルトン（id は必ず 'athlete'）。他の型のような
    //   nextId 連番採番ではなく固定idを使い、初回作成専用として既存ページを保護する。
    const singleton = a.type === 'athlete_profile';
    if (singleton && await store.get('athlete'))
      throw new Error('拒否: athlete は既に存在します。選手カルテの更新・追記は '
        + 'update_page（id: "athlete"）を使ってください。record_memory は初回作成専用です。');
    const id = singleton ? 'athlete' : await store.nextId(P[a.type]);
    await store.put({
      id, type: a.type, label: a.title, status: 'active',
      front: { id, type: a.type, aliases: [id, a.title], provenance: { source: a.provenance },
        status: 'active', source: 'session', ...(a.front ?? {}) },
      body: `# ${a.title}\n\n${a.body}`,
    }, { name: singleton ? 'athlete' : (a.type === 'entity' ? a.title : undefined) });
    await store.log(a.type, `${id} ${a.title}`, null);
    // ★id を返さない。[[タイトル]] 形式（file_analysis と同じパターン）で参照できるようにする。
    return `${a.type} を記録しました: 「${a.title}」\n以後 [[${a.title}]] で参照できます。`;
  },

  async record_outcome() {
    const args = a as RecordOutcomeArgs;
    const preds = await store.listPredictions();
    const p = preds.find((x) => x.id === args.prediction_id);
    if (!p) throw new Error(`${args.prediction_id} が見つかりません。`);

    // ★refuted と unadjudicable の取り違えガード（TASKS.md P2）。
    //   「そもそも実施・検証されなかった」ケースを refuted で記録すると、
    //   briefing の的中率（信頼の根拠）が静かに汚染される。曖昧な入力はまず拒否する。
    if (args.status === 'refuted' && looksUnadjudicable(String(args.observed ?? '')))
      throw new Error(
        `拒否: 'observed'（${cut(args.observed, 60)}）の内容は、練習・検証がそもそも実施`
        + `されなかったことを示しています。この場合は refuted ではなく unadjudicable を使って`
        + `ください。\n実際に実施した上で予測が外れたことが明確な場合のみ、その経過が分かる`
        + `observed を書いて refuted としてください。`);

    // ── この答え合わせが動かすべき依存先を、サーバー側で算出する ──
    //    「どれを更新すべきか知らなかった」を成立させないため。
    const owner = p.owner ? await store.get(p.owner) : null;
    const all = (await store.listAll?.()) ?? [];
    const cand = new Map<string, string>();
    for (const t of (owner?.front as DecisionFront | undefined)?.applies ?? [])
      cand.set(t, 'この判断が根拠にした反応モデル');
    if (owner) for (const n of all) {
      if (n.status === 'retracted') continue;
      if (((n.front.evidence_refs as string[] | undefined) ?? []).includes(owner.id))
        cand.set(n.id, `${owner.id} を根拠にしている`);
    }

    if (cand.size && !args.downstream) throw new Error(
      `拒否: この答え合わせが動かす依存先を downstream で述べてください。\n`
      + `記録するだけでは信念が更新されず、記憶が増えるだけになります。\n`
      + `変わらない場合も「変更なし: 理由」と明示してください。\n\n候補:\n`
      + [...cand].map(([id, why]) => {
          const n = all.find((x) => x.id === id);
          return `  ${id}  ${cut(n?.label, 44)}\n    （${why}${n?.front.confidence != null ? ` / 現在の確信度 ${n.front.confidence}` : ''}）`;
        }).join('\n'));

    const given = new Set((args.downstream ?? []).map((d) => d.id));
    const missed = [...cand.keys()].filter((id) => !given.has(id));
    if (missed.length) throw new Error(
      `拒否: 依存先のうち ${missed.join(', ')} に触れていません。`
      + `変わらないなら「変更なし: 理由」を書いてください。`);

    // ── 予測の判定 ──
    await store.putPrediction({ ...p, status: args.status, observed: args.observed,
      adjudicated_on: now, derived_lesson: args.derived_lesson ?? null });
    // ★putPrediction が owner の frontmatter を書き換えているので取り直す。
    //   候補算出のために取った owner をそのまま使うと、判定を古い値で上書きしてしまう。
    const fresh = p.owner ? await store.get(p.owner) : null;
    if (fresh) await store.put({ ...fresh, body: fresh.body
      + `\n## 答え合わせ \`${args.prediction_id}\` — ${args.status}（${now}）\n${args.observed}\n`
      + (args.derived_lesson ? `\n**教訓**: ${args.derived_lesson}\n` : '') });

    // ── ★依存先を実際に更新する ──
    const applied: string[] = [];
    for (const d of args.downstream ?? []) {
      const target = await store.get(d.id);
      if (!target) { applied.push(`⚠ ${d.id} が見つからない`); continue; }
      const before = target.front.confidence;
      await store.put({ ...target,
        front: { ...target.front, updated: now,
          ...(d.confidence != null ? { confidence: d.confidence } : {}) },
        body: target.body
          + `\n## ${args.prediction_id} の答え合わせを受けて（${now}）\n`
          + `予測は **${args.status}**。${d.effect}\n`
          + (d.confidence != null ? `\n確信度 ${before ?? '—'} → **${d.confidence}**\n` : '') });
      applied.push(d.confidence != null
        ? `${d.id}（確信度 ${before ?? '—'} → ${d.confidence}）`
        : `${d.id}`);
    }

    await store.log('outcome', `${args.prediction_id} → ${args.status}`,
      `- ${args.observed}\n- 更新: ${applied.join(' / ') || 'なし'}`);

    const done = (await store.listPredictions()).filter((x) => ['confirmed','refuted'].includes(x.status));
    const hit = done.filter((x) => x.status === 'confirmed').length;
    return `${args.prediction_id} → ${args.status}\n`
      + `更新した依存先: ${applied.join(' / ') || 'なし'}\n`
      + `通算的中率: ${done.length ? Math.round(100*hit/done.length) : 0}% (${hit}/${done.length})`;
  },

  async retract_claim() {
    const args = a as RetractClaimArgs;
    const n = await store.get(args.id);
    if (!n) throw new Error(`${a.id} が見つかりません。`);
    const cands = await store.downstream(a.id, 5);
    const chain = a.downstream ?? [];
    await store.put({ ...n, status: 'retracted',
      front: { ...n.front, status: 'retracted', corrected: a.corrected_value,
        refutation: { date: now, reason: a.reason },
        ...(chain.length ? { downstream_contamination: chain } : {}) },
      body: `# ${n.label}\n\n> ⛔ **撤回済み。この判断を根拠に使わない。**\n\n`
        + `訂正後: **${a.corrected_value}**\n\n## なぜ間違えたか\n${a.reason}\n`
        + (a.derived_lesson ? `\n## 教訓\n${a.derived_lesson}\n` : '')
        + (chain.length ? `\n## この誤りから派生した記録\n${L(chain)}\n` : '')
        + `\n---\n\n${n.body.replace(/^\s*#[^\n]*\n+/, '')}` });
    let done = 0;
    for (const id of chain) {
      const d = await store.get(id);
      if (d && d.status !== 'retracted') {
        await store.put({ ...d, status: 'retracted',
          front: { ...d.front, status: 'retracted', refutation: { date: now, reason: `${a.id} の誤りから派生` } },
          body: `# ${d.label}\n\n> ⛔ **撤回済み（[[${a.id}]] の誤りから派生）**\n\n${d.body.replace(/^\s*#[^\n]*\n+/, '')}` });
        done++;
      }
    }
    await store.log('retract', `${a.id} → ${a.corrected_value}`, `- 原因: ${a.reason}\n- 連鎖撤回: ${done}件`);
    const rest = cands.filter((c) => !chain.includes(c.id) && c.status !== 'retracted');
    // ★id を返さない。撤回対象・波及候補ともにラベル（人間可読な見出し）で示す。
    return `「${n.label}」を撤回しました（ページは保持）。連鎖撤回 ${done}件。\n`
      + (rest.length ? `⚠ 波及の可能性がまだあります: ${rest.map((r) => `「${r.label}」(${r.via})`).join(' ')}\n`
        + `  内容を確認し、必要なら downstream に含めて再実行してください。` : '他に波及先はありません。');
  },

  async update_page() {
    const n = await store.get(a.id);
    if (!n) throw new Error(`${a.id} が見つかりません。`);
    await store.put({ ...n, front: { ...n.front, ...(a.front ?? {}), updated: now },
      status: a.front?.status ?? n.status, body: a.append ? `${n.body}\n${a.append}\n` : n.body });
    // ★id を返さない。対象ページのラベルで示す。
    return `「${n.label}」を更新しました: ${Object.keys(a.front ?? {}).join(', ') || '本文'}`;
  },

  async graph_downstream() {
    const r = await store.downstream(a.id, a.max_depth ?? 5);
    return r.length
      ? `${a.id} の波及先 ${r.length}件\n` + r.map((x) =>
          `  depth${x.depth} [${x.via}] \`${x.id}\` ${cut(x.label, 42)} (${x.status})\n    経路: ${x.path}`).join('\n')
      : `${a.id} に波及先はありません`;
  },

  async tendency_record() {
    const decs = (await store.listByType('decision'))
      .filter((d) => (d.front?.applies ?? []).includes(a.id));
    if (!decs.length) return `${a.id} を根拠に使った判断はまだありません`;
    const preds = await store.listPredictions();
    const rows = decs.map((d) => ({ d, p: preds.find((x) => x.owner === d.id) }));
    // 予測を持たない判断があるので、判定済みだけを型で絞る
    const done = rows.filter((r): r is { d: typeof r.d; p: Prediction } =>
      r.p !== undefined && (r.p.status === 'confirmed' || r.p.status === 'refuted'));
    const hit = done.filter((r) => r.p.status === 'confirmed').length;
    return `${a.id} を根拠にした判断 ${rows.length}件\n`
      + rows.map((r) => `  \`${r.d.id}\` ${cut(r.d.label, 40)} → ${r.p?.id ?? '予測なし'} ${r.p?.status ?? ''}`).join('\n')
      + `\n実績: ${done.length ? `${Math.round(100*hit/done.length)}% (${hit}/${done.length})` : '判定済み0件'}`;
  },

  async lint_wiki() {
    const all = (await store.listAll?.()) ?? [];
    const preds = await store.listPredictions();
    const orph = await store.orphans();
    const F: string[] = [];

    // 未回収の予測
    for (const p of preds)
      if (p.status === 'pending' && p.review_on < now)
        F.push(`⏰ 未回収の予測 \`${p.id}\`（期限 ${p.review_on}）— ${cut(p.claim, 50)}`);

    const byId = new Map(all.map((n) => [n.id, n]));
    const retracted = all.filter((n) => n.status === 'retracted');

    // ★撤回済みを「根拠として」使ったまま生きている記録。
    //   mentions は除く — 撤回済みを例や経緯として引くのは正しい振る舞いなので。
    const STRUCTURAL = ['applies', 'reviewed', 'evidenced_by', 'supersedes', 'contaminated'];
    for (const r of retracted) {
      const node = await store.get(r.id);
      for (const e of node?.in ?? []) {
        if (!STRUCTURAL.includes(e.rel)) continue;
        const dep = byId.get(e.src);
        if (dep && dep.status !== 'retracted')
          F.push(`☠ \`${dep.id}\` が撤回済みの \`${r.id}\` を ${e.rel} で根拠にしたまま — 見直すか撤回する`);
      }
    }

    // ★撤回済みの結論を、撤回に触れずに断定しているページ。
    //   「撤回された」と書いてあるページは正しく扱えているので除外する。
    for (const r of retracted) {
      for (const n of all) {
        if (n.status === 'retracted' || n.id === r.id) continue;
        if (!n.body.includes(r.id)) continue;
        const assertive = /確定|唯一|裏付け|証明|判明した/.test(n.body);
        const awareOfRetraction = /撤回|無効|測定不能|誤り/.test(n.body);
        if (assertive && !awareOfRetraction)
          F.push(`⚠ \`${n.id}\` が撤回済み \`${r.id}\` の結論を、撤回に触れずに断定している — 本文を確認する`);
      }
    }

    // ★リンク切れ
    const known = new Set<string>();
    for (const n of all) {
      known.add(n.id);
      known.add(n.label);
      for (const al of (n.front.aliases as string[] | undefined) ?? []) known.add(al);
    }
    const broken = new Set<string>();
    for (const n of all)
      for (const m of n.body.matchAll(/\[\[([^\]|]+)/g)) {
        const t = m[1]!.trim().split('/').pop()!;
        if (!known.has(t) && !known.has(m[1]!.trim())) broken.add(`${n.id} → [[${t}]]`);
      }
    for (const b of [...broken].slice(0, 10)) F.push(`🔗 リンク切れ ${b}`);

    // ★provenance 欠落（schema が必須と定めているのに）
    const noProv = all.filter((n) =>
      !['lint', 'question_queue'].includes(n.type) && !n.front.provenance);
    if (noProv.length)
      F.push(`🏷 provenance の無いページ ${noProv.length}/${all.length}件 — `
        + noProv.slice(0, 8).map((n) => `\`${n.id}\``).join(' ')
        + (noProv.length > 8 ? ' …' : ''));

    // 失効した制約
    for (const c of await store.listByType('constraint'))
      if (c.front.valid_until && c.front.valid_until < now && c.status === 'active')
        F.push(`📅 失効済みの制約 \`${c.id}\`（${c.front.valid_until}）— status を更新するか保留案を再検討する`);

    // 反応モデルの健康度
    for (const r of await store.listByType('response_tendency')) {
      if (/## 証拠\n- （なし）/.test(r.body ?? ''))
        F.push(`🧪 証拠の無い反応モデル \`${r.id}\` — 昇格させるか削除するか判断が要る`);
      if (r.front.needs_operationalization || r.front.trigger?.draft)
        F.push(`⚙ 発火条件が未述語化 \`${r.id}\` — 現在の状態から自動判定できない`);
      if (!(r.front.evidence_refs as string[] | undefined)?.length)
        F.push(`🔍 \`${r.id}\` に evidence_refs が無い — 根拠が撤回されても波及を検出できない`);
    }

    // ★確信度が実績と乖離している反応モデル
    //   （信念が更新されていないことの直接の証拠）
    const decs = await store.listByType('decision');
    for (const r of await store.listByType('response_tendency')) {
      const used = decs.filter((d) => (d.front.applies ?? []).includes(r.id));
      if (!used.length) {
        if (r.status !== 'retracted')
          F.push(`💤 \`${r.id}\` は一度も判断の根拠に使われていない — 使われない信念は複利しない`);
        continue;
      }
      const rows = used.map((d) => preds.find((x) => x.owner === d.id))
        .filter((x): x is NonNullable<typeof x> => !!x && ['confirmed','refuted'].includes(x.status));
      if (rows.length < 2) continue;
      const hit = rows.filter((x) => x.status === 'confirmed').length;
      const rate = hit / rows.length;
      const conf = r.front.confidence;
      if (conf != null && Math.abs(conf - rate) > 0.3)
        F.push(`📉 \`${r.id}\` の確信度 ${conf} に対し実績 ${Math.round(rate*100)}%（${hit}/${rows.length}）— `
          + `信念が実績で更新されていない`);
    }

    // 未検証の基準値
    const ath = await store.listByType('athlete_profile');
    for (const m of (ath[0]?.body ?? '').matchAll(
      /^\|\s*(\w+)\s*\|[^|]+\|\s*`(coach_inference|proxy_derived|unknown)`\s*\|\s*⚠?要?確認?/gm))
      F.push(`❓ 未検証の基準値 \`${m[1]}\`（${m[2]}）— 確定事実として使わない`);

    const unfiled = (await store.listByType('note')).filter((n) => !n.front.filed);
    if (unfiled.length >= 3)
      F.push(`🗂 未整理のメモが ${unfiled.length}件 — 正式な型（禁則・反応モデル・エンティティ）に昇格させるか、`
        + `不要なら filed: true にして畳む`);

    for (const o of orph) F.push(`🕳 孤立ページ \`${o.id}\` [${o.type}] ${cut(o.label, 40)}`);

    const report = `# lint — ${now}\n\n` + (F.length ? F.map((f) => `- ${f}`).join('\n') : '- 指摘なし');

    // ★結果をページとして残す（原文: lint も進化の一部）
    await store.put({
      id: 'lint', type: 'lint', label: `lint — ${now}`, status: 'active',
      front: { id: 'lint', type: 'lint', updated: now, findings: F.length,
        provenance: { source: 'coach_inference' } },
      body: report,
    }, { name: 'lint' });
    await store.log('lint', `${F.length}件の指摘`, F.slice(0, 5).map((f) => `- ${f}`).join('\n'));

    return report;
  },

  async search_wiki() {
    const r = await store.search(a.query, 10, a.type, a.include_retracted === true);
    if (!r.length) return a.include_retracted ? '該当なし' : '該当なし（撤回済みは除外している。include_retracted で含められる）';
    return r.map((x) => {
      const flag = x.status === 'retracted' ? ' ⛔撤回済み — 根拠に使わない' : '';
      return `[${x.type}] \`${x.id}\` ${x.label}${flag}\n  …${x.ctx}…`;
    }).join('\n\n');
  },

  async get_page() {
    const n = await store.get(a.id);
    if (!n) throw new Error(`${a.id} が見つかりません。`);
    return `# ${n.label} (\`${n.id}\`, ${n.type}, ${n.status})\n`
      + `provenance: ${n.front?.provenance?.source ?? '—'}\n`
      + `→ ${n.out.map((e) => `${e.rel}:${e.dst}`).join(' ') || 'なし'}\n`
      + `← ${n.in.map((e) => `${e.rel}:${e.src}`).join(' ') || 'なし'}\n\n${n.body}`;
  },
  };

  const h = H[name];
  if (!h) throw new Error(`unknown tool: ${name}`);

  // ★記憶を書き換えるツールは、briefing を読んでいないと拒否する。
  //   禁則・撤回済みの主張・回収すべき予測を知らないまま判断を残させないため。
  //   読み取り（search_wiki / get_page / graph_downstream 等）は自由に通す。
  if (WRITE_TOOLS.has(name)) {
    const at = await store.lastBriefingAt();
    const ageMin = at ? (Date.now() - Date.parse(at)) / 60000 : Infinity;
    if (!(ageMin <= BRIEFING_TTL_MIN)) throw new Error(
      `拒否: get_coach_briefing をまだ読んでいません`
      + (at ? `（最後に読んだのは ${Math.round(ageMin)} 分前。${BRIEFING_TTL_MIN}分で切れます）` : '')
      + `。\n禁則・撤回済みの主張・回収すべき予測を知らないまま記録を残さないでください。\n`
      + `先に get_coach_briefing を呼んでから、このツールを再実行してください。`);
  }
  return await h();
}
