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
import { generateStream } from "./generate.mjs";
import { buildRoutePrompt, readMaterials, composeExtraSystem } from "./prepare.mjs";

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

/**
 * 直连模式下并进 system 的写作规范。
 *
 * 这些内容以前住在 agent 预设的 persona 里；直连不走 agent，所以搬到这里，
 * 由插件在组装 messages 时追加到酒馆那条 system 的末尾。
 * 露骨提示按用户要求保留 —— 它是「怎么写」的约束，不是「写什么」。
 */
const TAVERN_WRITING_RULES = `【写作规范】

1. 只输出创作内容本身。不要输出解释、标题、前言、总结或任何元评论。
2. 严格遵循设定材料里的角色性格、说话方式、写作风格与内容边界。
   格式、标签、块结构、思维链位置与写法，一律以设定材料为准：一个都不能少、
   不能改、不能自己编造新标签。
3. 使用简体中文。代码、命令、路径、文件名、标识符与专有名词保持原样。

【正文最低标准】

1. 平均句长 ≥ 30 字。段落可以短，句子必须有长的。
2. 不写「她感到 XX」。改成身体动作：手放哪、眼睛看哪、呼吸什么样。
3. 亲密场景里，一个动作至少铺 300 字（预备 / 接触 / 推进 / 反应 / 停留）。
4. 身体部位用解剖学原名，一个代称都不留。
   禁：那里 / 那处 / 那个地方 / 最敏感的地方 / 前端 / 底部 / 深处 / 那道 / 那根。
   用：龟头、冠状沟、马眼、系带、阴茎体、根部、阴囊、睾丸、会阴；
       阴唇、阴蒂、阴道、宫口、乳头、乳晕。
5. 每个动作句都要有「谁 + 做什么 + 对谁」。缺受力方必然模糊。
6. 结尾停在一个动作上。不总结、不升华、不回望。`;

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
  /**
   * 引擎：
   *   direct —— 两阶段。阶段 1 用 agent 做技能按需加载（只读文件不写正文），
   *             阶段 2 拿酒馆原始 messages 直连 ctx.llm 生成，不带任何 agent 痕迹。
   *   agent  —— 旧路径。整段提示词塞进一个带预设的会话跑完整一轮。
   * 出问题时把 engine 改回 agent 就能一键回退。
   */
  engine: z.string().default("direct"),
  /**
   * 路由表：酒馆里换模型名 = 换路由，不用重启 dsh、不用改地址。
   *
   * 每一项的 `id` 就是要在酒馆「模型」里填的字符串。命中后下面这些字段
   * 覆盖同名全局配置；没写的字段沿用全局值 —— 所以一条路由只写差异即可。
   *
   * 为什么能这么干：酒馆的 model 字段在整条链路上是纯字符串透传
   * （前端 generate_data.model → 服务端 requestBody.model → 原样 POST），
   * 没有任何白名单。插件这边原本没读 body.model，读一下就能分流。
   *
   * 命名避开 `/`：酒馆 CUSTOM 分支对 /^koboldcpp\// 有特判，带斜杠容易被误处理。
   */
  routes: z
    .array(
      z.object({
        id: z.string().default(""),
        engine: z.string().default(""),
        /** agent 路由用的预设；空 = 沿用 agentPreset。 */
        preset: z.string().default(""),
        /** direct 路由阶段 1 用的预设；空 = 沿用 preparePreset。 */
        preparePreset: z.string().default(""),
        provider: z.string().default(""),
        model: z.string().default(""),
        reasoningEffort: z.string().default(""),
        prepareReasoningEffort: z.string().default(""),
        /** 0 = 沿用全局 prepareTimeoutMs。 */
        prepareTimeoutMs: z.number().default(0),
        /** 0 = 沿用全局 prepareMaxChars。 */
        prepareMaxChars: z.number().default(0),
        /** 本路由可见的工具白名单；空 = 沿用全局 allowTools。 */
        allowTools: z.array(z.string()).default([]),
        /** 是否隐藏全局工具；不写 = 沿用全局 trimTools。 */
        trimTools: z.boolean(),
      }),
    )
    .default([]),
  /**
   * 请求的模型名一个路由都没命中时走哪条。
   * 留空 = 用下面的全局单值配置（engine / provider / model …）。
   */
  defaultRoute: z.string().default(""),
  agentPreset: z.string().default("tavern-roleplay"),
  /** 阶段 1 专用的轻量预设（只判断 + 读文件）。 */
  preparePreset: z.string().default("tavern-prep"),
  /** 阶段 1 最多等多久（毫秒）。判完就该停，给短一点。 */
  prepareTimeoutMs: z.number().default(20_000),
  /** 阶段 1 的思考档位：只做题材判断，不需要 high。 */
  prepareReasoningEffort: z.string().default("low"),
  /**
   * 阶段 1 输入的字符预算。酒馆提示词完整传入，只有超过这个数才压缩对话历史
   * （设定材料永远不截）。角色卡/世界书特别长时把这个值调大。
   */
  prepareMaxChars: z.number().default(60_000),
  /** 技能根目录。留空 = <工作区>/.dsh/skills。 */
  skillDir: z.string().default(""),
  /**
   * 额外保留的**全局**工具名。默认 [] = 隐藏所有全局工具。
   *
   * 为什么要有这个：dsh 的工具按上下文继承，预设只能加不能减，
   * 所以全局挂载的工具会跟着每一轮酒馆请求一起重发。实测一轮 43 个工具
   * / 33 KB / 约 9k tokens，其中 32 个是 MCP（26 个 chrome-devtools），
   * 与写小说完全无关。
   *
   * 注意这里**不需要**写 skill / read：它们是预设（tool-skill / tool-fs）
   * 挂在本 agent scope 上的「本地工具」，本来就不受裁剪影响、永远可见。
   * 只有想额外放开某个全局工具时才往这里加名字。
   *
   * 想完全关掉裁剪（排查问题时）：把 trimTools 设成 false。
   */
  allowTools: z.array(z.string()).default([]),
  /** 是否隐藏全局工具（chrome-devtools MCP、edit、write…）。默认 true。 */
  trimTools: z.boolean().default(true),
  provider: z.string().default("codebuddy"),
  model: z.string().default("deepseek-v4.1-flash"),
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
    /** 上一轮实际命中的路由（设置页显示，"为什么走了这条"一眼可见）。 */
    lastRoute: null,
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
      // 酒馆的状态检查会 GET {custom_url}/models 来填模型下拉框，
      // 所以这里把路由表整份吐出去 —— 配了路由之后，在酒馆里直接选就行，不用手打。
      const ids = (cfg.routes || []).map((r) => r.id);
      if (ids.length === 0) ids.push(cfg.model);
      sendJson(res, 200, {
        object: "list",
        data: ids.map((id) => ({ id, object: "model", owned_by: "dsh" })),
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
        engine: cfg.engine,
        agentPreset: cfg.agentPreset,
        preparePreset: cfg.preparePreset,
        provider: cfg.provider,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        routes: cfg.routes || [],
        defaultRoute: cfg.defaultRoute,
        lastRoute: state.lastRoute,
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

    // 用酒馆传来的模型名分流。没配 routes 时 resolveRoute 会落到全局单值配置，
    // 行为和改造前完全一样。
    const route = resolveRoute(cfg, body?.model);
    state.lastRoute = {
      at: Date.now(),
      routeId: route.routeId,
      matchedBy: route.matchedBy,
      requestedModel: route.requestedModel,
      engine: route.engine,
      provider: route.provider,
      model: route.model,
    };
    if (cfg.routes && cfg.routes.length > 0) {
      probe(
        `route: request="${route.requestedModel}" → ${route.routeId || "(global)"} via ${route.matchedBy} engine=${route.engine} ${route.provider}/${route.model}`,
      );
    }

    if (route.engine === "direct") {
      await handleChatDirect(req, res, messages, wantsStream, route);
      return;
    }

    const prompt = buildPrompt(messages);
    const startedAt = Date.now();

    if (cfg.debugDump) dumpRequest(cfg, state, body, messages);

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!wantsStream) {
      try {
        const out = await runTurn(prompt, { route });
        const { reasoning, content } = buildOutput(out);
        probe(
          `agent/done: steps=[${(out.toolSteps || []).join(",")}] dropped=${(out.droppedText || "").length} content=${content.length} reasoning=${reasoning.length} ms=${Date.now() - startedAt}${out.turnFailure ? ` partial=${out.turnFailure}` : ""}`,
        );
        writeTranscript(cfg, state, prompt, { ...out, reasoning, content, ms: Date.now() - startedAt }, warn);
        // 非流式没法像流式那样在末尾塞 error 帧，只能用 finish_reason 表达。
        // 酒馆本身不读这个字段，但 OpenAI 兼容客户端普遍会看，写上不影响任何东西；
        // 真正让人知道「不完整」的是 body 里的 bridge_partial。
        if (out.turnFailure) warn(`本轮正文不完整: ${out.turnFailure}`);
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: route.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              },
              finish_reason: out.turnFailure ? "length" : "stop",
            },
          ],
          usage: out.usage || {},
          ...(out.turnFailure
            ? {
                bridge_partial: {
                  reason: out.turnFailure,
                  message: "正文不完整：已收到的部分照常返回，但这条回复没有正常收尾。",
                },
              }
            : {}),
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
    res.write(sseChunk(id, route.model, { role: "assistant", content: "" }));

    const alive = () => !res.writableEnded && !res.destroyed;

    // 思维链真流式：dsh 每个 step 结束推一条 assistant/message，
    // 前几个 step 是工具调用（只有思维链没有正文），可以边生成边推。
    let sentReasoning = "";
    const pushReasoning = (r) => {
      if (!r || !alive()) return;
      sentReasoning += r;
      res.write(sseChunk(id, route.model, { reasoning_content: r }));
    };

    try {
      const out = await runTurn(prompt, {
        route,
        onMessage: (msg) => pushReasoning(msg.reasoning),
      });
      const { reasoning, content } = buildOutput(out);

      probe(
        `agent/done: steps=[${(out.toolSteps || []).join(",")}] dropped=${(out.droppedText || "").length} content=${content.length} reasoning=${reasoning.length} ms=${Date.now() - startedAt}${out.turnFailure ? ` partial=${out.turnFailure}` : ""}`,
      );

      writeTranscript(cfg, state, prompt, { ...out, reasoning, content, ms: Date.now() - startedAt }, warn);

      pushReasoning(reasoningTail(reasoning, sentReasoning));

      const pieces = content.match(new RegExp(`[\\s\\S]{1,${PIECE_SIZE}}`, "g")) || [];
      const gap = typingGap(pieces.length);
      for (const p of pieces) {
        if (!alive()) break;
        res.write(sseChunk(id, route.model, { content: p }));
        await sleep(gap);
      }
      res.write(sseChunk(id, route.model, {}, out.turnFailure ? "length" : "stop"));
      if (out.usage) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: route.model,
            choices: [],
            usage: out.usage,
          })}\n\n`,
        );
      }
      // 半截正文：正文已经发完，再补一条 error 让酒馆弹提示。
      // 酒馆不读 finish_reason，只认流里的 data.error（见 openai.js 的
      // tryParseStreamingError），所以这里必须写成 error 对象，
      // 否则用户永远不知道这条回复是被上游掐断的。
      //
      // 这里不用像 direct 那样分开写「有正文/没正文」两套文案：
      // runTurn 在「失败且正文为空」时已经直接抛了，走不到这条分支。
      if (out.turnFailure) {
        warn(`本轮正文不完整: ${out.turnFailure}`);
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: `正文不完整（${out.turnFailure}）。已收到的部分照常显示，但这条回复没有正常收尾。`,
              type: "bridge_partial",
            },
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

  /**
   * 直连路径（engine: direct）—— 两阶段。
   *
   * 阶段 1：agent 只做技能按需加载（判断 + 读文件，不写正文），
   *         插件从 tool/call 收路径，内容自己读全文。
   * 阶段 2：酒馆原始 messages + 写作规范 + 素材 → ctx.llm 逐字流式生成。
   *
   * 阶段 2 的上下文里没有任何 agent 成分：无 persona、无 runtime-context、
   * 无 skill-catalog、无工具。这是整条改造的目的。
   */
  async function handleChatDirect(req, res, messages, wantsStream, route) {
    const startedAt = Date.now();
    const prompt = buildPrompt(messages);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // 生成层只认 provider / model / reasoningEffort 三项，所以直接把路由投影过去。
    const genCfg = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
    };

    // ── 阶段 1：素材准备 ──
    const skillRoot =
      cfg.skillDir || (state.workspace ? join(state.workspace, ".dsh", "skills", "humanize-prose") : "");
    let files = [];
    try {
      const t0 = Date.now();
      const prep = await runTurn(buildRoutePrompt(messages, { maxChars: route.prepareMaxChars }), {
        presetId: route.preparePreset,
        collectPaths: true,
        timeoutMs: route.prepareTimeoutMs,
        reasoningEffort: route.prepareReasoningEffort,
        route,
      });
      files = skillRoot ? readMaterials(prep.paths, skillRoot, warn) : [];
      log(`阶段1 路由：read ${prep.paths.length} 次 → 收录 ${files.length} 份，${Date.now() - t0}ms`);
      probe(
        `direct/prepare: reads=${prep.paths.length} files=${files.length} bytes=${files.reduce((a, f) => a + f.bytes, 0)} ms=${Date.now() - t0}`,
      );
    } catch (e) {
      // 阶段 1 挂掉不该拖死整轮：没有素材也能写，只是文风会退一点
      warn(`阶段1 失败，本轮不带技能继续: ${e?.message ?? e}`);
      probe(`direct/prepare FAILED: ${e?.message ?? e}`);
    }

    const extraSystem = composeExtraSystem(TAVERN_WRITING_RULES, files);
    const llm = safeGet(ctx, "llm");

    // ── 阶段 2：非流式 ──
    if (!wantsStream) {
      try {
        const out = await generateStream({ llm, cfg: genCfg, messages, extraSystem });
        /**
         * 空正文 + 有失败原因 → 抛，和 agent 路径保持一致的判断标准。
         * 否则酒馆只会看到 200 + 空字符串，用户以为模型懒得说话，
         * 而真实原因（多半是 content_filter）被彻底吞掉。
         */
        if (out.failure && !out.content.trim()) throw new Error(out.failure);
        writeTranscript(
          cfg,
          state,
          prompt,
          { text: out.content, reasoning: out.reasoning, content: out.content, usage: out.usage, ms: Date.now() - startedAt },
          warn,
        );
        if (out.failure) warn(`本轮正文不完整: ${out.failure}`);
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: route.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: out.content,
                ...(out.reasoning ? { reasoning_content: out.reasoning } : {}),
              },
              finish_reason: out.failure ? "length" : "stop",
            },
          ],
          usage: out.usage || {},
          ...(out.failure
            ? {
                bridge_partial: {
                  reason: out.failure,
                  message: "正文不完整：已收到的部分照常返回，但这条回复没有正常收尾。",
                },
              }
            : {}),
        });
      } catch (e) {
        warn(`直连非流式错误: ${e?.message ?? e}`);
        sendJson(res, 500, { error: { message: String(e?.message ?? e) } });
      } finally {
        state.turns += 1;
        state.lastTurnMs = Date.now() - startedAt;
      }
      return;
    }

    // ── 阶段 2：流式（真逐字） ──
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    });
    res.write(sseChunk(id, route.model, { role: "assistant", content: "" }));
    const alive = () => !res.writableEnded && !res.destroyed;

    try {
      const out = await generateStream({
        llm,
        cfg: genCfg,
        messages,
        extraSystem,
        onReasoning: (t) => {
          if (alive()) res.write(sseChunk(id, route.model, { reasoning_content: t }));
        },
        onContent: (t) => {
          if (alive()) res.write(sseChunk(id, route.model, { content: t }));
        },
      });

      writeTranscript(
        cfg,
        state,
        prompt,
        { text: out.content, reasoning: out.reasoning, content: out.content, usage: out.usage, ms: Date.now() - startedAt },
        warn,
      );

      res.write(sseChunk(id, route.model, {}, out.failure ? "length" : "stop"));
      if (out.usage) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: route.model,
            choices: [],
            usage: out.usage,
          })}\n\n`,
        );
      }
      // 有失败原因就补一条错误帧：酒馆不读 finish_reason，只认流里的 data.error。
      // 两种情况文案不同 —— 有正文时正文已经发出去了，说「部分显示」；
      // 没正文时什么都不显示，用户最困惑，必须说清楚是上游出的问题。
      if (out.failure) {
        const hasContent = !!out.content.trim();
        warn(`本轮${hasContent ? "正文不完整" : "没有取到正文"}: ${out.failure}`);
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: hasContent
                ? `正文不完整（${out.failure}）。已收到的部分照常显示，但这条回复没有正常收尾。`
                : `没有取到正文（${out.failure}）。这是上游在生成阶段就中断了，不是桥接问题。`,
              type: "bridge_partial",
            },
          })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
      probe(
        `direct/done: content=${out.content.length} reasoning=${out.reasoning.length} finish=${out.finishKind || "-"} ms=${Date.now() - startedAt}${out.failure ? ` partial=${out.failure}` : ""}`,
      );
    } catch (e) {
      warn(`直连流式错误: ${e?.message ?? e}`);
      probe(`direct/stream FAILED: ${e?.message ?? e}`);
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
  async function runTurn(prompt, options = {}) {
    const {
      onMessage = null,
      presetId: presetOverride = null,
      collectPaths = false,
      timeoutMs = TURN_TIMEOUT_MS,
      reasoningEffort = null,
      route = null,
    } = options;
    const agents = safeGet(ctx, "agents");
    if (!agents || typeof agents.create !== "function") {
      throw new Error("dsh agents 服务不可用，无法创建会话");
    }

    const sessionId = randomUUID();
    const parts = new Map();
    const notified = new Set();
    /** agent 这一轮 read 过的文件路径（阶段 1 用）。 */
    const readPaths = new Set();
    /** 出现过工具调用的 step 号 —— 这些 step 说的话不许进正文，见下方 return。 */
    const toolSteps = new Set();
    /** turn/end 里带的失败原因（content_filter / 超长 / 上游中断…），有就抛出去。 */
    let turnFailure = null;
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
          const slot = parts.get(seq) || { text: "", reasoning: "", usage: null, step: null };
          slot.text += e.text;
          slot.reasoning += e.reasoning;
          if (e.usage) slot.usage = e.usage;
          // dsh 的 assistant/message 事件带 data.step（1 起）。
          // 记下来，等 turn/end 时按 step 判断这段 text 是「正文」还是「边说边调工具」。
          if (slot.step == null && typeof event.data?.step === "number") slot.step = event.data.step;
          parts.set(seq, slot);
          // 同一 seq 只回调一次，避免重复推给酒馆
          if (onMessage && !notified.has(seq)) {
            notified.add(seq);
            try {
              onMessage({ seq, text: e.text, reasoning: e.reasoning });
            } catch {}
          }
        } else if (event.type === "tool/call") {
          if (typeof event.data?.step === "number") toolSteps.add(event.data.step);
          else if (typeof event.step === "number") toolSteps.add(event.step);
          if (!collectPaths) return;
          // 只收路径，不收内容：tool/result 带 <path>/<content> 包装和行号，
          // 而且 agent 对大文件是分段 read 的，拼起来只有残片。
          const name = event.data?.name;
          if (name === "read" || name === "Read") {
            const raw = event.data?.arguments;
            try {
              const args = typeof raw === "string" ? JSON.parse(raw) : raw;
              const p = args?.file_path ?? args?.path;
              if (typeof p === "string" && p) readPaths.add(p);
            } catch {}
          }
        } else if (event.type === "turn/end") {
          /**
           * 必须看 reason：上游 content_filter / 超长 / 中断时 turn 是以 error
           * 结束的，但 parts 里可能是空的。不看的话调用方会当成「模型没说话」，
           * 给酒馆回一个 200 + 空正文 —— 真实原因被彻底吞掉，排查极难。
           * （实测过一次：content_filter 被隐藏，我先误以为是剔正文剔多了。）
           *
           * 真实形状（从会话文件 assistant/attempt 里抓的）：
           *   finish.reason = { kind: 'error', failure: { message, code } }
           *   turn/end.data.reason = { kind: 'error', error: { message, code } }
           * 两处键名不同（failure / error），都要兼容，别只认一个。
           */
          const reason = event.data?.reason;
          if (reason && typeof reason === "object" && reason.kind && reason.kind !== "completed") {
            const detail = reason.error || reason.failure || {};
            const msg = typeof detail === "string" ? detail : detail?.message;
            const code = typeof detail === "object" ? detail?.code : "";
            turnFailure = new Error(
              `agent 回合以 ${reason.kind} 结束${msg ? `：${msg}` : ""}${code ? `（${code}）` : ""}`,
            );
          }
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
      let presetId = presetOverride || route?.agentPreset || cfg.agentPreset;
      /**
       * setup 干两件事：
       *   1. 挂预设（persona / skill-filesystem / tool-fs 等）
       *   2. **裁剪工具**，只留本轮真正用得上的
       *
       * 第 2 件为什么必须做：dsh 的工具按上下文继承，预设只能「加」不能「减」。
       * 实测一轮酒馆请求的 tools 是 43 个、33 KB（≈9k tokens），其中
       * 32 个是全局挂载的 chrome-devtools MCP 工具 —— 每轮全量重发，
       * 与写小说毫无关系，却把上下文和成本一起吃掉。
       *
       * 官方入口是 tools.restrict({ allow/deny })，只作用于调用它的那个
       * agent scope（见 dsh-tools 的 license 注释：restrict 必须挂在 scoped
       * context 上）。setup 拿到的 agentCtx 正好是这个 scope，且在
       * followup 之前执行，所以在这里调能起作用。
       */
      let setup;
      if (agentPresets && typeof agentPresets.resolve === "function") {
        try {
          const composed = await agentPresets.resolve(presetId);
          if (typeof composed?.id === "string" && composed.id) presetId = composed.id;
          if (typeof agentPresets.mount === "function") {
            setup = async (agentCtx) => {
              await agentPresets.mount(agentCtx, composed.id);
              restrictTools(agentCtx, route && route.trimTools !== undefined ? route.trimTools : cfg.trimTools, route?.allowTools ?? cfg.allowTools);
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
          provider: route?.provider || cfg.provider,
          model: route?.model || cfg.model,
          reasoningEffort: reasoningEffort || route?.reasoningEffort || cfg.reasoningEffort,
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

      await Promise.race([turnEnded, sleep(timeoutMs).then(() => {
        throw new Error(`等待响应超时（${timeoutMs / 1000}s）`);
      })]);

      const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]);
      let text = "";
      let reasoning = "";
      let toolText = "";
      let usage = null;
      let lastPlainSince = -1;
      for (let i = 0; i < ordered.length; i++) {
        const [, slot] = ordered[i];
        reasoning += slot.reasoning;
        if (slot.usage) usage = slot.usage;
        const stepped = slot.step != null && toolSteps.has(slot.step);
        if (stepped) {
          // 这一步调了工具 → 它的正文是「我看看设定材料再写」这类过程话，不能给酒馆
          toolText += slot.text;
        } else {
          text += slot.text;
          if (slot.text.trim()) lastPlainSince = i;
        }
      }
      /**
       * 正文只取「最后一个工具步骤之后」的部分。
       *
       * 为什么不能简单取所有非工具步骤：模型经常在第 1 步先说一句
       * 「我先读一下设定材料」，第 2 步才真正动笔。前面那些 step 同样没有
       * tool/call，但它们是过程话。按「最后一个工具 step 之后」切，
       * 两种情况都对：纯工具链 → 只留收尾那一步；无工具直答 → 全都留。
       *
       * 兜底：切完是空的（模型只在工具步里说过话）→ 退回全部非工具文本。
       */
      let finalText = text;
      if (toolSteps.size > 0 && ordered.length > 0) {
        // 不用 findLastIndex：dsh 内嵌 Node 版本不保证，普通循环最稳
        let cut = -1;
        for (let i = ordered.length - 1; i >= 0; i--) {
          const s = ordered[i][1];
          if (s.step != null && toolSteps.has(s.step)) {
            cut = i;
            break;
          }
        }
        if (cut >= 0) {
          const tail = ordered.slice(cut + 1).map(([, s]) => s.text).join("");
          finalText = tail.trim() ? tail : text;
        }
      }
      /**
       * 有失败原因时怎么处理。
       *
       * 三种情况要分开对待：
       *   1. 正文为空        → 抛。空正文 + 静默 200 是最糟的结果：
       *                        酒馆显示「模型没说话」，真实原因（通常是
       *                        content_filter）被彻底吞掉，排查时完全没线索。
       *   2. 有正文 + 被截断  → 正文照发，之后再补一条错误。
       *                        上游已吐出来的字是用户要的，不能因为结尾出错就扔掉；
       *                        但也不能默不作声让半截话当成完整回复入库。
       *   3. 有正文 + 无失败  → 正常返回。
       *
       * 注意酒馆**不读 finish_reason**（openai.js 里全程没有这个字段），
       * 它只认流里的 `data.error` 和非 200 状态码。所以「补一条错误」必须走
       * warning 字段往下传，由 handleChat 决定怎么发，不能只塞个 finish_reason。
       */
      if (turnFailure && !finalText.trim()) throw turnFailure;

      return {
        text: finalText,
        reasoning,
        usage,
        sessionId,
        paths: [...readPaths],
        toolSteps: [...toolSteps],
        droppedText: toolText,
        turnFailure: turnFailure ? String(turnFailure.message || turnFailure) : "",
      };
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
/**
 * 把本会话可见的工具收窄到 allow 列表。
 *
 * 为什么需要：dsh 的工具是按上下文继承的，预设只能往里加、没法往外减。
 * 结果就是全局挂的 26 个 chrome-devtools MCP 工具会跟着每一轮酒馆请求
 * 一起重发 —— 实测 43 个工具、33 KB、约 9k tokens，与写正文毫无关系。
 *
 * 两条实现约束（都来自 dsh-tools 的源码）：
 *   1. `restrict()` 必须在 scoped context 上调用，否则直接抛错。
 *      setup 拿到的 agentCtx 正是这个 scope。
 *   2. `restrict()` 会校验名字：列表里有任何未注册的名字就整体失败。
 *      而「哪些名字存在」随 profile 装配变化（用户可能没装某些插件），
 *      所以这里先问 view().restrictableNames，只保留真实存在的，
 *      再决定要不要调 —— 一个都不剩就跳过，不要用空 allow 把工具全灭。
 *
 * @param agentCtx  setup 拿到的 agent scope context
 * @param allow     要保留的全局工具名（空数组/未配置 = 不裁剪）
 */
function restrictTools(agentCtx, enabled, allow) {
  if (enabled === false) return;
  const list = Array.isArray(allow) ? allow.map((s) => String(s || "").trim()).filter(Boolean) : [];
  try {
    const tools = agentCtx.get("tools");
    if (!tools || typeof tools.restrict !== "function") return;

    /**
     * 关键：这里必须用 **deny** 而不是 allow。
     *
     * dsh 把工具分成两类（见 dsh-tools 的 view()）：
     *   - 全局工具：继承自父上下文（chrome-devtools MCP、edit、write…）。
     *     进 `restrictableNames`，可以被 restrict 过滤。
     *   - scope 本地工具：预设通过 tool-skill / tool-fs 挂到本 agent 上的
     *     （skill、read）。**不进 restrictableNames**，而且 view() 里是
     *     无条件可见的 —— 源码注释写明 "scoped registrations remain visible"。
     *
     * 所以 restrict({ allow: ["skill","read"] }) 是错的：那两个名字不在
     * 可裁剪集合里，restrict 内部会按「未知工具名」直接抛错。
     * （第一版就是这么写的，结果 allow 过滤成空、提前 return，静默没生效。）
     *
     * 正确做法：把全局工具里**不要的**全部 deny 掉。skill / read 压根不用管，
     * 它们是 scope 本地的，本来就不受影响。
     */
    const view = typeof tools.view === "function" ? tools.view(undefined) : null;
    if (!view || !(view.restrictableNames instanceof Set)) {
      logOnce(agentCtx, "拿不到全局工具视图，本轮跳过裁剪");
      return;
    }

    const globalNames = [...view.restrictableNames];
    // allow 里若写了某个全局工具名就保留它，其余全局工具全部禁掉
    const keep = list.filter((n) => view.restrictableNames.has(n));
    const deny = globalNames.filter((n) => !keep.includes(n));

    if (deny.length === 0) {
      logOnce(agentCtx, "没有可裁剪的全局工具，本轮跳过");
      return;
    }

    tools.restrict({ deny });
    logOnce(agentCtx, `已隐藏 ${deny.length} 个全局工具（保留 ${keep.length} 个全局 + 全部本地工具）`);
    try {
      probe(
        `tools restricted: deny=${deny.length} [${deny.slice(0, 8).join(",")}${deny.length > 8 ? ",…" : ""}] keepGlobal=[${keep.join(",")}]`,
      );
    } catch {}
  } catch (e) {
    // 裁剪失败不该拖死整轮：工具多几个只是费 token，不是功能故障
    logOnce(agentCtx, `裁剪工具失败，本轮保留全部工具: ${e?.message ?? e}`);
    try {
      probe(`tools restrict FAILED: ${e?.message ?? e}`);
    } catch {}
  }
}

/** 往 dsh 日志里写一条 warn，任何一环缺失都静默。 */
function logOnce(agentCtx, msg) {
  try {
    agentCtx.logger?.warn?.(`tavern-bridge: ${msg}`);
  } catch {}
}

function withDefaults(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const pick = (k, d) => (c[k] === undefined || c[k] === null ? d : c[k]);
  return {
    port: Math.max(1, Math.min(65535, Math.trunc(Number(pick("port", 57421))) || 57421)),
    portFallback: pick("portFallback", true) !== false,
    host: String(pick("host", "127.0.0.1")) || "127.0.0.1",
    workspace: String(pick("workspace", "") || ""),
    engine: String(pick("engine", "direct")).toLowerCase() === "agent" ? "agent" : "direct",
    routes: normalizeRoutes(pick("routes", [])),
    defaultRoute: String(pick("defaultRoute", "") || ""),
    agentPreset: String(pick("agentPreset", "tavern-roleplay")) || "tavern-roleplay",
    preparePreset: String(pick("preparePreset", "tavern-prep")) || "tavern-prep",
    prepareTimeoutMs: Math.max(1000, Math.trunc(Number(pick("prepareTimeoutMs", 20_000))) || 20_000),
    prepareReasoningEffort: String(pick("prepareReasoningEffort", "low")) || "low",
    prepareMaxChars: Math.max(8000, Math.trunc(Number(pick("prepareMaxChars", 60_000))) || 60_000),
    skillDir: String(pick("skillDir", "") || ""),
    allowTools: Array.isArray(pick("allowTools", []))
      ? pick("allowTools", []).map((s) => String(s || "").trim()).filter(Boolean)
      : [],
    trimTools: pick("trimTools", true) !== false,
    provider: String(pick("provider", "codebuddy")) || "codebuddy",
    model: String(pick("model", "deepseek-v4.1-flash")) || "deepseek-v4.1-flash",
    reasoningEffort: String(pick("reasoningEffort", "high")) || "high",
    authToken: String(pick("authToken", "") || ""),
    skillDeploy: String(pick("skillDeploy", "if-missing")) || "if-missing",
    saveTranscript: String(pick("saveTranscript", "md")) || "md",
    debugDump: pick("debugDump", false) === true,
  };
}

/**
 * 把 routes 配置洗成干净的对象数组。
 *
 * 两个必须做的清洗：
 *   1. **丢掉没有 id 的项** —— id 是唯一的匹配键，空 id 永远命中不了，
 *      留着只会让设置页显示一条点了没反应的死路由。
 *   2. **id 去重，先出现的赢** —— 酒馆的模型名是个下拉框，重名就无法区分。
 */
function normalizeRoutes(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      engine: String(r.engine ?? "").trim().toLowerCase() === "agent" ? "agent" : r.engine === "" || r.engine == null ? "" : "direct",
      preset: String(r.preset ?? "").trim(),
      preparePreset: String(r.preparePreset ?? "").trim(),
      provider: String(r.provider ?? "").trim(),
      model: String(r.model ?? "").trim(),
      reasoningEffort: String(r.reasoningEffort ?? "").trim(),
      prepareReasoningEffort: String(r.prepareReasoningEffort ?? "").trim(),
      prepareTimeoutMs: Math.max(0, Math.trunc(Number(r.prepareTimeoutMs) || 0)),
      prepareMaxChars: Math.max(0, Math.trunc(Number(r.prepareMaxChars) || 0)),
      allowTools: Array.isArray(r.allowTools) ? r.allowTools.map((s) => String(s || "").trim()).filter(Boolean) : [],
      trimTools: typeof r.trimTools === "boolean" ? r.trimTools : undefined,
    });
  }
  return out;
}

/**
 * 按酒馆传来的模型名解析出本轮实际生效的配置。
 *
 * 匹配是**大小写不敏感的全等**，不做前缀/模糊：模型名是人在酒馆里手填的，
 * 模糊匹配会让 `tavern-direct-2` 这类误写悄悄跑到别的路由上，反而更难查。
 *
 * 三级回退：
 *   1. 命中 routes[].id        → 用它
 *   2. 命中 defaultRoute       → 用它
 *   3. 都没命中                 → 用全局单值配置（engine / provider / model …）
 *
 * 返回值一定是完整配置，调用方直接用，不用再判空。
 */
function resolveRoute(cfg, requestedModel) {
  const want = String(requestedModel ?? "").trim();
  const list = Array.isArray(cfg.routes) ? cfg.routes : [];

  let hit = null;
  let matchedBy = "global";
  if (want) {
    hit = list.find((r) => r.id.toLowerCase() === want.toLowerCase()) ?? null;
    if (hit) matchedBy = "model";
  }
  if (!hit && cfg.defaultRoute) {
    hit = list.find((r) => r.id.toLowerCase() === cfg.defaultRoute.toLowerCase()) ?? null;
    if (hit) matchedBy = "default";
  }

  // 没命中任何路由 = 老行为，全局单值配置说了算
  if (!hit) {
    return {
      routeId: "",
      matchedBy: "global",
      requestedModel: want,
      engine: cfg.engine,
      agentPreset: cfg.agentPreset,
      preparePreset: cfg.preparePreset,
      prepareTimeoutMs: cfg.prepareTimeoutMs,
      prepareReasoningEffort: cfg.prepareReasoningEffort,
      prepareMaxChars: cfg.prepareMaxChars,
      allowTools: cfg.allowTools,
      trimTools: cfg.trimTools,
      provider: cfg.provider,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
    };
  }

  // 命中路由：只覆盖它写了的字段，其余沿用全局
  const or = (v, fallback) => (v && String(v).trim() ? String(v).trim() : fallback);
  return {
    routeId: hit.id,
    matchedBy,
    requestedModel: want,
    engine: or(hit.engine, cfg.engine) === "agent" ? "agent" : "direct",
    agentPreset: or(hit.preset, cfg.agentPreset),
    preparePreset: or(hit.preparePreset, cfg.preparePreset),
    prepareTimeoutMs: hit.prepareTimeoutMs > 0 ? hit.prepareTimeoutMs : cfg.prepareTimeoutMs,
    prepareReasoningEffort: or(hit.prepareReasoningEffort, cfg.prepareReasoningEffort),
    prepareMaxChars: hit.prepareMaxChars > 0 ? hit.prepareMaxChars : cfg.prepareMaxChars,
    allowTools: hit.allowTools && hit.allowTools.length > 0 ? hit.allowTools : cfg.allowTools,
    // 路由没写 trimTools 就用全局；写了 false 才算关掉
    trimTools: hit.trimTools === undefined ? cfg.trimTools : hit.trimTools,
    provider: or(hit.provider, cfg.provider),
    model: or(hit.model, cfg.model),
    reasoningEffort: or(hit.reasoningEffort, cfg.reasoningEffort),
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
  // 存档要记「这一轮实际生效的模型」，不是全局默认 —— 配了路由之后两者常常不同。
  const eff = state.lastRoute
    ? {
        provider: state.lastRoute.provider || cfg.provider,
        model: state.lastRoute.model || cfg.model,
        effort: state.lastRoute.reasoningEffort || cfg.reasoningEffort,
        preset: state.lastRoute.preset || cfg.agentPreset,
        route: state.lastRoute.routeId || "",
      }
    : { provider: cfg.provider, model: cfg.model, effort: cfg.reasoningEffort, preset: cfg.agentPreset, route: "" };
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
        provider: eff.provider,
        model: eff.model,
        effort: eff.effort,
        preset: eff.preset,
        route: eff.route,
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
    writeFileSync(file, renderTranscriptMd({ ...rec, prompt, title, day, hhmmss, eff }), "utf8");

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
    `> ${r.eff.provider}/${r.eff.model} · 思考 ${r.eff.effort} · 预设 ${r.eff.preset}${r.eff.route ? ` · 路由 ${r.eff.route}` : ""}${usage}`,
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
