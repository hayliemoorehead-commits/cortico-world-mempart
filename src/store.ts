/**
 * 记忆分区的数据层。
 *
 * 设计对应文档《上下文记忆系统》：
 *  - 原文永久保存：原始文本 gzip 后存「冷层」(mempart-cold.json)，绝不丢失、不替代。
 *  - 短卡 + 分层：每条记忆只把 shortCard(压缩摘要) 放进上下文/检索结果(热/温层)。
 *  - T0–T9 分层：tier 越小越重要；T0 永久核心、T1–T3 长期、T8–T9 噪音。
 *  - 时间衰减 + 访问频率升降：effectiveTier = tier + 时间衰减 - 访问提升(纯派生,不破坏原值)。
 *  - 混合检索：关键词命中 + 分层加权 + 时间近因 + 访问频率。
 *  - source_id 回取原话：original(sourceId) 解压冷层原文。
 *  - 冲突不覆盖：supersede 把旧记录标 supersededBy、新记录标 supersedes。
 *
 * 全程零外部依赖(只用 node:fs / node:zlib)，保证在沙箱/桌宠部署里稳定可用。
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Importance = 'permanent' | 'longterm' | 'shortterm' | 'noise';

export interface MemRecord {
  /** 稳定 id，用于检索回取与冲突关联。 */
  sourceId: string;
  /** 基础重要性层级 0–9；越小越重要。 */
  tier: number;
  importance: Importance;
  /** 类别：identity/constraint/preference/project/todo/fact/chitchat… */
  kind: string;
  /** 压缩后的短卡(进上下文/检索结果的就是它，不是原文)。 */
  shortCard: string;
  /** 指向冷层原文块的 id。 */
  originalId: string;
  createdAt: number;
  lastAccessAt: number;
  accessCount: number;
  /** 本记录取代的旧记录 sourceId(若有)。 */
  supersedes: string | null;
  /** 被哪条新记录取代(若有，则 inactive)。 */
  supersededBy: string | null;
  /** 被取代后变 false，检索默认排除。 */
  active: boolean;
  /** 过期时间(epoch ms)，按类别自动设定(见 TTL_BY_KIND)；到点退出检索/热层。历史数据没有此字段=永不过期。 */
  expiresAt?: number | null;
}

interface ColdEntry {
  b64: string; // gzip + base64 原文
  createdAt: number;
  sourceId: string;
}

const TIER_BY_IMPORTANCE: Record<Importance, number> = {
  permanent: 0,
  longterm: 2,
  shortterm: 5,
  noise: 8,
};

const DAY = 86_400_000;
const DECAY_PER_DAYS = 30; // 每 30 天时间衰减 +1 层
const PROMO_EVERY = 5; // 每被回忆 5 次访问提升 -1 层(最多 -3)
const PROMO_CAP = 3;

/**
 * T0/T1 写入门禁:只有 identity(身份)与 constraint(硬约束/安全/法律)允许进核心层,
 * 其余类别一律封顶到 T2 —— 避免「明早 xx 点集合」这类临时约定占着永久核心的位子。
 */
const CORE_KINDS = new Set(['identity', 'constraint']);
const CORE_MIN_TIER = 2;

/** 易逝类别的默认存活时长(毫秒):到期即从检索与热层消失,冷层原文仍保留可回溯。 */
const TTL_BY_KIND: Record<string, number> = {
  chitchat: 1 * DAY,
  todo: 3 * DAY,
};

const TIER_LABEL: Record<number, string> = {
  0: '永久核心', 1: '永久', 2: '长期', 3: '长期', 4: '中期',
  5: '短期', 6: '短期', 7: '易逝', 8: '噪音', 9: '噪音',
};

export function clampTier(t: number): number {
  if (!Number.isFinite(t)) return 2;
  return Math.max(0, Math.min(9, Math.round(t)));
}

/** 写入门禁：只有 identity/constraint 能占 T0/T1，其余类别封顶到 T2。单独提出来便于单测。 */
export function gateTier(tier: number, kind: string): number {
  const k = (kind ?? '').trim().toLowerCase();
  if (CORE_KINDS.has(k)) return clampTier(tier);
  return clampTier(Math.max(tier, CORE_MIN_TIER));
}

/** 按类别算过期时间：chitchat/todo 有默认寿命，其余不过期；可用 ttl_ms 显式覆盖。 */
export function expiryOf(now: number, kind: string, ttlMs?: number): number | null {
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) return now + ttlMs;
  const life = TTL_BY_KIND[(kind ?? '').trim().toLowerCase()];
  return life ? now + life : null;
}

/** 取记录的过期时间；历史数据没有该字段=永不过期。 */
function ttlOf(r: MemRecord): number | null {
  const v = r.expiresAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 已过期(多是过期的待办/寒暄)：不再进检索与热层，但冷层原文与记录都保留，可回溯。 */
export function isExpired(r: MemRecord, now: number): boolean {
  const t = ttlOf(r);
  return t !== null && now > t;
}

/** 派生层级：基础 tier + 时间衰减 − 访问提升。纯函数，不改动存储值。 */
export function effectiveTier(r: MemRecord, now: number): number {
  if (isExpired(r, now)) return 9; // 过期一律沉底
  const ageDays = Math.max(0, (now - r.createdAt) / DAY);
  // permanent 豁免时间衰减：身份/硬约束不因岁月冲刷而淡出，始终留在热层。
  const decay = r.importance === 'permanent' ? 0 : Math.floor(ageDays / DECAY_PER_DAYS);
  const promo = Math.min(PROMO_CAP, Math.floor(r.accessCount / PROMO_EVERY));
  return clampTier(r.tier + decay - promo);
}

export function tierLabel(t: number): string {
  return TIER_LABEL[clampTier(t)] ?? '其它';
}

/**
 * 分词结果：
 *  - strong(强特征)：拉丁词、CJK **二元组(bigram)**。语义确定，命中权重高。
 *  - weak(弱特征)：单字/单字符。用于「短查询」「一字之差」的兜底，权重打折扣。
 *
 * 为什么必须有 bigram：旧实现把中文逐字切，「记忆」会被拆成「记」「忆」两个独立 token，
 * 于是查「记忆」能命中任何含「记」或「忆」的卡片(如「记得买菜」「回忆童年」)，误召回极高。
 * bigram 把「记忆」当作一个整体特征，只有真正相邻出现才算命中。
 */
export interface Tokens {
  strong: Set<string>;
  weak: Set<string>;
}

/** 弱特征相对强特征的权重折扣：单字命中只能算辅助证据，不足以单独撑起相关性。 */
const WEAK_WEIGHT = 0.3;

/** 类别(kind)命中在总分里的折算：只是旁证，不该跟短卡平分秋色。 */
const KIND_WEIGHT = 0.5;

/** 冷层原文命中在总分里的折算：能救回被摘要掉的技术细节，但要低于短卡命中。 */
const ORIGINAL_WEIGHT = 0.6;

/** IDF 下限，避免语料极小时所有权重塌成 0。 */
const IDF_FLOOR = 0.2;

/** 中文/英文混合分词：拉丁词整体 + CJK bigram(强) + CJK 单字(弱)。 */
export function tokenizeDetailed(s: string): Tokens {
  const lower = (s ?? '').toLowerCase();
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length >= 2) strong.add(t);
    else weak.add(t);
  }
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      weak.add(run);
      continue;
    }
    // 相邻二字组成一个强特征；同时保留单字作为弱特征兜底。
    for (let i = 0; i + 2 <= run.length; i++) strong.add(run.slice(i, i + 2));
    for (const ch of run) weak.add(ch);
  }
  return { strong, weak };
}

/** 兼容旧接口：强特征 + 弱特征的合集。取(tf)词表时用，不用于相关性计分。 */
export function tokenize(s: string): Set<string> {
  const { strong, weak } = tokenizeDetailed(s);
  const all = new Set<string>(strong);
  for (const t of weak) all.add(t);
  return all;
}

/**
 * 关键词覆盖率 0–1：查询 token 中被命中的**加权比例**。
 * 权重用 IDF —— 「的」「了」这类遍地都是的字权重趋近 0，专有名词权重高，
 * 这样即使查询里混入停用词，也不会把结果拉平。
 */
function coverageScore(q: Tokens, target: Tokens, idf: Map<string, number>): number {
  let hit = 0;
  let total = 0;
  for (const t of q.strong) {
    const w = idf.get(t) ?? 1;
    total += w;
    if (target.strong.has(t)) hit += w;
  }
  for (const t of q.weak) {
    const w = (idf.get(t) ?? 1) * WEAK_WEIGHT;
    total += w;
    if (target.weak.has(t) || target.strong.has(t)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

/**
 * Dice 相似度 0–1（IDF 加权）：用于判断「要不要存的这条，跟已有记忆是不是重复/冲突」。
 * 比单边覆盖率更公平，不会因为新内容长(词多)就把相似度压低。
 */
function diceScore(a: Tokens, b: Tokens, idf: Map<string, number>): number {
  let inter = 0;
  let sa = 0;
  let sb = 0;
  for (const t of a.strong) {
    const w = idf.get(t) ?? 1;
    sa += w;
    if (b.strong.has(t)) inter += w;
  }
  for (const t of b.strong) sb += idf.get(t) ?? 1;
  const counted = new Set<string>();
  for (const t of a.weak) {
    const w = (idf.get(t) ?? 1) * WEAK_WEIGHT;
    sa += w;
    if (b.weak.has(t) || b.strong.has(t)) {
      inter += w;
      counted.add(t);
    }
  }
  for (const t of b.weak) {
    const w = (idf.get(t) ?? 1) * WEAK_WEIGHT;
    sb += w;
    // 反向的弱命中只在未被计入过时才补，避免同一 token 重复加分。
    if (!counted.has(t) && (a.weak.has(t) || a.strong.has(t))) inter += w;
  }
  const total = sa + sb;
  return total > 0 ? (2 * inter) / total : 0;
}

function mergeTokens(a: Tokens, b: Tokens): Tokens {
  const strong = new Set<string>(a.strong);
  for (const t of b.strong) strong.add(t);
  const weak = new Set<string>(a.weak);
  for (const t of b.weak) weak.add(t);
  return { strong, weak };
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

export interface RecallHit {
  rec: MemRecord;
  et: number; // effectiveTier 命中时的派生层级
  score: number;
  /** 短卡没直接命中、靠冷层原文捞回来的：说明细节被摘要掉了，值得 mp_original 取原话。 */
  viaOriginal: boolean;
}

/** 一条记录在内存索引里的分词视图。冷层原文也纳入索引，压缩掉的细节才召得回来。 */
interface IndexedTokens {
  card: Tokens;
  original: Tokens;
  kind: Tokens;
}

export interface SimilarHit {
  rec: MemRecord;
  sim: number;
}

export class MemStore {
  private records: MemRecord[] = [];
  private originals: Record<string, ColdEntry> = {};
  private seq = 0;
  private readonly storePath: string;
  private readonly coldPath: string;
  /** 分词索引(含冷层原文)，懒构建：只有第一次检索/查重时才付出解压成本。 */
  private index = new Map<string, IndexedTokens>();
  /** token → IDF 权重。语料越小 IDF 区分度越低，但有下限保护，不会全塌成一坨。 */
  private idf = new Map<string, number>();
  private indexDirty = true;

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.storePath = join(dataDir, 'mempart-store.json');
    this.coldPath = join(dataDir, 'mempart-cold.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      this.records = Array.isArray(raw.records) ? raw.records : [];
      this.seq = typeof raw.seq === 'number' ? raw.seq : this.records.length;
    } catch {
      this.records = [];
      this.seq = 0;
    }
    try {
      const raw = JSON.parse(readFileSync(this.coldPath, 'utf8'));
      this.originals = raw && typeof raw.originals === 'object' ? raw.originals : {};
    } catch {
      this.originals = {};
    }
    this.indexDirty = true;
  }

  /**
   * 懒构建分词索引 + IDF。
   * 冷层原文在这里解压一次并纳入索引——这是「原文可被检索」的关键：
   * 短卡只留一句话摘要，若只索引短卡，被摘要掉的技术细节这辈子都召不回来。
   */
  private ensureIndex(): void {
    if (!this.indexDirty) return;
    const index = new Map<string, IndexedTokens>();
    const df = new Map<string, number>();
    const bump = (t: Tokens): void => {
      for (const tk of t.strong) df.set(tk, (df.get(tk) ?? 0) + 1);
    };
    for (const r of this.records) {
      const card = tokenizeDetailed(r.shortCard);
      const kind = tokenizeDetailed(r.kind);
      let original: Tokens = { strong: new Set<string>(), weak: new Set<string>() };
      const text = this.originalText(r);
      if (text) original = tokenizeDetailed(text);
      index.set(r.sourceId, { card, original, kind });
      bump(card);
      bump(original);
    }
    const n = Math.max(1, this.records.length);
    const idf = new Map<string, number>();
    for (const [tk, cnt] of df) idf.set(tk, Math.max(IDF_FLOOR, Math.log(1 + n / (1 + cnt))));
    this.index = index;
    this.idf = idf;
    this.indexDirty = false;
  }

  /** 解压某条记录的冷层原文；损坏/缺失返回 null（不抛，避免一条坏数据拖垮整个检索）。 */
  private originalText(r: MemRecord): string | null {
    const c = this.originals[r.originalId];
    if (!c) return null;
    try {
      return gunzipSync(Buffer.from(c.b64, 'base64')).toString('utf8');
    } catch {
      return null;
    }
  }

  flush(): void {
    if (!this.storePath) return;
    atomicWrite(this.storePath, JSON.stringify({ records: this.records, seq: this.seq }));
    atomicWrite(this.coldPath, JSON.stringify({ originals: this.originals }));
  }

  /** 存一条记忆：原文进冷层(压缩)，短卡+分层进温层。 */
  remember(opts: {
    text: string;
    card: string;
    tier?: number;
    importance?: Importance;
    kind?: string;
    ttl_ms?: number;
  }): MemRecord {
    const importance: Importance = opts.importance ?? 'longterm';
    const rawTier = typeof opts.tier === 'number'
      ? clampTier(opts.tier)
      : TIER_BY_IMPORTANCE[importance];
    const kind = (opts.kind && opts.kind.trim()) ? opts.kind.trim() : 'fact';
    const tier = gateTier(rawTier, kind); // 非核心类别不许占 T0/T1
    const now = Date.now();
    const n = ++this.seq;
    const originalId = 'o' + n.toString(36);
    const sourceId = 'mp_' + now.toString(36) + n.toString(36);
    const b64 = gzipSync(Buffer.from(opts.text, 'utf8')).toString('base64');
    this.originals[originalId] = { b64, createdAt: now, sourceId };
    const card = (opts.card && opts.card.trim()) ? opts.card.trim() : opts.text.slice(0, 120);
    const rec: MemRecord = {
      sourceId,
      tier,
      importance,
      kind,
      shortCard: card,
      originalId,
      createdAt: now,
      lastAccessAt: now,
      accessCount: 0,
      supersedes: null,
      supersededBy: null,
      active: true,
      expiresAt: expiryOf(now, kind, opts.ttl_ms),
    };
    this.records.push(rec);
    this.indexDirty = true;
    this.flush();
    return rec;
  }

  /**
   * 混合检索：关键词 + 分层 + 时间 + 频率。
   * 只回短卡，不回原文(要原话用 original())。命中项会被记一次访问(可能升层)。
   */
  recall(query: string, tierFilter?: number, limit = 8, includeSuperseded = false): RecallHit[] {
    const now = Date.now();
    const q = tokenizeDetailed(query);
    this.ensureIndex();
    const hits: RecallHit[] = [];
    for (const r of this.records) {
      if (!r.active && !includeSuperseded) continue;
      if (isExpired(r, now) && !includeSuperseded) continue; // 过期的待办/寒暄不再干扰召回
      const idx = this.index.get(r.sourceId);
      if (!idx) continue;
      const cardS = coverageScore(q, idx.card, this.idf);
      const kindS = coverageScore(q, idx.kind, this.idf);
      const origS = coverageScore(q, idx.original, this.idf);
      // 短卡是主通道；类别是辅助；原文是「摘要之外的补充证据」，必须打折——
      // 原文通常比短卡长得多，不打折的话覆盖面广的长记录会压过精确命中的短卡。
      const kscore = Math.min(1, cardS + kindS * KIND_WEIGHT + origS * ORIGINAL_WEIGHT);
      const viaOriginal = cardS <= 0 && origS > 0; // 摘要里没有、靠原文捞回来的
      const et = effectiveTier(r, now);
      const tierBoost = (10 - et) / 10; // 越重要权重越高
      const ageDays = Math.max(0, (now - r.createdAt) / DAY);
      const recencyBoost = Math.exp(-ageDays / 30);
      const freqBoost = Math.log1p(r.accessCount) / Math.log1p(20);
      let score = kscore * (1 + tierBoost * 0.8 + recencyBoost * 0.5 + freqBoost * 0.3);
      if (tierFilter !== undefined) score *= et === clampTier(tierFilter) ? 2 : 0.15;
      // 没有任何关键词命中且未指定分层时，不进入结果(避免噪音灌水)
      if (kscore > 0 || tierFilter !== undefined) hits.push({ rec: r, et, score, viaOriginal });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    for (const h of top) {
      h.rec.accessCount += 1;
      h.rec.lastAccessAt = now;
    }
    if (top.length) this.flush();
    return top;
  }

  /**
   * 写入前的相似候选探测：找与「待写内容」最像的活跃记录。
   *
   * 存在的意义：supersede 过去全靠模型自觉，冲突事实因此静默共存（既说用 A 方案又说用 B 方案），
   * 重复内容也越存越多。这里由系统把候选摆到模型面前，让它当场决定「是更新还是重记」。
   * 纯查询，不计访问、不改状态。
   */
  similarTo(text: string, card?: string, limit = 3): SimilarHit[] {
    const now = Date.now();
    this.ensureIndex();
    const c = card && card.trim() ? card : text;
    const target = mergeTokens(tokenizeDetailed(c), tokenizeDetailed(text));
    const out: SimilarHit[] = [];
    for (const r of this.records) {
      if (!r.active) continue;
      if (isExpired(r, now)) continue;
      const idx = this.index.get(r.sourceId);
      if (!idx) continue;
      const cand = mergeTokens(idx.card, idx.original);
      const sim = diceScore(target, cand, this.idf);
      if (sim > 0) out.push({ rec: r, sim });
    }
    out.sort((a, b) => b.sim - a.sim);
    return out.slice(0, limit);
  }

  /** 按 source_id 解压回取精确原文(冷层)。 */
  original(sourceId: string): string | null {
    const r = this.records.find((x) => x.sourceId === sourceId);
    if (!r) return null;
    const text = this.originalText(r); // 损坏的原文块返回 null，不抛，避免一条坏数据拖垮回取
    if (text === null) return null;
    r.accessCount += 1;
    r.lastAccessAt = Date.now();
    this.flush();
    return text;
  }

  /** 冲突不覆盖：旧记录标 supersededBy 并停用，新记录标 supersedes。 */
  supersede(newId: string, oldId: string): boolean {
    const n = this.records.find((x) => x.sourceId === newId);
    const o = this.records.find((x) => x.sourceId === oldId);
    if (!n || !o || n === o) return false;
    o.supersededBy = newId;
    o.active = false;
    n.supersedes = oldId;
    this.flush();
    return true;
  }

  setTier(sourceId: string, tier: number): boolean {
    const r = this.records.find((x) => x.sourceId === sourceId);
    if (!r) return false;
    r.tier = clampTier(tier);
    this.flush();
    return true;
  }

  /** 永久删除一条(含冷层原文)。用于 T8–T9 噪音清理。 */
  forget(sourceId: string): boolean {
    const idx = this.records.findIndex((x) => x.sourceId === sourceId);
    if (idx < 0) return false;
    const r = this.records[idx];
    delete this.originals[r.originalId];
    this.records.splice(idx, 1);
    this.indexDirty = true;
    this.flush();
    return true;
  }

  /** 热层 T0–T2 常驻短卡(供 envPromptVars 注入上下文)。 */
  hotLayer(limit = 24): MemRecord[] {
    const now = Date.now();
    return this.records
      .filter((r) => r.active)
      .map((r) => ({ r, et: effectiveTier(r, now) }))
      .filter((x) => x.et <= 2)
      .sort((a, b) => a.et - b.et || b.r.accessCount - a.r.accessCount)
      .slice(0, limit)
      .map((x) => x.r);
  }

  /** 各层级活跃条数统计。 */
  stats(): { total: number; active: number; expired: number; byTier: Record<number, number>; originals: number } {
    const now = Date.now();
    const byTier: Record<number, number> = {};
    let active = 0;
    let expired = 0;
    for (const r of this.records) {
      if (!r.active) continue;
      if (isExpired(r, now)) expired++;
      active++;
      const et = effectiveTier(r, now);
      byTier[et] = (byTier[et] ?? 0) + 1;
    }
    return { total: this.records.length, active, expired, byTier, originals: Object.keys(this.originals).length };
  }
}

export { TIER_BY_IMPORTANCE };
