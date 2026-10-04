/**
 * Agent API 输入校验器。
 *
 * 为什么手写而不是再引一个校验库：`input_schema` 就是**公布给 Agent 的那一份契约**
 * （GET /api/agent/tools 原样返回）。契约与执行分成两份定义时，一旦漂移就会出现
 * "Agent 照文档调用却被 400 拒绝、而文档看起来完全正确" —— 这种缺陷任何测试都发现不了，
 * 因为两份定义各自都自洽。这里让校验器只读那一份公布的 schema，二者必然同源。
 *
 * 支持的关键字就是 tools.ts 用到的那个子集：type / enum / required / additionalProperties /
 * default / minimum / maximum / minLength / maxLength / minItems / maxItems / items。
 * 其余描述性字段（description 等）忽略即可。
 */
import { AgentError } from "./errors.js";

export type JsonSchemaType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "number" ? "number" : typeof v;
}

function matchesType(value: unknown, t: JsonSchemaType): boolean {
  switch (t) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function describeExpected(schema: JsonSchema): string {
  if (schema.enum?.length) return `取值必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(" / ")}`;
  const t = Array.isArray(schema.type) ? schema.type.join(" 或 ") : (schema.type ?? "any");
  if (t === "integer" || t === "number") {
    const lo = schema.minimum !== undefined ? ` ≥ ${schema.minimum}` : "";
    const hi = schema.maximum !== undefined ? ` ≤ ${schema.maximum}` : "";
    return `必须是${t === "integer" ? "整数" : "数字"}${lo}${hi}`;
  }
  if (t === "string") {
    const lo = schema.minLength !== undefined ? `至少 ${schema.minLength} 个字符` : "";
    const hi = schema.maxLength !== undefined ? `不超过 ${schema.maxLength} 个字符` : "";
    return `必须是字符串${lo && hi ? `，${lo}且${hi}` : lo || hi ? `，${lo || hi}` : ""}`;
  }
  return `必须是 ${t}`;
}

function checkValue(key: string, value: unknown, schema: JsonSchema): unknown {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    throw new AgentError("bad_input", `字段「${key}」${describeExpected(schema)}，实际收到 ${typeName(value)} 类型的 ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new AgentError("bad_input", `字段「${key}」取值不在允许列表里（可用：${schema.enum.map((e) => JSON.stringify(e)).join(" / ")}），收到 ${JSON.stringify(value)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new AgentError("bad_input", `字段「${key}」不得小于 ${schema.minimum}，收到 ${value}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new AgentError("bad_input", `字段「${key}」不得大于 ${schema.maximum}，收到 ${value}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new AgentError("bad_input", `字段「${key}」至少 ${schema.minLength} 个字符，收到 ${value.length} 个`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new AgentError("bad_input", `字段「${key}」最长 ${schema.maxLength} 个字符，收到 ${value.length} 个（过长就缩小范围，不要一次要全部）`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new AgentError("bad_input", `字段「${key}」至少 ${schema.minItems} 项，收到 ${value.length} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new AgentError("bad_input", `字段「${key}」最多 ${schema.maxItems} 项，收到 ${value.length} 项`);
    if (schema.items) return value.map((v, i) => checkValue(`${key}[${i}]`, v, schema.items as JsonSchema));
  }
  return value;
}

/**
 * 按公布的 schema 校验并归一化输入：补 default、拒绝未知键、逐字段给出中文原因。
 * 返回值只含 schema 声明过的键，所以 handler 可以放心按名取用。
 */
export function validateAgentInput(schema: JsonSchema, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentError("bad_input", `input 必须是 JSON 对象，收到 ${typeName(raw)}`);
  }
  const input = raw as Record<string, unknown>;
  const props = schema.properties ?? {};
  const allowed = Object.keys(props);

  const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
  if (unknown.length > 0 && schema.additionalProperties === false) {
    throw new AgentError(
      "bad_input",
      `不认识的字段 ${unknown.map((k) => `「${k}」`).join("、")}；本工具只接受 ${
        allowed.length ? allowed.map((k) => `「${k}」`).join(" / ") : "无字段（空对象 {}）"
      }。字段名请照 GET /api/agent/tools 里的 input_schema 传。`,
    );
  }

  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const sub = props[key];
    const value = input[key];
    if (value === undefined) {
      if (sub.default !== undefined) { out[key] = sub.default; continue; }
      if ((schema.required ?? []).includes(key)) {
        throw new AgentError("bad_input", `缺少必填字段「${key}」（${describeExpected(sub)}）。${sub.description ?? ""}`.trim());
      }
      continue;
    }
    if (typeof value === "string" && value.trim() === "" && !sub.enum) continue;   // 空串按"未填"处理
    out[key] = checkValue(key, value, sub);
  }
  return out;
}
