#!/usr/bin/env node
// Anthropic → Gemini 路由代理服务器

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const { anthropicToGeminiRequest, geminiToAnthropicResponse, patchToolResultNames } = require('./converter');
const { StreamConverter, parseGeminiSSELines } = require('./stream');

const LOG = {
  debug: (...args) => config.logLevel === 'debug' && console.log('[DEBUG]', ...args),
  info: (...args) => ['debug', 'info'].includes(config.logLevel) && console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

// ============================================================
// 主服务器
// ============================================================

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', routes: { gemini: 'sonnet*', anthropic: 'others' } }));
  }

  // 只处理 Messages API
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);

      LOG.info(`→ ${parsed.model} | stream=${!!parsed.stream} | messages=${(parsed.messages || []).length}`);

      if (config.routeToGemini(parsed.model)) {
        await handleGeminiRoute(req, res, parsed);
      } else {
        await handleAnthropicRoute(req, res, body);
      }
    } catch (err) {
      LOG.error('Request handling failed:', err.message);
      sendError(res, 500, err.message);
    }
    return;
  }

  // 其他路径直接代理到 Anthropic
  await proxyToAnthropic(req, res);
});

// ============================================================
// Gemini 路由（格式转换）
// ============================================================

async function handleGeminiRoute(req, res, anthropicBody) {
  // 给 tool_result 补上 name
  if (anthropicBody.messages) {
    patchToolResultNames(anthropicBody.messages);
  }

  const geminiReq = anthropicToGeminiRequest(anthropicBody);
  const isStream = !!anthropicBody.stream;
  const model = config.gemini.model;
  const endpoint = isStream ? 'streamGenerateContent' : 'generateContent';
  const queryParams = isStream ? '?alt=sse' : '';

  // 构造 Gemini URL
  let geminiUrl;
  const apiKey = config.gemini.apiKey;
  const baseUrl = config.gemini.baseUrl;

  // 支持自定义 URL 格式
  if (baseUrl.includes('{model}')) {
    // 用户自定义了带 {model} 占位符的 URL
    geminiUrl = baseUrl.replace('{model}', model);
    if (!geminiUrl.includes('?')) {
      geminiUrl += isStream ? `/${endpoint}${queryParams}` : `/${endpoint}`;
    }
    // 如果 URL 里已有 key 参数就不再加
    if (!geminiUrl.includes('key=') && apiKey) {
      geminiUrl += (geminiUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
    }
  } else {
    geminiUrl = `${baseUrl}/v1beta/models/${model}:${endpoint}${queryParams}`;
    if (apiKey) {
      geminiUrl += (geminiUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
    }
  }

  LOG.info(`  → Gemini: ${model} (${endpoint})`);
  LOG.debug('  Gemini URL:', geminiUrl.replace(/key=[^&]+/, 'key=***'));
  LOG.debug('  Gemini body:', JSON.stringify(geminiReq).slice(0, 500));

  const reqBody = JSON.stringify(geminiReq);
  const urlObj = new URL(geminiUrl);
  const transport = urlObj.protocol === 'https:' ? https : http;

  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(reqBody),
    },
  };

  // 如果有自定义 auth header（非标准 key= 方式）
  if (req.headers['x-goog-api-key']) {
    options.headers['x-goog-api-key'] = req.headers['x-goog-api-key'];
  }

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        handleGeminiError(proxyRes, res, anthropicBody.model);
        return resolve();
      }

      if (isStream) {
        handleGeminiStream(proxyRes, res, anthropicBody.model);
      } else {
        handleGeminiNonStream(proxyRes, res, anthropicBody.model);
      }
      resolve();
    });

    proxyReq.on('error', (err) => {
      LOG.error('Gemini request error:', err.message);
      sendError(res, 502, `Gemini connection failed: ${err.message}`);
      resolve();
    });

    proxyReq.write(reqBody);
    proxyReq.end();
  });
}

function handleGeminiStream(proxyRes, res, originalModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const converter = new StreamConverter(originalModel);
  let leftover = '';

  proxyRes.on('data', (chunk) => {
    const text = leftover + chunk.toString();
    const lines = text.split('\n');
    // 最后一行可能不完整，暂存
    leftover = lines.pop() || '';

    let accumulated = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        accumulated = trimmed.slice(6);
        // 处理这个 data
        const events = converter.processGeminiChunk(accumulated);
        for (const ev of events) {
          res.write(ev);
        }
      }
    }
  });

  proxyRes.on('end', () => {
    // 处理残余
    if (leftover.trim().startsWith('data: ')) {
      const events = converter.processGeminiChunk(leftover.trim().slice(6));
      for (const ev of events) {
        res.write(ev);
      }
    }

    // 确保正确关闭
    if (!converter.currentBlockType && converter.started) {
      // 已经正常 finish 了
    } else {
      const finalEvents = converter.finalize();
      for (const ev of finalEvents) {
        res.write(ev);
      }
    }

    res.end();
    LOG.info('  ← Gemini stream done');
  });

  proxyRes.on('error', (err) => {
    LOG.error('Gemini stream error:', err.message);
    res.end();
  });
}

function handleGeminiNonStream(proxyRes, res, originalModel) {
  let data = '';
  proxyRes.on('data', (chunk) => { data += chunk; });
  proxyRes.on('end', () => {
    try {
      const geminiResp = JSON.parse(data);
      const anthropicResp = geminiToAnthropicResponse(geminiResp, originalModel);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicResp));
      LOG.info(`  ← Gemini response: ${anthropicResp.stop_reason}`);
    } catch (err) {
      LOG.error('Failed to parse Gemini response:', err.message, data.slice(0, 500));
      sendError(res, 502, 'Invalid Gemini response');
    }
  });
}

function handleGeminiError(proxyRes, res, originalModel) {
  let data = '';
  proxyRes.on('data', (chunk) => { data += chunk; });
  proxyRes.on('end', () => {
    LOG.error(`Gemini returned ${proxyRes.statusCode}:`, data.slice(0, 500));
    // 转换为 Anthropic 格式的错误
    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: `Gemini API error (${proxyRes.statusCode}): ${data.slice(0, 200)}`,
      },
    }));
  });
}

// ============================================================
// Anthropic 路由（直接透传）
// ============================================================

async function handleAnthropicRoute(req, res, bodyStr) {
  await proxyToAnthropicWithBody(req, res, bodyStr);
}

async function proxyToAnthropic(req, res) {
  const targetUrl = `${config.anthropic.baseUrl}${req.url}`;
  LOG.info(`  → Anthropic passthrough: ${req.method} ${req.url}`);

  return proxyRaw(req, res, targetUrl, null);
}

async function proxyToAnthropicWithBody(req, res, bodyStr) {
  const targetUrl = `${config.anthropic.baseUrl}${req.url}`;
  LOG.info(`  → Anthropic passthrough: ${req.method} ${req.url}`);

  return proxyRaw(req, res, targetUrl, bodyStr);
}

function proxyRaw(req, res, targetUrl, body) {
  const urlObj = new URL(targetUrl);
  const transport = urlObj.protocol === 'https:' ? https : http;

  // 复制原始 headers，替换 host
  const headers = { ...req.headers };
  headers.host = urlObj.host;

  // 确保 anthropic API key 正确
  if (config.anthropic.apiKey) {
    headers['x-api-key'] = config.anthropic.apiKey;
  }

  // 如果有 body，更新 content-length
  if (body != null) {
    headers['content-length'] = Buffer.byteLength(body);
  }

  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: req.method,
    headers,
  };

  return new Promise((resolve) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      // 透传响应 headers
      const respHeaders = {};
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        respHeaders[key] = val;
      }
      res.writeHead(proxyRes.statusCode, respHeaders);
      proxyRes.pipe(res);
      proxyRes.on('end', () => {
        LOG.info('  ← Anthropic response done');
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      LOG.error('Anthropic proxy error:', err.message);
      sendError(res, 502, `Anthropic connection failed: ${err.message}`);
      resolve();
    });

    if (body != null) {
      proxyReq.write(body);
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  });
}

// ============================================================
// 工具函数
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message },
  }));
}

// ============================================================
// 启动
// ============================================================

server.listen(config.port, () => {
  console.log(`\n🔀 Anthropic ↔ Gemini Proxy`);
  console.log(`   Listening on http://127.0.0.1:${config.port}`);
  console.log(`   Gemini route: model matching /sonnet/i → ${config.gemini.model}`);
  console.log(`   Anthropic route: everything else → ${config.anthropic.baseUrl}`);
  console.log(`   Gemini base: ${config.gemini.baseUrl}`);
  if (!config.anthropic.apiKey) console.log('   ⚠ ANTHROPIC_API_KEY not set');
  if (!config.gemini.apiKey) console.log('   ⚠ GEMINI_API_KEY not set (ok if using custom URL with auth)');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} already in use. Set PROXY_PORT to use a different port.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
