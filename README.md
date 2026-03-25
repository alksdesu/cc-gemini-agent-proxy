# anthropic-gemini-proxy

Route Claude Code requests to Gemini based on model name. Zero dependencies, pure Node.js.

```
Claude Code ──POST /v1/messages──▶ proxy:4000
                                      │
                          model matches /sonnet/i ?
                            ┌─yes──────┴──────no─┐
                            ▼                     ▼
                     Gemini API             Anthropic API
                  (format translate)         (passthrough)
```

When model name contains `sonnet`, the proxy translates the request to Gemini format, forwards it, and translates the response back. Everything else goes straight to Anthropic untouched.

## Quick Start

```bash
node proxy.js
```

```
🔀 Anthropic ↔ Gemini Proxy
   Listening on http://127.0.0.1:4000
   Gemini route: model matching /sonnet/i → gemini-3.1-pro-preview
   Anthropic route: everything else → https://api.anthropic.com
```

Then point Claude Code at it:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
```

## Config

Edit `config.js` directly or use env vars — whatever you prefer.

```js
// config.js
module.exports = {
  port: 4000,

  anthropic: {
    apiKey: 'sk-ant-your-key',           // or process.env.ANTHROPIC_API_KEY
    baseUrl: 'https://api.anthropic.com', // your Claude endpoint
  },

  gemini: {
    apiKey: 'your-gemini-key',            // or process.env.GEMINI_API_KEY
    baseUrl: 'https://generativelanguage.googleapis.com', // or custom
    model: 'gemini-3.1-pro-preview',
    thinkingLevel: 'medium',              // low / medium / high / max
  },

  // which models go to Gemini
  routeToGemini: (model) => /sonnet/i.test(model),
};
```

Env vars (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GEMINI_BASE_URL`, `GEMINI_MODEL`, etc.) work as fallbacks if you don't hardcode them.

### Custom Gemini URL

If you're using a third-party Gemini endpoint, just set `baseUrl`. The proxy builds the full path automatically:

```
{baseUrl}/v1beta/models/{model}:generateContent
{baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse
```

If your URL needs a different structure, use `{model}` as a placeholder:

```js
baseUrl: 'https://my-gateway.com/v1/models/{model}'
```

## What gets translated

| Anthropic | Gemini |
|---|---|
| `messages[].role: "assistant"` | `contents[].role: "model"` |
| `system` | `systemInstruction` |
| `tools[].input_schema` | `tools[].functionDeclarations[].parameters` |
| `tool_use` / `tool_result` | `functionCall` / `functionResponse` |
| `max_tokens` | `generationConfig.maxOutputTokens` |
| `temperature`, `top_p` | `generationConfig.temperature`, `topP` |
| `stream: true` | `streamGenerateContent?alt=sse` |
| `thinking.budget_tokens` | `thinkingConfig.thinkingLevel` |

Streaming is fully supported — Gemini SSE chunks get translated to Anthropic's `message_start` → `content_block_delta` → `message_stop` event flow in real time.

## Use with Claude Code subagents

The whole point: run your main session on Opus (hits real Anthropic) and route subagents through Gemini.

```yaml
# .claude/agents/gemini-worker.md
---
name: gemini-worker
description: General tasks routed to Gemini
model: sonnet
---

You are a helpful assistant.
```

Claude sees `model: sonnet`, proxy catches it, Gemini handles it.

## Files

```
proxy.js       — HTTP server, routing logic
config.js      — all configuration
converter.js   — Anthropic ↔ Gemini request/response translation
stream.js      — SSE stream translator (Gemini → Anthropic format)
```

## Logging

Set `logLevel` in config or `PROXY_LOG_LEVEL` env var:

- `info` (default) — route decisions, request summaries
- `debug` — full request/response bodies
- `error` — errors only

## Limitations

- Gemini 3.1 Pro can't fully disable thinking (minimum is `low`)
- Image/PDF inputs are translated but not heavily tested
- The proxy doesn't cache or retry — it's a thin translation layer

## License

Do whatever you want with it.
