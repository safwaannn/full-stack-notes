const express = require('express');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { xss } = require('express-xss-sanitizer');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

const AppError = require('./utils/appError');
const globalErrorHandler = require('./controllers/errorController');

const tourRouter = require('./routes/tourRoutes');
const userRouter = require('./routes/userRoutes');
const reviewRouter = require('./routes/reviewRoutes');

const app = express();

app.set('query parser', 'extended');

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow cross-origin requests (adjust origin in production to your actual domain)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  );
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Security HTTP headers ─────────────────────────────────────────────────────
app.use(helmet());

// ── Development logging ──────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Rate limiting — general API ───────────────────────────────────────────────
const apiLimiter = rateLimit({
  max: 100,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: {
    status: 'fail',
    message: 'Too many requests from this IP, please try again in an hour!',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// ── Rate limiting — auth routes (stricter) ────────────────────────────────────
const authLimiter = rateLimit({
  max: 20,
  windowMs: 15 * 60 * 1000, // 15 minutes
  message: {
    status: 'fail',
    message: 'Too many authentication attempts, please try again in 15 minutes!',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/v1/users/login', authLimiter);
app.use('/api/v1/users/signup', authLimiter);
app.use('/api/v1/users/forgotPassword', authLimiter);

// ── Body parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));

// ── Data sanitisation against NoSQL query injection ──────────────────────────
// express-mongo-sanitize v2 has a bug with Express 5 (tries to set req.query
// which is a read-only getter). Sanitize req.body manually instead.
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize.sanitize(req.body);
  next();
});

// ── Data sanitisation against XSS ────────────────────────────────────────────
app.use(xss());

// ── Prevent HTTP parameter pollution ─────────────────────────────────────────
app.use(
  hpp({
    whitelist: [
      'duration',
      'ratingsQuantity',
      'ratingsAverage',
      'maxGroupSize',
      'difficulty',
      'price',
    ],
  }),
);

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static('./public'));

// ── Request timestamp ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.requestTime = new Date().toISOString();
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/tours', tourRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/reviews', reviewRouter);

// ── Unhandled routes ──────────────────────────────────────────────────────────
app.all('/{*splat}', (req, res, next) => {
  next(new AppError(`Cannot find ${req.originalUrl} on this server!`, 404));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(globalErrorHandler);

module.exports = app;
