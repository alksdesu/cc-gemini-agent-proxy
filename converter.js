// Anthropic ↔ Gemini 格式双向转换
const crypto = require('crypto');
const config = require('./config');

function genId(prefix = 'msg') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// ============================================================
// Anthropic → Gemini 请求转换
// ============================================================

function anthropicToGeminiRequest(body) {
  const result = {};

  // system → systemInstruction
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text || '').join('\n');
    result.systemInstruction = { parts: [{ text: systemText }] };
  }

  // messages → contents
  result.contents = convertMessages(body.messages || []);

  // tools → functionDeclarations
  if (body.tools && body.tools.length > 0) {
    result.tools = [{
      functionDeclarations: body.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || t.parameters || undefined,
      })),
    }];
  }

  // generationConfig
  const gc = {};
  if (body.max_tokens) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature != null) gc.temperature = body.temperature;
  if (body.top_p != null) gc.topP = body.top_p;
  if (body.top_k != null) gc.topK = body.top_k;
  if (body.stop_sequences) gc.stopSequences = body.stop_sequences;

  // thinking 配置
  if (body.thinking && body.thinking.budget_tokens) {
    gc.thinkingConfig = mapThinkingConfig(body.thinking.budget_tokens);
  } else {
    gc.thinkingConfig = { thinkingLevel: config.gemini.thinkingLevel.toUpperCase() };
  }

  if (Object.keys(gc).length > 0) result.generationConfig = gc;

  // 安全设置
  result.safetySettings = config.safetySettings;

  return result;
}

function mapThinkingConfig(budgetTokens) {
  if (budgetTokens <= 1024) return { thinkingLevel: 'LOW' };
  if (budgetTokens <= 8192) return { thinkingLevel: 'MEDIUM' };
  return { thinkingLevel: 'HIGH' };
}

// 转换消息数组
function convertMessages(messages) {
  const contents = [];

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = convertContentToParts(msg.content, msg.role);

    if (parts.length > 0) {
      // Gemini 要求相邻同 role 的消息合并
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }
  }

  return contents;
}

// 将 Anthropic content 转为 Gemini parts
function convertContentToParts(content, role) {
  // 简单字符串
  if (typeof content === 'string') {
    return [{ text: content }];
  }

  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text });
        break;

      case 'tool_use':
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input || {},
          },
        });
        break;

      case 'tool_result':
        parts.push({
          functionResponse: {
            name: block.name || '_unknown',
            response: formatToolResult(block),
          },
        });
        break;

      case 'image':
        if (block.source && block.source.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        }
        break;

      case 'thinking':
        // Anthropic thinking block → 跳过，已通过 thinkingConfig 处理
        break;

      default:
        // 未知类型，尝试作为文本
        if (block.text) parts.push({ text: block.text });
        break;
    }
  }

  return parts;
}

function formatToolResult(block) {
  const content = block.content;
  if (typeof content === 'string') {
    return { result: content };
  }
  if (Array.isArray(content)) {
    const texts = content.filter(c => c.type === 'text').map(c => c.text);
    return { result: texts.join('\n') };
  }
  return { result: JSON.stringify(content) };
}

// ============================================================
// Gemini → Anthropic 响应转换（非流式）
// ============================================================

function geminiToAnthropicResponse(geminiResp, originalModel) {
  const candidate = geminiResp.candidates && geminiResp.candidates[0];
  if (!candidate) {
    return {
      id: genId('msg'),
      type: 'message',
      role: 'assistant',
      model: originalModel,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];
  const parts = (candidate.content && candidate.content.parts) || [];
  let hasToolUse = false;

  for (const part of parts) {
    if (part.text != null) {
      content.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      hasToolUse = true;
      content.push({
        type: 'tool_use',
        id: genId('toolu'),
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  // 如果没有任何内容，至少返回空文本
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const stopReason = mapFinishReason(candidate.finishReason, hasToolUse);
  const usage = geminiResp.usageMetadata || {};

  return {
    id: genId('msg'),
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

function mapFinishReason(reason, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  switch (reason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY': return 'end_turn';
    case 'RECITATION': return 'end_turn';
    default: return 'end_turn';
  }
}

// ============================================================
// 给 tool_result 补上 name（Anthropic 的 tool_result 只有 tool_use_id，没有 name）
// ============================================================

function patchToolResultNames(messages) {
  // 先收集所有 tool_use 的 id → name 映射
  const idToName = {};
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        idToName[block.id] = block.name;
      }
    }
  }

  // 给 tool_result 打上 name
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        block.name = idToName[block.tool_use_id] || block.name || '_unknown';
      }
    }
  }

  return messages;
}

module.exports = {
  anthropicToGeminiRequest,
  geminiToAnthropicResponse,
  patchToolResultNames,
  genId,
  mapFinishReason,
};
