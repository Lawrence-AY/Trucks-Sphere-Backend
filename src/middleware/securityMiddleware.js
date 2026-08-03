/**
 * Security Middleware — Rate Limiting, Input Sanitization, SQL Injection Prevention
 *
 * Provides:
 *  - Rate limiting per IP/client (prevents brute force & DDoS)
 *  - Input sanitization (XSS, SQL injection, NoSQL injection prevention)
 *  - Request size limiting
 *  - Additional security headers via helmet config
 */

// ─── Rate Limiting Store (in-memory with TTL) ───
const rateLimitStore = new Map(); // key → { count, resetAt, blocked }

// Clean up expired entries every 60 seconds
const cleanupRateLimitStore = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (entry.blocked && now > entry.blockedUntil) {
      rateLimitStore.delete(key);
    } else if (now > entry.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 60000);
cleanupRateLimitStore.unref();

/**
 * Rate Limiter Middleware Factory
 */
function rateLimiter(options = {}) {
  const { windowMs = 60000, max = 100, blockDurationMs = 300000 } = options;

  return (req, res, next) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || 'unknown';
    const routeKey = req.path;
    const key = `${clientIp}:${routeKey}`;
    const now = Date.now();
    let entry = rateLimitStore.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs, blocked: false };
      rateLimitStore.set(key, entry);
    }

    if (entry.blocked) {
      if (now < entry.blockedUntil) {
        const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfterSeconds: retryAfter });
      }
      entry.blocked = false;
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count++;
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      entry.blocked = true;
      entry.blockedUntil = now + blockDurationMs;
      const retryAfter = Math.ceil(blockDurationMs / 1000);
      res.set('Retry-After', String(retryAfter));
      console.warn(`[Security] Rate limit exceeded: ${clientIp} on ${routeKey} (${entry.count}/${max})`);
      return res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfterSeconds: retryAfter });
    }
    next();
  };
}

const authRateLimiter = rateLimiter({ windowMs: 60000, max: 10, blockDurationMs: 900000 });
const apiRateLimiter = rateLimiter({ windowMs: 60000, max: 200, blockDurationMs: 300000 });
const passwordResetRateLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5, blockDurationMs: 30 * 60 * 1000 });

// ─── Input Sanitization ───

const INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|UNION|EXEC|EXECUTE)\b.*\b(FROM|INTO|TABLE|DATABASE|WHERE|SET)\b)/i,
  /(\$where|\$gt|\$gte|\$lt|\$lte|\$ne|\$in|\$nin|\$regex|\$exists|\$type|\$mod|\$elemMatch)/i,
  /<script[\s>]/i,
  /on\w+\s*=/i,
  /javascript:/i,
  /(\bexec\b.*\bxp_cmdshell\b|\bexec\b.*\bsp_executesql\b)/i,
  /\bOR\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
  /\/\*[\s\S]*?\*\/|\bUNION\b.*\bSELECT\b/i,
];

// This API does not accept shell expressions. Reject command substitution,
// shell chaining, and process-launch constructs before they reach any route.
const COMMAND_INJECTION_PATTERNS = [
  /(?:`[^`]*`|\$\([^)]*\))/,
  /(?:^|[;&|])\s*(?:bash|sh|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|curl|wget|nc|ncat|netcat|python(?:3)?|node|perl|ruby)\b/i,
  /(?:&&|\|\|)\s*\S+/,
  /(?:^|[;&|])\s*(?:rm|del|rmdir|mkfs|shutdown|reboot)\b/i,
];

function findCommandInjection(value, fieldName = '') {
  if (typeof value === 'string') {
    return COMMAND_INJECTION_PATTERNS.some((pattern) => pattern.test(value)) ? fieldName || 'input' : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = findCommandInjection(value[index], `${fieldName}[${index}]`);
      if (match) return match;
    }
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const match = findCommandInjection(item, fieldName ? `${fieldName}.${key}` : key);
      if (match) return match;
    }
  }
  return null;
}

function commandInjectionFilter(req, res, next) {
  const field = findCommandInjection(req.body, 'body') || findCommandInjection(req.query, 'query');
  if (!field) return next();
  console.warn(`[Security] Command injection pattern rejected in field "${field}"`);
  return res.status(400).json({ error: 'Request contains unsupported command syntax.' });
}

function sanitizeValue(value, fieldName = '') {
  if (typeof value !== 'string') return value;
  let sanitized = value;
  sanitized = sanitized.replace(/\0/g, '');
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      console.warn(`[Security] Injection pattern detected in field "${fieldName}"`);
      sanitized = sanitized.replace(pattern, '[FILTERED]');
    }
  }
  return sanitized;
}

function sanitizeObject(obj, prefix = '') {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeValue(obj, prefix);
  if (Array.isArray(obj)) return obj.map((item, i) => sanitizeObject(item, `${prefix}[${i}]`));
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      sanitized[key] = sanitizeObject(value, fullKey);
    }
    return sanitized;
  }
  return obj;
}

function inputSanitizer(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object') req.body = sanitizeObject(req.body);
    if (req.query && typeof req.query === 'object') {
      const cleanQuery = {};
      for (const [key, value] of Object.entries(req.query)) {
        cleanQuery[key] = sanitizeValue(typeof value === 'string' ? value : String(value), `query.${key}`);
      }
      req.query = cleanQuery;
    }
    if (req.params && typeof req.params === 'object') {
      const cleanParams = {};
      for (const [key, value] of Object.entries(req.params)) {
        cleanParams[key] = sanitizeValue(typeof value === 'string' ? value : String(value), `param.${key}`);
      }
      req.params = cleanParams;
    }
    next();
  } catch (err) {
    console.error('[Security] Input sanitization error:', err.message);
    next();
  }
}

function requestSizeLimiter(maxSize = 10485760) {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxSize) {
      return res.status(413).json({ error: 'Request entity too large', maxSizeBytes: maxSize, maxSizeMB: Math.round(maxSize / 1048576) });
    }
    next();
  };
}

const SENSITIVE_FIELD_PATTERN = /(password|token|secret|authorization|cookie|api[_-]?key|credential|private[_-]?key|oobcode|code)$/i;

function redactSensitiveData(value, key = '') {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [entryKey, redactSensitiveData(item, entryKey)]));
  }
  return value;
}

function sanitizedRequestPath(req) {
  const query = redactSensitiveData(req.query || {});
  const entries = Object.entries(query);
  if (!entries.length) return req.path;
  const serialized = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
  return `${req.path}?${serialized}`;
}

function requestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.info('[HTTP]', {
      method: req.method,
      path: sanitizedRequestPath(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip,
    });
  });
  next();
}

function enforceHttpsInProduction(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (req.secure || forwardedProto === 'https') return next();

  const host = String(req.get('host') || '');
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
    return res.status(400).json({ error: 'Invalid host header.' });
  }
  return res.redirect(308, `https://${host}${req.originalUrl}`);
}

const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'"],
      objectSrc: ["'none'"], mediaSrc: ["'self'"], frameSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true, noSniff: true, originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
};

module.exports = {
  rateLimiter,
  authRateLimiter,
  apiRateLimiter,
  passwordResetRateLimiter,
  commandInjectionFilter,
  inputSanitizer,
  requestSizeLimiter,
  requestLogger,
  enforceHttpsInProduction,
  helmetConfig,
  sanitizeValue,
  sanitizeObject,
  redactSensitiveData,
  findCommandInjection,
};
