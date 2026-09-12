// ウィキの型定義。ローカル版（markdown）と本番版（Durable Object）が
// 同じ契約を満たすことを、テストではなく型で保証するための中心。

export type MaybePromise<T> = T | Promise<T>;

export type NodeType =
  | 'constraint' | 'response_tendency' | 'decision' | 'analysis' | 'conflict'
  | 'note'   // 気づいたその場で落とすメモ。検証なしで書ける。あとで昇格させる
  | 'entity' | 'athlete_profile' | 'question_queue' | 'lint' | 'plan';

export type Status = 'active' | 'retracted' | 'superseded' | 'dormant';
export type Severity = 'absolute' | 'strong' | 'soft';
export type Modality = 'MUST' | 'MUST_NOT' | 'SHOULD' | 'SHOULD_NOT';

/** 出所。順位は 実測 > 本人の申告 > 本人の経験則 > 代理換算 > コーチの推論 */
export type ProvenanceSource =
  | 'primary_measured' | 'external_primary' | 'athlete_report'
  | 'athlete_estimate' | 'proxy_derived' | 'coach_inference' | 'unknown';

export interface Provenance {
  source: ProvenanceSource;
  /** エージェント経由で渡された値。直接観測していない。 */
  via?: 'agent';
  asserted_by?: string;
  quoted_from?: string;
}

export type PredictionStatus = 'pending' | 'confirmed' | 'refuted' | 'unadjudicable';

/** frontmatter に埋め込まれる形 */
export interface EmbeddedPrediction {
  id: string;
  claim: string;
  adjudication_criterion: string;
  review_on: string;
  status: PredictionStatus;
  observed?: string | null;
  adjudicated_on?: string;
  derived_lesson?: string | null;
}

/** store が扱う正規化された形（criterion に名前が短縮される） */
export interface Prediction {
  id: string;
  owner?: string | null;
  claim: string;
  criterion: string;
  review_on: string;
  status: PredictionStatus;
  observed?: string | null;
  adjudicated_on?: string | null;
  derived_lesson?: string | null;
}

export interface Trigger { predicate?: string; draft?: string }
export interface Refutation { date: string; reason: string }

interface BaseFront {
  id: string;
  type: NodeType;
  status?: Status;
  aliases?: string[];
  provenance?: Provenance;
  source?: string;
  updated?: string;
  /** YAML 由来なので型ごとの追加キーを許す。既知キーは下の union で型が付く。 */
  [key: string]: unknown;
}

export interface ConstraintFront extends BaseFront {
  type: 'constraint';
  severity?: Severity;
  modality?: Modality;
  valid_until?: string | null;
  on_expiry?: string | null;
  justified_by?: string | string[];
  /** 根拠になっている記録の id */
  evidence_refs?: string[];
}
export interface TendencyFront extends BaseFront {
  type: 'response_tendency';
  /** 根拠になっている記録の id。撤回されたら confidence を見直す */
  evidence_refs?: string[];
  borne_by?: string;
  confidence?: number | null;
  trigger?: Trigger;
  scope?: Record<string, unknown>;
  needs_operationalization?: boolean;
  implication?: string;
}
export interface DecisionFront extends BaseFront {
  type: 'decision';
  date?: string;
  applies?: string[];
  constraints_reviewed?: string[];
  prediction?: EmbeddedPrediction | null;
  predictions?: EmbeddedPrediction[];
  refutation?: Refutation;
  corrected?: string;
  downstream_contamination?: string[];
  context?: Record<string, unknown> | null;
}
export interface AnalysisFront extends BaseFront {
  type: 'analysis';
  question?: string;
  answer?: string;
  confidence?: number | null;
  supersedes?: string[];
  resolved_on?: string;
}
/** 選手とコーチの主張が衝突した記録。撤回されうるので一級のノードにする。 */
export interface ConflictFront extends BaseFront {
  type: 'conflict';
  proposition?: string;
  verdict?: 'athlete_correct' | 'coach_correct' | 'both_partial' | 'open';
  resolved_on?: string;
  /** この衝突の解決を根拠にした記録（撤回時の波及先） */
  supports?: string[];
}

/** 会話中に落とすメモ。検証をかけず、確実に残ることを優先する。 */
export interface NoteFront extends BaseFront {
  type: 'note';
  kind?: 'observation' | 'preference' | 'constraint_hint' | 'context';
  filed?: boolean;      // 正式な型に昇格したか
  filed_as?: string;
}

export interface GenericFront extends BaseFront {
  type: 'entity' | 'athlete_profile' | 'question_queue' | 'lint' | 'plan';
}

export type Front =
  | ConstraintFront | TendencyFront | DecisionFront | AnalysisFront | ConflictFront
  | NoteFront | GenericFront;

/** type から front の型を引く。listByType が返すノードを絞り込むために使う。 */
export type FrontFor<T extends NodeType> =
  T extends 'constraint' ? ConstraintFront :
  T extends 'response_tendency' ? TendencyFront :
  T extends 'decision' ? DecisionFront :
  T extends 'analysis' ? AnalysisFront :
  T extends 'conflict' ? ConflictFront :
  T extends 'note' ? NoteFront : GenericFront;

export interface TypedNode<T extends NodeType> extends WikiNode {
  type: T;
  front: FrontFor<T>;
}

export interface WikiNode {
  id: string;
  type: NodeType;
  label: string;
  status?: Status;
  front: Front;
  body: string;
}

export interface NodeWithEdges extends WikiNode {
  out: Array<{ dst: string; rel: EdgeRel }>;
  in: Array<{ src: string; rel: EdgeRel }>;
}

export type EdgeRel =
  | 'applies' | 'reviewed' | 'supersedes' | 'contaminated'
  | 'evidenced_by'   // ★この記録が根拠にしているもの。根拠が撤回されたら波及する
  | 'mentions';
export interface Edge { src: string; dst: string; rel: EdgeRel }

export interface SearchHit {
  id: string; type: NodeType; label: string; ctx: string;
  /** 撤回済みを Query で再利用しないための表示 */
  status?: Status | string;
}
export interface OrphanRow { id: string; type: NodeType; label: string }
export interface DownstreamRow {
  id: string; depth: number; via: EdgeRel;
  type: NodeType; label: string; status: Status | string; path: string;
}
export interface GraphNode {
  id: string; type: NodeType; label: string; status?: Status | string;
  provenance?: ProvenanceSource | null; confidence?: number | null; severity?: Severity | null;
}
export interface GraphView {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string; rel: EdgeRel }>;
}

export interface Stats {
  nodes: number; edges: number;
  predictions: Record<string, number> | Array<{ status: string; c: number }>;
}

/** log.md / DO の log テーブルの1行。短期記憶（直近のやり取り）の元データ。 */
export interface LogEntry {
  ts: string; kind: string; title: string; detail?: string | null;
}

/**
 * ★セッション単位の生ログ。`log_session` ツールが書き込む。
 * 書き込み専用 — コーチングの生存パスからは読まない（MCPツールとしては公開しない）。
 * 将来スキーマを変えて再抽出するための唯一の corpus なので、削らず・上書きしない。
 */
export interface RawEntry {
  id: string;          // 'YYYY-MM-DD-session-NN'
  date: string;        // 'YYYY-MM-DD'
  transcript: string;
  created_at: string;  // ISO
}

export interface PutOptions { name?: string }

/**
 * ★2つのバックエンドが満たすべき契約。
 * `coach-memory/lib/fs-store.ts`（markdown）と `worker/src/do-store.ts`（DO の SQLite）。
 * 同期でも非同期でもよい（dispatch 側が await する）。
 */
export interface Store {
  today(): MaybePromise<string>;
  listAll?(): MaybePromise<WikiNode[]>;
  listByType<T extends NodeType>(type: T): MaybePromise<Array<TypedNode<T>>>;
  get(id: string): MaybePromise<NodeWithEdges | null>;
  put(node: WikiNode, opts?: PutOptions): MaybePromise<void>;
  nextId(prefix: string): MaybePromise<string>;
  /** 既定で撤回済みを除く。includeRetracted で明示的に含める。 */
  search(query: string, limit?: number, type?: NodeType, includeRetracted?: boolean): MaybePromise<SearchHit[]>;
  listPredictions(): MaybePromise<Prediction[]>;
  putPrediction(p: Prediction): MaybePromise<void>;
  downstream(id: string, maxDepth?: number): MaybePromise<DownstreamRow[]>;
  orphans(): MaybePromise<OrphanRow[]>;
  /** 可視化用。ノードとエッジだけの軽い形。 */
  graph(): MaybePromise<GraphView>;
  log(kind: string, title: string, detail?: string | null): MaybePromise<void>;
  /** ★短期記憶。直近のログを新しい順で返す。get_coach_briefing が読む。 */
  recentLog(limit?: number): MaybePromise<LogEntry[]>;
  stats(): MaybePromise<Stats>;
  /**
   * ★schema 層（CLAUDE.md）。MCP の resources として接続先の LLM に公開する。
   * これが無いと、リポジトリ外から MCP だけで繋いだ LLM は規約を読めない。
   */
  getSchema(): MaybePromise<string | null>;
  /**
   * ★briefing を読んだ時刻の記録と取得（ISO 文字列）。
   * MCP はサーバー側から会話の区切りが見えないので、時間で「読んだことにする」。
   */
  markBriefing(): MaybePromise<void>;
  lastBriefingAt(): MaybePromise<string | null>;
  /** ローカル版のみ。index.md の再生成。 */
  reindex?(): MaybePromise<number>;
  /** ★セッションの生ログを追記専用で保存する。上書き禁止。 */
  putRaw(entry: { date: string; transcript: string }): MaybePromise<{ id: string }>;
  /** ★オフラインの再抽出・監査用。MCPツールとしては公開しない。 */
  listRaw(): MaybePromise<RawEntry[]>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; required?: string[]; properties?: Record<string, unknown> };
}
