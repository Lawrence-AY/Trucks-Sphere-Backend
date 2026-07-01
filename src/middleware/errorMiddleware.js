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
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.originalUrl} not found`,
      details: [],
    },
  });
};

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal Server Error';
  const code = err.code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'API_ERROR');

  console.error(`[Error] ${statusCode}: ${err.message}`, err.stack);

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details: err.details || [],
    },
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = { ApiError, notFoundHandler, errorHandler };
