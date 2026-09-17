/**
 * ============================================================================
 * GLOBAL ERROR HANDLING MIDDLEWARE
 * ============================================================================
 *
 * THE BIG IDEA
 * ------------
 * Every error in this whole application — from any controller, any model
 * validator, any DB failure — ends up in this ONE function. That is possible
 * because of a single Express rule:
 *
 *   A middleware function with FOUR parameters `(err, req, res, next)` is an
 *   ERROR-HANDLING middleware.
 *
 * Express counts the parameters. Four = error handler; three = normal
 * middleware. So `(err, req, res)` with three params would silently be treated
 * as a normal handler and never receive errors — and `next` must stay in the
 * signature even though we never call it. This is genuinely surprising and
 * catches everybody once.
 *
 * Express jumps here the moment anything is passed to `next(...)`, skipping all
 * remaining normal middleware. Combined with `catchAsync`, that means one place
 * decides what every client ever sees when something goes wrong.
 *
 * WHY THIS IS SO VALUABLE
 * -----------------------
 * 1. CONSISTENCY — every error has the same JSON shape, so the front-end needs
 *    one error path, not thirty.
 * 2. SECURITY — one place decides what to hide. Stack traces and DB internals
 *    are told the front-end nothing in production.
 * 3. CLEAN CONTROLLERS — a controller says `next(new AppError('Not found', 404))`
 *    and stops thinking about presentation.
 *
 * MOUNTING MATTERS: `app.use(globalErrorHandler)` must be the LAST `app.use` in
 * app.js. Express runs middleware in registration order, so an error handler
 * registered before your routes will never see their errors.
 */
const AppError = require('./../utils/appError');

/**
 * ============================================================================
 * PART 1 — TRANSLATORS: turn ugly technical errors into friendly AppErrors
 * ============================================================================
 *
 * Errors thrown by MongoDB, Mongoose and the JWT library are not `AppError`s,
 * so they carry no `isOperational` flag and no status code. Left alone, a user
 * typing a malformed id would get a scary 500 "Something went wrong" when the
 * honest answer is a 400 "that id is invalid".
 *
 * Each function below recognises one specific error and returns a clean
 * AppError in its place.
 */

/**
 * CastError — Mongoose could not convert a value to the schema's type.
 * Almost always a malformed ObjectId:  GET /api/v1/tours/not-a-real-id
 * `err.path` is the field name ('_id'), `err.value` is what was supplied.
 */
const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

/**
 * Duplicate key — MongoDB error code 11000. Raised by a `unique` index: a
 * duplicate tour name, an email that is already registered, or the same user
 * reviewing the same tour twice.
 *
 * ⚠️ FIX — THE ORIGINAL LINE WAS BROKEN IN TWO WAYS:
 *
 *     const value = err.errmsg.match(/(["'])(?:(?=(\\?))\2.)*?\1/[0]);
 *
 *   (a) The `[0]` is INSIDE the regex literal — `/regex/[0]` indexes into the
 *       RegExp object and evaluates to `undefined`, so `match(undefined)`
 *       searched for the literal string "undefined" and returned null.
 *   (b) `err.errmsg` does not always exist on modern driver versions, so this
 *       could throw "Cannot read properties of undefined (reading 'match')" —
 *       an error INSIDE the error handler, which crashes the process.
 *
 * The modern fix is far simpler: the driver hands us `err.keyValue`, an object
 * of exactly the fields that clashed, e.g. `{ email: 'a@b.com' }`. No regex
 * needed at all. Regex-scraping an error message was always fragile — it breaks
 * whenever the database changes its wording.
 */
const handleDuplicateFieldsDB = (err) => {
  // `?? {}` guards against a shape we didn't anticipate, so this translator can
  // never itself be the thing that crashes.
  const keyValue = err.keyValue ?? {};
  const fields = Object.keys(keyValue).join(', ');
  const values = Object.values(keyValue).join(', ');

  const message = fields
    ? `Duplicate value for ${fields}: "${values}". Please use another value.`
    : 'Duplicate field value. Please use another value.';

  return new AppError(message, 400);
};

/**
 * ValidationError — one or more schema rules failed (required, minlength, enum,
 * a custom validator...).
 *
 * `err.errors` is an OBJECT keyed by field name, where each value has its own
 * `.message`. `Object.values()` turns it into an array so we can map over it and
 * report every problem at once rather than one at a time.
 *
 * ⚠️ FIX: the original read `${errorsdjoin('. ')}` — a mangled
 * `errors.join('. ')`. It threw "errorsdjoin is not defined" *inside the error
 * handler*, so any validation failure in production became an unhandled crash
 * instead of a 400. Errors in your error handler are the worst kind of bug:
 * they destroy the one safety net you have.
 */
const handleValidationErrorDB = (err) => {
  const errors = Object.values(err.errors).map((el) => el.message);
  const message = `Invalid input data. ${errors.join('. ')}`;
  return new AppError(message, 400);
};

/**
 * A malformed / tampered / wrongly-signed JWT.
 *
 * ⚠️ FIX: the original checked for `'JWTError'`, which is not a real name. The
 * `jsonwebtoken` library throws `JsonWebTokenError`. So the check never matched
 * and a bad token produced a 500 instead of a 401 — meaning a client could not
 * tell "please log in again" apart from "the server is broken".
 */
const handleJWTError = () =>
  new AppError('Invalid token. Please log in again.', 401);

/**
 * An expired JWT.
 *
 * ⚠️ FIX: same class of mistake — the real name is `TokenExpiredError`, not
 * `JWTExpiredError`. Worth remembering the two exact strings; you cannot guess
 * them, you have to look them up in the library's docs.
 */
const handleJWTExpiredError = () =>
  new AppError('Your token has expired. Please log in again.', 401);

/**
 * ============================================================================
 * PART 2 — SENDERS: dev gets everything, production gets only what's safe
 * ============================================================================
 */

/**
 * DEVELOPMENT: dump absolutely everything. You are the only one reading it, and
 * the stack trace is what actually tells you which line broke.
 */
const sendErrorDev = (err, req, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    message: err.message,
    stack: err.stack,
  });
};

/**
 * PRODUCTION: this is the security boundary.
 *
 *   isOperational === true  → an error WE created deliberately with AppError.
 *                             The message was written for a user. Safe to send.
 *
 *   isOperational undefined → a bug, or an unrecognised library error. Its
 *                             message may expose file paths, queries or schema
 *                             internals. Log it for us, send a generic message
 *                             to them.
 *
 * That distinction is the whole reason AppError exists.
 */
const sendErrorProd = (err, req, res) => {
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  }

  // An unexpected error: log the FULL thing server-side. In a real deployment
  // this is where you'd also report to Sentry / Datadog.
  console.error('💥 UNEXPECTED ERROR:', err);

  return res.status(500).json({
    status: 'error',
    message: 'Something went very wrong. Please try again later.',
  });
};

/**
 * ============================================================================
 * PART 3 — THE HANDLER ITSELF
 * ============================================================================
 */
module.exports = (err, req, res, next) => {
  // Defaults, in case something reached us that isn't an AppError — e.g. a
  // plain `throw new Error('oops')`, which has no statusCode at all. Without
  // these, `res.status(undefined)` throws.
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'production') {
    /**
     * ⚠️ FIX — THE SUBTLEST AND MOST IMPORTANT BUG IN THIS FILE.
     *
     * The original wrote:  let error = { ...err };
     *
     * Spreading an Error looks like it copies it, but it does NOT. Spread only
     * copies OWN ENUMERABLE properties — and on an Error object, `name`,
     * `message` and `stack` are all NON-enumerable. So `{ ...err }` produces an
     * object with `error.name === undefined` and `error.message === undefined`.
     *
     * The consequence: EVERY check below (`error.name === 'CastError'`, etc.)
     * compared undefined to a string and failed. None of the translators ever
     * ran in production. Worse, the copy is a plain object, not an Error, so it
     * lost `isOperational` too — meaning even your own carefully-worded
     * AppError messages were replaced by "Something went very wrong".
     *
     * In other words: in production this file did nothing but return generic
     * 500s. And it worked fine in development, because that branch never
     * copies. A bug that only appears in production is the hardest kind to find.
     *
     * THE FIX: `Object.create(Object.getPrototypeOf(err))` makes a new object
     * with the SAME prototype (so it is still a real Error / AppError), and
     * `Object.assign` + explicit copies bring the non-enumerable fields across.
     *
     * (Why copy at all instead of mutating `err`? So each translator can return
     * a fresh AppError without us having destroyed the original — handy if you
     * later want to log the untouched error.)
     */
    let error = Object.create(Object.getPrototypeOf(err));
    Object.assign(error, err);
    error.name = err.name;
    error.message = err.message;
    error.statusCode = err.statusCode;
    error.status = err.status;
    error.isOperational = err.isOperational;

    // ⚠️ FIX: was `'castError'` (lowercase c). Mongoose uses `CastError`.
    // String comparison is case-sensitive, so this never matched.
    if (error.name === 'CastError') error = handleCastErrorDB(error);

    // ⚠️ FIX: was `error.code === '11000'` — the STRING '11000'. The driver
    // sets a NUMBER. `'11000' === 11000` is false with `===`, so duplicate-key
    // errors always fell through to the generic 500. This is the classic
    // strict-equality type trap.
    if (error.code === 11000) error = handleDuplicateFieldsDB(error);

    if (error.name === 'ValidationError')
      error = handleValidationErrorDB(error);

    // ⚠️ FIX: correct library error names (see the translators above).
    if (error.name === 'JsonWebTokenError') error = handleJWTError();
    if (error.name === 'TokenExpiredError') error = handleJWTExpiredError();

    return sendErrorProd(error, req, res);
  }

  // Development is the default — safer to over-share locally than to
  // accidentally hide a stack trace because NODE_ENV was misspelled.
  return sendErrorDev(err, req, res);
};
