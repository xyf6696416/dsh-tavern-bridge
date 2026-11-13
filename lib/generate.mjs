/**
 * 阶段 2：脱离 dsh agent 的生成层。
 *
 * 直接把酒馆的原始 messages 交给 ctx.llm，不建会话、不挂预设、不带工具，
 * 因此上下文里没有 persona、没有 runtime-context、没有 skill-catalog。
 *
 * 传输走 `llm.prepareCall()` + `prepared.stream()` —— 这是 dsh-agent-loop
 * 自己用的入口，等于白拿密钥、重试、代理、超时和错误分类，不用自己拉 HTTP。
 *
 * chunk 形状（dsh-llm/lib/types/assistant-stream.js）：
 *   { type: 'text-delta',      index, text }
 *   { type: 'reasoning-delta', index, text }
 *   { type: 'tool-call-delta', index, id, name?, argumentsDelta }
 *   { type: 'block-start' | 'block-end' | 'usage' | 'finish' }
 * 所以这里是**逐字真流式**，不像会话格式那样把增量折叠掉。
 */
import {
  createSystemMessage,
  createUserMessage,
  createAssistantMessage,
} from "@deepseek-ai/dsh-llm";

/** 把 OpenAI 的 content（字符串或多模态数组）压成纯文本。 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("");
  }
  return content == null ? "" : String(content);
}

/**
 * 酒馆 messages → dsh message 结构，顺便把 extraSystem 并进系统消息。
 *
 * 合并策略：追加到酒馆**自己那条 system 的末尾**，不新开一条。
 * 这样模型看到的是「酒馆预设 + 写作规范 + 技能」一整块，没有额外层级，
 * 酒馆的世界书/角色卡/格式契约仍然是第一优先。
 */
export function toDshMessages(messages, extraSystem) {
  const extra = typeof extraSystem === "string" ? extraSystem.trim() : "";
  const list = Array.isArray(messages) ? messages : [];

  const merged = [];
  let systemDone = false;
  for (const m of list) {
    const role = typeof m?.role === "string" ? m.role : "user";
    const text = contentText(m?.content);
    if (role === "system") {
      if (!systemDone && extra) {
        merged.push({ role: "system", text: `${text}\n\n${extra}` });
        systemDone = true;
      } else {
        merged.push({ role: "system", text });
      }
      continue;
    }
    merged.push({ role, text });
  }
  if (!systemDone && extra) merged.unshift({ role: "system", text: extra });

  const out = [];
  for (const m of merged) {
    if (m.role === "system") {
      out.push(createSystemMessage(m.text));
    } else if (!m.text) {
      // 空正文的 user/assistant 直接丢：adapter 对空 content 会报错
      continue;
    } else if (m.role === "assistant") {
      out.push(
        createAssistantMessage({
          content: m.text ? [{ type: "text", text: m.text }] : [],
          source: {},
        }),
      );
    } else {
      // user 以及任何意外角色（tool / developer）一律当 user，保住内容不丢
      out.push(
        createUserMessage({
          content: m.text ? [{ type: "text", text: m.text }] : [],
          source: { kind: "user" },
        }),
      );
    }
  }
  return out;
}

/**
 * 直连生成一轮，边收边回调。
 *
 * @param llm     dsh 的 llm 服务（ctx.get("llm")）
 * @param cfg     含 provider / model / reasoningEffort
 * @param messages 酒馆原始 messages
 * @param extraSystem 要并进 system 的内容（写作规范 + 技能文件）
 * @param onReasoning 收到思维链增量
 * @param onContent   收到正文增量
 * @param signal  AbortSignal
 */
export async function generateStream({
  llm,
  cfg,
  messages,
  extraSystem,
  onReasoning,
  onContent,
  signal,
}) {
  if (!llm || typeof llm.prepareCall !== "function") {
    throw new Error("dsh llm 服务不可用，无法直连生成");
  }

  const dshMessages = toDshMessages(messages, extraSystem);
  if (dshMessages.length === 0) throw new Error("没有可发送的消息");

  const selection = {
    provider: cfg.provider,
    model: cfg.model,
    ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
  };

  let prepared;
  try {
    prepared = await llm.prepareCall(selection, signal);
  } catch (e) {
    // prepareCall 失败（无适配器之类）不该直接崩，退回裸 stream
    prepared = undefined;
    if (typeof llm.stream !== "function") throw e;
  }

  const config = prepared?.config ?? selection;
  const request = { ...config, messages: dshMessages };
  const stream = prepared?.stream ? prepared.stream(request) : llm.stream(request);

  let content = "";
  let reasoning = "";
  let usage = null;
  let finish = null;
  /** 上游结束原因的 kind（stopped / error / max-tokens / aborted …）。 */
  let finishKind = "";
  /** 上游结束原因里携带的具体失败描述。 */
  let finishFailure = "";

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (!chunk || typeof chunk !== "object") continue;
      switch (chunk.type) {
        case "reasoning-delta":
          if (chunk.text) {
            reasoning += chunk.text;
            if (onReasoning) onReasoning(chunk.text);
          }
          break;
        case "text-delta":
          if (chunk.text) {
            content += chunk.text;
            if (onContent) onContent(chunk.text);
          }
          break;
        case "usage":
          usage = chunk.usage ?? chunk;
          break;
        case "finish": {
          finish = chunk;
          /**
           * finish.reason 是**对象**不是字符串，实测形状：
           *   { kind: 'error', failure: { message, code } }
           * 直接 String() 会得到 "[object Object]"，所以逐层取。
           */
          const r = chunk.reason;
          if (typeof r === "string") {
            finishKind = r;
          } else if (r && typeof r === "object") {
            finishKind = String(r.kind ?? "");
            const f = r.failure;
            if (f && typeof f === "object") {
              finishFailure = [f.message, f.code].filter(Boolean).join("（") + (f.code ? "）" : "");
            } else if (typeof f === "string") {
              finishFailure = f;
            }
          }
          break;
        }
        default:
          break;
      }
    }
  } catch (e) {
    /**
     * 流中途报错：已经收到的正文不能丢（用户要的就是那些字），
     * 但必须把「不完整」这件事告诉调用方 —— 否则半截话会被当成完整回复。
     * 这里不 throw，改成把失败原因挂到返回值上，由上层决定怎么告知用户。
     */
    if (!content) throw e;
    return {
      content,
      reasoning,
      usage,
      finish,
      finishKind: finishKind || "error",
      failure: `上游中途中断：${e?.message ?? e}`,
    };
  }

  // 正文已经吐了一部分但上游是异常收尾 → 这条回复不完整，要标出来
  const badKind = finishKind && !/^(stopped|stop|completed|end_turn|end-turn)$/i.test(finishKind);
  const failure = badKind
    ? `上游以 ${finishKind} 结束${finishFailure ? `：${finishFailure}` : ""}`
    : finishFailure
      ? `上游报告失败${finishFailure}`
      : "";

  return { content, reasoning, usage, finish, finishKind, failure };
}
