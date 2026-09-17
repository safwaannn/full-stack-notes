/**
 * ============================================================================
 * app.js — THE EXPRESS APPLICATION
 * ============================================================================
 *
 * WHY IS THIS SEPARATE FROM server.js?
 * ------------------------------------
 * A clean separation of concerns:
 *   app.js    — everything about HANDLING requests (middleware, routes)
 *   server.js — everything about RUNNING the process (env vars, DB, listen)
 *
 * The practical payoff: `app` can be imported without starting a server. That is
 * what makes automated testing possible — a test file requires `app`, fires fake
 * requests at it with supertest, and never binds a port. If `app.listen()` lived
 * in here, importing the app would occupy port 3000 and tests would collide.
 *
 * ⚠️⚠️ THE MOST IMPORTANT CONCEPT IN THIS FILE: THE MIDDLEWARE STACK.
 * ------------------------------------------------------------------
 * Express is, at heart, a list of functions that a request walks through in
 * order. Each one can inspect it, change it, end it, or call `next()` to pass it
 * along:
 *
 *   request → helmet → morgan → express.json → sanitizers → router → response
 *                                    │
 *                             if anything calls next(err)
 *                                    ↓
 *                           globalErrorHandler
 *
 * ORDER IS EVERYTHING. `app.use()` calls run in the sequence you write them, so
 * misplacing one line can silently disable it. The classic example: if
 * `express.json()` came AFTER the routes, `req.body` would be `undefined` in
 * every controller — no error, just mysteriously empty bodies. The ordering
 * below is deliberate and commented.
 */
const path = require('path');
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

/**
 * Express 5 defaults to the 'simple' query parser, which does NOT build nested
 * objects. Our API relies on `?price[gte]=500` arriving as
 * `{ price: { gte: '500' } }` — with the simple parser it would arrive as the
 * literal key `'price[gte]'` and all advanced filtering would silently stop
 * working. 'extended' restores the Express 4 behaviour.
 */
app.set('query parser', 'extended');

/* ══════════════════════════ 1. GLOBAL MIDDLEWARE ═════════════════════════ */

/**
 * --- SECURITY HEADERS (helmet) --------------------------------------------
 * Sets about a dozen HTTP headers that harden the browser's behaviour:
 * Content-Security-Policy, X-Frame-Options (blocks clickjacking),
 * Strict-Transport-Security (forces HTTPS), and removes `X-Powered-By` so you
 * aren't advertising your stack to scanners.
 *
 * ⚠️ MOVED TO THE TOP. It was previously registered after the logger, the static
 * files and the rate limiter — so any response produced by those (every image and
 * CSS file in /public, and every 429 from the limiter) went out with NO security
 * headers at all. A security header only protects the responses that pass through
 * it after it was registered. Security middleware belongs first, always.
 */
app.use(helmet());

/**
 * --- REQUEST LOGGING (morgan) --------------------------------------------
 * 'dev' gives colour-coded one-liners:  GET /api/v1/tours 200 12.4 ms - 8734
 *
 * Wrapped in a dev-only check: in production you want a structured format that a
 * log aggregator can parse ('combined'), and logging every request to stdout on a
 * busy server is a measurable cost. Also, morgan logs the full URL — including
 * any token accidentally passed as a query parameter.
 */
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

/**
 * --- STATIC FILES ---------------------------------------------------------
 * Serves everything in /public directly. `public/overview.html` becomes
 * `http://localhost:3000/overview.html` — note there is NO `/public` in the URL;
 * the folder becomes the web root.
 *
 * ⚠️ FIX: the original passed the relative string `'./public'`. Relative paths
 * are resolved against the CURRENT WORKING DIRECTORY, not against this file. So
 * it worked when you ran `npm start` from inside /Natours, and silently served
 * nothing if you started the app from the parent folder or via a process manager
 * that sets a different cwd. `path.join(__dirname, 'public')` is always correct
 * because `__dirname` is this file's own directory. Use it for every filesystem
 * path in a Node app.
 */
app.use(express.static(path.join(__dirname, 'public')));

/**
 * --- RATE LIMITING -------------------------------------------------------
 * Caps each IP at 100 requests per hour on `/api`. The defence against
 * brute-forcing passwords and against someone hammering your database.
 *
 * `windowMs` is the window in MILLISECONDS: 60 * 60 * 1000 = one hour. Writing
 * the multiplication out is clearer than the literal 3600000 and much harder to
 * get wrong by a factor of ten.
 *
 * Applied only to `/api` so static assets aren't counted — a single page load
 * pulls a dozen images and would eat the budget immediately.
 *
 * ADDED `standardHeaders`, which makes the limiter send `RateLimit-Limit` and
 * `RateLimit-Remaining`, so a well-behaved client can slow itself down instead of
 * discovering the limit by being blocked.
 *
 * ⚠️ A LIMITATION WORTH KNOWING: this counts by IP, held in memory. Behind a
 * proxy or load balancer every request appears to come from the proxy's IP, so
 * one user's traffic would exhaust everybody's quota — you need
 * `app.set('trust proxy', 1)` for that. And because the store is in memory, the
 * counts reset on restart and are not shared between instances. For real
 * production use a Redis store.
 */
const limiter = rateLimit({
  max: 100,
  windowMs: 60 * 60 * 1000,
  standardHeaders: true,
  message: 'Too many requests from this IP, please try again in an hour.',
});
app.use('/api', limiter);

/**
 * --- BODY PARSER ---------------------------------------------------------
 * Reads the raw JSON body off the request stream and puts the parsed object on
 * `req.body`. Without this, `req.body` is undefined in every controller.
 *
 * `limit: '10kb'` rejects anything larger with a 413. This is a real safeguard:
 * without a limit, someone can POST a 500MB body and exhaust your server's
 * memory — a trivially cheap denial of service.
 */
app.use(express.json({ limit: '10kb' }));

/**
 * --- COOKIE PARSER (hand-written) ----------------------------------------
 * Reads the `Cookie` header into `req.cookies`, which `authController.protect`
 * uses so a browser session works from the httpOnly cookie without the front-end
 * attaching an Authorization header.
 *
 * Normally you would `npm install cookie-parser` and `app.use(cookieParser())`.
 * It is implemented by hand here purely to avoid an extra dependency — and it is
 * a good illustration of how little the real package does for the read path.
 *
 * The Cookie header is one string: `jwt=abc123; theme=dark`. So: split on '; ',
 * then split each pair on the FIRST '=' only — a JWT contains dots and base64
 * padding, and a naive `.split('=')` would truncate any value containing '='.
 * `decodeURIComponent` reverses the percent-encoding cookies use for special
 * characters.
 */
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;

  if (header) {
    header.split(';').forEach((pair) => {
      const index = pair.indexOf('=');
      if (index < 0) return; // malformed fragment, skip it
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      try {
        req.cookies[key] = decodeURIComponent(value);
      } catch {
        // A malformed percent-escape makes decodeURIComponent throw. Keep the
        // raw value rather than letting one bad cookie 500 the whole request.
        req.cookies[key] = value;
      }
    });
  }

  next();
});

/**
 * --- NoSQL INJECTION SANITISATION ---------------------------------------
 * Strips any key starting with `$` or containing `.` from the body and query.
 *
 * THE ATTACK IT STOPS. Post this to /login:
 *     { "email": { "$gt": "" }, "password": "..." }
 * `$gt: ""` means "any email greater than the empty string" — i.e. ALL of them —
 * so `User.findOne()` returns the first user in the collection and the attacker
 * is attempting a login against an account they never had to name. Because
 * MongoDB queries ARE JSON, an attacker who controls a JSON value controls part
 * of your query. That is the NoSQL equivalent of SQL injection.
 *
 * WHY THE MANUAL WRAPPER instead of `app.use(mongoSanitize())`? In Express 5
 * `req.query` is a lazy GETTER with no setter, so the library's normal approach
 * of assigning to `req.query` throws "Cannot set property query". Redefining the
 * property with `Object.defineProperty` is the working workaround. Keep it until
 * the package ships Express 5 support.
 *
 * NOTE: this is a second line of defence. The first is `APIFeatures.filter()`,
 * which allow-lists the operators it will pass to Mongo. Layered defences are the
 * point — either one alone can be bypassed by something you didn't think of.
 */
app.use((req, res, next) => {
  req.body = mongoSanitize.sanitize(req.body);

  Object.defineProperty(req, 'query', {
    value: mongoSanitize.sanitize(req.query),
    writable: true,
    configurable: true,
  });

  next();
});

/**
 * --- XSS SANITISATION ---------------------------------------------------
 * Strips HTML/script tags out of incoming data. Stops an attacker storing
 * `<script>steal(document.cookie)</script>` as their user name, which would then
 * execute in the browser of every admin who views the user list. That is called
 * STORED XSS, and it is dangerous precisely because the payload is served by your
 * own trusted domain.
 *
 * The httpOnly cookie in authController is the paired defence: even if a script
 * does run, it cannot read the token.
 *
 * (`xss-clean`, which you will see in older tutorials, is deprecated and
 * unmaintained — `express-xss-sanitizer` is its live replacement. The unused
 * `xss-clean` entry can be dropped from package.json.)
 */
app.use(xss());

/**
 * --- PARAMETER POLLUTION (hpp) ------------------------------------------
 * `?sort=price&sort=duration` makes Express produce an ARRAY:
 * `sort: ['price', 'duration']`. Code written expecting a string then calls
 * `.split(',')` on an array and crashes with "split is not a function". `hpp`
 * keeps only the LAST occurrence, so the value is always a string.
 *
 * The `whitelist` names the fields where duplicates are legitimate — you really
 * might want `?duration=5&duration=9` to mean "either". Anything not listed gets
 * de-duplicated.
 *
 * ⚠️ MUST COME AFTER the body parser and the sanitisers — it operates on the
 * already-parsed query, so registering it earlier would leave it nothing to clean.
 */
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

/**
 * --- A CUSTOM MIDDLEWARE, AS AN EXAMPLE ---------------------------------
 * Stamps every request with its arrival time. This is the general pattern for
 * passing data down the chain: attach it to `req`, and every later handler can
 * read it. There is no other shared context between middleware.
 *
 * Note it takes `(req, res, next)` — three parameters. Four would make Express
 * treat it as an ERROR handler and it would never run. See errorController.
 */
app.use((req, res, next) => {
  req.requestTime = new Date().toISOString();
  next();
});

/* ═══════════════════════════════ 2. ROUTES ═══════════════════════════════ */

/**
 * MOUNTING THE ROUTERS. Each router handles everything under its prefix, so
 * tourRoutes.js writes `'/:id'` and it becomes `/api/v1/tours/:id`.
 *
 * WHY `/api/v1/`? VERSIONING. The day you need to change a response shape in a
 * breaking way, you publish `/api/v2/` and leave v1 running, so existing clients
 * keep working while they migrate. Retro-fitting versioning after clients depend
 * on your URLs is painful; costing nothing now, it is always worth doing.
 */
app.use('/api/v1/tours', tourRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/reviews', reviewRouter);

/* ══════════════════════ 3. 404 — UNMATCHED ROUTES ═══════════════════════ */

/**
 * A CATCH-ALL for any request that matched nothing above.
 *
 * WHY IT WORKS: middleware runs in order, so anything reaching this line has
 * already been offered to every router and rejected. `app.all` covers every HTTP
 * verb, and `'/{*splat}'` is Express 5's syntax for "any path" (Express 4 wrote
 * this as `'*'` — the syntax changed with the new path-matching engine).
 *
 * ⚠️ IT MUST BE AFTER ALL THE ROUTES. Put it above them and it swallows
 * everything: every request in your app becomes a 404.
 *
 * `next(new AppError(...))` routes it through the same global error handler as
 * everything else, so a 404 has the same JSON shape as any other error and the
 * front-end needs no special case for it.
 */
app.all('/{*splat}', (req, res, next) => {
  next(new AppError(`Cannot find ${req.originalUrl} on this server`, 404));
});

/* ═════════════════════ 4. GLOBAL ERROR HANDLER ══════════════════════════ */

/**
 * THE LAST `app.use` IN THE FILE — and that is a requirement, not a style choice.
 * Express only sends an error to an error-handling middleware registered AFTER
 * the code that produced it. Registered above the routes, it would never fire and
 * every error would fall through to Express's ugly default HTML error page.
 *
 * It is recognised as an error handler purely by having FOUR parameters. See
 * controllers/errorController.js for how it decides what is safe to send.
 */
app.use(globalErrorHandler);

module.exports = app;
