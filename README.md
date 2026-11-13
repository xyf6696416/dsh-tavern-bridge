> [!WARNING]
> **本仓库包含成人向内容（18+）。**
> `assets/skills/humanize-prose/` 是面向虚构角色扮演的中文叙事写作指导，
> 含露骨性描写技法与成人场景词汇。仅限成年人、仅用于虚构创作。
> 若你不接受此类内容，请立即离开。

# dsh-tavern-bridge

酒馆（SillyTavern）中转插件。在 dsh 进程内自建 HTTP 监听，把 OpenAI 兼容请求转给 dsh agent。

## 跟旧脚本的区别

以前是 `E:\SillyTavern\jsk2\tavern_dsh_bridge.mjs`，一个独立 node 进程：要手动启动、要管 PID、dsh 重启后 web server 端口漂移还得跟着重新探测。

现在是 dsh 插件：

| | 旧脚本 | 本插件 |
|---|---|---|
| 启动 | 手动 `node ...` | 随 dsh 启停 |
| 端口 | 跟着 dsh 的 web server 漂 | 自己定（默认 57421） |
| 建会话 | HTTP 绕 `/m/api` | 进程内 `ctx.get("agents")` |
| 端口探测 | 扫本机端口 + 自愈重探 | 不需要 |
| 预设 | 单独装 `dsh-tavern-roleplay` | 内置 |
| 技能 | 手工放 `F:\SillyTavern\.dsh\skills` | 内置，自动部署到工作区 |
| 查看/复制地址 | 自己翻配置文件 | 设置页「酒馆中转」 |

## 装法

`profile` 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-tavern-bridge": "file:E:/gzq_deepseek/dsh-tavern-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-tavern-bridge", "..."]
    }
  }
}
```

> 本包已内置 `tavern-roleplay` 预设。**如果同时保留 `dsh-tavern-roleplay` 的 bundle，两个包会重复注册同一 id 的预设**，请把它从 `bundles` 里移除。

改完重启 dsh。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: tavern-bridge
      name: dsh-tavern-bridge
      config:
        port: 57421              # 监听端口
        portFallback: true       # 被占用就往后找空闲端口
        host: '127.0.0.1'        # 只绑回环
        workspace: ''            # 空 = %USERPROFILE%\Desktop\DSH酒馆
        agentPreset: tavern-roleplay
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: high
        authToken: ''            # 空 = 不校验
        skillDeploy: if-missing  # if-missing | overwrite | never
        debugDump: false         # 落盘最近请求到 <工作区>/.tavern-debug/
```

## 酒馆怎么填

聊天补全来源选「自定义 (OpenAI 兼容)」：

- **Custom Endpoint**：`http://127.0.0.1:57421/v1`（末尾带 `/v1`，**不要**带 `/chat/completions`）
- **模型名**：`deepseek-flash`（随便填，插件强制用配置里的）
- **API Key**：`authToken` 为空时随便填

端口被占用自动后移时，实际地址在 **dsh 设置 → 酒馆中转** 里看，带一键复制，不用翻配置。

## 工作区

默认 `%USERPROFILE%\Desktop\DSH酒馆`，不存在会自动创建。

插件会做两件准备工作：

1. **放一个空 `.git` 目录**。dsh 找技能根目录的方式是「最近的含 `.git` 的上级目录」，工作区没有 `.git` 时根目录就是工作区本身，`<工作区>/.dsh/skills` 正好命中第 100 优先位。但如果工作区被放进某个 git 仓库里，根目录会往上跑，技能就搜不到了 —— 这个空目录把根钉住。它只是存在性标记，没初始化任何仓库。
2. **把 `humanize-prose` 技能同步到 `<工作区>/.dsh/skills/`**。`skillDeploy: if-missing`（默认）时目标已存在就跳过，不会覆盖你手改过的版本。

## 请求流程

```
酒馆 POST /v1/chat/completions
  → 建一次性会话（agents.create，预设 + 模型 + 思考档位）
  → setSandboxMode(read-only)：能读技能文件，写不了任何东西
  → followup(整段提示词)
  → 收 session/event
      每个 step 的 assistant/message → 思维链**实时**增量推给酒馆
      turn/end → 正文按打字节奏铺开（约 2.2s）
  → 释放会话
```

每轮都新建会话：酒馆每次都带完整上下文，复用会话会让历史爆炸。

**已知限制**：dsh 的会话格式是 v2，内核把 token 级增量折叠进了 `assistant/message.stream`，不再单独发 `assistant/chunk`。所以拿不到逐字流 —— 思维链能按 step 实时推，正文只能等生成完再铺开。

## 会话记录

两个地方都能看到：

**① dsh 自己的会话列表** —— 每轮建的会话会 `attachSession` 到工作区注册表，
所以在 dsh GUI 里按工作区分组就能看到 `DSH酒馆` 下面的一轮轮会话，点进去有完整历史。

> **前端刷新有个坑**：dsh 前端的会话列表只在页面加载（前端与 host 重连）时
> 从后端拉一次基线，之后新出现的会话不会自己补进来。而中转插件是在后端用
> `agents.create` 建的会话，前端完全没参与这次创建 —— 所以**改完插件第一次重启前**，
> 侧栏里看不到历史那些酒馆会话，重启后才一次性补齐。
>
> 从本版起，插件的客户端模块订阅了工作区清单（后端这份是实时推送的）：
> 一旦发现某个工作区里有本地会话表查不到的 id，就调前端 session service 的
> `refresh()` 重拉基线，新会话立刻出现在工作区下。所以正常情况下**不用再手动重启**。


**② 工作区里的 markdown 存档** —— 插件另外落一份方便直接翻：

```
<工作区>\会话记录\
├─ 索引.md
└─ 2026-11-08\
   ├─ 00-17-08-他把那截东西从口袋里捏出来….md
   └─ ...
```

每个 md 里是：正文（完整）+ 思维链（折叠）+ 用户输入（截断 800 字）+ 耗时/用量。

> 模型本身是 `read-only`，写不了任何文件 —— 这是故意的。这些存档是**插件**写的，
> 插件跑在 dsh 主进程里，有自己的写权限。

配置 `saveTranscript`：`md`（默认）/ `json`（追加 jsonl）/ `off`（只留在 dsh 会话列表里）。
