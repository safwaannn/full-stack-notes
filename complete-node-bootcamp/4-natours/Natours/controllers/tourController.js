/**
 * ============================================================================
 * TOUR CONTROLLER
 * ============================================================================
 *
 * A controller's only job: read the request, ask the model to do the work, send
 * a response. Validation lives in the schema, query-building lives in
 * APIFeatures, error formatting lives in errorController. What remains here is
 * genuinely tour-specific: the alias route, two aggregation reports, and the two
 * geospatial endpoints.
 *
 * The plain CRUD five come straight from the factory — see factoryHandler.js.
 */
const catchAsync = require('./../utils/catchAsync.js');
const AppError = require('./../utils/appError.js');
const factory = require('./factoryHandler.js');
const Tour = require('./../models/tourModel.js');

// CLEANED UP: the original imported `fs`, `path` and `APIFetures` (sic) but used
// none of them — leftovers from the file-based version of this project. Unused
// imports are not harmless: they make a reader wonder whether this file still
// touches the filesystem, and they slow startup slightly.

/**
 * ============================================================================
 * ALIAS ROUTE — /tours/top-5-cheap
 * ============================================================================
 * Users constantly want "the 5 best cheap tours". Rather than making them write
 *
 *   /tours?limit=5&sort=-ratingsAverage,price&fields=name,price,ratingsAverage,summary
 *
 * we give them a memorable URL and prefill the query string ourselves.
 *
 * THE TECHNIQUE: this is middleware that runs BEFORE `getAllTours`, mutating
 * `req.query` on the way through. By the time APIFeatures reads `req.query`, it
 * cannot tell the difference between these values and ones a user typed. In the
 * router it looks like:
 *
 *   router.route('/top-5-cheap').get(aliasTopTours, getAllTours);
 *
 * Note the values are STRINGS ('5', not 5) because that is what a real URL
 * would produce, and APIFeatures does the string→number conversion itself.
 *
 * `next()` is essential. Forget it and the request hangs forever with no error —
 * the single most common middleware bug there is.
 */
exports.aliasTopTours = (req, res, next) => {
  req.query.limit = '5';
  req.query.sort = '-ratingsAverage,price';
  req.query.fields = 'name,price,ratingsAverage,summary';
  next();
};

/**
 * ============================================================================
 * THE FIVE CRUD HANDLERS — built by the factory
 * ============================================================================
 * `getTour` passes `{ path: 'reviews' }` so a single tour arrives with its
 * reviews attached, resolved through the virtual populate defined in
 * tourModel.js. `getAllTours` deliberately does NOT — see factoryHandler.
 *
 * ⚠️ FIX: these five lines appeared TWICE in the original file (once near the
 * top, again lower down). The second set silently overwrote the first. Harmless
 * by luck — the definitions were identical — but it is a live trap: edit the
 * first copy and your change vanishes, because the second one wins. Duplicate
 * exports never produce a warning in JavaScript.
 */
exports.getAllTours = factory.getAll(Tour);
exports.getTour = factory.getOne(Tour, { path: 'reviews' });
exports.createTour = factory.createOne(Tour);
exports.updateTour = factory.updateOne(Tour);
exports.deleteTour = factory.deleteOne(Tour);

/**
 * ============================================================================
 * AGGREGATION PIPELINE #1 — statistics grouped by difficulty
 * ============================================================================
 *
 * WHAT AN AGGREGATION PIPELINE IS
 * -------------------------------
 * Think of a factory conveyor belt. Documents enter at one end and pass through
 * STAGES in order; each stage transforms what it receives and hands the result
 * to the next. It is how you answer "how many / what's the average / grouped by
 * what" questions inside the database, instead of pulling everything into Node
 * and looping — which would be far slower and could exhaust memory.
 *
 * The `$` prefix has TWO different meanings, and mixing them up is the main
 * source of confusion:
 *   `$group`, `$match`  — a STAGE or OPERATOR name (a keyword)
 *   `'$difficulty'`     — inside a string: "the VALUE of the difficulty field"
 * So `{ $sum: '$price' }` reads "sum up the value of each document's price".
 *
 * THE STAGES BELOW
 * ----------------
 * $match — a filter, same syntax as `find()`. Put it FIRST whenever possible:
 *          every later stage then processes fewer documents, and $match can use
 *          your indexes while later stages cannot. Stage order is the main
 *          performance lever in aggregation.
 *
 * $group — the heart of it. `_id` names the grouping key: `$toUpper: '$difficulty'`
 *          means "group by difficulty, uppercased" → one output row per
 *          difficulty level. Everything else defines a value computed per group:
 *            { $sum: 1 }         — add 1 per document = a COUNT
 *            { $avg: '$price' }  — the mean
 *            { $min } / { $max } — the extremes
 *          Setting `_id: null` instead would collapse everything into a single
 *          row of overall totals.
 *
 * $sort  — 1 = ascending, -1 = descending. It must come AFTER $group, because we
 *          are sorting the computed `avgPrice`, which does not exist until $group
 *          has produced it. You cannot sort by a field you haven't created yet.
 *
 * Note that secret tours are excluded automatically by the `pre('aggregate')`
 * hook in tourModel.js — this pipeline doesn't need to think about it.
 */
exports.getTourStats = catchAsync(async (req, res, next) => {
  const stats = await Tour.aggregate([
    {
      $match: { ratingsAverage: { $gte: 4.5 } },
    },
    {
      $group: {
        _id: { $toUpper: '$difficulty' },
        numTours: { $sum: 1 },
        numRatings: { $sum: '$ratingsQuantity' },
        avgRating: { $avg: '$ratingsAverage' },
        avgPrice: { $avg: '$price' },
        minPrice: { $min: '$price' },
        maxPrice: { $max: '$price' },
      },
    },
    {
      $sort: { avgPrice: 1 },
    },
  ]);

  res.status(200).json({
    status: 'success',
    results: stats.length,
    data: stats,
  });
});

/**
 * ============================================================================
 * AGGREGATION PIPELINE #2 — the busiest month of a given year
 * ============================================================================
 * Business question: "which months of 2021 have the most tours starting, and
 * which tours are they?" Useful for planning staff and equipment.
 *
 * THE INTERESTING STAGE IS `$unwind`.
 * A tour has an ARRAY of `startDates` — say three. We want to count *departures*,
 * not tours. `$unwind: '$startDates'` splits one document with three dates into
 * three documents, each with a single date. That is the only way to group by
 * individual date. It is the standard way to work with array fields, and it is
 * why the output count can exceed the number of tours.
 *
 * $addFields — adds a computed field while keeping everything else. (`$project`
 *              would force you to list every field you want to keep.)
 * $project   — `_id: 0` removes `_id`; we already copied it into `month`, and a
 *              raw `_id` in a report is just noise.
 * $limit     — a safety cap. 12 is the most months a year can have.
 *
 * `req.params.year * 1` converts the URL string to a number. If `:year` is
 * absent (the `/monthly-plan` route without a year), that yields NaN, which is
 * falsy, so `|| 2021` supplies the default.
 *
 * ⚠️ A DATE-RANGE SUBTLETY: `new Date('2021-12-31')` is parsed as UTC MIDNIGHT,
 * i.e. the very start of the 31st. So `$lte` that value excludes almost all of
 * December 31st. Using `< 2022-01-01` instead is the correct, off-by-one-proof
 * way to express "within this year". Fixed below.
 */
exports.getMonthlyPlan = catchAsync(async (req, res, next) => {
  const year = req.params.year * 1 || 2021;

  const plan = await Tour.aggregate([
    {
      $unwind: '$startDates',
    },
    {
      $match: {
        startDates: {
          $gte: new Date(`${year}-01-01`),
          $lt: new Date(`${year + 1}-01-01`), // see the note above
        },
      },
    },
    {
      $group: {
        _id: { $month: '$startDates' }, // $month extracts 1–12 from a Date
        numTourStarts: { $sum: 1 },
        tours: { $push: '$name' }, // $push collects values into an array
      },
    },
    {
      $addFields: { month: '$_id' },
    },
    {
      $project: { _id: 0 },
    },
    {
      $sort: { numTourStarts: -1 }, // busiest month first
    },
    {
      $limit: 12,
    },
  ]);

  res.status(200).json({
    status: 'success',
    results: plan.length,
    data: plan,
  });
});

/**
 * ============================================================================
 * GEOSPATIAL #1 — tours within a radius
 * ============================================================================
 * Route: /tours-within/:distance/center/:latlng/unit/:unit
 * Example: /api/v1/tours/tours-within/400/center/34.111745,-118.113491/unit/mi
 *          "every tour starting within 400 miles of that point"
 *
 * WHY THE URL LOOKS LIKE THAT: the values could equally be a query string
 * (`?distance=400&center=...`). Using path segments with names in between is
 * just a readable convention — you can tell what each number means without
 * consulting docs.
 *
 * THE MATHS — `$centerSphere` wants the radius in RADIANS, not miles or km.
 * A radian on a sphere = distance ÷ radius of that sphere. Earth's radius is
 * 3963.2 miles or 6378.1 km, hence those two magic numbers. Getting this wrong
 * silently returns either everything or nothing, with no error.
 *
 * ⚠️ FIX 1 — THE MISSING `await`. The original wrote `const tours = Tour.find({...})`
 * with no `await`, so `tours` was an un-executed Mongoose QUERY object, not the
 * results. It then sent that object as JSON: `tours.length` was `undefined` and
 * the `data` field was a dump of Mongoose's internal query state. The endpoint
 * appeared to "work" (HTTP 200!) while returning complete nonsense. A missing
 * `await` is the most common bug in async Node code — and note it does not throw.
 *
 * ⚠️ FIX 2 — VALIDATION ORDER. The lat/lng check came AFTER the coordinates had
 * already been used to build the query. A guard clause must run BEFORE the thing
 * it is guarding, otherwise it is decoration. Moved to the top.
 *
 * ⚠️ FIX 3 — added `isNaN` checks. `'abc,def'.split(',')` yields two truthy
 * strings, so the original truthiness test passed happily and Mongo then threw a
 * confusing internal error. We now verify they are actually numbers and produce
 * a clear 400.
 *
 * REQUIREMENT: the `2dsphere` index in tourModel.js. Without it MongoDB refuses
 * the query outright.
 */
exports.getToursWithIn = catchAsync(async (req, res, next) => {
  const { distance, latlng, unit } = req.params;
  const [lat, lng] = latlng.split(',');

  // --- Guard clauses FIRST -------------------------------------------------
  if (!lat || !lng || Number.isNaN(lat * 1) || Number.isNaN(lng * 1)) {
    return next(
      new AppError(
        'Please provide latitude and longitude in the format lat,lng',
        400,
      ),
    );
  }
  if (Number.isNaN(distance * 1) || distance * 1 <= 0) {
    return next(new AppError('Please provide a positive distance', 400));
  }

  // Convert the distance into radians for the sphere the Earth approximates.
  const radius = unit === 'mi' ? distance / 3963.2 : distance / 6378.1;

  const tours = await Tour.find({
    // ⚠️ [lng, lat] — GeoJSON order is longitude FIRST. The URL gives them the
    // other way round (because humans say "lat, long"), so we deliberately swap
    // here. Forgetting this is the #1 reason geo queries return nothing.
    startLocation: { $geoWithin: { $centerSphere: [[lng * 1, lat * 1], radius] } },
  });

  res.status(200).json({
    status: 'success',
    results: tours.length,
    data: tours,
  });
});

/**
 * ============================================================================
 * GEOSPATIAL #2 — distance from a point to every tour
 * ============================================================================
 * Route: /distances/:latlng/unit/:unit
 * Example: /api/v1/tours/distances/34.111745,-118.113491/unit/mi
 *          "how far is each tour from me?"
 *
 * `$geoNear` is special in three ways worth memorising:
 *   1. It MUST be the FIRST stage of the pipeline. (This is why tourModel's
 *      `pre('aggregate')` hook explicitly checks for it before unshifting a
 *      $match in front — otherwise this endpoint would break.)
 *   2. It requires a geospatial index, and if there is exactly one it uses it
 *      automatically.
 *   3. It sorts by distance ascending for free — nearest first, no $sort needed.
 *
 * `distanceField` names the new field it writes the distance into. The raw value
 * is always in METRES, hence `distanceMultiplier`:
 *   metres → miles:      × 0.000621371
 *   metres → kilometres: × 0.001
 *
 * ⚠️ THIS FUNCTION HAD FOUR SEPARATE BUGS — it could not run at all:
 *
 *   1. `unit === 'mi' ? 0.00062137 : distance / 0.001` — `distance` is not
 *      defined anywhere in this function (only `latlng` and `unit` are
 *      destructured). A guaranteed ReferenceError → instant 500 on every call.
 *      And `/ 0.001` would have been backwards anyway: dividing by 0.001
 *      MULTIPLIES by 1000, turning metres into millimetres.
 *   2. `const distances = Tour.aggregate(...)` — no `await` again.
 *   3. `type: 'point'` — lowercase. GeoJSON requires the exact string `'Point'`
 *      with a capital P; the schema's own enum is `['Point']`. Lowercase is
 *      rejected.
 *   4. The response referenced `tours`, a variable that does not exist here
 *      (copy-pasted from the function above) — another ReferenceError. So the
 *      computed `distances` were never even sent.
 *
 * All four are fixed below. Together they are a good illustration of why you
 * should hit every endpoint once before assuming it works: nothing here would
 * be caught by reading the code casually.
 */
exports.getDistances = catchAsync(async (req, res, next) => {
  const { latlng, unit } = req.params;
  const [lat, lng] = latlng.split(',');

  // Guard clauses first, again.
  if (!lat || !lng || Number.isNaN(lat * 1) || Number.isNaN(lng * 1)) {
    return next(
      new AppError(
        'Please provide latitude and longitude in the format lat,lng',
        400,
      ),
    );
  }

  // Metres → the requested unit.
  const multiplier = unit === 'mi' ? 0.000621371 : 0.001;

  const distances = await Tour.aggregate([
    {
      $geoNear: {
        near: {
          type: 'Point', // capital P — required by GeoJSON
          coordinates: [lng * 1, lat * 1], // longitude first; * 1 → Number
        },
        distanceField: 'distance',
        distanceMultiplier: multiplier,
      },
    },
    {
      // Return only what is useful. Without this you get the whole tour
      // document repeated for every result.
      $project: {
        distance: 1,
        name: 1,
      },
    },
  ]);

  res.status(200).json({
    status: 'success',
    results: distances.length,
    unit: unit === 'mi' ? 'miles' : 'kilometres',
    data: distances,
  });
});
