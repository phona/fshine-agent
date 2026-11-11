/**
 * SPIKE-ONLY：通用 Agent 模式开关（对照实验臂）。
 *
 * 实验目的：把「不带 fshine 历史检索 / 召回底账 / 上下文状态 / 长期记忆注入」的通用
 * Agent 行为单独量出来，与现有编排臂做 A/B 对照。打开时只做三件事：
 *   ① 不注册 search_history / get_messages（复合历史入口整体撤掉）；
 *   ② runtime 拿不到 platformTasks / contextStates / memoryRecords（依赖缺失时既有
 *      守卫本来就不跑，见 runtime.ts 依赖投影处）；
 *   ③ 压缩跳过宿主 sidecar（pi 原生 compact 的摘要 + 保留尾巴照常）。
 *
 * 预期寿命：只活在这个 spike 分支上。对照报告合并后，开关、三个分支接线与测试一起
 * 删除；它不是产品开关，不写进 config/agent.yaml，也不进部署文档。最长保留到
 * 2026-12-31，到期未收口即视为遗留。
 *
 * 取值：未设置 / 空串 / `0` / `false` = 关闭（缺省臂）；`1` / `true`（大小写不敏感、
 * 两端空白忽略）= 打开。关闭时所有接线点都走原有分支，不改任何既有对象与顺序。
 */
export const SPIKE_GENERIC_MODE_ENV = 'FSHINE_SPIKE_GENERIC_AGENT';

/** 是否打开 spike 通用模式；`env` 缺省读进程环境，测试可显式传入。 */
export function isSpikeGenericModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[SPIKE_GENERIC_MODE_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
