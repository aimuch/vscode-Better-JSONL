// LLM conversation & Agent trajectory detector and reader view.
// Supports OpenAI/ChatML messages, Anthropic thinking/tool_use/tool_result, Gemini contents/parts,
// SFT/DPO prompt/completion/chosen/rejected datasets, and agent step records.
import { t } from '../shared/i18n';
import { renderImagePreviewHtml, renderMarkdownSafe } from './inspect';
import { esc, isArr, isContainer, isObj, stringifyPretty, type JObj, type JVal } from './json';

export interface ToolCallItem {
  id?: string;
  name: string;
  args: string;
}

export interface ToolResultItem {
  id?: string;
  name?: string;
  output: string;
  isError?: boolean;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'chosen' | 'rejected' | 'other';
  label: string;
  text: string;
  thinking?: string;
  toolCalls?: ToolCallItem[];
  toolResults?: ToolResultItem[];
}

export interface ConversationView {
  turns: ChatTurn[];
  model?: string;
  actualTokens?: number;
  estTokens: number;
}

function normalizeRole(r: string): ChatTurn['role'] {
  const low = r.toLowerCase();
  if (low === 'system' || low === 'developer') return 'system';
  if (low === 'user' || low === 'human') return 'user';
  if (low === 'assistant' || low === 'model' || low === 'bot' || low === 'ai') return 'assistant';
  if (low === 'tool' || low === 'function' || low === 'observation') return 'tool';
  if (low === 'chosen') return 'chosen';
  if (low === 'rejected') return 'rejected';
  return 'other';
}

function asText(v: JVal | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  return stringifyPretty(v, 2, 100_000);
}

function parseContentBlocks(
  content: JVal | undefined,
): { text: string; thinking?: string; calls: ToolCallItem[]; results: ToolResultItem[] } {
  const texts: string[] = [];
  const thoughts: string[] = [];
  const calls: ToolCallItem[] = [];
  const results: ToolResultItem[] = [];
  if (typeof content === 'string') {
    texts.push(content);
  } else if (content !== undefined && isArr(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (isObj(part)) {
        const tp = typeof part.type === 'string' ? part.type : '';
        if (tp === 'thinking' || typeof part.thinking === 'string') {
          thoughts.push(asText(part.thinking ?? part.text));
        } else if (tp === 'tool_use' || part.functionCall !== undefined) {
          const fc = isObj(part.functionCall) ? (part.functionCall as JObj) : part;
          calls.push({
            id: typeof part.id === 'string' ? part.id : undefined,
            name: typeof fc.name === 'string' ? fc.name : 'tool',
            args: stringifyPretty((fc.input ?? fc.args ?? fc.arguments ?? {}) as JVal, 2, 50_000),
          });
        } else if (tp === 'tool_result' || part.functionResponse !== undefined) {
          const fr = isObj(part.functionResponse) ? (part.functionResponse as JObj) : part;
          results.push({
            id: typeof part.tool_use_id === 'string' ? part.tool_use_id : undefined,
            name: typeof fr.name === 'string' ? fr.name : undefined,
            output: asText((fr.content ?? fr.response ?? fr.output) as JVal | undefined),
            isError: part.is_error === true,
          });
        } else if (typeof part.text === 'string') {
          if (part.thought === true) thoughts.push(part.text);
          else texts.push(part.text);
        } else {
          texts.push(stringifyPretty(part, 2, 20_000));
        }
      }
    }
  } else if (content !== undefined && content !== null) {
    texts.push(stringifyPretty(content, 2, 50_000));
  }
  return {
    text: texts.join('\n\n'),
    thinking: thoughts.length ? thoughts.join('\n\n') : undefined,
    calls,
    results,
  };
}

function parseMessageItem(item: JVal): ChatTurn | null {
  if (!isObj(item)) return null;
  const rawRole = typeof item.role === 'string' ? item.role : typeof item.from === 'string' ? item.from : typeof item.speaker === 'string' ? item.speaker : undefined;
  const rawContent = item.content ?? item.value ?? item.parts ?? item.text;
  if (!rawRole && rawContent === undefined && !isArr(item.tool_calls)) return null;
  const roleStr = rawRole ?? 'message';
  const role = normalizeRole(roleStr);
  const parsed = parseContentBlocks(rawContent as JVal | undefined);
  const calls = [...parsed.calls];
  const results = [...parsed.results];
  if (isArr(item.tool_calls)) {
    for (const tc of item.tool_calls) {
      if (!isObj(tc)) continue;
      const fn = isObj(tc.function) ? (tc.function as JObj) : tc;
      let argsText = '';
      const rawArgs = fn.arguments ?? fn.args ?? fn.input;
      if (typeof rawArgs === 'string') {
        try {
          argsText = stringifyPretty(JSON.parse(rawArgs) as JVal, 2, 50_000);
        } catch {
          argsText = rawArgs;
        }
      } else if (rawArgs !== undefined) {
        argsText = stringifyPretty(rawArgs as JVal, 2, 50_000);
      }
      calls.push({
        id: typeof tc.id === 'string' ? tc.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : 'tool',
        args: argsText,
      });
    }
  }
  if (role === 'tool' && parsed.text && !results.length) {
    results.push({
      id: typeof item.tool_call_id === 'string' ? item.tool_call_id : undefined,
      name: typeof item.name === 'string' ? item.name : undefined,
      output: parsed.text,
    });
  }
  const extraThink =
    typeof item.reasoning_content === 'string'
      ? item.reasoning_content
      : typeof item.thinking === 'string'
        ? item.thinking
        : undefined;
  const thinking = [extraThink, parsed.thinking].filter(Boolean).join('\n\n') || undefined;
  const nameTag = typeof item.name === 'string' && role !== 'tool' ? ` (${item.name})` : '';
  return {
    role,
    label: roleStr + nameTag,
    text: role === 'tool' && results.length ? '' : parsed.text,
    thinking,
    toolCalls: calls.length ? calls : undefined,
    toolResults: results.length ? results : undefined,
  };
}

/** Rough token estimate (~4 UTF-8 chars per ASCII token, ~1.5 per CJK char). */
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x2e80) cjk++;
  }
  const ascii = s.length - cjk;
  return Math.max(1, Math.round(ascii / 4 + cjk * 0.7));
}

export function detectConversation(val: JVal | undefined): ConversationView | undefined {
  if (!val || !isContainer(val)) return undefined;

  // Case 1: Array of role/content message objects directly (for example inspecting `$.messages`).
  if (isArr(val)) {
    if (val.length === 0 || val.length > 500) return undefined;
    const turns: ChatTurn[] = [];
    for (const item of val) {
      const turn = parseMessageItem(item);
      if (!turn) return undefined;
      turns.push(turn);
    }
    const chars = turns.map((tr) => tr.text + (tr.thinking ?? '')).join(' ');
    return { turns, estTokens: estimateTokens(chars) };
  }

  const obj = val as JObj;
  const turns: ChatTurn[] = [];

  // Optional top-level system prompt
  const sys = obj.system ?? obj.system_prompt ?? obj.systemInstruction;
  if (sys !== undefined && sys !== null && sys !== '') {
    const sysParsed = parseContentBlocks(isObj(sys) && 'parts' in sys ? (sys as JObj).parts : (sys as JVal));
    if (sysParsed.text) turns.push({ role: 'system', label: 'system', text: sysParsed.text });
  }

  // Case 2: `messages` / `conversations` / `contents` array
  const arrCandidate = isArr(obj.messages)
    ? obj.messages
    : isArr(obj.conversations)
      ? obj.conversations
      : isArr(obj.contents)
        ? obj.contents
        : undefined;
  if (arrCandidate && arrCandidate.length > 0 && arrCandidate.length <= 500) {
    let validCount = 0;
    for (const it of arrCandidate) {
      const tr = parseMessageItem(it);
      if (tr) {
        turns.push(tr);
        validCount++;
      }
    }
    if (validCount > 0) {
      // Optional OpenAI response wrapper (`choices[0].message`)
      if (isArr(obj.choices) && isObj(obj.choices[0]) && isObj((obj.choices[0] as JObj).message)) {
        const respTurn = parseMessageItem((obj.choices[0] as JObj).message);
        if (respTurn) turns.push(respTurn);
      }
      return finalizeConv(obj, turns);
    }
  }

  // Case 3: SFT / DPO (`prompt` / `instruction` + `completion` / `response` / `chosen` / `rejected`)
  const promptVal = obj.prompt ?? obj.instruction;
  const hasSft =
    typeof promptVal === 'string' &&
    (typeof obj.completion === 'string' || typeof obj.response === 'string' || typeof obj.output === 'string' || typeof obj.chosen === 'string' || isArr(obj.chosen));
  if (hasSft) {
    const inputExtra = typeof obj.input === 'string' && obj.input ? `\n\n${obj.input}` : '';
    turns.push({ role: 'user', label: obj.instruction !== undefined ? 'instruction' : 'prompt', text: (promptVal as string) + inputExtra });
    const ans = obj.completion ?? obj.response ?? obj.output;
    if (typeof ans === 'string') turns.push({ role: 'assistant', label: 'response', text: ans });
    if (obj.chosen !== undefined) turns.push({ role: 'chosen', label: 'chosen ✓', text: asText(obj.chosen) });
    if (obj.rejected !== undefined) turns.push({ role: 'rejected', label: 'rejected ✗', text: asText(obj.rejected) });
    return finalizeConv(obj, turns);
  }

  // Case 4: Single agent trajectory step (`thinking` + `tool_calls` / `content` + `role` or `source`)
  if ((typeof obj.thinking === 'string' || isArr(obj.tool_calls)) && (typeof obj.content === 'string' || obj.tool_calls !== undefined)) {
    const stepTurn = parseMessageItem({
      ...obj,
      role: typeof obj.role === 'string' ? obj.role : typeof obj.source === 'string' ? obj.source : 'assistant',
    });
    if (stepTurn) return finalizeConv(obj, [stepTurn]);
  }

  return undefined;
}

function finalizeConv(obj: JObj, turns: ChatTurn[]): ConversationView {
  const model = typeof obj.model === 'string' ? obj.model : undefined;
  let actualTokens: number | undefined;
  if (isObj(obj.usage)) {
    const u = obj.usage as JObj;
    const tot = u.total_tokens ?? u.totalTokens;
    if (typeof tot === 'number') actualTokens = tot;
    else if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') actualTokens = u.input_tokens + u.output_tokens;
  }
  const textAll = turns
    .map((tr) => [tr.text, tr.thinking ?? '', ...(tr.toolCalls?.map((c) => c.args) ?? []), ...(tr.toolResults?.map((r) => r.output) ?? [])].join(' '))
    .join(' ');
  return { turns, model, actualTokens, estTokens: estimateTokens(textAll) };
}

export function renderConversationHtml(conv: ConversationView): string {
  const tokenInfo =
    conv.actualTokens !== undefined
      ? t('{0} turns · {1} tokens', conv.turns.length.toLocaleString(), conv.actualTokens.toLocaleString())
      : t('{0} turns · ~{1} tokens', conv.turns.length.toLocaleString(), conv.estTokens.toLocaleString());
  const head = `<div class="chat-meta">${conv.model ? `<span class="badge">${esc(conv.model)}</span>` : ''}<span class="dim">${esc(tokenInfo)}</span></div>`;
  const cards = conv.turns.map((tr) => {
    const thinkHtml = tr.thinking
      ? `<details class="chat-think"><summary>${esc(t('Thinking / Reasoning'))}</summary><div class="chat-think-body md-body">${renderMarkdownSafe(tr.thinking)}</div></details>`
      : '';
    const imgHtml = tr.text ? renderImagePreviewHtml(tr.text) : null;
    const bodyHtml = imgHtml ? imgHtml : tr.text ? `<div class="chat-content md-body">${renderMarkdownSafe(tr.text)}</div>` : '';
    const callsHtml = (tr.toolCalls ?? [])
      .map(
        (c) =>
          `<div class="chat-tool call"><div class="chat-tool-head"><span class="badge">${esc(t('Tool call'))}</span><strong class="mono">${esc(c.name)}</strong>${c.id ? `<span class="dim mono">${esc(c.id)}</span>` : ''}</div>${c.args ? `<pre class="dec-pre mono">${esc(c.args)}</pre>` : ''}</div>`,
      )
      .join('');
    const resHtml = (tr.toolResults ?? [])
      .map(
        (r) =>
          `<div class="chat-tool result${r.isError ? ' err' : ''}"><div class="chat-tool-head"><span class="badge${r.isError ? ' bad' : ''}">${esc(t('Tool result'))}</span>${r.name ? `<strong class="mono">${esc(r.name)}</strong>` : ''}${r.id ? `<span class="dim mono">${esc(r.id)}</span>` : ''}</div><pre class="dec-pre mono">${esc(r.output)}</pre></div>`,
      )
      .join('');
    return `<div class="chat-turn role-${tr.role}"><div class="chat-role">${esc(tr.label)}</div>${thinkHtml}${bodyHtml}${callsHtml}${resHtml}</div>`;
  });
  return `<div class="chat-reader">${head}${cards.join('')}</div>`;
}

/** Side-by-side LLM Eval comparison view for two aligned conversations (Model A vs Model B). */
export function renderSideBySideEvalHtml(
  leftLabel: string,
  left: ConversationView,
  rightLabel: string,
  right: ConversationView,
  verdict?: 'A' | 'tie' | 'B',
): string {
  const mkBtn = (v: 'A' | 'tie' | 'B', label: string) =>
    `<button class="btn${verdict === v ? ' active' : ''}" data-eval-verdict="${v}">${esc(label)}</button>`;
  return `<div class="eval-sbs">
    <div class="eval-bar">
      <span class="dim">${esc(t('LLM Eval Verdict:'))}</span>
      ${mkBtn('A', t('A wins'))}
      ${mkBtn('tie', t('Tie'))}
      ${mkBtn('B', t('B wins'))}
    </div>
    <div class="eval-cols">
      <div class="eval-col"><div class="eval-col-head"><strong>A · ${esc(leftLabel)}</strong></div>${renderConversationHtml(left)}</div>
      <div class="eval-col"><div class="eval-col-head"><strong>B · ${esc(rightLabel)}</strong></div>${renderConversationHtml(right)}</div>
    </div>
  </div>`;
}
