# cortico-world-mempart（记忆分区）

基于文档《上下文记忆系统》实现的 Cortico World 扩展：分层存、按需取，而不是把历史压成一段提示词。

## 核心设计（对应文档）

- **原文永久保存**：原始文本 gzip 压缩后存「冷层」(`mempart-cold.json`)，绝不丢失、不替代。
- **短卡 + 分层**：每条记忆只把 `shortCard`（压缩摘要）放进上下文与检索结果（热/温层）。
- **T0–T9 分层**：`tier` 越小越重要。T0 永久核心（身份/硬约束/安全/法律），T1–T3 长期（偏好/项目决策/待办），T8–T9 噪音/寒暄。
- **时间衰减 + 访问频率升降**：`effectiveTier = tier + ⌊age/30d⌋ − ⌊accessCount/5⌋`（纯派生，不破坏原值）。
- **热层常驻**：T0–T2 短卡经 `envPromptVars` + `ENV_PROMPT.md` 注入 system 前缀。
- **混合检索**：关键词命中 + 分层加权 + 时间近因 + 访问频率（对应文档「关键词+向量+T层+时间」；向量留作可扩展钩子）。
- **source_id 回取原话**：`mp_original` 解压冷层返回精确原文。
- **冲突不覆盖**：`mp_supersede` 标记 `superseded_by` / `supersedes`，旧记录停用但保留可回溯。

## 工具（前缀 `mp_`，避免与内置 `mem_*` 撞名）

| 工具 | 作用 |
| --- | --- |
| `mp_remember` | 存一条记忆（原文→冷层，短卡+分层→温层），返回 `source_id` |
| `mp_recall` | 混合检索，只回短卡；支持按 tier 过滤 |
| `mp_original` | 按 `source_id` 解压回取精确原文 |
| `mp_supersede` | 冲突关联：旧标 `superseded_by` 停用，新标 `supersedes` |
| `mp_set_tier` | 手动调层级 |
| `mp_forget` | 永久删除（含冷层原文），仅用于噪音/过时 |
| `mp_list` | 各层级条数概览 |

## 存储位置

`<部署 data 目录>/mempart-store.json`（温层记录）与 `mempart-cold.json`（冷层压缩原文）。每个部署数据相互隔离。

## 依赖

零外部依赖，仅用 `node:fs` / `node:zlib`，在沙箱与桌宠部署中均可稳定运行。
