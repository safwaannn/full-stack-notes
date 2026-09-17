/**
 * ============================================================================
 * server.js — THE ENTRY POINT
 * ============================================================================
 *
 * This file's whole job is running the PROCESS:
 *   1. load environment variables
 *   2. install the process-level safety nets
 *   3. connect to the database
 *   4. start listening
 *   5. shut down cleanly when asked
 *
 * All request handling lives in app.js. See the note at the top of that file for
 * why the split matters (short version: it makes the app testable).
 *
 * ⚠️ ORDER IN THIS FILE IS CRITICAL, and for a reason that is easy to miss:
 *
 *     dotenv.config()  MUST come BEFORE  require('./app')
 *
 * `require` executes a module immediately, and app.js — through its routers and
 * controllers — reads `process.env` at load time. If the app is required first,
 * those values are still `undefined`, and you get baffling failures like a JWT
 * signed with an undefined secret. Any line that reads `process.env` must run
 * after dotenv.
 */

/* ═══════════════ 1. UNCAUGHT EXCEPTIONS — register first ════════════════ */

/**
 * ADDED (this was missing entirely). A SYNCHRONOUS error that nothing caught —
 * a typo like `console.log(x)` where `x` was never defined.
 *
 * WHY REGISTER IT AT THE VERY TOP? Because it can only catch what happens after
 * it is installed. Placed at the bottom of the file, a crash during the requires
 * above it would go unhandled.
 *
 * WHY `process.exit(1)` AND NOT JUST LOG? Because after an uncaught exception the
 * process is in an UNKNOWN state — a function was abandoned halfway, so variables
 * may be half-updated and locks unreleased. Continuing risks corrupting data.
 * The correct response is to crash loudly and let a process manager (nodemon in
 * development, pm2 or Docker in production) start a clean one. Exit code 1 means
 * "failure", which is how the supervisor knows to restart.
 *
 * ⚠️ THIS IS A SAFETY NET, NOT ERROR HANDLING. If it fires, you have a bug to
 * fix — do not use it as a way to keep a broken process alive.
 */
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION! Shutting down...');
  console.error(err.name, err.message);
  console.error(err.stack);
  process.exit(1);
});

const mongoose = require('mongoose');
const dotenv = require('dotenv');

/* ═════════════════════ 2. ENVIRONMENT VARIABLES ═════════════════════════ */

/**
 * Reads config.env and copies each KEY=value into `process.env`.
 *
 * WHY A SEPARATE FILE AT ALL? So secrets are not in your source code. config.env
 * is listed in .gitignore, which means the database password and JWT secret never
 * reach GitHub. This matters more than it sounds: bots scan public repos for
 * leaked credentials within minutes of a push.
 *
 * The path is relative to the CURRENT WORKING DIRECTORY, not to this file. So you
 * must run `npm start` from inside the /Natours folder. (`path.join(__dirname,
 * 'config.env')` would be robust against that, and is the better habit.)
 */
dotenv.config({ path: './config.env' });

/**
 * ADDED — FAIL FAST ON MISSING CONFIGURATION.
 *
 * Without this, a missing variable produces a confusing failure much later and
 * far away: an absent `JWT_SECRET` makes `jwt.sign` throw "secretOrPrivateKey
 * must have a value" on the first login attempt, which looks like an auth bug
 * rather than a config one. Checking up front turns a mysterious runtime error
 * into a clear message at startup. This is the "fail fast" principle: if the app
 * cannot possibly work, refuse to start.
 */
const requiredEnv = [
  'DATABASE',
  'DATABASE_PASSWORD',
  'JWT_SECRET',
  'JWT_EXPIREIN',
  'JWT_COOKIE_EXPIREIN',
];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`💥 Missing required env variables: ${missing.join(', ')}`);
  console.error('   Check your config.env file.');
  process.exit(1);
}

// Required AFTER dotenv — see the note at the top of this file.
const app = require('./app');

/* ══════════════════════ 3. DATABASE CONNECTION ══════════════════════════ */

/**
 * The Atlas connection string in config.env holds a `<PASSWORD>` placeholder
 * rather than the real password, so that the two secrets stay on separate lines
 * and the URI can be shared or logged more safely. `.replace()` swaps it in.
 *
 * ⚠️ `.replace()` with a STRING only replaces the FIRST occurrence — fine here
 * since there is exactly one placeholder, but worth knowing. `replaceAll()` or a
 * `/g` regex replaces every one.
 *
 * ADDED — `.catch()` ON THE CONNECTION. The original had only `.then()`, so a
 * failed connection (wrong password, IP not whitelisted in Atlas, no internet)
 * became an unhandled promise rejection: a wall of stack trace with no
 * explanation, while the HTTP server carried on listening and every request
 * hung waiting for a database that was never there. Now it reports the real
 * reason and exits.
 */
const DB = process.env.DATABASE.replace(
  '<PASSWORD>',
  process.env.DATABASE_PASSWORD,
);

mongoose
  .connect(DB)
  .then(() => console.log('✅ DB connection successful'))
  .catch((err) => {
    console.error('💥 DB connection FAILED:', err.message);
    console.error(
      '   Check: password correct? IP whitelisted in Atlas? Online?',
    );
    process.exit(1);
  });

/* ═══════════════════════ 4. START THE SERVER ════════════════════════════ */

/**
 * `process.env.PORT || 3000` — read the port from the environment, falling back
 * to 3000. Not optional in production: hosts like Heroku and Render ASSIGN you a
 * port through this variable and your app must use it, or it is unreachable.
 *
 * We keep the returned server object because the shutdown handlers below need it
 * to call `server.close()`.
 */
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  console.log(`🚀 Listening on http://localhost:${port}`);
  console.log(`   Environment: ${process.env.NODE_ENV}`);
});

/* ══════════════════ 5. UNHANDLED PROMISE REJECTIONS ═════════════════════ */

/**
 * ADDED (also missing). The ASYNCHRONOUS counterpart to `uncaughtException`: a
 * rejected promise that nobody attached a `.catch()` to. The typical cause is an
 * outage the app cannot recover from — the database going away mid-flight.
 *
 * NOTE THE DIFFERENT SHUTDOWN STYLE, and this is the interesting part:
 *
 *     server.close(() => process.exit(1));
 *
 * `server.close()` performs a GRACEFUL shutdown: it stops accepting NEW
 * connections but lets in-flight requests finish, and only then runs the
 * callback. Calling `process.exit(1)` directly would kill the process instantly
 * and every user mid-request would get a dropped connection.
 *
 * Why is `uncaughtException` above NOT graceful? Because there the process state
 * is untrustworthy — finishing requests could write corrupt data. Here the code
 * is fine, an external dependency failed, so draining cleanly is safe and
 * strictly better. The distinction is worth internalising: *graceful when the
 * process is healthy, immediate when it is not.*
 */
process.on('unhandledRejection', (err) => {
  console.error('💥 UNHANDLED REJECTION! Shutting down gracefully...');
  console.error(err.name, err.message);

  server.close(() => {
    process.exit(1);
  });
});

/**
 * ADDED — SIGTERM. This is not an error: it is a platform politely asking the
 * process to stop (a deploy, a scale-down, `docker stop`). Heroku and Kubernetes
 * send SIGTERM and then SIGKILL a few seconds later, so handling it is the
 * difference between finishing your in-flight requests and having them severed
 * mid-response on every single deploy.
 *
 * Exit code 0 here, not 1 — this was a normal, requested shutdown, and a
 * supervisor reads a non-zero code as a crash worth alerting on.
 */
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('   Process terminated.');
    process.exit(0);
  });
});
