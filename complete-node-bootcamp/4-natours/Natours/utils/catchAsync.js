/**
 * ============================================================================
 * catchAsync — the "no more try/catch in every controller" helper
 * ============================================================================
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * Express 4 does NOT understand promises. If an `async` handler rejects, the
 * rejection is invisible to Express: the client just hangs forever until it
 * times out, and you get an "UnhandledPromiseRejection" warning in your logs.
 *
 * So without help, EVERY single controller would need this boilerplate:
 *
 *   exports.getAllTours = async (req, res, next) => {
 *     try {
 *       const tours = await Tour.find();
 *       res.status(200).json({ status: 'success', data: tours });
 *     } catch (err) {
 *       next(err);          // <-- the only interesting line
 *     }
 *   };
 *
 * That try/catch is identical in all 20 controllers. Pure noise.
 *
 * THE SOLUTION: a higher-order function
 * -------------------------------------
 * "Higher-order function" just means: a function that takes a function and
 * returns a new function. Read the code below in three steps:
 *
 *   1. `catchAsync(fn)`  — we hand it our async controller. It does NOT run it.
 *   2. It returns a brand-new `(req, res, next) => {...}` function. THIS is
 *      what we actually give to Express as the route handler.
 *   3. Later, when a request arrives, Express calls that returned function.
 *      Only NOW does our `fn` run — and because we attached `.catch(next)`,
 *      any rejection is automatically forwarded to Express's error pipeline.
 *
 * WHY `.catch(next)` AND NOT `.catch(err => next(err))`?
 * -----------------------------------------------------
 * They are the same thing. `.catch()` calls whatever function you give it with
 * the error as the first argument — which is exactly `next(err)`. Passing
 * `next` directly is just shorter.
 *
 * WHY IS THERE NO `await` HERE?
 * -----------------------------
 * We don't need the result — we only need to know if it failed. Calling an
 * `async` function returns a promise immediately, and we attach `.catch` to it.
 * Adding `await` would mean this wrapper also becomes async, and then *its*
 * rejection would need handling. Simpler this way.
 *
 * A SUBTLE BUG THIS AVOIDS
 * ------------------------
 * `Promise.resolve(fn(...))` is used below instead of a bare `fn(...).catch()`.
 * Why? If someone accidentally wraps a NON-async function that throws
 * synchronously, `fn(...)` would throw before `.catch` could ever be attached,
 * and the error would escape. `Promise.resolve()` cannot help with a sync
 * throw either — so we add a real try/catch as a final safety net. This makes
 * catchAsync safe to wrap around literally anything.
 *
 * NOTE: Express 5 (which this project uses) DOES auto-forward rejected
 * promises from async handlers. So catchAsync is technically optional here.
 * We keep it because it is explicit, it also covers sync throws, and it keeps
 * the code portable back to Express 4.
 */
module.exports = (fn) => {
  // The function Express will actually call for each request.
  return (req, res, next) => {
    try {
      // Promise.resolve() normalises the return value: if `fn` is async we get
      // its promise back unchanged; if it somehow returned a plain value, we
      // get an already-resolved promise. Either way `.catch` is safe to call.
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      // Safety net for a synchronous `throw` inside a non-async function.
      next(err);
    }
  };
};
