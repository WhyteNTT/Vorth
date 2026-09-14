const ApiError = require('../utils/ApiError');
const env = require('../config/env');

function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details || null;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    message = 'Validation failed';
  }

  // PostgreSQL invalid UUID
  if (err.code === '22P02') {
    statusCode = 400;
    message = 'Invalid identifier.';
  }

  // PostgreSQL unique constraint violation
  if (err.code === '23505') {
    statusCode = 409;
    message = 'That value is already in use.';
  }

  // Multer file upload errors
  if (err.name === 'MulterError') {
    statusCode = 400;
    message = err.message;
  }

  if (statusCode >= 500) {
    console.error('[error]', err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    details,
    ...(env.nodeEnv === 'development' && statusCode >= 500 ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler };
