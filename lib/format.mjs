/**
 * 酒馆产物格式规范层
 *
 * 目标: 让 dsh 的输出适配**任意**角色卡, 而不是只适配某一张卡。
 *
 * 核心思路 (不依赖具体卡的私有约定):
 *   1. 思维链走**独立通道** (reasoning_content), 不混进正文。
 *      - 模型原生思维链: dsh 的 reasoning 字段 (真实模型推理)
 *      - 模型写在正文里的思维链块: <thinking>...</thinking> / 【思维链】... 等
 *      两者都要能识别并抽走。
 *   2. 正文尾部的**代码围栏/未闭合标签**必须修好, 否则酒馆 markdown
 *      会把整段尾部吞成代码块 (实测: 模型输出 ```json 但没闭合,
 *      酒馆渲染成 <p><br>```</p>, 尾部全乱)。
 *   3. **不擅自删除**卡私有的结构化块 (如 <dream_plot> / <UpdateVariable> /
 *      <StatusPlaceHolderImpl/>) —— 那是卡自己的正则/脚本契约, 删了会坏掉状态栏。
 *      只做「围栏配平」这种不改变语义的修复。
 */

// ── 思维链块识别 ────────────────────────────────────────────
// 覆盖常见写法: <thinking> <reasoning> <think> <thought_of_chain> <思考> 【思维链】
//
// 设计原则: **通用优先, 不硬编码某张卡**。
//   - 固定白名单 (thinking/reasoning/think/thought/chain_of_thought/scratchpad)
//   - 启发式: 标签名里含 think/reason/thought/chain/cot/思考/思维/推理
//     的成对标签, 一律当作思维链抽走。
//     这样像 <thought_of_chain>、<thought_of_chain_x>、<my_reasoning> 这类
//     各卡自定义的思考标签也能被识别, 不需要为每张卡加规则。
const THINK_TAG_HINT = /think|reason|thought|chain|cot|scratchpad|思考|思维|推理|脉络|脑内/i;

const THINK_BLOCK_PATTERNS = [
  // 成对标签 (可含属性, 可换行)
  {
    re: /<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g,
    isThinking: (tag) => THINK_TAG_HINT.test(tag),
  },
  // 【思维链】独占一行 → 到下一个 【xxx】 或空行块结束
  {
    re: /^[ \t]*[【\[]((?:思维链|思考|推理|Reasoning|Thinking|reasoning)(?:\s*[:：].*)?)[】\]][ \t]*$/gim,
    isThinking: () => true,
    block: true,
  },
];

// 成对标签的"自闭合"变体: <thinking/> 之类, 直接忽略
// 注意: 只匹配**自闭合**形式, 不能误伤 <simple_thinking> 这类开标签
const SELF_CLOSING_THINK = /<\/?(?:\w*think\w*|\w*reason\w*|\w*thought\w*|\w*chain\w*)(?:\s[^>]*)?\/>/gi;

/**
 * 标签深度跟踪。
 *
 * 顶层扫描: 遇到非思维链的开标签 → 整块原样输出 (含内部内容), 并**跳过**该块内部,
 * 这样嵌套在里面的 <simple_thinking> 之类不会被当成顶层思维链抽走。
 */
export function extractInlineThinking(text) {
  if (!text) return { reasoning: '', content: '' };

  let reasoning = '';
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { out += text.slice(i); break; }

    // 标签之前的所有普通文本必须原样保留 (思维链块之间的正文!)
    const lead = text.slice(i, lt);

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const stop = end < 0 ? n : end + 3;
      out += lead + text.slice(lt, stop);
      i = stop;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt < 0) { out += text.slice(i); break; }

    const tagText = text.slice(lt, gt + 1);
    const m = tagText.match(/^<(\/?)([A-Za-z_][\w-]*)\b[^>]*?(\/?)>$/);
    if (!m) { out += lead + text.slice(lt, gt + 1); i = gt + 1; continue; }

    const [, closing, name, selfClose] = m;

    if (closing || selfClose === '/') {
      out += lead + text.slice(lt, gt + 1);
      i = gt + 1;
      continue;
    }

    // 开标签: 用深度计数找配对的闭标签
    const rest = text.slice(gt + 1);
    const tagRe = new RegExp(`<(/?)${name}\\b[^>]*?>`, 'gi');
    let depth = 1;
    let bodyEnd = -1;
    let closeLen = 0;
    let tm;
    while ((tm = tagRe.exec(rest)) !== null) {
      if (tm[1] === '/') {
        depth--;
        if (depth === 0) { bodyEnd = gt + 1 + tm.index; closeLen = tm[0].length; break; }
      } else if (!/\/>$/.test(tm[0])) {
        depth++;
      }
    }

    if (bodyEnd < 0) {
      // 没配对 → 原样输出
      out += lead + text.slice(lt, gt + 1);
      i = gt + 1;
      continue;
    }

    const body = text.slice(gt + 1, bodyEnd);
    const after = bodyEnd + closeLen;

    if (THINK_TAG_HINT.test(name)) {
      const t = body.trim();
      if (t) reasoning += (reasoning ? '\n\n' : '') + t;
      // 思维链块前的普通文本保留, 块本身丢弃
      out += lead;
      i = after;
      continue;
    }

    // 非思维链的开标签: 整块原样输出 (含内部内容), 跳过内部
    out += lead + text.slice(lt, after);
    i = after;
  }

  // 【思维链】独占一行的块
  out = out.replace(
    /^[ \t]*[【\[]((?:思维链|思考|推理|Reasoning|Thinking|reasoning)(?:\s*[:：][^\]】]*)?)[】\]][ \t]*\n([\s\S]*?)(?=\n[ \t]*[【\[][^\]】]+[】\]]|\n[ \t]*<[A-Za-z]|$)/gim,
    (full, name, body) => {
      const t = String(body || '').trim();
      if (!t) return '';
      reasoning += (reasoning ? '\n\n' : '') + t;
      return '';
    },
  );

  out = out.replace(SELF_CLOSING_THINK, '');

  return { reasoning: reasoning.trim(), content: out.replace(/\n{3,}/g, '\n\n').trim() };
}

// ── 代码围栏配平 ────────────────────────────────────────────
/**
 * 修复代码围栏, 让酒馆的 markdown 渲染不再吞掉正文尾部。
 *
 * 背景 (实测, 天草莓郁卡):
 *   模型输出 ```json 开围栏, 闭合围栏却写在**行尾内联**:
 *       "……怀疑"男朋友"是假```"
 *   按 CommonMark, 闭合围栏必须独占一行 (前面只能有空白),
 *   所以行内那个 ``` 不算闭合 → marked 把之后**所有内容**当成代码块
 *   → 酒馆渲染出 `<p><br>```</p>` 这种残骸, 尾部全乱。
 *
 * 规则 (CommonMark 一致):
 *   - 行首 (可带空白) 的 ``` → 开围栏
 *   - 处于围栏中时, 行首的 ``` → 闭围栏
 *   - 行内的 ``` → **不**作为围栏 (纯文本), 除非该行围栏标记之后无内容
 *     (那种情况视为"想闭合但写在了行尾" → 拆行, 把闭合标记移到独立行)
 *   - 结束时仍有未闭合围栏 → 末尾补一个独立行的闭合围栏
 *
 * 只动围栏标记的**位置**, 不删任何内容, 因此不破坏卡自己的结构化块。
 */
export function balanceCodeFences(text) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);

  let inFence = false;
  let marker = '```';
  const out = [];

  for (const line of lines) {
    if (!inFence) {
      const m = line.match(/^([ \t]*)(```+|~~~+)(.*)$/);
      if (m) {
        inFence = true;
        marker = m[2][0];
        out.push(line);
        continue;
      }
      out.push(line);
      continue;
    }

    // 围栏中: 找行内围栏标记
    const runs = [];
    const re = /(`{3,}|~{3,})/g;
    let mm;
    while ((mm = re.exec(line)) !== null) runs.push({ idx: mm.index, len: mm[0].length, ch: mm[0][0] });

    // 行首围栏 → 正常闭合
    const head = line.match(/^([ \t]*)(```+|~~~+)(.*)$/);
    if (head && head[2][0] === marker && head[2].length >= 3) {
      inFence = false;
      out.push(line);
      continue;
    }

    // 行内围栏: 若其后无内容 → 视为想闭合, 拆行把闭合标记独立出来
    const same = runs.find((r) => r.ch === marker && r.len >= 3);
    if (same) {
      const after = line.slice(same.idx + same.len);
      if (after.trim() === '') {
        const before = line.slice(0, same.idx).replace(/\s+$/, '');
        if (before) out.push(before);
        out.push(marker.repeat(3));
        inFence = false;
        continue;
      }
    }

    out.push(line);
  }

  if (inFence) {
    out.push('');
    out.push(marker.repeat(3));
  }
  return out.join('\n');
}

// ── 尾部结构完整性 ──────────────────────────────────────────
/**
 * 检查正文尾部是否"看起来被截断"。
 * 典型症状: 以未闭合的 HTML 标签 / 半个 JSON 数组结尾。
 * 只做诊断, 不擅自改内容 (改内容属于卡的世界书管辖范围)。
 */
export function inspectTail(text) {
  const issues = [];
  if (!text) return { ok: true, issues };

  const trimmed = text.trim();

  // 1. 未闭合的代码围栏
  const fences = (trimmed.match(/^[ \t]*(```+|~~~+)/gm) || []).length;
  if (fences % 2 === 1) issues.push('代码围栏未闭合');

  // 2. 未闭合的成对标签 (忽略 HTML 空元素)
  const VOID_TAGS = new Set([
    'br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed',
    'source', 'track', 'wbr', '!doctype',
  ]);
  const tagCount = {};
  for (const m of trimmed.matchAll(/<(\/?)([A-Za-z_][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, tag, selfClose] = m;
    if (VOID_TAGS.has(tag.toLowerCase())) continue;
    if (selfClose === '/') continue; // 自闭合标签 <xxx/>
    tagCount[tag] = (tagCount[tag] || 0) + (closing ? -1 : 1);
  }
  const unclosedTags = Object.entries(tagCount)
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  if (unclosedTags.length) issues.push(`未闭合标签: ${unclosedTags.join(', ')}`);

  // 3. JSON 数组/对象看起来被截断
  if (/\[$/.test(trimmed) || /,\s*$/.test(trimmed)) {
    if (/^\s*[[{]/.test(trimmed) && !/[\]}]/.test(trimmed.slice(-3))) {
      issues.push('JSON 可能被截断');
    }
  }

  return { ok: issues.length === 0, issues };
}

// ── 主入口 ──────────────────────────────────────────────────
/**
 * 把 dsh 的原始输出整理成酒馆能正确渲染的 { reasoning, content }。
 *
 * @param {string} rawText        dsh 返回的正文 (不含 reasoning 通道)
 * @param {string} nativeReasoning dsh reasoning 通道的内容 (模型原生思维链)
 * @param {object} opts
 * @returns {{ reasoning: string, content: string, tailIssues: string[] }}
 */
export function normalizeOutput(rawText, nativeReasoning = '', opts = {}) {
  const { fixFences = true } = opts;

  // 1. 抽走写在正文里的思维链块, 与原生思维链合并
  const { reasoning: inlineReason, content: afterThink } = extractInlineThinking(rawText || '');

  const reasoningParts = [];
  if (nativeReasoning && nativeReasoning.trim()) reasoningParts.push(nativeReasoning.trim());
  if (inlineReason) reasoningParts.push(inlineReason);
  const reasoning = reasoningParts.join('\n\n');

  // 2. 修围栏
  let content = fixFences ? balanceCodeFences(afterThink) : afterThink;

  // 3. 诊断尾部
  const tail = inspectTail(content);

  // 4. 去掉首尾多余空行, 但保留尾部换行 (酒馆渲染更稳)
  content = content.replace(/^\n+/, '').replace(/\s+$/, '');

  return { reasoning, content, tailIssues: tail.issues };
}
