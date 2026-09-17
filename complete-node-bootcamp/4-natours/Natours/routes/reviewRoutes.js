/**
 * ============================================================================
 * REVIEW ROUTES
 * ============================================================================
 * This router is mounted TWICE, which is what makes reviews reachable two ways:
 *
 *   app.js:        app.use('/api/v1/reviews', reviewRouter)
 *                    → GET /api/v1/reviews
 *
 *   tourRoutes.js: router.use('/:tourId/reviews', reviewRouter)
 *                    → GET  /api/v1/tours/:tourId/reviews
 *                    → POST /api/v1/tours/:tourId/reviews
 *
 * One set of handlers, two URL shapes. The controllers adapt by checking whether
 * `req.params.tourId` is present.
 */
const express = require('express');
const reviewController = require('./../controllers/reviewController');
const authController = require('./../controllers/authController');

/**
 * ⚠️ `{ mergeParams: true }` — THE ONE LINE THAT MAKES NESTING WORK.
 *
 * By default each router gets its own `req.params`, containing only the
 * parameters from ITS OWN path. So when tourRouter matches `:tourId` and hands
 * off to this router, `:tourId` belongs to the PARENT's params — and inside here
 * `req.params.tourId` would be `undefined`.
 *
 * `mergeParams: true` tells Express to merge the parent's params into this
 * router's. That is how `factory.getAll` can read `req.params.tourId` to filter,
 * and how `setTourUserId` can read it to populate `req.body.tour`.
 *
 * Leave it out and the symptom is subtle rather than loud: no error, but the
 * nested GET returns EVERY review instead of just that tour's, and the nested
 * POST fails validation with "A review must belong to a tour". If a nested route
 * misbehaves, this is the first line to check.
 */
const router = express.Router({ mergeParams: true });

/**
 * EVERY review route requires a login. `router.use()` with no path applies to all
 * routes below it — same "secure by default" pattern as userRoutes.js. Reviews
 * are attributed to a person, so there is no meaningful anonymous case: we need
 * `req.user` on reads too, since `restrictToOwner` compares against it.
 */
router.use(authController.protect);

router
  .route('/')
  .get(reviewController.getAllReviews)
  .post(
    // Only ordinary users write reviews. Guides and admins reviewing their own
    // tours would be a conflict of interest, so they are excluded on purpose —
    // this is a business rule, not an oversight.
    authController.restrictTo('user'),
    // Fills in `tour` (from the URL) and `user` (from the TOKEN) before the
    // generic create handler runs. See reviewController for why the user id must
    // come from the token.
    reviewController.setTourUserId,
    reviewController.createReview,
  );

router
  .route('/:id')
  .get(reviewController.getReview)
  /**
   * ⚠️ `restrictToOwner` IS ADDED HERE, AND IT CLOSES A REAL HOLE.
   *
   * `restrictTo('user', 'admin')` alone only answers "what KIND of account is
   * this?" — it cannot answer "is this review yours?". So previously ANY
   * logged-in user could PATCH or DELETE ANY review, just by knowing its id.
   *
   * Role-based checks and ownership checks are two different things, and you
   * almost always need BOTH. The rule of thumb: any route with an `:id` that
   * points at user-generated content needs an ownership check. `restrictToOwner`
   * loads the review, compares its author to `req.user.id`, and lets admins
   * through so they can still moderate.
   *
   * The ORDER of these three is deliberate: cheap role check first (no DB hit),
   * then the ownership check (one query), then the actual work.
   */
  .patch(
    authController.restrictTo('user', 'admin'),
    reviewController.restrictToOwner,
    reviewController.updateReview,
  )
  .delete(
    authController.restrictTo('user', 'admin'),
    reviewController.restrictToOwner,
    reviewController.deleteReview,
  );

module.exports = router;
