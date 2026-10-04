const ApiError = require('../utils/ApiError');
const env = require('../config/env');

function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

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

  // PostgreSQL foreign key violation. Reachable by racing a delete - a comment
  // posted the instant its series goes away - so it is the caller's timing, not
  // a broken server. The constraint name is not echoed: it maps the schema.
  if (err.code === '23503') {
    statusCode = 409;
    message = 'That refers to something that no longer exists.';
  }

  // PostgreSQL check constraint violation: the value was well-formed but is not
  // allowed, which is a client problem.
  if (err.code === '23514') {
    statusCode = 400;
    message = 'That value is not allowed.';
  }

  // Multer file upload errors
  if (err.name === 'MulterError') {
    statusCode = 400;
    message = err.message;
  }

  if (statusCode >= 500) {
    console.error('[error]', err);

    /*
     * A 5xx message was almost certainly not written for a reader. It comes from
     * pg, fs or a driver, and reads like `relation "series" does not exist` or
     * `ECONNREFUSED 127.0.0.1:5432` - schema names, file paths, host and port,
     * served to anyone who can reach the API.
     *
     * The browser did not show any of it, because the frontend rewrites 5xx
     * bodies before rendering them. That is a display filter, not a boundary:
     * curl, a script, and the next client this ships all get the raw message.
     * So the message is filtered here too, at the point where it leaves.
     *
     * ApiError.isOperational marks the errors whose wording was chosen on
     * purpose. Those are kept even at 5xx - a deliberate `ApiError.internal(...)`
     * is something a person wrote for a human, and discarding it would throw away
     * information we chose to give.
     */
    if (!err.isOperational) {
      message = 'Something went wrong on our side. Please try again.';
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
    details,
    // Development only, and only when NODE_ENV says so explicitly - an unset
    // NODE_ENV must not read as development on a host that forgot to set it.
    ...(env.nodeEnv === 'development' && statusCode >= 500 ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler };
