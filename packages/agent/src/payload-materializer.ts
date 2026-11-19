/**
 * 载荷型参数的物化（宿主装信封；owner 2026-11-19 拍板的设计）。
 *
 * 背景（live 实证）：`dummy.proposal` 这类操作要求模型自己造一个协议载荷文件，于是
 * `载荷文件读不到` / `Unknown field: operation,count` / `Token does not match` 连环撞。
 * 根治原则：**Worker 只关心「要执行什么」，不关心「怎么装信封」**——
 *   · 模型只给业务**值**（对象/数组）；大载荷用 run_js 产出数据文件并登记为 fileId；
 *   · 宿主负责 lint → 序列化落盘 → 把路径翻译进该参数 → 才提交执行层。
 *
 * 本模块是**纯函数**（零 import 面，除 node:fs/path 的确定性文件写）：给定 schema 与模型给的
 * 值，做**窄结构校验**（对象性 / required / 顶层类型 / additionalProperties 拒绝），合法则
 * 原子写进 `<taskDir>/in/<label>.json`，返回路径或结构化失败（missing/unknown）。不引第三方
 * schema 库（保持窄实现），不做业务判断，不触网、不 spawn。
 *
 * 契约（execution-contract.ts `ExecutionArgDeclaration.payload`）：schema 的具体语义归执行层；
 * 本模块只实现「足够让模型一轮改对」的最小子集——多余/缺失/写法不对都如实回报，不猜、不补。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 单份载荷上限（缺省 5 MiB）：超过即拒（不落盘、不给执行面）。 */
export const PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 物化结果：成功给路径；失败给**结构化**缺什么（missing）与多出来/写法不对（unknown）。
 * 非对象与非法的失败 missing/unknown 可能同时为空（形态错，不是字段错）。
 */
export type PayloadMaterializeResult =
  | { ok: true; path: string }
  | { ok: false; missing: string[]; unknown: string[] };

interface ValueSchema {
  type?: unknown;
  required?: unknown;
  properties?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  minLength?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 顶层类型吻合的窄判定（只认 JSON 基本类型；未知/缺省类型声明一律放行）。 */
function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return asRecord(value) !== undefined;
    case undefined:
    case null:
      return true;
    default:
      // 未识别的类型声明：不裁决（执行层 schema 是权威，宿主只做窄实现）。
      return true;
  }
}

/** 违规路径的展示形态：根值用 `(root)`，其余原样（`records[2].value` / `[2].name`）。 */
function displayPath(path: string): string {
  return path === '' ? '(root)' : path;
}

/** 整数型上限/下限声明的读取：只认非负整数，其余形状不裁决。 */
function limitOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 窄值校验（递归但只覆盖执行层声明用到的子集）：对象 required/additionalProperties、
 * 数组 items/minItems/maxItems、string minLength、基本类型。schema 未声明/未识别的构造
 * 一律不裁决（执行层 schema 是权威，宿主只做窄实现）。
 *
 * 违规以路径记入 missing（必填缺失）或 unknown（值形态不符/多出来）：
 *   · 根值 `(root)`；对象字段 `collection`；数组元素 `records[2]`；
 *   · 数组超上限记 `records>maxItems:500`（"多出来"的机械形态）。
 */
function lintValue(value: unknown, schema: unknown, path: string, out: { missing: string[]; unknown: string[] }): void {
  const spec = asRecord(schema) as ValueSchema | undefined;
  if (spec === undefined) return;
  if (spec.type === 'object') {
    const required = Array.isArray(spec.required)
      ? spec.required.filter((key): key is string => typeof key === 'string')
      : [];
    const record = asRecord(value);
    if (record === undefined) {
      // 非对象值：必填全部缺失（值形态错，不能逐字段判定）。
      out.missing.push(...required.map((key) => (path === '' ? key : `${path}.${key}`)));
      return;
    }
    const properties = asRecord(spec.properties) ?? {};
    for (const key of required) {
      if (record[key] === undefined) out.missing.push(path === '' ? key : `${path}.${key}`);
    }
    for (const [key, item] of Object.entries(record)) {
      const child = path === '' ? key : `${path}.${key}`;
      const declared = properties[key];
      if (declared === undefined) {
        // additionalProperties:false 才拒额外字段；缺省/true 允许。
        if (spec.additionalProperties === false) out.unknown.push(child);
        continue;
      }
      lintValue(item, declared, child, out);
    }
    return;
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) {
      out.unknown.push(displayPath(path));
      return;
    }
    const minItems = limitOf(spec.minItems);
    if (minItems !== undefined && value.length < minItems) out.missing.push(displayPath(path));
    const maxItems = limitOf(spec.maxItems);
    if (maxItems !== undefined && value.length > maxItems) {
      out.unknown.push(`${displayPath(path)}>maxItems:${maxItems}`);
    }
    if (spec.items !== undefined) {
      for (const [index, item] of value.entries()) lintValue(item, spec.items, `${path}[${index}]`, out);
    }
    return;
  }
  if (!matchesType(value, spec.type)) {
    out.unknown.push(displayPath(path));
    return;
  }
  const minLength = limitOf(spec.minLength);
  if (spec.type === 'string' && minLength !== undefined && typeof value === 'string' && value.length < minLength) {
    out.unknown.push(displayPath(path));
  }
}

/**
 * 窄结构校验：对象性 / required / 属性类型 / additionalProperties，数组的
 * items / minItems / maxItems，string 的 minLength（见 `lintValue`）。
 * 返回 missing（必填缺失）与 unknown（额外字段或值形态不符）——两类都非空即通过。
 * schema 不是对象/不适用时不裁决（放行）。
 */
export function lintPayload(value: unknown, schema: unknown): { missing: string[]; unknown: string[] } {
  const out = { missing: [] as string[], unknown: [] as string[] };
  lintValue(value, schema, '', out);
  return out;
}

/** 载荷文件名 label：只保留安全字符（param 名派生；越界形状不参与路径拼接）。 */
function safeLabel(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, '');
  return sanitized === '' ? 'payload' : sanitized;
}

/**
 * lint + 落盘到 `<taskDir>/in/<label>.json`（原子写：同目录 tmp + rename）。
 * 违规（缺字段/未知字段/非对象/超大）一律不落盘——绝不让不合规内容到执行面。
 */
export function materializePayload(input: {
  taskDir: string;
  label: string;
  value: unknown;
  schema?: unknown;
  maxBytes?: number;
}): PayloadMaterializeResult {
  const lint = lintPayload(input.value, input.schema);
  if (lint.missing.length > 0 || lint.unknown.length > 0) {
    return { ok: false, missing: lint.missing, unknown: lint.unknown };
  }
  const json = JSON.stringify(input.value);
  const maxBytes = input.maxBytes ?? PAYLOAD_MAX_BYTES;
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    return { ok: false, missing: [], unknown: [] };
  }
  const inDir = path.join(input.taskDir, 'in');
  mkdirSync(inDir, { recursive: true });
  const file = path.join(inDir, `${safeLabel(input.label)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${json}\n`);
  renameSync(tmp, file);
  return { ok: true, path: file };
}
