const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const path = require('path');

const env = require('./config/env');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimiter');
const ApiError = require('./utils/ApiError');

const app = express();
const frontendRoot = path.join(__dirname, '../../../');
const allowedOrigins = new Set([
  ...env.clientOrigins,
  `http://localhost:${env.port}`,
  `http://127.0.0.1:${env.port}`,
]);

// --- security & parsing ---
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow the frontend to load /uploads images
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(mongoSanitize()); // strips keys starting with '$' or containing '.' from user input

if (env.nodeEnv !== 'test') {
  app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
}

// --- CORS ---
// In development with no CLIENT_ORIGINS set, allow any origin so the
// static frontend (opened via a local dev server or file://) can call
// the API. In production, CLIENT_ORIGINS must be set explicitly.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // same-origin / server-to-server / curl
      if (env.clientOrigins.length === 0) {
        if (env.nodeEnv === 'production') {
          return callback(ApiError.forbidden('This origin is not permitted.'));
        }
        return callback(null, true);
      }
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(ApiError.forbidden('This origin is not permitted.'));
    },
    credentials: true,
  })
);

app.use('/api', generalLimiter);

// --- static file serving for uploaded covers/pages ---
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(frontendRoot));

// --- routes ---
app.get('/', (req, res) => res.sendFile(path.join(frontendRoot, 'index.html')));
app.use('/api', routes);

// --- error handling (must be last) ---
app.use(notFound);
app.use(errorHandler);

module.exports = app;
