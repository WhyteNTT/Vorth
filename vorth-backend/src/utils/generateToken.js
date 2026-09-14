const jwt = require('jsonwebtoken');
const env = require('../config/env');

function generateToken(user) {
  return jwt.sign(
    { id: user.id.toString(), role: user.role },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

module.exports = generateToken;
