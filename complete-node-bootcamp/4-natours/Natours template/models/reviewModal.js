const mongoose = require('mongoose');
const Tour = require('./tourModel');

const reviewSchema = new mongoose.Schema(
  {
    review: {
      type: String,
      required: [true, 'Review text is required.'],
      trim: true,
      maxlength: [1000, 'A review must be less than 1000 characters.'],
    },
    rating: {
      type: Number,
      default: 4.5,
      min: [1, 'Rating must be at least 1.'],
      max: [5, 'Rating must be at most 5.'],
    },
    createdAt: {
      type: Date,
      // FIX: pass the function reference, not the result of calling it.
      // Date.now() (with parens) is evaluated once at schema load time —
      // every document would share the same timestamp.
      default: Date.now,
    },
    user: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: [true, 'A review must belong to a user.'],
    },
    tour: {
      type: mongoose.Schema.ObjectId,
      ref: 'Tour',
      required: [true, 'A review must belong to a tour.'],
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Compound index: one review per user per tour
reviewSchema.index({ tour: 1, user: 1 }, { unique: true });

// Mongoose 9: pre hooks do NOT receive `next`
reviewSchema.pre(/^find/, function () {
  this.populate({
    path: 'user',
    select: 'name photo',
  });
});

// ── Static: recalculate tour's average rating ─────────────────────────────────
reviewSchema.statics.calcAverageRatings = async function (tourId) {
  const stats = await this.aggregate([
    { $match: { tour: tourId } },
    {
      $group: {
        _id: '$tour',
        nRating: { $sum: 1 },
        avgRating: { $avg: '$rating' },
      },
    },
  ]);

  if (stats.length > 0) {
    await Tour.findByIdAndUpdate(tourId, {
      ratingsQuantity: stats[0].nRating,
      ratingsAverage: stats[0].avgRating,
    });
  } else {
    await Tour.findByIdAndUpdate(tourId, {
      ratingsQuantity: 0,
      ratingsAverage: 4.5,
    });
  }
};

// After save — use async post so errors surface instead of being swallowed
reviewSchema.post('save', async function () {
  await this.constructor.calcAverageRatings(this.tour);
});

// For findOneAndUpdate / findOneAndDelete — capture doc before the change
reviewSchema.pre(/^findOneAnd/, async function () {
  // Store on `this` so the post hook can access it
  this.r = await this.model.findOne(this.getQuery());
});

// After update/delete — recalculate with the stored doc
reviewSchema.post(/^findOneAnd/, async function () {
  if (this.r) await this.r.constructor.calcAverageRatings(this.r.tour);
});

const Review = mongoose.model('Review', reviewSchema);
module.exports = Review;
