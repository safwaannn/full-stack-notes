/**
 * ============================================================================
 * TOUR ROUTES
 * ============================================================================
 *
 * WHAT A ROUTER IS
 * ----------------
 * `express.Router()` creates a mini-application: a self-contained bundle of
 * routes and middleware. app.js then mounts it at a prefix:
 *
 *     app.use('/api/v1/tours', tourRouter);
 *
 * Because of that prefix, every path in THIS file is written relative to it.
 * `router.route('/')` means `/api/v1/tours`, and `'/:id'` means
 * `/api/v1/tours/:id`. Change the version to v2 in app.js and every route
 * follows — that is the point of mounting.
 *
 * ⚠️⚠️ RULE #1 OF EXPRESS ROUTING: ORDER MATTERS.
 * Express walks the routes top to bottom and uses the FIRST one that matches.
 * `/:id` is a wildcard — it matches `/top-5-cheap` too, treating "top-5-cheap"
 * as an id. So every specific literal route MUST be declared ABOVE `/:id`.
 * Put `/:id` first and `/top-5-cheap` becomes unreachable: you get
 * "Invalid _id: top-5-cheap" and a very confusing debugging session.
 */
const express = require('express');
const tourController = require('./../controllers/tourController');
const authController = require('./../controllers/authController');
const reviewRouter = require('./../routes/reviewRoutes');

const router = express.Router();

/**
 * ---------------------------------------------------------------------------
 * NESTED ROUTE: reviews that belong to a tour
 * ---------------------------------------------------------------------------
 *     POST /api/v1/tours/:tourId/reviews   → create a review for this tour
 *     GET  /api/v1/tours/:tourId/reviews   → list this tour's reviews
 *
 * "When a request comes in for this tour's reviews, stop handling it here and
 * hand the whole thing to reviewRouter." This is called MOUNTING A ROUTER, and
 * it keeps review logic in the review files rather than duplicating it here.
 *
 * ⚠️ FIX — THIS LINE CRASHED THE SERVER AT STARTUP. The original read:
 *
 *       app.use('/:tourId/reviews', reviewRouter);
 *            ^^^ `app` does not exist in this file!
 *
 * There is no `app` here — only `router`. So Node threw
 * "ReferenceError: app is not defined" the instant this module was required,
 * which happens during app.js's own require chain. Combined with the
 * `reviewScehma` typo in the review model, the application could not start at
 * all. Note that `app` was never imported, and no linter caught it — an
 * undeclared global is a runtime error, not a syntax error.
 *
 * For `:tourId` to be readable inside reviewRouter, that router MUST be created
 * with `{ mergeParams: true }`. Without it, a child router gets its own empty
 * `req.params` and `req.params.tourId` is undefined. See reviewRoutes.js.
 *
 * Declared FIRST because it is the most specific pattern.
 */
router.use('/:tourId/reviews', reviewRouter);

/**
 * ---------------------------------------------------------------------------
 * SPECIAL / LITERAL ROUTES — all above `/:id`
 * ---------------------------------------------------------------------------
 */

// An alias with a prefilled query string. TWO handlers: `aliasTopTours` runs
// first, sets req.query, then calls next() which passes control to getAllTours.
// This is how you chain middleware — as many as you like, comma-separated.
router
  .route('/top-5-cheap')
  .get(tourController.aliasTopTours, tourController.getAllTours);

// Aggregation reports.
router.route('/tour-stats').get(tourController.getTourStats);

// Two routes, one handler. `:year?` optional params were removed in Express 5,
// so we register both paths explicitly and the controller defaults the year.
router.route('/monthly-plan').get(tourController.getMonthlyPlan);
router.route('/monthly-plan/:year').get(tourController.getMonthlyPlan);

/**
 * GEOSPATIAL ROUTES.
 *
 * `/tours-within/400/center/34.111,-118.113/unit/mi`
 *
 * Why not `?distance=400&center=...`? Both work. The path style is a readable
 * convention: the words between the values label them, so the URL documents
 * itself. Query strings suit OPTIONAL parameters; path segments suit REQUIRED
 * ones — and all three of these are required, so paths are the better fit.
 */
router
  .route('/tours-within/:distance/center/:latlng/unit/:unit')
  .get(tourController.getToursWithIn);

router.route('/distances/:latlng/unit/:unit').get(tourController.getDistances);

/**
 * ---------------------------------------------------------------------------
 * THE MAIN CRUD ROUTES
 * ---------------------------------------------------------------------------
 * `router.route('/')` groups the methods that share a path, so you write the
 * path once and chain `.get()`, `.post()` onto it. Purely for readability —
 * `router.get('/', ...)` and `router.post('/', ...)` are identical in behaviour.
 *
 * ⚠️ FIX — SECURITY: PERMISSIONS WERE INCONSISTENT AND BACKWARDS.
 * The original had:
 *   - `GET /` protected  → you had to log in just to browse the tour catalogue
 *   - `POST /` WIDE OPEN → any stranger could create tours
 *   - `PATCH /:id` WIDE OPEN → any stranger could rewrite prices
 *   - `DELETE /:id` correctly restricted
 *
 * That is exactly inverted: reading is harmless, writing is not. Fixed below.
 * The lesson is a general one — when you add `protect` to a router, walk every
 * single route and ask "who should be able to do this?" rather than protecting
 * whichever one you happened to be working on.
 */
router
  .route('/')
  // PUBLIC on purpose: browsing tours is how you attract customers. No login.
  .get(tourController.getAllTours)
  // Creating a tour is a staff action. Note the ORDER: `protect` must come
  // before `restrictTo`, because restrictTo reads `req.user.role`, which only
  // exists after protect has run.
  .post(
    authController.protect,
    authController.restrictTo('admin', 'lead-guide'),
    tourController.createTour,
  );

router
  .route('/:id')
  // Public — anyone may view a single tour (with its reviews).
  .get(tourController.getTour)
  .patch(
    authController.protect,
    authController.restrictTo('admin', 'lead-guide'),
    tourController.updateTour,
  )
  .delete(
    authController.protect,
    authController.restrictTo('admin', 'lead-guide'),
    tourController.deleteTour,
  );

module.exports = router;
