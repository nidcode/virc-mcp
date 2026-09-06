import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ROOT = process.env.COACH_WIKI || '/Users/niida/project/niida/myskill/coach';
export const WIKI = path.join(ROOT, 'wiki');
export const today = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePage(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = FM.exec(raw);
  const front = m ? (YAML.parse(m[1]) ?? {}) : {};
  const body = m ? raw.slice(m[0].length) : raw;
  return { file, rel: path.relative(WIKI, file), front, body };
}

export function listPages(type) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.md')) {
        try { out.push(parsePage(f)); } catch { /* skip malformed */ }
      }
    }
  };
  if (fs.existsSync(WIKI)) walk(WIKI);
  return type ? out.filter((p) => p.front.type === type) : out;
}

export const byId = (id) => listPages().find((p) => p.front.id === id);

export function savePage(p) {
  const out = '---\n' + YAML.stringify(p.front, { lineWidth: 0 }).trimEnd() + '\n---\n'
    + (p.body.startsWith('\n') ? p.body : '\n' + p.body);
  fs.writeFileSync(p.file, out, 'utf8');
}

export function createPage(dir, name, front, body) {
  const d = path.join(WIKI, dir);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${name}.md`);
  savePage({ file, front, body });
  return `${dir}/${name}`;
}

export function nextId(prefix) {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  let max = 0;
  for (const p of listPages()) {
    const m = re.exec(p.front.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
    for (const pr of [p.front.prediction, ...(p.front.predictions ?? [])].filter(Boolean)) {
      const mm = pr?.id && re.exec(pr.id);
      if (mm) max = Math.max(max, Number(mm[1]));
    }
  }
  return `${prefix}_${String(max + 1).padStart(2, '0')}`;
}

export const slug = (s) => {
  let t = String(s).replace(/[\/\\:*?"<>|\n#[\]]/g, '').trim();
  const cut = t.search(/[、。（(]/);
  if (cut > 6) t = t.slice(0, cut);
  return t.replace(/\s+/g, '').slice(0, 24);
};

export function appendLog(kind, title, detail) {
  const line = `\n## [${today()}] ${kind} | ${title}\n${detail ? detail + '\n' : ''}`;
  fs.appendFileSync(path.join(ROOT, 'log.md'), line, 'utf8');
}

const LOG_ENTRY = /^## \[(\d{4}-\d{2}-\d{2})\] (\S+) \| (.+)$/gm;

// ★短期記憶。log.md を新しい順にパースして返す。
// lint は同じ内容が何度も連続で追記されがちなので、直近1件だけ残して畳む。
export function recentLog(limit = 8) {
  const f = path.join(ROOT, 'log.md');
  if (!fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, 'utf8');
  const heads = [...text.matchAll(LOG_ENTRY)];
  const entries = heads.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const detail = text.slice(start, end).trim();
    return { ts: m[1], kind: m[2], title: m[3].trim(), detail: detail || null };
  }).reverse();

  const out = [];
  let sawLint = false;
  for (const e of entries) {
    if (e.kind === 'lint') { if (sawLint) continue; sawLint = true; }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

const KIND = {
  constraint: '禁則', response_tendency: '反応モデル', decision: '判断',
  analysis: '分析', entity: 'エンティティ', athlete_profile: 'カルテ', question_queue: '質問',
};

export function rebuildIndex() {
  const pages = listPages();
  const groups = {};
  for (const p of pages) {
    const k = KIND[p.front.type] ?? 'その他';
    (groups[k] ||= []).push(p);
  }
  const link = (p) => `[[${p.rel.replace(/\.md$/, '')}|${(p.body.match(/^#\s+(.+)$/m) ?? [, p.front.id])[1]}]]`;
  const order = ['カルテ', 'エンティティ', '分析', '反応モデル', '禁則', '判断', '質問', 'その他'];
  const L = [`# index`, '', `${pages.length} ページ · 更新 ${today()}`, ''];
  for (const k of order) {
    if (!groups[k]?.length) continue;
    L.push(`## ${k} (${groups[k].length})`, '');
    for (const p of groups[k].sort((a, b) => (a.front.id ?? '').localeCompare(b.front.id ?? ''))) {
      const tags = [];
      if (p.front.status && p.front.status !== 'active') tags.push(`\`${p.front.status}\``);
      if (p.front.severity === 'absolute') tags.push('⛔');
      if (p.front.confidence != null) tags.push(`conf ${p.front.confidence}`);
      if (p.front.prediction?.status === 'pending') tags.push(`⏳${p.front.prediction.review_on}`);
      if (p.front.valid_until) tags.push(`〜${p.front.valid_until}`);
      L.push(`- \`${p.front.id ?? '—'}\` ${link(p)}${tags.length ? ' — ' + tags.join(' · ') : ''}`);
    }
    L.push('');
  }
  fs.writeFileSync(path.join(ROOT, 'index.md'), L.join('\n'), 'utf8');
  return pages.length;
}

// 未回収・回収予定の予測を判断ページから集める
export function predictions() {
  const out = [];
  for (const p of listPages()) {
    const list = [p.front.prediction, ...(p.front.predictions ?? [])].filter(Boolean);
    for (const pr of list) out.push({ ...pr, owner: p.front.id, page: p });
  }
  return out;
}
