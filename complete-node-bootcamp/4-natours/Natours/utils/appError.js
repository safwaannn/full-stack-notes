/**
 * ============================================================================
 * AppError — our own custom Error class
 * ============================================================================
 *
 * WHY DO WE NEED THIS AT ALL?
 * ---------------------------
 * JavaScript's built-in `Error` only carries a `message`. But an HTTP API needs
 * more than a message — it needs to know:
 *
 *   1. WHICH status code to send back (404? 400? 500?)
 *   2. Is this a "normal" error we EXPECTED (bad input, wrong password),
 *      or is it a real BUG in our code (typo, reading a property of undefined)?
 *
 * That second question is the important one. We must NEVER leak internal bug
 * details (stack traces, DB internals) to the client in production — that is a
 * security leak. But we DO want to tell the user "you sent an invalid email".
 *
 * So we tag our own errors with `isOperational = true`, meaning:
 *   "This is a predictable, human-caused problem. It is safe to show."
 *
 * Anything that reaches the global error handler WITHOUT that flag is treated
 * as a programming bug → generic 500 "Something went wrong" for the client,
 * full details logged on the server only. See controllers/errorController.js.
 *
 * HOW `extends Error` WORKS
 * ------------------------
 * `class AppError extends Error` means AppError *is an* Error. So:
 *   - `err instanceof Error` is true (Express recognises it as an error)
 *   - it gets a real `.stack` (the list of calls that led to this line)
 * `super(message)` calls the parent Error constructor, which is what actually
 * sets `this.message`. It MUST be called before we touch `this`.
 *
 * USAGE
 * -----
 *   return next(new AppError('No tour found with that ID', 404));
 *
 * Passing anything to `next()` tells Express: "skip all remaining normal
 * middleware and jump straight to the error-handling middleware".
 *
 * IMPORTANT: always `return next(...)`. Without `return`, the function keeps
 * running after handing the error off, and you get the classic
 * "Cannot set headers after they are sent to the client" crash.
 */
class AppError extends Error {
  constructor(message, statusCode) {
    // Let the built-in Error set up `this.message` and the prototype chain.
    super(message);

    this.statusCode = statusCode;

    // Convenience label: 4xx = the CLIENT did something wrong  → 'fail'
    //                    5xx = the SERVER did something wrong  → 'error'
    // We turn the number into a string so we can inspect its first character:
    //   `${404}`.startsWith('4') === true
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';

    // The flag that separates "expected problem" from "bug in my code".
    this.isOperational = true;

    // Removes THIS constructor from the stack trace, so the trace begins at
    // the line where you actually wrote `new AppError(...)`. Much easier to
    // debug — you see your controller, not this file.
    //
    // NOTE the spelling: captureStackTrace (capture-Stack-Trace). A typo here
    // throws "Error.captureStackTrace is not a function".
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
