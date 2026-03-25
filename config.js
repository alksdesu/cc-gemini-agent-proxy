// Anthropic → Gemini 路由代理配置

module.exports = {
  port: parseInt(process.env.PROXY_PORT || '4000', 10),

  // Anthropic 直连配置（opus 等走这里）
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: (process.env.ANTHROPIC_REAL_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  },

  // Gemini 配置（sonnet 走这里）
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
    model: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
    // thinking 级别：low / medium / high / max
    thinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'medium',
  },

  // 路由规则：哪些模型名走 Gemini
  routeToGemini(model) {
    return /sonnet/i.test(model);
  },

  // 安全设置（默认全部关闭限制）
  safetySettings: [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
  ],

  // 日志级别: 'debug' | 'info' | 'error'
  logLevel: process.env.PROXY_LOG_LEVEL || 'info',
};
