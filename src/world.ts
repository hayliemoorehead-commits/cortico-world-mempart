/**
 * 记忆分区 World（mempart）。工具前缀 mp_，避免与内置 memory 世界的 mem_* 撞名。
 *
 * 工具：
 *  mp_remember  存一条记忆(原文永久存冷层 + 短卡进温层 + 分层)
 *  mp_recall    混合检索(关键词+分层+时间+频率)，只回短卡
 *  mp_original  按 source_id 解压回取精确原文(要原话时用)
 *  mp_supersede 冲突不覆盖：新记忆标 supersedes，旧记忆标 supersededBy 并停用
 *  mp_set_tier  手动调层级(访问频率/时间之外的显式升降)
 *  mp_forget    永久删除一条(含冷层原文)，用于 T8–T9 噪音清理
 *  mp_list      各层级条数概览
 *
 * 热层(T0–T2)短卡经 envPromptVars + ENV_PROMPT.md 常驻 system 前缀。
 */
import type { World, WorldHost, ToolDef, ToolTag, WorldConsoleDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { fileURLToPath } from 'node:url';
import { MemStore, effectiveTier, tierLabel, type Importance, type MemRecord } from './store.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

const TIER_GUIDE = '分层 T0–T9：T0 永久核心(身份/硬约束/安全/法律)；T1–T3 长期(偏好/项目决策/近期待办)；T4–T7 中期到短期；T8–T9 噪音/寒暄(可短期保留或丢弃)。给不出就写 importance，会自动落层。'
  + '注意两条硬性规则：①T0/T1 只对 kind=identity/constraint 开放，其余类别(含 todo/fact)写 tier 0–1 会被自动封顶到 T2——临时约定不该占着永久核心；'
  + '②kind=todo 默认 3 天后过期、kind=chitchat 默认 1 天过期，到期自动退出检索与热层(冷层原文仍保留)，需要别的寿命就传 ttl_ms。';

const DUP_WARN_SIM = 0.32;

function fmtRecord(r: MemRecord, et: number, viaOriginal = false): string {
  const how = viaOriginal ? ' [原文命中：短卡里没有这些细节，用 mp_original 取原话]' : '';
  return `[T${et}/${r.tier}·${tierLabel(et)}·${r.importance}·${r.kind}] ${r.shortCard} 〈source_id=${r.sourceId}〉${how}`;
}

export class MemPartWorld implements World {
  readonly id = 'mempart';
  private host: WorldHost | null = null;
  private store: MemStore | null = null;

  constructor(private readonly ctx: WorldContext) {
    const dir = (this.ctx.dataDir && this.ctx.dataDir.trim()) ? this.ctx.dataDir : '.';
    try {
      this.store = new MemStore(dir);
    } catch (err) {
      this.store = null;
      // 起不来也不能让 World 构造抛错(否则进 missing)
      console.error('[mempart] 存储初始化失败:', err);
    }
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const s = this.store?.stats();
    host.log.info(`[mempart] 启动，数据目录=${this.ctx.dataDir}，当前 ${s?.active ?? 0} 条活跃记忆`);
  }

  async stop(): Promise<void> {
    this.store?.flush();
    this.host = null;
  }

  /** 热层 T0–T2 短卡常驻进 system 前缀。返回 null 表示本 World 这段不进前缀。 */
  envPromptVars(): Record<string, string> | null {
    if (!this.store) return null;
    const hot = this.store.hotLayer(24);
    const text = hot.length
      ? hot
          .map((r) => `- [T${effectiveTier(r, Date.now())}·${tierLabel(effectiveTier(r, Date.now()))}·${r.kind}] ${r.shortCard}`)
          .join('\n')
      : '（热层暂无常驻记忆；用 mp_remember 记下重要的事后，T0–T2 会自动常驻这里）';
    return { mempartHot: text };
  }

  private need(): MemStore {
    if (!this.store) throw new Error('记忆分区尚未就绪(存储初始化失败)');
    return this.store;
  }

  private tiersDesc(): string {
    const s = this.store?.stats();
    if (!s) return '（暂无记忆）';
    const parts = Object.keys(s.byTier).map((t) => `T${t}:${s.byTier[+t]}`).sort();
    const exp = s.expired ? `，已过期 ${s.expired} 条` : '';
    return `活跃 ${s.active} 条（${parts.join(' ') || '空'}），冷层原文 ${s.originals} 块${exp}`;
  }

  tools(): ToolDef[] {
    const str = (title: string) => ({ type: 'string', title });
    const num = (title: string) => ({ type: 'number', title });
    const mk = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
      tags: ToolTag[],
      run: (a: Record<string, unknown>) => Promise<string>,
      extra: Partial<ToolDef> = {},
    ): ToolDef => ({
      name,
      description,
      parameters: { type: 'object', additionalProperties: false, properties, required },
      tags,
      handler: async (args) => {
        try {
          return await run(args);
        } catch (e: unknown) {
          return `⚠ 调用失败: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
      ...extra,
    });

    return [
      mk(
        'mp_remember',
        `记住一件值得长期保留的事。原文会被永久压缩保存(冷层)，同时生成一张「短卡」(压缩摘要)放进上下文与检索结果，二者都不会互相替代。${TIER_GUIDE}`
          + 'tier 直接给 0–9 最准；不给就写 importance(permanent/longterm/shortterm/noise 自动落层)。'
          + 'card 是给模型自己回看用的压缩摘要——务必写"提炼过的一句话"，别直接把原文整段塞进来(原文请用 text 字段，会自动进冷层)。'
          + 'kind 填类别：identity(身份)/constraint(硬约束)/preference(偏好)/project(项目决策)/todo(待办)/fact(事实)/chitchat(寒暄)。'
          + '返回 source_id，之后回忆或回取原话都靠它。',
        {
          text: str('原始内容(完整原文，会永久压缩保存)'),
          card: str('压缩短卡(一句话摘要，进上下文/检索的就是它；留空则取原文前 120 字)'),
          tier: num('层级 0–9(不给就按 importance 落层)'),
          importance: { type: 'string', enum: ['permanent', 'longterm', 'shortterm', 'noise'], description: '重要性，决定默认层级' },
          kind: str('类别：identity/constraint/preference/project/todo/fact/chitchat'),
          ttl_ms: num('寿命(毫秒)，覆盖类别默认值；传 0 或留空用默认(todo 3 天/chitchat 1 天，其余不过期)'),
        },
        ['text'],
        ['write'],
        async (a) => {
          const text = String(a.text ?? '').trim();
          if (!text) return '⚠ mp_remember 需要 text(原文内容)';
          const card = typeof a.card === 'string' ? a.card.trim() : '';
          const tier = typeof a.tier === 'number' ? a.tier : undefined;
          const importance = (['permanent', 'longterm', 'shortterm', 'noise'].includes(String(a.importance)) ? String(a.importance) : undefined) as Importance | undefined;
          const kind = typeof a.kind === 'string' ? a.kind.trim() : undefined;
          const ttlRaw = Number(a.ttl_ms);
          const ttl_ms = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
          const asked = tier;
          // 写入「之前」先看有没有撞车的老记忆(写后查会把自己也算进相似度里)。
          const dup = this.need().similarTo(text, card, 3);
          const rec = this.need().remember({ text, card, tier, importance, kind, ttl_ms });
          const gated = typeof asked === 'number' && asked < 2 && rec.tier !== asked
            ? `（注意：T${asked} 只对 identity/constraint 开放，已封顶到 T${rec.tier}）` : '';
          const life = rec.expiresAt ? `，寿命到 ${new Date(rec.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
          const dupHint = dup.length > 0 && dup[0].sim >= DUP_WARN_SIM
            ? '\n⚠ 库里已有相似记忆，请当场判断是「重复」还是「更新」：\n'
              + dup.map((d) => `  · [相似度 ${(d.sim * 100).toFixed(0)}%] ${d.rec.sourceId} — ${d.rec.shortCard}`).join('\n')
              + `\n  若是同一件事的最新结论 → mp_supersede(new_source_id=${rec.sourceId}, old_source_id=<上面那条>) 取代旧记录，别让冲突事实并存；`
              + '若确认是重复记载 → mp_forget 掉旧的。若确实是另一件新事，忽略本提示。'
            : '';
          return `OK 已记住（source_id=${rec.sourceId}，层级 T${rec.tier}·${tierLabel(rec.tier)}，类别 ${rec.kind}${gated}${life}）。原文已永久压缩保存，短卡进入检索；热层(T0–T2)会常驻到你的上下文里。${dupHint}`;
        },
        { barrierAfter: true },
      ),

      mk(
        'mp_recall',
        '按「关键词 + 分层 + 时间 + 访问频率」混合检索长期记忆，只回短卡(不回原文，要原话用 mp_original)。'
          + '想起旧事/约定/用户说过什么时用它，别凭空编造回忆；检索不到就直说想不起来。'
          + 'tier 可限定只看某层(如只要 T0 永久核心就填 0)；不填则跨全部分层。limit 默认 8。',
        {
          query: str('查询内容'),
          tier: num('只看某层(0–9)，不填则全层'),
          limit: num('返回条数(默认 8)'),
          includeSuperseded: { type: 'boolean', description: '是否包含已被取代(旧)的记录，默认否' },
        },
        ['query'],
        ['read'],
        async (a) => {
          const query = String(a.query ?? '').trim();
          if (!query) return '⚠ mp_recall 需要 query';
          const tier = typeof a.tier === 'number' ? a.tier : undefined;
          const limit = Math.min(30, Number(a.limit) || 8);
          const inc = a.includeSuperseded === true;
          const hits = this.need().recall(query, tier, limit, inc);
          if (!hits.length) return `OK 没有匹配「${query}」的记忆（当前 ${this.tiersDesc()}）`;
          return `OK 命中 ${hits.length} 条（${this.tiersDesc()}）：\n`
            + hits.map((h, i) => `${i + 1}. ${fmtRecord(h.rec, h.et, h.viaOriginal)}`).join('\n')
            + '\n(需要原话可用 mp_original 按 source_id 取回精确原文)';
        },
      ),

      mk(
        'mp_original',
        '按 source_id 解压回取某条记忆的「精确原文」(冷层)。检索结果只给短卡，只有需要逐字原话/精确内容时才调它——不要把全部历史塞进上下文。',
        { source_id: str('记忆的 source_id(来自 mp_remember 或 mp_recall 的返回)') },
        ['source_id'],
        ['read'],
        async (a) => {
          const id = String(a.source_id ?? '').trim();
          if (!id) return '⚠ mp_original 需要 source_id';
          const text = this.need().original(id);
          if (text == null) return `OK 没找到 source_id=${id} 的原文(可能已被 forget 或 id 有误)`;
          return `OK 原文（source_id=${id}）：\n"""\n${text}\n"""`;
        },
      ),

      mk(
        'mp_supersede',
        '新信息推翻旧记忆时调用：冲突不覆盖。旧记录标 supersededBy 并停用(不再出现在常规检索)，新记录标 supersedes 指向它，方便回溯。两个参数都要 source_id。',
        { new_source_id: str('新的、正确的记忆 source_id'), old_source_id: str('被取代的旧记忆 source_id') },
        ['new_source_id', 'old_source_id'],
        ['write'],
        async (a) => {
          const n = String(a.new_source_id ?? '').trim();
          const o = String(a.old_source_id ?? '').trim();
          if (!n || !o) return '⚠ mp_supersede 需要 new_source_id 和 old_source_id';
          const ok = this.need().supersede(n, o);
          return ok ? `OK 已关联：旧 ${o} 标记为被 ${n} 取代(停用)，新 ${n} 指向旧记录，原文都保留可回溯。` : `FAIL 找不到 ${n} 或 ${o}(或二者相同)`;
        },
        { barrierAfter: true },
      ),

      mk(
        'mp_set_tier',
        '手动调整某条记忆的层级(0–9)。用于访问频率/时间之外的显式升降：把一条常忘的重要结论提到 T0，或把临时约定降到 T8 让它自然淡出。',
        { source_id: str('记忆 source_id'), tier: num('目标层级 0–9') },
        ['source_id', 'tier'],
        ['write'],
        async (a) => {
          const id = String(a.source_id ?? '').trim();
          const t = Number(a.tier);
          if (!id || !Number.isFinite(t)) return '⚠ mp_set_tier 需要 source_id 和 tier(0–9)';
          const ok = this.need().setTier(id, t);
          return ok ? `OK ${id} 已设为 T${Math.max(0, Math.min(9, Math.round(t)))}` : `FAIL 找不到 ${id}`;
        },
      ),

      mk(
        'mp_forget',
        '永久删除一条记忆(连同冷层原文，不可恢复)。只用于 T8–T9 噪音/寒暄或确认过时的内容；重要记忆请用 mp_supersede 而不是删除。',
        { source_id: str('要删除的记忆 source_id') },
        ['source_id'],
        ['write'],
        async (a) => {
          const id = String(a.source_id ?? '').trim();
          if (!id) return '⚠ mp_forget 需要 source_id';
          const ok = this.need().forget(id);
          return ok ? `OK 已永久删除 ${id}（含冷层原文）` : `FAIL 找不到 ${id}`;
        },
        { barrierAfter: true },
      ),

      mk(
        'mp_list',
        '列出记忆分区概览：各层级(T0–T9 派生层级)活跃条数、冷层原文块数。便于总览当前记忆分布。',
        {},
        [],
        ['read', 'snapshot'],
        async () => `OK ${this.tiersDesc()}\n热层(T0–T2)常驻进上下文；温层(T3–T7)按需检索；冷层存原文。`,
      ),
    ];
  }

  console(): WorldConsoleDecl {
    const s = this.store?.stats();
    return {
      lamps: [
        {
          label: '记忆分区',
          state: this.store ? 'online' : 'error',
          hint: this.store ? `已载入 ${s?.active ?? 0} 条活跃记忆` : '存储初始化失败',
        },
        {
          label: '冷层原文',
          state: this.store ? 'online' : 'error',
          hint: this.store ? `${s?.originals ?? 0} 块原文已压缩保存` : '不可用',
        },
      ],
      badges: [
        { label: '活跃', value: String(s?.active ?? 0) },
        { label: '原文块', value: String(s?.originals ?? 0) },
      ],
      promptDocs: [
        {
          key: 'worlds.mempart.envPrompt',
          title: '记忆分区 · 环境提示词',
          description: '进 system 前缀的那一段：热层(T0–T2)常驻短卡 + 分层记忆的使用纪律。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'mempartHot', description: '热层 T0–T2 常驻的短卡文本(逐行一条)' },
          ],
        },
      ],
    };
  }
}
