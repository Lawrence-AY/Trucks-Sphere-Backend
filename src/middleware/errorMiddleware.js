/**
 * Centralized error handling middleware
 */

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    code: 'ROUTE_NOT_FOUND',
  });
};

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const rawCode = String(err.code || '').trim().toUpperCase();
  const code = /^[A-Z0-9_:-]+$/.test(rawCode) ? rawCode : `HTTP_${statusCode}`;

  console.error(`[Error] ${statusCode}: ${err.message}`, err.stack);

  res.status(statusCode).json({
    code,
    error: code,
  });
};

module.exports = { ApiError, notFoundHandler, errorHandler };
