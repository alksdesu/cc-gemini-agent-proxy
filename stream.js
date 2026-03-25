// Gemini SSE → Anthropic SSE 流式转换
const { genId } = require('./converter');

class StreamConverter {
  constructor(originalModel) {
    this.model = originalModel;
    this.msgId = genId('msg');
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.contentIndex = 0;
    this.currentBlockType = null; // 'text' | 'tool_use'
    this.started = false;
    this.buffer = '';
  }

  // 生成 message_start 事件
  emitMessageStart() {
    this.started = true;
    return this.formatSSE('message_start', {
      type: 'message_start',
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  // 处理一个 Gemini SSE data 行，返回 Anthropic SSE 事件数组
  processGeminiChunk(dataStr) {
    const events = [];

    let parsed;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return events;
    }

    // 提取 usage
    if (parsed.usageMetadata) {
      if (parsed.usageMetadata.promptTokenCount) {
        this.inputTokens = parsed.usageMetadata.promptTokenCount;
      }
      if (parsed.usageMetadata.candidatesTokenCount) {
        this.outputTokens = parsed.usageMetadata.candidatesTokenCount;
      }
    }

    // 初次收到数据，发送 message_start
    if (!this.started) {
      events.push(this.emitMessageStart());
    }

    const candidate = parsed.candidates && parsed.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      return events;
    }

    for (const part of candidate.content.parts) {
      if (part.text != null) {
        events.push(...this.handleTextPart(part.text));
      }
      if (part.functionCall) {
        events.push(...this.handleFunctionCallPart(part.functionCall));
      }
    }

    // 检查是否结束
    const finishReason = candidate.finishReason || parsed.finishReason;
    if (finishReason && finishReason !== 'UNSPECIFIED') {
      events.push(...this.handleFinish(finishReason));
    }

    return events;
  }

  handleTextPart(text) {
    const events = [];

    // 如果当前 block 不是 text，先关闭旧的，再开新的
    if (this.currentBlockType && this.currentBlockType !== 'text') {
      events.push(this.emitContentBlockStop());
    }

    if (this.currentBlockType !== 'text') {
      events.push(this.emitContentBlockStart({ type: 'text', text: '' }));
      this.currentBlockType = 'text';
    }

    events.push(this.formatSSE('content_block_delta', {
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'text_delta', text },
    }));

    return events;
  }

  handleFunctionCallPart(fc) {
    const events = [];

    // 先关闭当前 block
    if (this.currentBlockType) {
      events.push(this.emitContentBlockStop());
    }

    const toolId = genId('toolu');

    events.push(this.emitContentBlockStart({
      type: 'tool_use',
      id: toolId,
      name: fc.name,
    }));
    this.currentBlockType = 'tool_use';

    // 把 args 整体作为 input_json_delta 发送
    const argsJson = JSON.stringify(fc.args || {});
    events.push(this.formatSSE('content_block_delta', {
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'input_json_delta', partial_json: argsJson },
    }));

    return events;
  }

  handleFinish(finishReason) {
    const events = [];

    // 记住当前 block 类型再关闭
    const lastBlockType = this.currentBlockType;
    if (this.currentBlockType) {
      events.push(this.emitContentBlockStop());
    }

    const hasToolUse = lastBlockType === 'tool_use' || finishReason === 'FUNCTION_CALL';
    const stopReason = hasToolUse ? 'tool_use' :
      finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';

    events.push(this.formatSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    }));

    events.push(this.formatSSE('message_stop', { type: 'message_stop' }));

    return events;
  }

  emitContentBlockStart(block) {
    const event = this.formatSSE('content_block_start', {
      type: 'content_block_start',
      index: this.contentIndex,
      content_block: block,
    });
    return event;
  }

  emitContentBlockStop() {
    const event = this.formatSSE('content_block_stop', {
      type: 'content_block_stop',
      index: this.contentIndex,
    });
    this.contentIndex++;
    this.currentBlockType = null;
    return event;
  }

  // 如果最终没收到 finish，手动关闭
  finalize() {
    const events = [];
    if (!this.started) {
      events.push(this.emitMessageStart());
      events.push(this.emitContentBlockStart({ type: 'text', text: '' }));
      this.currentBlockType = 'text';
      events.push(this.emitContentBlockStop());
    } else if (this.currentBlockType) {
      events.push(this.emitContentBlockStop());
    }
    events.push(this.formatSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    }));
    events.push(this.formatSSE('message_stop', { type: 'message_stop' }));
    return events;
  }

  formatSSE(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// 解析 Gemini SSE 流中的 data 行
function parseGeminiSSELines(chunk) {
  const lines = chunk.split('\n');
  const dataItems = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ')) {
      dataItems.push(trimmed.slice(6));
    }
  }
  return dataItems;
}

module.exports = { StreamConverter, parseGeminiSSELines };
