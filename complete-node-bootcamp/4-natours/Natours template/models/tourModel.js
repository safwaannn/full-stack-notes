const mongoose = require('mongoose');
const slugify = require('slugify');

const tourSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'A tour name is required.'],
      unique: true,
      trim: true,
      minlength: [10, 'A tour name must have at least 10 characters.'],
      maxlength: [50, 'A tour name must have at most 50 characters.'],
    },
    slug: {
      type: String,
    },
    duration: {
      type: Number,
      required: [true, 'A tour must have a duration.'],
    },
    maxGroupSize: {
      type: Number,
      required: [true, 'A tour must have a max group size.'],
    },
    difficulty: {
      type: String,
      required: [true, 'A tour must have a difficulty.'],
      enum: {
        values: ['easy', 'medium', 'difficult'],
        message: 'Difficulty must be: easy, medium, or difficult.',
      },
    },
    ratingsQuantity: {
      type: Number,
      default: 0,
    },
    ratingsAverage: {
      type: Number,
      default: 4.5,
      min: [1, 'Rating must be above 1.0.'],
      max: [5, 'Rating must be below 5.0.'],
      set: (val) => Math.round(val * 10) / 10,
    },
    price: {
      type: Number,
      required: [true, 'A tour must have a price.'],
      min: [100, 'Price must be at least 100.'],
      max: [9999, 'Price must be at most 9999.'],
    },
    priceDiscount: {
      type: Number,
      validate: {
        validator: function (val) {
          // `this` only refers to the document on CREATE.
          // On UPDATE via findByIdAndUpdate, `this` is the query, not the doc.
          // We return true when the current document price isn't available
          // rather than block the update silently.
          return this.price == null || val < this.price;
        },
        message: 'Discount ({VALUE}) must be less than the regular price.',
      },
    },
    summary: {
      type: String,
      required: [true, 'A tour must have a summary.'],
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'A tour must have a description.'],
      trim: true,
    },
    imageCover: {
      type: String,
      required: [true, 'A tour must have a cover image.'],
    },
    images: [String],
    startDates: [Date],
    secretTour: {
      type: Boolean,
      default: false,
    },
    startLocation: {
      type: {
        type: String,
        default: 'Point',
        enum: ['Point'],
      },
      coordinates: [Number],
      address: String,
      description: String,
    },
    locations: [
      {
        type: {
          type: String,
          default: 'Point',
          enum: ['Point'],
        },
        coordinates: [Number],
        address: String,
        description: String,
        day: Number,
      },
    ],
    guide: [
      {
        type: mongoose.Schema.ObjectId,
        ref: 'User',
      },
    ],
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ── Indexes ───────────────────────────────────────────────────────────────────
tourSchema.index({ price: 1, ratingsAverage: -1 });
tourSchema.index({ slug: 1 });
tourSchema.index({ startLocation: '2dsphere' });
// Additional indexes for fields commonly used in queries / aggregations
tourSchema.index({ difficulty: 1 });
tourSchema.index({ startDates: 1 });

// ── Virtuals ──────────────────────────────────────────────────────────────────
tourSchema.virtual('durationWeek').get(function () {
  return this.duration / 7;
});

tourSchema.virtual('reviews', {
  ref: 'Review',
  foreignField: 'tour',
  localField: '_id',
});

// ── Middleware — Mongoose 9: pre hooks do NOT receive `next` ──────────────────

// Slugify name on create/update
tourSchema.pre('save', function () {
  this.slug = slugify(this.name, { lower: true });
});

// Exclude secret tours from all find queries; record start time
tourSchema.pre(/^find/, function () {
  this.find({ secretTour: { $ne: true } });
  this.start = Date.now();
});

// Populate guide references for all find queries
tourSchema.pre(/^find/, function () {
  this.populate({
    path: 'guide',
    select: '-__v -passwordChangedAt',
  });
});

// Log query execution time after every find (useful for performance monitoring)
tourSchema.post(/^find/, function (docs) {
  if (this.start) {
    console.log(`Query took ${Date.now() - this.start}ms`);
  }
});

const Tour = mongoose.model('Tour', tourSchema);

module.exports = Tour;
