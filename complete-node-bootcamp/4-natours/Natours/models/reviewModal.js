/**
 * ============================================================================
 * REVIEW MODEL
 * ============================================================================
 *
 * ⚠️ THIS FILE CONTAINED THE BUG THAT BROKE **EVERY** API ENDPOINT.
 *
 * The variable was declared as `reviewSchema` but then used as `reviewScehma`
 * (letters transposed) on four lines. In JavaScript, reading an undeclared
 * variable throws a ReferenceError immediately — at REQUIRE time, not when a
 * route is hit. The chain was:
 *
 *     server.js → app.js → reviewRoutes → reviewController → reviewModal.js 💥
 *
 * So Node crashed before `app.listen()` ever ran, and *nothing* worked — not
 * tours, not login, nothing. This is worth internalising: one typo in a module
 * that is imported at startup takes down the entire application, and the error
 * message points at a file you may not even have been editing. Always read the
 * FIRST line of a stack trace.
 *
 * (The filename says "Modal" — a spelling slip for "Model"; a modal is a popup
 * dialog. It is left as-is so existing imports keep working, but if you rename
 * it to `reviewModel.js`, update the two requires in reviewController.js and
 * dev-data/data/import-dev-data.js.)
 *
 * WHAT THIS MODEL DEMONSTRATES: a "parent referencing" join table. Each review
 * stores WHICH tour and WHICH user it belongs to, and the interesting logic is
 * keeping the parent tour's rating average in sync automatically.
 */
const mongoose = require('mongoose');
const Tour = require('./tourModel');

const reviewSchema = new mongoose.Schema(
  {
    review: {
      type: String,
      required: [true, 'A review cannot be empty'],
      trim: true,
    },

    rating: {
      type: Number,
      default: 4.5,
      min: [1, 'Rating must be at least 1'],
      max: [5, 'Rating must be at most 5'],
    },

    createdAt: {
      type: Date,

      // ⚠️ FIX — A CLASSIC AND VERY SNEAKY BUG.
      // The original was `default: Date.now()` WITH parentheses. That CALLS the
      // function once, at the moment this file is first loaded, and stores the
      // resulting fixed number as the default. Result: every review ever
      // created gets the timestamp of when the server last restarted.
      //
      // Without parentheses we pass the function ITSELF, and Mongoose calls it
      // fresh for each new document. Remember it as:
      //   Date.now   → "here is how to get the time"  ✅
      //   Date.now() → "here is the time, right now"  ❌
      default: Date.now,
    },

    /**
     * PARENT REFERENCING: the review points at its parent, not the other way
     * round. The right choice whenever the child list could grow without bound
     * — a popular tour might collect thousands of reviews, and MongoDB caps a
     * single document at 16MB.
     */
    user: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: [true, 'A review must belong to a user'],
    },

    tour: {
      type: mongoose.Schema.ObjectId,
      ref: 'Tour',
      required: [true, 'A review must belong to a tour'],
    },
  },
  {
    // Needed for virtuals to appear in API responses — see tourModel.js.
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/**
 * ============================================================================
 * PREVENT DUPLICATE REVIEWS
 * ============================================================================
 * A COMPOUND UNIQUE INDEX on (tour, user): the PAIR must be unique. So one user
 * can review many tours, and one tour can be reviewed by many users, but the
 * same user cannot review the same tour twice.
 *
 * This is enforced by MongoDB, not Mongoose, so a violation arrives as a raw
 * MongoServerError with code 11000 — handled and translated into a readable 400
 * by controllers/errorController.js.
 *
 * ⚠️ IF DUPLICATES ALREADY EXIST in your collection, MongoDB silently refuses
 * to build this index and logs a warning at startup — after which duplicates
 * keep being allowed. If this doesn't seem to work, delete the existing reviews
 * and re-import:
 *     node dev-data/data/import-dev-data.js --delete-users-reviews
 *     node dev-data/data/import-dev-data.js --import-users-reviews
 */
reviewSchema.index({ tour: 1, user: 1 }, { unique: true });

/**
 * ============================================================================
 * QUERY MIDDLEWARE — auto-populate the author
 * ============================================================================
 * So a review response carries the reviewer's name and photo instead of a bare
 * ObjectId the front-end would have to resolve itself.
 *
 * ⚠️ WHY WE NO LONGER POPULATE `tour` HERE (this was a real inefficiency):
 * `GET /tours/:id` populates its `reviews` virtual. If each of those reviews
 * then populates its `tour`, you get the parent tour fetched again for every
 * single review — and each of those tours populates ITS guides, because
 * tourModel has a pre-find populate hook. Ten reviews meant ~21 extra queries
 * and a deeply nested response with the same tour repeated ten times.
 *
 * This is called a "populate chain" or N+1 query problem, and it is the most
 * common performance trap in Mongoose. Populating only `user` here keeps a
 * single tour request to 3 queries. Where the tour name is genuinely needed —
 * the standalone `GET /reviews` list — the controller asks for it explicitly.
 *
 * ⚠️ FIX — MONGOOSE 9 BREAKING CHANGE: the `next` parameter is gone (see the
 * long note in tourModel.js). Mongoose 9 does not pass it, so the original
 * `next()` call threw "next is not a function" on every review query.
 */
reviewSchema.pre(/^find/, function () {
  this.populate({
    path: 'user',
    select: 'name photo',
  });
});

/**
 * ============================================================================
 * DENORMALISATION: keeping `ratingsAverage` on the Tour up to date
 * ============================================================================
 *
 * THE PROBLEM: `GET /tours` should show each tour's average rating. Computing
 * that on every request means aggregating over all reviews of all tours — slow,
 * and repeated for data that barely changes.
 *
 * THE SOLUTION: store the average ON the tour, and recompute it whenever a
 * review is created, updated or deleted. Reads become instant; writes do a
 * little extra work. That trade — duplicating derived data for read speed — is
 * called DENORMALISATION, and it is a normal, deliberate technique in MongoDB
 * (unlike in SQL, where it is usually a smell).
 *
 * WHY A `static` AND NOT A `method`? Statics live on the MODEL
 * (`Review.calcAverageRatings()`), methods live on a document. We need
 * `this.aggregate()`, which only exists on the model. Inside a static, `this`
 * IS the Review model.
 *
 * (Renamed from `calcAvergaeRatings` — "Avergae" — so the name is searchable.)
 */
reviewSchema.statics.calcAverageRatings = async function (tourId) {
  // An AGGREGATION PIPELINE: data flows through the stages in order, each one
  // transforming what the previous produced.
  const stats = await this.aggregate([
    // Stage 1 — keep only this tour's reviews.
    { $match: { tour: tourId } },
    // Stage 2 — collapse them into one summary row.
    {
      $group: {
        _id: '$tour', // group key: the field to group by ($ = "the value of")
        nRating: { $sum: 1 }, // add 1 per document = a count
        avgRating: { $avg: '$rating' }, // the mean of the rating field
      },
    },
  ]);

  // `stats` is an array. It has one entry if reviews exist, and is EMPTY if the
  // last review was just deleted — which is exactly why we need the else branch.
  if (stats.length > 0) {
    // ⚠️ FIX: these were `ratingQuantity` / `ratingAverage` — both missing the
    // "s". The Tour schema calls them `ratingsQuantity` / `ratingsAverage`.
    // Because Mongoose silently DROPS unknown fields by default (strict mode),
    // this update did absolutely nothing, with no error to hint at it. Ratings
    // simply never updated. Field-name typos in an update object are silent —
    // this is why they are so hard to spot.
    await Tour.findByIdAndUpdate(tourId, {
      ratingsQuantity: stats[0].nRating,
      ratingsAverage: stats[0].avgRating,
    });
  } else {
    // No reviews left → reset to the schema defaults.
    // ⚠️ FIX: the original wrote `ratingQuantity: 1` here, claiming one rating
    // when there are zero. Should be 0.
    await Tour.findByIdAndUpdate(tourId, {
      ratingsQuantity: 0,
      ratingsAverage: 4.5,
    });
  }
};

/**
 * --- RECALCULATE AFTER A NEW REVIEW IS SAVED -------------------------------
 *
 * WHY `post` AND NOT `pre`? The new review must already be in the database
 * before we aggregate, otherwise it would be left out of its own average.
 *
 * WHY `this.constructor`? Inside document middleware `this` is the document.
 * We need the MODEL to call the static on. `this.constructor` is the model that
 * built this document. We cannot just write `Review.calcAverageRatings(...)`
 * because `const Review = mongoose.model(...)` is further down the file and
 * would still be undefined when this line is *defined* — though by the time it
 * *runs* it would exist. `this.constructor` avoids depending on that subtlety.
 *
 * ⚠️ FIX: the original did not `await` the recalculation. So the average was
 * computed in the background AFTER the response had already been sent — the
 * client saw a stale rating, and any failure vanished silently as an unhandled
 * rejection. Declaring the hook `async` and awaiting makes Mongoose wait for the
 * promise before `.save()` resolves, so the response reflects reality.
 *
 * (And per the Mongoose 9 note in tourModel.js, there is no `next` to call — an
 * `async` hook simply returns.)
 */
reviewSchema.post('save', async function () {
  await this.constructor.calcAverageRatings(this.tour);
});

/**
 * --- RECALCULATE AFTER AN UPDATE OR DELETE ---------------------------------
 *
 * This needs TWO hooks, and the reason is genuinely tricky.
 *
 * These are QUERY hooks, so `this` is the Query — there is no document, and we
 * do not know which tour is affected. And in the POST hook the query has
 * already run, so we can no longer look the old document up.
 *
 * The workaround: in the PRE hook, run the query once ourselves to grab the
 * document, and stash it on the query object (`this.reviewDoc`). Query objects
 * are plain JS objects, so we can hang our own properties on them, and the same
 * object is passed to the post hook. In the POST hook we read the tour id back
 * off it.
 *
 * ⚠️ FIX #1 — THE REGEX WAS WRONG. The original used `/^findByIdAnd/`, which
 * matches NOTHING. `findByIdAndUpdate` is just a convenience wrapper: Mongoose
 * rewrites it to `findOneAndUpdate({_id: id})` and fires the hook under the
 * name **findOneAndUpdate**. So these hooks never ran once, and ratings never
 * updated on edit or delete. The correct pattern is `/^findOneAnd/`.
 *
 * ⚠️ FIX #2 — the original pre-hook declared `next` as a parameter but never
 * called it. Mongoose then waits forever for permission to continue, and the
 * request hangs with no error at all. Rule: if you accept `next`, you MUST call
 * it on every path. (Here the function is async and takes no `next`, so
 * Mongoose continues when the promise resolves — simpler and safer.)
 */
reviewSchema.pre(/^findOneAnd/, async function () {
  // `this.findOne()` re-runs the query's own conditions to fetch the doc as it
  // exists RIGHT NOW, before the change is applied.
  this.reviewDoc = await this.findOne();
});

reviewSchema.post(/^findOneAnd/, async function () {
  // ⚠️ THE NULL GUARD THAT WAS MISSING. If the id doesn't exist,
  // `this.reviewDoc` is null, and `null.tour` throws
  // "Cannot read properties of null" — turning a clean 404 into a 500 crash.
  // Always guard a value that came from a lookup that may have found nothing.
  if (!this.reviewDoc) return;

  await this.reviewDoc.constructor.calcAverageRatings(this.reviewDoc.tour);
});

const Review = mongoose.model('Review', reviewSchema);

module.exports = Review;
