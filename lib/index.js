/**
 * dsh-tavern-bridge — 酒馆（SillyTavern）中转插件。
 *
 * 在 dsh 进程内自建 HTTP 监听（默认 127.0.0.1:57421），把酒馆发来的
 * OpenAI 兼容请求转给 dsh agent，并把结果按流式协议吐回去。
 *
 * 与早期独立脚本（tavern_dsh_bridge.mjs）的关键差异：
 *   1. **不进 webServer**：端口自己定，不随 dsh 的 web server 漂移；
 *   2. **进程内直连**：走 ctx.get("agents") 与 ctx.on("session/event")，
 *      不再绕 /m/api 的 HTTP 往返，也彻底删掉了端口探测与自愈逻辑；
 *   3. **自带预设与技能**：装完即用，工作区默认建在桌面。
 *
 * 生命周期：apply() 里起服务，ctx.effect 的 disposer 关服务。
 * dsh 起来中转就在，dsh 关掉端口就释放。
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { normalizeOutput } from "./format.mjs";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 加载探针：写在模块顶层，用来区分「bundle 没加载」和「加载了但 apply 没跑」。
 * 出问题看 %USERPROFILE%\.dsh\tavern-bridge-probe.log 就知道卡在哪一步。
 */
function probe(line) {
  try {
    const dir = join(homedir(), ".dsh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tavern-bridge-probe.log"), `${new Date().toISOString()} ${line}\n`, {
      flag: "a",
    });
  } catch {}
}
probe("module imported");

/** 一次请求最多等多久（毫秒）。 */
const TURN_TIMEOUT_MS = 240_000;
/** 端口被占用时往后试几个。 */
const PORT_SCAN = 20;
/** 正文铺开的目标总时长与间隔上下限。 */
const TYPE_TARGET_MS = 2200;
const TYPE_MIN_GAP = 8;
const TYPE_MAX_GAP = 110;
/** 分块大小（字符）。 */
const PIECE_SIZE = 24;
/**
 * 一轮结束后会话保持活动多久（毫秒）再回收。
 *
 * 为什么不能立刻释放：dsh GUI 的会话列表只认活动 agent，
 * 一 dispose 会话就从界面消失，只剩磁盘文件。
 * 10 分钟足够 GUI 拉取、也给用户留了看历史的窗口。
 */
const SESSION_KEEPALIVE_MS = 10 * 60 * 1000;

export const name = "tavern-bridge";

/**
 * 不注入 webServer：本插件自己 listen，跟 dsh 的 web 端口无关。
 * 需要 agents 服务，但用 ctx.get 惰性取（headless 形态下取不到也不崩）。
 */
export const inject = [];

export const Config = z.object({
  port: z.number().default(57421),
  portFallback: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  workspace: z.string().default(""),
  agentPreset: z.string().default("tavern-roleplay"),
  provider: z.string().default("deepseek-official"),
  model: z.string().default("deepseek-flash"),
  reasoningEffort: z.string().default("high"),
  authToken: z.string().default(""),
  skillDeploy: z.string().default("if-missing"),
  saveTranscript: z.string().default("md"),
  debugDump: z.boolean().default(false),
});

// ── 插件入口 ────────────────────────────────────────────────
export function apply(ctx, rawConfig) {
  probe("apply() called");
  const cfg = withDefaults(rawConfig);
  const log = (m) => safeLog(ctx, "info", m);
  const warn = (m) => safeLog(ctx, "warn", m);

  /** 运行期状态（设置页要读）。 */
  const state = {
    listening: false,
    port: cfg.port,
    url: "",
    workspace: "",
    lastError: "",
    startedAt: 0,
    turns: 0,
    lastTurnMs: 0,
  };

  /** sessionId → 事件回调。全局只订阅一次，按会话分发。 */
  const listeners = new Map();

  const offSession = ctx.on("session/event", (session, event) => {
    const id = session?.id;
    if (!id) return;
    const fn = listeners.get(id);
    if (!fn) return;
    try {
      fn(event);
    } catch (e) {
      warn(`事件回调异常: ${e?.message ?? e}`);
    }
  });

  // 工作区 -> 技能 -> 注册到 dsh 工作区列表 -> 监听，按顺序执行；任一步失败都不拖垮 dsh。
  (async () => {
    try {
      state.workspace = ensureWorkspace(cfg, log, warn);
    } catch (e) {
      warn(`工作区准备失败: ${e?.message ?? e}`);
      state.workspace = resolve(homedir());
    }
    try {
      deploySkills(cfg, state.workspace, log, warn);
    } catch (e) {
      warn(`技能部署失败: ${e?.message ?? e}`);
    }
    // 把工作区登记进 dsh 的工作区列表 —— 装完插件就该在 GUI 里看到它，
    // 而不是等第一次聊天才冒出来。已注册过则直接复用。
    try {
      await registerWorkspace(null);
    } catch (e) {
      warn(`工作区登记失败: ${e?.message ?? e}`);
    }
    try {
      await startServer();
    } catch (e) {
      state.lastError = String(e?.message ?? e);
      warn(`监听失败: ${state.lastError}`);
    }
  })();

  /**
   * 确保工作区在 dsh 的工作区列表里。传 sessionId 时顺便把该会话挂进去。
   * 返回 Workspace 对象（拿不到就 undefined），调用方自己决定是否致命。
   */
  async function registerWorkspace(sessionId) {
    const registry = safeGet(ctx, "workspaceRegistry");
    if (!registry) {
      warn("workspaceRegistry 不可用，会话会显示为「未分组」");
      return undefined;
    }
    let ws = undefined;
    if (typeof registry.resolveByPath === "function") {
      ws = await registry.resolveByPath(state.workspace);
      if (!ws) {
        // cwd 是某个已注册工作区的子目录时，向上找最近的归给它
        let p = state.workspace;
        while (!ws && p && p.length > 3) {
          const cut = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
          if (cut <= 2) break;
          p = p.slice(0, cut);
          ws = await registry.resolveByPath(p);
        }
      }
    }
    if (!ws && typeof registry.create === "function") {
      ws = await registry.create(state.workspace);
      log(`已把工作区登记到 dsh: ${state.workspace}`);
      probe(`workspace registered: ${state.workspace}`);
    }
    if (ws && sessionId && typeof ws.attachSession === "function") {
      await ws.attachSession(sessionId);
      probe(`attached ${sessionId} to workspace`);
    }
    return ws;
  }

  ctx.effect(() => () => {
    try {
      offSession?.();
    } catch {}
    for (const fn of listeners.values()) {
      try {
        fn(null);
      } catch {}
    }
    listeners.clear();
    try {
      state.server?.close();
      state.listening = false;
      log("已停止监听");
    } catch {}
  });

  /** 起 HTTP 监听，端口占用时按配置往后找。 */
  async function startServer() {
    const bind = (port) =>
      new Promise((res2, rej) => {
        const srv = createServer((req, rsp) => {
          handleRequest(req, rsp).catch((e) => {
            warn(`请求处理异常: ${e?.message ?? e}`);
            try {
              if (!rsp.headersSent) sendJson(rsp, 500, { error: { message: String(e?.message ?? e) } });
              else rsp.destroy();
            } catch {}
          });
        });
        srv.once("error", rej);
        srv.listen(port, cfg.host, () => {
          srv.removeListener("error", rej);
          res2(srv);
        });
      });

    let port = cfg.port;
    let srv = null;
    try {
      srv = await bind(port);
    } catch (e) {
      if (e?.code !== "EADDRINUSE" || !cfg.portFallback) {
        throw new Error(
          e?.code === "EADDRINUSE"
            ? `端口 ${port} 已被占用（配置里 portFallback 为 false，不自动换端口）`
            : `${cfg.host}:${port} 监听失败: ${e?.message ?? e}`,
        );
      }
      warn(`端口 ${port} 被占用，往后找空闲端口…`);
      for (let i = 1; i <= PORT_SCAN; i++) {
        const p = cfg.port + i;
        try {
          srv = await bind(p);
          port = p;
          break;
        } catch {}
      }
      if (!srv) throw new Error(`端口 ${cfg.port}–${cfg.port + PORT_SCAN} 全部被占用`);
    }

    state.server = srv;
    state.port = port;
    state.listening = true;
    state.url = `http://${cfg.host}:${port}/v1`;
    state.startedAt = Date.now();
    probe(`listening on ${state.url}`);
    log(`已监听 ${state.url}（工作区 ${state.workspace}，预设 ${cfg.agentPreset}，模型 ${cfg.provider}/${cfg.model}）`);
  }

  // ── 路由 ──────────────────────────────────────────────────
  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${cfg.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      sendJson(res, 200, { ok: true, listening: state.listening, port: state.port });
      return;
    }

    if (req.method === "GET" && path === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [{ id: cfg.model, object: "model", owned_by: "dsh" }],
      });
      return;
    }

    // 设置页取状态用（仅回环可访问，服务本身也只绑回环）
    if (req.method === "GET" && (path === "/bridge/api/status" || path === "/tavern/api/status")) {
      sendJson(res, 200, {
        ok: true,
        listening: state.listening,
        port: state.port,
        url: state.url,
        baseUrl: state.url.replace(/\/v1$/, ""),
        workspace: state.workspace,
        agentPreset: cfg.agentPreset,
        provider: cfg.provider,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        portFallback: cfg.portFallback,
        skillDeploy: cfg.skillDeploy,
        hasToken: !!cfg.authToken,
        token: maskedToken(cfg.authToken),
        turns: state.turns,
        lastTurnMs: state.lastTurnMs,
        startedAt: state.startedAt,
        lastError: state.lastError,
      });
      return;
    }

    // 设置页要拉完整口令（复制按钮用），单独一个端点避免状态轮询里带明文
    if (req.method === "GET" && (path === "/bridge/api/token" || path === "/tavern/api/token")) {
      sendJson(res, 200, { ok: true, token: cfg.authToken || "" });
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleChat(req, res);
      return;
    }

    sendJson(res, 404, { error: { message: `未找到 ${req.method} ${path}` } });
  }

  // ── 对话入口 ──────────────────────────────────────────────
  async function handleChat(req, res) {
    if (cfg.authToken && !checkAuth(req, cfg.authToken)) {
      sendJson(res, 401, { error: { message: "invalid api key" } });
      return;
    }

    const body = await readJsonBody(req);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const wantsStream = body?.stream !== false;
    const prompt = buildPrompt(messages);
    const startedAt = Date.now();

    if (cfg.debugDump) dumpRequest(cfg, state, body, messages);

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!wantsStream) {
      try {
        const out = await runTurn(prompt);
        const { reasoning, content } = buildOutput(out);
        writeTranscript(cfg, state, prompt, { ...out, reasoning, content, ms: Date.now() - startedAt }, warn);
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: cfg.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              },
              finish_reason: "stop",
            },
          ],
          usage: out.usage || {},
        });
      } catch (e) {
        warn(`非流式错误: ${e?.message ?? e}`);
        sendJson(res, 500, { error: { message: String(e?.message ?? e) } });
      }
      return;
    }

    // ── 流式 ──
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    });
    res.write(sseChunk(id, cfg.model, { role: "assistant", content: "" }));

    const alive = () => !res.writableEnded && !res.destroyed;

    // 思维链真流式：dsh 每个 step 结束推一条 assistant/message，
    // 前几个 step 是工具调用（只有思维链没有正文），可以边生成边推。
    let sentReasoning = "";
    const pushReasoning = (r) => {
      if (!r || !alive()) return;
      sentReasoning += r;
      res.write(sseChunk(id, cfg.model, { reasoning_content: r }));
    };

    try {
      const out = await runTurn(prompt, (msg) => pushReasoning(msg.reasoning));
      const { reasoning, content } = buildOutput(out);

      writeTranscript(cfg, state, prompt, { ...out, reasoning, content, ms: Date.now() - startedAt }, warn);

      pushReasoning(reasoningTail(reasoning, sentReasoning));

      const pieces = content.match(new RegExp(`[\\s\\S]{1,${PIECE_SIZE}}`, "g")) || [];
      const gap = typingGap(pieces.length);
      for (const p of pieces) {
        if (!alive()) break;
        res.write(sseChunk(id, cfg.model, { content: p }));
        await sleep(gap);
      }
      res.write(sseChunk(id, cfg.model, {}, "stop"));
      if (out.usage) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: cfg.model,
            choices: [],
            usage: out.usage,
          })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e) {
      warn(`流式错误: ${e?.message ?? e}`);
      if (alive()) {
        res.write(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e) } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } finally {
      state.turns += 1;
      state.lastTurnMs = Date.now() - startedAt;
    }
  }

  // ── 跑一轮 agent ──────────────────────────────────────────
  /**
   * 新建一次性会话 → 发消息 → 等到 turn/end。
   * 每轮都新建会话：酒馆每次都带完整上下文，复用会话会让历史爆炸。
   */
  async function runTurn(prompt, onMessage = null) {
    const agents = safeGet(ctx, "agents");
    if (!agents || typeof agents.create !== "function") {
      throw new Error("dsh agents 服务不可用，无法创建会话");
    }

    const sessionId = randomUUID();
    const parts = new Map();
    const notified = new Set();
    let onEvent = null;

    const turnEnded = new Promise((res2) => {
      onEvent = (event) => {
        if (!event) {
          res2();
          return;
        }
        if (event.type === "assistant/message") {
          const seq = event.seq ?? 0;
          const e = extractMessage(event.data || {});
          const slot = parts.get(seq) || { text: "", reasoning: "", usage: null };
          slot.text += e.text;
          slot.reasoning += e.reasoning;
          if (e.usage) slot.usage = e.usage;
          parts.set(seq, slot);
          // 同一 seq 只回调一次，避免重复推给酒馆
          if (onMessage && !notified.has(seq)) {
            notified.add(seq);
            try {
              onMessage({ seq, text: e.text, reasoning: e.reasoning });
            } catch {}
          }
        } else if (event.type === "turn/end") {
          res2();
        }
      };
    });

    listeners.set(sessionId, onEvent);

    let handle = null;
    try {
      // 预设必须经 setup 挂载才真的装配（persona / skill-filesystem / tool-fs 等）。
      // 只传 meta.agentPreset 的话，会话名字对了但插件树没挂上 ——
      // 表现就是缺 skill 工具、技能目录永不发布，模型退回默认人设。
      const agentPresets = safeGet(ctx, "agentPresets");
      let presetId = cfg.agentPreset;
      let setup;
      if (agentPresets && typeof agentPresets.resolve === "function") {
        try {
          const composed = await agentPresets.resolve(presetId);
          if (typeof composed?.id === "string" && composed.id) presetId = composed.id;
          if (typeof agentPresets.mount === "function") {
            setup = async (agentCtx) => {
              await agentPresets.mount(agentCtx, composed.id);
            };
          } else {
            warn("agentPresets.mount 不可用（旧版 dsh），会话将以无预设方式创建");
          }
        } catch (e) {
          throw new Error(`预设 ${presetId} 解析失败: ${e?.message ?? e}`);
        }
      } else {
        warn("agentPresets 服务不可用，无法挂载预设");
      }

      handle = await agents.create({
        sessionId,
        meta: { cwd: state.workspace, agentPreset: presetId },
        agentOptions: {
          provider: cfg.provider,
          model: cfg.model,
          reasoningEffort: cfg.reasoningEffort,
        },
        ...(setup ? { setup } : {}),
      });

      // read-only：本会话只读，模型能读技能文件但写不了任何东西。
      try {
        setSandboxMode(handle.agent.session, "read-only");
      } catch (e) {
        warn(`设置只读沙箱失败: ${e?.message ?? e}`);
      }

      // 把会话挂到工作区注册表 —— 不挂的话 dsh 的会话列表里它落在「未分组」。
      // 工作区在启动时已登记，这里只做本轮的归属。
      try {
        await registerWorkspace(sessionId);
      } catch (e) {
        warn(`挂到工作区失败（会话本身不受影响）: ${e?.message ?? e}`);
      }

      const message = createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      });
      handle.agent.followup(message);

      await Promise.race([turnEnded, sleep(TURN_TIMEOUT_MS).then(() => {
        throw new Error(`等待响应超时（${TURN_TIMEOUT_MS / 1000}s）`);
      })]);

      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]);
      let text = "";
      let reasoning = "";
      let usage = null;
      for (const [, slot] of ordered) {
        text += slot.text;
        reasoning += slot.reasoning;
        if (slot.usage) usage = slot.usage;
      }
      return { text, reasoning, usage, sessionId };
    } finally {
      listeners.delete(sessionId);
      // **不要立刻 dispose**。dispose 会把 agent 从活会话表里摘掉，
      // dsh GUI 的会话列表只认「处于活动状态」的会话 —— 一释放，
      // 会话就只剩磁盘文件，界面里看不到（这正是之前工作区空空的原因）。
      // 交给延迟释放：留足时间让 GUI 拉到它，之后回收内存。
      if (handle && typeof handle.dispose === "function") {
        const timer = setTimeout(() => {
          Promise.resolve()
            .then(() => handle.dispose())
            .catch(() => {});
        }, SESSION_KEEPALIVE_MS);
        // 别让定时器拖住进程退出
        timer.unref?.();
      }
    }
  }
}

// ── 配置与路径 ──────────────────────────────────────────────
function withDefaults(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const pick = (k, d) => (c[k] === undefined || c[k] === null ? d : c[k]);
  return {
    port: Math.max(1, Math.min(65535, Math.trunc(Number(pick("port", 57421))) || 57421)),
    portFallback: pick("portFallback", true) !== false,
    host: String(pick("host", "127.0.0.1")) || "127.0.0.1",
    workspace: String(pick("workspace", "") || ""),
    agentPreset: String(pick("agentPreset", "tavern-roleplay")) || "tavern-roleplay",
    provider: String(pick("provider", "deepseek-official")) || "deepseek-official",
    model: String(pick("model", "deepseek-flash")) || "deepseek-flash",
    reasoningEffort: String(pick("reasoningEffort", "high")) || "high",
    authToken: String(pick("authToken", "") || ""),
    skillDeploy: String(pick("skillDeploy", "if-missing")) || "if-missing",
    saveTranscript: String(pick("saveTranscript", "md")) || "md",
    debugDump: pick("debugDump", false) === true,
  };
}

/**
 * 准备好工作区目录，并钉住技能搜索根。
 *
 * dsh 的 skill 搜索根是「最近的含标记文件（默认 .git）的上级目录」。
 * 工作区没有 .git 时 projectRoot 就是工作区本身 —— `<工作区>/.dsh/skills`
 * 正好排在第 100 位。但如果工作区被放进某个 git 仓库里，projectRoot
 * 会往上跑，技能就找不到了。这里建一个空 .git **目录**把它钉住：
 * 只作存在性标记，不初始化任何仓库，也不影响把工作区当普通文件夹用。
 */
function ensureWorkspace(cfg, log, warn) {
  const ws =
    cfg.workspace && cfg.workspace.trim()
      ? resolve(cfg.workspace.trim())
      : join(homedir(), "Desktop", "DSH酒馆");

  if (!existsSync(ws)) {
    mkdirSync(ws, { recursive: true });
    log(`已创建工作区 ${ws}`);
  }

  const marker = join(ws, ".git");
  if (!existsSync(marker)) {
    try {
      mkdirSync(marker, { recursive: true });
      log("已放置 .git 标记（让技能搜索根停在本次工作区）");
    } catch (e) {
      warn(`放置 .git 标记失败（技能可能搜不到）: ${e?.message ?? e}`);
    }
  }
  return ws;
}

/**
 * 把插件自带的 humanize-prose 同步到 `<工作区>/.dsh/skills/`。
 *
 * skillDeploy:
 *   if-missing  目标已存在就整个跳过（默认，不覆盖手改）
 *   overwrite   每次启动清掉重写
 *   never       什么都不做
 */
function deploySkills(cfg, workspace, log, warn) {
  if (cfg.skillDeploy === "never") return;
  const srcRoot = join(PKG_DIR, "assets", "skills");
  if (!existsSync(srcRoot)) {
    warn(`内置技能目录不存在: ${srcRoot}`);
    return;
  }
  const dstRoot = join(workspace, ".dsh", "skills");
  mkdirSync(dstRoot, { recursive: true });

  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = join(srcRoot, entry.name);
    const to = join(dstRoot, entry.name);
    if (existsSync(to)) {
      if (cfg.skillDeploy !== "overwrite") continue;
      rmrf(to);
    }
    copyDir(from, to);
    log(`已部署技能 ${entry.name}`);
  }
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) copyFileSync(a, b);
  }
}

function rmrf(p) {
  if (!existsSync(p)) return;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, e.name);
    if (e.isDirectory()) rmrf(q);
    else {
      try {
        unlinkSync(q);
      } catch {}
    }
  }
  try {
    rmdirSync(p);
  } catch {}
}

// ── 消息抽取 ────────────────────────────────────────────────
/**
 * 从事件 payload 抽正文与思维链。
 *
 * 两种形态都要认：
 *   - 摘要形态（SSE / history）：data.text / data.reasoning
 *   - 原始形态（ctx.on 拿到的内核事件）：data.message.content 是 ContentBlock[]，
 *     思维链在 { type:"reasoning" }、正文在 { type:"text" } 里。
 */
function extractMessage(data) {
  const out = { text: "", reasoning: "", usage: null };
  if (!data || typeof data !== "object") return out;

  if (typeof data.text === "string") out.text += data.text;
  if (typeof data.reasoning === "string") out.reasoning += data.reasoning;

  const blocks = data.message?.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "reasoning" && typeof b.text === "string") out.reasoning += b.text;
      else if (b.type === "text" && typeof b.text === "string") out.text += b.text;
    }
  }
  if (data.usage) out.usage = data.usage;
  return out;
}

// ── 产物整理 ────────────────────────────────────────────────
const SECTION_RE = /^\s*[【\[]([^\]】]+)[】\]]\s*$/;

/** 把 dsh 输出的 【段名】 分段拆成 { reasoning, content }。 */
function splitSections(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      if (cur) sections.push(cur);
      cur = { name: m[1].trim(), body: [] };
    } else {
      if (!cur) cur = { name: "", body: [] };
      cur.body.push(line);
    }
  }
  if (cur) sections.push(cur);

  if (sections.length <= 1 && (!sections[0] || !sections[0].name)) {
    return { reasoning: "", content: String(raw || "").trim() };
  }

  const REASONING_NAMES = /思维链|思考|推理|reasoning|think/i;
  let reasoning = "";
  const contentParts = [];
  for (const s of sections) {
    const body = s.body.join("\n").trim();
    if (!s.name) {
      if (body) contentParts.push(body);
      continue;
    }
    if (REASONING_NAMES.test(s.name)) reasoning += (reasoning ? "\n\n" : "") + body;
    else contentParts.push(`【${s.name}】\n${body}`);
  }
  return { reasoning: reasoning.trim(), content: contentParts.join("\n\n").trim() };
}

/** 三路思维链合并 + 抽内嵌 thinking + 修围栏。 */
function buildOutput(out) {
  const { reasoning: secReasoning, content: secContent } = splitSections(out.text || "");
  const norm = normalizeOutput(
    secContent,
    [out.reasoning, secReasoning].filter(Boolean).join("\n\n"),
  );
  return { reasoning: norm.reasoning, content: norm.content };
}

// ── 流式辅助 ────────────────────────────────────────────────
function sseChunk(id, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/**
 * 思维链里还没发过的部分。
 * 正常顺序是「原生思维链在前、正文内嵌的 <thinking> 在后」，直接用前缀切；
 * 顺序对不上时用 indexOf 把已发那段抠掉 —— 宁可重复，也不能整段丢。
 */
function reasoningTail(full, sent) {
  if (!full) return "";
  if (!sent) return full;
  if (full.startsWith(sent)) return full.slice(sent.length);
  const i = full.indexOf(sent);
  if (i >= 0) return full.slice(0, i) + full.slice(i + sent.length);
  return full;
}

/** 正文铺开间隔：目标 ~2.2s，夹在 8–110ms。 */
function typingGap(pieceCount) {
  if (!pieceCount) return 0;
  return Math.min(TYPE_MAX_GAP, Math.max(TYPE_MIN_GAP, Math.round(TYPE_TARGET_MS / pieceCount)));
}

// ── 杂项 ────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

function safeLog(ctx, level, msg) {
  try {
    const f = ctx?.logger?.[level];
    if (typeof f === "function") f.call(ctx.logger, `tavern-bridge: ${msg}`);
    else console.log(`tavern-bridge: ${msg}`);
  } catch {}
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve_({});
      try {
        resolve_(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req, token) {
  const h = req.headers["authorization"];
  if (typeof h === "string") {
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim() === token) return true;
  }
  const k = req.headers["x-api-key"];
  if (typeof k === "string" && k.trim() === token) return true;
  return false;
}

function maskedToken(t) {
  if (!t) return "";
  if (t.length <= 10) return t.slice(0, 2) + "…";
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

/**
 * 酒馆每次请求都带完整上下文（角色卡 + 世界书 + 历史），
 * 所以 dsh 会话必须一次性，这里把 messages 摊平成单个提示词。
 */
function buildPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
    if (m?.role === "system") parts.push(`[角色设定]\n${content}`);
    else if (m?.role === "user") parts.push(content);
    else if (m?.role === "assistant") parts.push(`[上一轮回复]\n${content}`);
  }
  return parts.join("\n\n");
}

function dumpRequest(cfg, state, body, messages) {
  try {
    const dir = join(state.workspace || homedir(), ".tavern-debug");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(dir, `req_${stamp}.json`), JSON.stringify({ body, messages }, null, 2), "utf8");
  } catch {}
}

// ── 会话存档 ────────────────────────────────────────────────
/**
 * 把这一轮写到工作区，方便直接在文件夹里回顾。
 *
 * 模型本身是 read-only 写不了东西（故意的），所以由插件来落盘 ——
 * 插件跑在 dsh 主进程，有自己的写权限。
 *
 * 布局：
 *   <工作区>/会话记录/2026-11-08/00-17-08-乳链.md
 *   <工作区>/会话记录/索引.md
 */
function writeTranscript(cfg, state, prompt, rec, warn) {
  if (cfg.saveTranscript === "off" || !state.workspace) return;
  try {
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hhmmss = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const title = titleOf(rec.content);
    const slug = safeName(title);

    if (cfg.saveTranscript === "json") {
      const dir = join(state.workspace, "会话记录");
      mkdirSync(dir, { recursive: true });
      const line = {
        time: now.toISOString(),
        day,
        title,
        sessionId: rec.sessionId,
        ms: rec.ms,
        provider: cfg.provider,
        model: cfg.model,
        effort: cfg.reasoningEffort,
        preset: cfg.agentPreset,
        usage: rec.usage || null,
        prompt,
        reasoning: rec.reasoning,
        content: rec.content,
      };
      appendFileSync(join(dir, "会话记录.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
      return;
    }

    // md（默认）
    const root = join(state.workspace, "会话记录");
    const dir = join(root, day);
    mkdirSync(dir, { recursive: true });
    let file = join(dir, `${hhmmss}-${slug}.md`);
    for (let i = 2; existsSync(file) && i < 100; i++) {
      file = join(dir, `${hhmmss}-${slug}-${i}.md`);
    }
    writeFileSync(file, renderTranscriptMd({ ...rec, prompt, title, day, hhmmss, cfg }), "utf8");

    const idx = join(root, "索引.md");
    if (!existsSync(idx)) {
      writeFileSync(idx, "# 会话记录索引\n\n| 日期 | 时间 | 字数 | 标题 | 文件 |\n|---|---|---|---|---|\n", "utf8");
    }
    appendFileSync(
      idx,
      `| ${day} | ${hhmmss.replace(/-/g, ":")} | ${rec.content.length} | ${title} | [${day}/${hhmmss}-${slug}.md](${day}/${encodeURI(`${hhmmss}-${slug}.md`).replace(/%20/g, "%20")}) |\n`,
      "utf8",
    );
  } catch (e) {
    warn(`写会话存档失败: ${e?.message ?? e}`);
  }
}

function renderTranscriptMd(r) {
  const sec = (s) => (s ? s.trim() : "");
  const prompt = r.prompt.length > 800 ? `${r.prompt.slice(0, 800)}\n\n…（完整提示词 ${r.prompt.length} 字，已截断）` : r.prompt;
  const usage = r.usage
    ? `\n> 用量 ${r.usage.inputTokens ?? "-"} in / ${r.usage.outputTokens ?? "-"} out`
    : "";

  const parts = [
    `# ${r.hhmmss.replace(/-/g, ":")} · ${r.title}`,
    "",
    `> ${r.day} · 耗时 ${(r.ms / 1000).toFixed(1)}s · 思维链 ${r.reasoning.length} 字 / 正文 ${r.content.length} 字`,
    `> ${r.cfg.provider}/${r.cfg.model} · 思考 ${r.cfg.reasoningEffort} · 预设 ${r.cfg.agentPreset}${usage}`,
    `> 会话 \`${r.sessionId}\``,
    "",
    "## 正文",
    "",
    sec(r.content) || "（空）",
    "",
  ];

  if (r.reasoning) {
    parts.push("---", "", "<details><summary>思维链（点击展开）</summary>", "", sec(r.reasoning), "", "</details>", "");
  }

  parts.push("---", "", "<details><summary>用户输入</summary>", "", sec(prompt), "", "</details>", "");
  return parts.join("\n");
}

/** 用正文首句做标题，最多 14 字。 */
function titleOf(content) {
  const first = String(content || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("<") && !s.startsWith("#"));
  if (!first) return "无标题";
  const clean = first.replace(/[\\/:*?"<>|\r\n\t]/g, "").replace(/^[「『"'“”‘’]+/, "");
  return clean.length > 14 ? `${clean.slice(0, 14)}…` : clean;
}

function safeName(s) {
  const out = String(s || "无标题")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out.slice(0, 24) || "无标题";
}

function pad(n) {
  return String(n).padStart(2, "0");
}
