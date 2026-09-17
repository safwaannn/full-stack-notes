/**
 * ============================================================================
 * TOUR MODEL — the shape, the rules and the automatic behaviour of a tour
 * ============================================================================
 *
 * MENTAL MODEL: SCHEMA vs MODEL vs DOCUMENT
 * -----------------------------------------
 *   SCHEMA   = the blueprint. "A tour has a name (text, required) and a price
 *              (number, at least 100)." It describes and validates. No DB yet.
 *   MODEL    = the factory built from the blueprint. `Tour.find()`,
 *              `Tour.create()` — this is what actually talks to MongoDB.
 *   DOCUMENT = one single tour object produced by the model.
 *
 * MongoDB itself is schema-less: it would happily store `{ price: "banana" }`.
 * Mongoose adds the schema layer on top so bad data is rejected in Node,
 * before it ever reaches the database.
 *
 * WHY VALIDATE IN THE MODEL AND NOT IN THE CONTROLLER?
 * ---------------------------------------------------
 * Because the model is the ONE place every write must pass through. If the rule
 * "price must be ≥ 100" lives in the controller, you have to remember to repeat
 * it in createTour, updateTour, the import script, and any future admin panel.
 * Put it in the schema once and it is enforced everywhere, forever. This is the
 * "fat model, thin controller" idea.
 */
const mongoose = require('mongoose');
const slugify = require('slugify');

const tourSchema = new mongoose.Schema(
  {
    /**
     * ------------------------------------------------------------------------
     * FIELD DEFINITIONS
     * ------------------------------------------------------------------------
     * The `[true, 'message']` array form means: [is-it-required, error-text].
     * Always write your own message — Mongoose's default ("Path `name` is
     * required.") leaks internal field names to your users.
     */
    name: {
      type: String,
      required: [true, 'A tour name is required'],

      // `unique` is NOT a validator — this is the single most misunderstood
      // schema option. It tells MongoDB to build a unique INDEX. So the check
      // happens in the database, not in Mongoose, and when it fails you do NOT
      // get a nice ValidationError — you get a raw MongoServerError with
      // code 11000. That is exactly why errorController.js has a dedicated
      // `handleDuplicateFieldsDB` function to translate it.
      unique: true,

      // Strips leading/trailing whitespace: '  Forest Hiker  ' → 'Forest Hiker'
      trim: true,

      minlength: [10, 'A tour name must have at least 10 characters'],
      maxlength: [50, 'A tour name must have at most 50 characters'],

      // Left off on purpose: `validate: [validator.isAlpha]` would reject any
      // name containing a space — which is every realistic tour name.
    },

    // A URL-friendly version of the name: 'The Forest Hiker' → 'the-forest-hiker'
    // Filled in automatically by the pre-save hook below, never by the client.
    slug: String,

    duration: {
      type: Number,
      required: [true, 'A tour duration is required'],
    },

    maxGroupSize: {
      type: Number,
      required: [true, 'A tour group size is required'],
    },

    difficulty: {
      type: String,
      required: [true, 'A tour difficulty is required'],
      // `enum` = "the value must be one of these exact strings".
      // Only works on Strings. The object form lets us supply the message.
      enum: {
        values: ['easy', 'medium', 'difficult'],
        message: 'Difficulty must be either: easy, medium or difficult',
      },
    },

    ratingsQuantity: {
      type: Number,
      default: 0,
    },

    ratingsAverage: {
      type: Number,
      default: 4.5,
      min: [1, 'Rating must be at least 1.0'],
      max: [5, 'Rating must be at most 5.0'],

      // A SETTER runs every time this field is assigned, and stores whatever it
      // returns. This one rounds to 1 decimal place.
      //
      // Why the `* 10 / 10` dance? `Math.round(4.666)` gives 5 — we lose the
      // decimal. So: 4.666 * 10 = 46.66 → round → 47 → / 10 = 4.7. This matters
      // because the review model recalculates this average from raw ratings and
      // would otherwise store ugly values like 4.666666666666667.
      set: (val) => Math.round(val * 10) / 10,
    },

    price: {
      type: Number,
      required: [true, 'A tour price is required'],
      min: [100, 'Price must be at least 100'],
      max: [9999, 'Price must be at most 9999'],
    },

    priceDiscount: {
      type: Number,
      /**
       * A CUSTOM VALIDATOR. Return `true` to accept, `false` to reject.
       *
       * ⚠️ TWO CRITICAL GOTCHAS, both about `this`:
       *
       * 1. It MUST be a regular `function`, never an arrow function. Arrow
       *    functions inherit `this` from the surrounding scope, so `this.price`
       *    would be undefined and this validator would never work.
       *
       * 2. `this` only points to the document on CREATE (`.save()` / `.create()`).
       *    On `findByIdAndUpdate`, Mongoose is running an UPDATE query — there
       *    is no document in memory, so `this.price` is undefined and the
       *    comparison silently passes. This is why validators like this one
       *    cannot be fully trusted on updates. If you need it enforced there,
       *    load the doc, change the fields, and call `.save()`.
       */
      validate: {
        validator: function (val) {
          return val < this.price;
        },
        // `{VALUE}` is a Mongoose placeholder — it is replaced with the value
        // that failed validation.
        message: 'Discount price ({VALUE}) must be below the regular price',
      },
    },

    summary: {
      type: String,
      required: [true, 'A tour summary is required'],
      trim: true,
    },

    description: {
      type: String,
      required: [true, 'A tour description is required'],
      trim: true,
    },

    imageCover: {
      type: String,
      required: [true, 'A tour cover image is required'],
    },

    // Shorthand for `{ type: [String] }` — an array of image filenames.
    images: [String],

    startDates: [Date],

    // ADDED: the API's default sort order needs a reliable timestamp, and
    // "when was this created" is useful on its own.
    // `select: false` hides it from API responses by default (a client can
    // still ask for it explicitly with ?fields=createdAt).
    //
    // ⚠️ Note it is `Date.now` — the FUNCTION, with no parentheses. Writing
    // `Date.now()` would call it once when this file is first loaded, and then
    // every tour you ever create would share that single server-start
    // timestamp. This exact bug existed in the review model.
    createdAt: {
      type: Date,
      default: Date.now,
      select: false,
    },

    secretTour: {
      type: Boolean,
      default: false,
    },

    /**
     * ------------------------------------------------------------------------
     * GEOSPATIAL DATA — GeoJSON
     * ------------------------------------------------------------------------
     * MongoDB understands a specific format called GeoJSON, and it requires
     * exactly two fields: `type` and `coordinates`.
     *
     * The nested `type: { type: String }` looks bizarre but is necessary:
     * Mongoose sees the key `type` and normally reads it as "the data type of
     * this field". By nesting an object that itself has a `type` key, we tell
     * Mongoose "no, `type` is a real field name here, and it holds a String".
     *
     * ⚠️ COORDINATE ORDER IS [LONGITUDE, LATITUDE] — the opposite of what
     * Google Maps shows you, and the #1 cause of "my geo query returns nothing".
     * Latitude runs -90..90, longitude -180..180, so if you see a value above
     * 90 in the first slot, your order is right. This is why the tour
     * controller carefully does `[lng, lat]` when building geo queries.
     */
    startLocation: {
      type: {
        type: String,
        default: 'Point',
        enum: ['Point'], // GeoJSON also allows LineString, Polygon...
      },
      coordinates: [Number], // [longitude, latitude]
      address: String,
      description: String,
    },

    /**
     * EMBEDDING: the stops of the tour live INSIDE the tour document.
     * Correct choice here because a location has no meaning without its tour
     * and is never queried on its own.
     */
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
        day: Number, // which day of the tour this stop belongs to
      },
    ],

    /**
     * REFERENCING: we store only the users' ObjectIds, not their data.
     *
     * FIX: this field was named `guide` (singular), but the seed data in
     * dev-data/data/tours.json uses `guides`, and the pre-find hook below tried
     * to populate `'guides'`. So the names never matched: every imported tour
     * silently lost its guides, and the populate did nothing at all. Renamed to
     * `guides` so the schema, the seed data and the populate agree.
     *
     * Referencing (vs embedding) is right here because a user exists
     * independently of any tour, and if they change their name we want that
     * reflected everywhere automatically — with embedded copies we'd have to
     * hunt down and update every tour.
     */
    guides: [
      {
        type: mongoose.Schema.ObjectId,
        ref: 'User', // must match the string in mongoose.model('User', ...)
      },
    ],
  },

  /**
   * ------------------------------------------------------------------------
   * SCHEMA OPTIONS (the second argument to new Schema)
   * ------------------------------------------------------------------------
   * Virtuals are computed on the fly and do not exist in MongoDB. By default
   * they are dropped when a document is converted to JSON. These two options
   * say "include them" — without this, `durationWeek` and `reviews` would be
   * missing from every API response, which is a very common head-scratcher.
   */
  {
    toJSON: { virtuals: true }, // used by res.json()
    toObject: { virtuals: true }, // used by .toObject() / console.log
  },
);

/**
 * ============================================================================
 * INDEXES — the single biggest performance lever you have
 * ============================================================================
 * Without an index, a query does a COLLECTION SCAN: Mongo reads every single
 * document to find matches. With an index it walks a sorted B-tree instead —
 * the difference between flipping through a whole book and using its index.
 *
 * COMPOUND INDEX: `{ price: 1, ratingsAverage: -1 }` (1 = ascending,
 * -1 = descending). It serves queries on `price` alone, and on
 * `price + ratingsAverage` together — but NOT on `ratingsAverage` alone. Order
 * matters: an index works left-to-right, like a phone book sorted by surname
 * then first name (useless for finding all the "Johns").
 *
 * The cost: every write must also update every index. So index the fields you
 * actually filter and sort on, and nothing more.
 *
 * `2dsphere` is a special index for geospatial queries on an Earth-like sphere.
 * `$geoWithin` and `$geoNear` REQUIRE it — without this line the
 * /tours-within and /distances endpoints fail outright.
 */
tourSchema.index({ price: 1, ratingsAverage: -1 });
tourSchema.index({ slug: 1 });
tourSchema.index({ startLocation: '2dsphere' });

/**
 * ============================================================================
 * VIRTUAL PROPERTIES — derived data, never stored
 * ============================================================================
 * Duration in weeks is just duration/7. Storing it would mean two fields that
 * can drift out of sync. Compute it instead.
 *
 * Again: a regular `function`, because we need `this` = the document.
 *
 * THE TRADE-OFF: virtuals do not exist in the database, so you cannot query,
 * sort or filter by them. `?durationWeek[gte]=1` will never work.
 */
tourSchema.virtual('durationWeek').get(function () {
  return this.duration / 7;
});

/**
 * VIRTUAL POPULATE — "child referencing" without polluting the parent.
 *
 * THE PROBLEM: we want `GET /tours/:id` to include that tour's reviews. But a
 * tour could have thousands of reviews. Storing an array of review IDs on the
 * tour would grow without limit (MongoDB caps a document at 16MB) and would
 * need updating on every new review.
 *
 * THE SOLUTION: the Review documents already store `tour: <tourId>`. So we can
 * ask the question backwards — "find every review whose `tour` field equals my
 * `_id`" — and expose the answer as a virtual field.
 *
 *   foreignField: 'tour'  — the field on the Review model
 *   localField:  '_id'    — the field on THIS (Tour) model to match it against
 *
 * Nothing is stored, and nothing is fetched until someone calls
 * `.populate('reviews')` — which is exactly what factory.getOne does for
 * getTour. Note we deliberately do NOT populate reviews on getAllTours: that
 * would be a huge query for a list view nobody reads the reviews on.
 */
tourSchema.virtual('reviews', {
  ref: 'Review',
  foreignField: 'tour',
  localField: '_id',
});

/**
 * ============================================================================
 * MIDDLEWARE (Mongoose calls these "hooks")
 * ============================================================================
 * Functions that run automatically before or after an event. There are four
 * kinds, and mixing them up is the most common Mongoose mistake:
 *
 *   DOCUMENT  middleware — 'save', 'validate'. `this` = the document.
 *   QUERY     middleware — 'find', 'findOne', 'findOneAndUpdate'.
 *                          `this` = the QUERY, not a document.
 *   AGGREGATE middleware — 'aggregate'. `this` = the aggregation object.
 *   MODEL     middleware — 'insertMany'. `this` = the model.
 *
 * ⚠️ THE BIG GOTCHA: document middleware ('save') does NOT run on
 * `findByIdAndUpdate`. So the slug below is generated on create but NOT on
 * update. If you rename a tour via PATCH, its slug goes stale. The fix is
 * either a matching 'findOneAndUpdate' hook, or loading the doc and calling
 * `.save()` instead.
 */

// --- DOCUMENT middleware: runs before .save() and .create() -----------------
// `pre` = before the event, `post` = after it.
//
// ⚠️⚠️ NOTE THE SIGNATURE — MONGOOSE 9 BREAKING CHANGE (this project is on
// mongoose 9.8.1, and EVERY hook in the original code got this wrong).
//
// Mongoose used to pass a `next` callback into middleware, so hooks were written
// `function (next) { ...; next(); }`. **Mongoose 9 no longer passes it.** So
// `next` is `undefined`, and calling it throws
//     TypeError: next is not a function
// That single change broke every tour query, every user lookup and every review
// find with a 500 — a package upgrade silently invalidated the old style.
//
// THE MODERN STYLE IS SIMPLER: declare NO parameters and Mongoose treats the
// hook as synchronous, continuing the moment it returns. For asynchronous work
// declare the function `async` and Mongoose awaits the promise. Either way there
// is no callback to call and none to forget — which also removes the classic
// "request hangs forever because I forgot next()" bug entirely.
tourSchema.pre('save', function () {
  this.slug = slugify(this.name, { lower: true });
});

// --- QUERY middleware: hide secret tours from every find -------------------
//
// The regex `/^find/` matches find, findOne, findOneAndUpdate, findOneAndDelete
// — everything starting with "find". Using plain `'find'` would only cover
// `Tour.find()`, so `GET /tours/:id` (findOne) would happily return a secret
// tour. Always use the regex for this kind of filter.
//
// FIX: the original had TWO separate `/^find/` hooks, and the populate one
// referenced `path: 'guides'` while the schema field was `guide` — so it
// populated nothing. Merged into one hook, with the field name now correct.
//
// FIX: `-__V` (capital V) was also wrong. Mongoose's version key is `__v`
// lowercase, so the exclusion silently did nothing.
//
// FIX: dropped the `next` parameter — see the Mongoose 9 note above.
tourSchema.pre(/^find/, function () {
  // `this` is the Query. Calling .find() again ADDs conditions to it (they are
  // combined with AND), it does not replace the existing ones.
  //
  // Why `$ne: true` and not `false`? Because a tour created before this field
  // existed has no `secretTour` key at all. `{ secretTour: false }` would not
  // match a missing field, so those tours would vanish from the API.
  // "not equal to true" correctly includes both `false` and missing.
  this.find({ secretTour: { $ne: true } });

  // Swap the guide IDs for the real user documents.
  // Under the hood this is a SECOND query to the users collection — populate is
  // not free. `select` trims the payload and, importantly, keeps
  // `passwordChangedAt` out of API responses.
  this.populate({
    path: 'guides',
    select: '-__v -passwordChangedAt',
  });

  // Stash the start time so the post-hook below can measure the query duration.
  this.start = Date.now();
});

// --- POST query middleware: cheap performance logging ----------------------
// Runs after the query finishes. `docs` is the RESULT of the query — post hooks
// receive it as their first argument, which is the one parameter Mongoose 9 does
// still pass. (`next` does not follow it any more.)
tourSchema.post(/^find/, function (docs) {
  // Dev-only, so we don't flood production logs with a line per query.
  if (process.env.NODE_ENV === 'development') {
    console.log(`⏱  Query took ${Date.now() - this.start}ms`);
  }
});

/**
 * --- AGGREGATE middleware: keep secret tours out of the statistics ---------
 *
 * FIX: the original was commented out as `pre(/^aggregate/)`. Regexes do not
 * work for the aggregate hook — the event name is the literal string
 * 'aggregate'. That is why it never ran.
 *
 * `this.pipeline()` returns the array of stages. `unshift` puts a $match at the
 * FRONT so secret tours are filtered out before any grouping happens.
 *
 * ⚠️ THE TRAP THAT MAKES THIS DANGEROUS: `$geoNear` MUST be the very first
 * stage in a pipeline. Blindly unshifting a $match in front of it breaks
 * `/distances` with "$geoNear is only valid as the first stage". So we check
 * for it first and skip. This is a real bug in most tutorial versions of this
 * file — it only appears once you add the geo endpoints.
 */
tourSchema.pre('aggregate', function () {
  const pipeline = this.pipeline();
  const startsWithGeoNear =
    pipeline.length > 0 && Object.keys(pipeline[0])[0] === '$geoNear';

  if (!startsWithGeoNear) {
    pipeline.unshift({ $match: { secretTour: { $ne: true } } });
  }
});

// Compile the blueprint into a working model. The string 'Tour' is what other
// schemas use in `ref: 'Tour'`, and Mongoose lowercases + pluralises it to pick
// the collection name: 'Tour' → the `tours` collection.
const Tour = mongoose.model('Tour', tourSchema);

module.exports = Tour;
