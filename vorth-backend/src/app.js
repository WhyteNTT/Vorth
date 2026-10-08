const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');

const env = require('./config/env');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimiter');
const { requestId } = require('./middleware/requestId');
const ApiError = require('./utils/ApiError');

const app = express();
const frontendRoot = path.join(__dirname, '../../vorth-frontend');

// Only trust X-Forwarded-* when explicitly told to; otherwise a client could
// spoof its IP and walk straight through the rate limiters.
if (env.trustProxy) app.set('trust proxy', 1);

const allowedOrigins = new Set([
  ...env.clientOrigins,
  `http://localhost:${env.port}`,
  `http://127.0.0.1:${env.port}`,
]);

// --- security & parsing ---
//
// Content-Security-Policy is declared explicitly. Helmet's default is
// `default-src 'self'` with no connect-src, which silently blocked the
// frontend's fetch() calls whenever the API was on a different origin than
// the page (e.g. opening the page on 127.0.0.1 while the API was on localhost).
const connectSources = ["'self'", ...allowedOrigins];
const imageSources = ["'self'", 'data:', 'blob:', ...allowedOrigins];

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow the frontend to load /uploads images
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // The UI builds gradients and backgrounds via inline style attributes.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      // Allow the API to be reached from the configured frontend origins.
      connectSrc: connectSources,
      imgSrc: imageSources,
      mediaSrc: imageSources,
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
/*
 * First, so every later middleware - including the logger and the error handler -
 * has an id to attach to. Placed before the body parsers deliberately: a request
 * with a malformed JSON body fails in `express.json()` and goes straight to the
 * error handler, and that is exactly the kind of 500 whose log line needs to say
 * which request it was.
 */
app.use(requestId);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// Required to read the httpOnly refresh-token cookie on /api/auth/*.
app.use(cookieParser());

if (env.nodeEnv !== 'test') {
  /*
   * `:id` is a morgan token this app defines, reading `req.id` set by requestId
   * above. Declaring it and appending it to the built-in format keeps every
   * existing field in place - `combined` and `dev` stay exactly what they were -
   * rather than hand-rolling an equivalent format, which would change every log
   * line in production for the sake of one field.
   *
   * morgan.token is a global registry rather than a per-instance one, so this is
   * idempotent: re-requiring app.js in a test process redefines the same token to
   * the same function.
   */
  morgan.token('id', (req) => req.id || '-');
  const base = env.nodeEnv === 'production' ? 'combined' : 'dev';
  app.use(morgan(`${base} :id`));
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
