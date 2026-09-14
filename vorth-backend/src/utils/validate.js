const { validationResult } = require('express-validator');
const ApiError = require('./ApiError');

// Call at the top of any route handler after a validation chain to
// short-circuit with a clean 400 response if input failed validation.
function throwIfInvalid(req) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const details = result.array().map((e) => ({ field: e.path, message: e.msg }));
    throw ApiError.badRequest('Validation failed', details);
  }
}

module.exports = throwIfInvalid;
