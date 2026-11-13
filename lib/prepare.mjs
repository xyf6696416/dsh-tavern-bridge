/**
 * 阶段 1：用 dsh agent 做技能文件的按需加载。
 *
 * 为什么还要过一遍 agent：skill 的「按需」判断靠模型看索引再决定读哪几份，
 * 比关键词匹配准。但这一阶段**只判断、只读文件，不写正文**。
 *
 * 关键取舍：内容不从 tool/result 里截。
 * 实测那个事件是一串带包装和行号的文本：
 *   <path>…11-器官与异物.md</path> <type>file</type> <content> 1: …
 * 而且 agent 对大文件是分段读的（47 KB 的文件分 4 次，单次最大 4188 字符），
 * 拼起来只有残片。所以这里只从 tool/call 里收 **路径**，内容自己按路径读全文。
 *
 * 另外 SKILL.md 本身不收：它的正文是「先调 skill、再 read 哪几份」这类
 * 给 agent 的指令，对没有工具的生成模型是误导。只收 references/。
 */
import { readFileSync, statSync } from "node:fs";

/** 阶段 1 输入的字符预算上限（约 3~4 万 tokens）。超了才压缩历史。 */
const ROUTE_MAX_CHARS = 60_000;
/** 最多拼几份 references，防止 agent 把 12 份全读了。 */
const MAX_FILES = 6;

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return content == null ? "" : String(content);
}

/**
 * 拼阶段 1 的输入：**酒馆原始提示词完整传入**。
 *
 * 为什么必须完整：题材判据常常不在最近对话里，而在角色卡、世界书、预设的
 * 格式契约里（比如「她今天穿了白丝」写在角色卡上，而最近一轮只是「嗯」）。
 * 只截最近几轮会让按需加载退化成瞎猜。
 *
 * 唯一的压缩是**超长时的历史截断**：设定材料（system）永远全量保留 ——
 * 它才是题材的主要来源；对话历史从最后一条往回填充，超出预算就丢掉更早的，
 * 单条超预算则保留其尾部（越近的信息越有用）。
 */
export function buildRoutePrompt(messages, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : ROUTE_MAX_CHARS;
  const list = Array.isArray(messages) ? messages : [];

  const systemParts = [];
  for (const m of list) {
    if (m && m.role === "system") {
      const t = contentText(m.content).trim();
      if (t) systemParts.push(t);
    }
  }
  const systemText = systemParts.join("\n\n");

  // 预算给历史；system 太长时留一个保底窗口
  let budget = Math.max(4000, maxChars - systemText.length);
  const turns = list.filter((m) => m && (m.role === "user" || m.role === "assistant"));
  const picked = [];
  for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
    const t = contentText(turns[i].content).trim();
    if (!t) continue;
    const text = t.length > budget ? t.slice(t.length - budget) : t;
    budget -= text.length;
    picked.unshift(`[${turns[i].role === "user" ? "用户" : "角色"}] ${text}`);
  }

  return [
    systemText ? `【设定材料】\n${systemText}` : "【设定材料】\n（本轮没有设定材料）",
    "",
    picked.length > 0 ? `【对话历史】\n${picked.join("\n\n")}` : "【对话历史】\n（无）",
    "",
    "【任务】",
    "按预设要求执行：调 skill 拿索引 → 判断这一轮用得上哪几份 references → 用 read 读完 → 立刻停止。",
    "拿不准题材时，宁可多读一份。",
  ].join("\n");
}

/**
 * 从收集到的路径里挑出 references，读全文。
 *
 * @param paths    agent 走 read 时留下的 file_path 列表
 * @param skillDir humanize-prose 技能根目录
 * @param warn     日志
 */
export function readMaterials(paths, skillDir, warn) {
  const seen = new Set();
  const picked = [];

  for (const p of paths || []) {
    if (typeof p !== "string") continue;
    const norm = p.replace(/\//g, "\\");
    if (!norm.toLowerCase().startsWith(skillDir.replace(/\//g, "\\").toLowerCase())) continue;
    // 只收 references/ 下的，SKILL.md 是给 agent 的指令，不收
    if (!/[\\/]references[\\/]/i.test(norm)) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(norm);
  }

  const files = [];
  for (const p of picked) {
    if (files.length >= MAX_FILES) break;
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size === 0) continue;
      const text = readFileSync(p, "utf8");
      const name = p.split("\\").pop() || p;
      files.push({ name, path: p, text, bytes: st.size });
    } catch (e) {
      if (warn) warn(`读素材失败 ${p}: ${e?.message ?? e}`);
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return files;
}

/**
 * 把素材拼成要并进 system 的那段文本。
 * 顺序：写作规范（由调用方给） → 素材文件。
 */
export function composeExtraSystem(normText, files) {
  const parts = [];
  if (normText && normText.trim()) parts.push(normText.trim());
  if (files && files.length > 0) {
    parts.push(
      [
        "【写作参考 —— 以下是本轮会用到的写法细则，按需遵守，不要引述它们的标题】",
        ...files.map((f) => `\n### ${f.name}\n${f.text.trim()}`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
