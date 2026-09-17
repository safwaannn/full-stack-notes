/**
 * ============================================================================
 * REVIEW CONTROLLER
 * ============================================================================
 *
 * Reviews are served from TWO different URL shapes, and both reach these same
 * handlers:
 *
 *   GET  /api/v1/reviews                  — every review (admin-style listing)
 *   GET  /api/v1/tours/:tourId/reviews    — only that tour's reviews  (NESTED)
 *   POST /api/v1/tours/:tourId/reviews    — create a review for that tour
 *
 * WHY NESTED ROUTES ARE WORTH THE TROUBLE: the URL itself expresses the
 * relationship. `/tours/abc123/reviews` reads as "the reviews belonging to tour
 * abc123", so the client never has to know the field name `tour` or construct a
 * filter. It also means the tour id cannot be omitted or mismatched.
 *
 * The machinery that makes it work is in reviewRoutes.js (`mergeParams: true`)
 * and factoryHandler.js (`if (req.params.tourId) filter = {...}`).
 */
const AppError = require('./../utils/appError.js');
const catchAsync = require('./../utils/catchAsync.js');
const factory = require('./factoryHandler.js');
const Review = require('./../models/reviewModal.js');

/**
 * ---------------------------------------------------------------------------
 * Fill in `tour` and `user` before creating a review
 * ---------------------------------------------------------------------------
 * A review needs both fields (they are `required` in the schema), but we don't
 * want the client sending them:
 *
 *   `tour` comes from the URL (`/tours/:tourId/reviews`), so a nested POST needs
 *          only `{ review, rating }` in the body.
 *
 *   `user` comes from the TOKEN. This is the security-critical part.
 *
 * ⚠️ FIX — THIS WAS A REAL VULNERABILITY. The original wrote:
 *
 *       if (!req.body.user) req.body.user = req.params.id;
 *
 * `req.params.id` is the URL parameter — on a POST to `/reviews` it doesn't even
 * exist, so `user` was undefined and creation failed the `required` validator
 * with a confusing 500-ish error. But the worse problem is the pattern itself:
 * taking an identity from the URL (or from the body) means the client CHOOSES who
 * the review is attributed to. That is IMPERSONATION — anyone could post reviews
 * signed with someone else's user id.
 *
 * The correct source is `req.user.id`, set by `protect` from the verified JWT.
 * The rule generalises: **an identity must always come from the token, never from
 * anything the client can type.**
 *
 * The `if (!req.body.X)` guards let an admin override these when hitting the
 * non-nested `/reviews` route directly. If you want to forbid that entirely,
 * drop the `if` and always overwrite — that is the stricter, safer choice.
 */
exports.setTourUserId = (req, res, next) => {
  if (!req.body.tour) req.body.tour = req.params.tourId;
  if (!req.body.user) req.body.user = req.user.id;
  next();
};

/**
 * ---------------------------------------------------------------------------
 * OWNERSHIP CHECK  (ADDED — this was missing, and it mattered)
 * ---------------------------------------------------------------------------
 * ⚠️ THE HOLE IT CLOSES: reviewRoutes.js allows `restrictTo('user', 'admin')` on
 * PATCH and DELETE. `restrictTo` only checks the ROLE — so ANY logged-in user
 * could edit or delete ANY other user's review, simply by knowing its id. Role
 * checks answer "what KIND of user are you?", never "is this yours?".
 *
 * That second question needs the document itself, so it has to be checked here:
 * load the review, compare its `user` to the caller, and let admins bypass.
 *
 * `review.user` may be a populated User document (the model's pre-find hook
 * populates it) or a raw ObjectId, so we normalise with `._id ?? review.user`
 * before comparing. And we compare STRINGS: an ObjectId is an object, so
 * `idA === idB` is false even for the same id — you must call `.toString()`.
 * Silently-failing ObjectId comparison is a classic Mongoose trap, and here it
 * would fail *open*, denying nobody.
 *
 * Used in the router as middleware before updateReview / deleteReview.
 */
exports.restrictToOwner = catchAsync(async (req, res, next) => {
  const review = await Review.findById(req.params.id);

  if (!review) {
    return next(new AppError('No review found with that ID', 404));
  }

  // Admins may moderate anyone's review.
  if (req.user.role === 'admin') return next();

  const ownerId = (review.user?._id ?? review.user).toString();
  if (ownerId !== req.user.id) {
    return next(
      new AppError('You can only modify your own reviews', 403),
    );
  }

  next();
});

/**
 * ---------------------------------------------------------------------------
 * THE CRUD HANDLERS
 * ---------------------------------------------------------------------------
 * All five come from the factory. Nothing about reviews needs custom CRUD logic
 * — the interesting behaviour lives elsewhere:
 *
 *   - recalculating the tour's `ratingsAverage` → the post-save and
 *     post-findOneAnd hooks in models/reviewModal.js
 *   - blocking duplicate reviews → the compound unique index, also in the model
 *   - filtering by tour on the nested route → `factory.getAll`
 *
 * `getAllReviews` opts into populating the tour NAME. The model deliberately no
 * longer populates `tour` on every find (it caused a chain of redundant queries
 * when a tour populated its reviews — see the note in reviewModal.js), so the
 * standalone review list, where the tour name genuinely is useful, asks for it
 * here instead. That is the pattern: populate at the call site that needs it,
 * not globally in the model.
 */
exports.getAllReviews = factory.getAll(Review, { path: 'tour', select: 'name' });
exports.getReview = factory.getOne(Review, { path: 'tour', select: 'name' });
exports.createReview = factory.createOne(Review);
exports.updateReview = factory.updateOne(Review);
exports.deleteReview = factory.deleteOne(Review);
