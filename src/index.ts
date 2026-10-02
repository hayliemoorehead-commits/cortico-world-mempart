/** 扩展入口：默认导出 WorldDefinition。 */
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import { MemPartWorld } from './world.ts';

export const MEMPART: WorldDefinition<WorldSection> = {
  id: 'mempart',
  label: '记忆分区',
  defaults: () => ({ enabled: true }),
  create: (ctx) => new MemPartWorld(ctx),
};

export { MemPartWorld };
export default MEMPART;
