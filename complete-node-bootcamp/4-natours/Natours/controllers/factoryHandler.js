/**
 * ============================================================================
 * HANDLER FACTORY — one generic CRUD implementation for every resource
 * ============================================================================
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * "Delete a tour by id", "delete a user by id" and "delete a review by id" are
 * the same twelve lines of code three times over, differing only in the model.
 * Written out per resource that is ~200 lines of near-identical code, and a bug
 * fixed in one copy stays broken in the other two.
 *
 * THE PATTERN: A FUNCTION THAT RETURNS A FUNCTION
 * -----------------------------------------------
 *   exports.deleteTour = factory.deleteOne(Tour);
 *
 * Read that carefully — `factory.deleteOne(Tour)` runs IMMEDIATELY, at startup,
 * and what it returns is the actual `(req, res, next)` route handler. The model
 * is baked into it.
 *
 * This works because of a CLOSURE: the returned function keeps access to the
 * `Model` variable from the scope it was created in, long after `deleteOne` has
 * finished. Each call to `factory.deleteOne()` creates a separate closure, so
 * `deleteTour` remembers Tour and `deleteUser` remembers User, with no
 * interference. Closures are the single most useful idea in JavaScript, and this
 * file is one of the clearest practical examples of one.
 *
 * (The parameter was spelled `Modal` throughout the original — a modal is a
 * popup dialog; a model is a data blueprint. Renamed to `Model` for clarity.)
 *
 * WHEN NOT TO USE THE FACTORY: anything with resource-specific rules.
 * `updateMe` filters which fields may change; `deleteMe` soft-deletes instead of
 * removing. Those stay hand-written in their own controllers.
 *
 * RESPONSE SHAPE — now consistent everywhere:
 *   { status: 'success', results?: <n>, data: <the doc or array> }
 * The original mixed `data: doc`, `data: { tours: doc }` and misspelled
 * 'sucess', so a front-end had to special-case each endpoint.
 */
const APIFeatures = require('../utils/apiFeatures');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

/**
 * ---------------------------------------------------------------------------
 * DELETE ONE
 * ---------------------------------------------------------------------------
 * WHY CHECK FOR `!doc`? `findByIdAndDelete` does not throw when the id doesn't
 * exist — it simply resolves to `null`. Without this check we would happily
 * reply "success" for a document that was never there, and the client would
 * believe a deletion happened. Any find/delete/update by id needs this guard.
 *
 * ⚠️ FIX: the original responded `200` with `data: null`. The correct status for
 * a successful delete is **204 No Content**, and 204 means literally that — no
 * body at all. Sending a JSON body with 204 is a spec violation that some HTTP
 * clients treat as a malformed response. So we use `res.status(204).json(null)`
 * only for the standard shape; `.send()` with no argument is the cleanest.
 */
exports.deleteOne = (Model) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findByIdAndDelete(req.params.id);

    if (!doc) {
      return next(new AppError('No document found with that ID', 404));
    }

    // 204 = "it worked, and there is deliberately nothing to send back".
    res.status(204).send();
  });

/**
 * ---------------------------------------------------------------------------
 * UPDATE ONE (PATCH)
 * ---------------------------------------------------------------------------
 * PATCH vs PUT: PATCH updates only the fields you send; PUT replaces the whole
 * document. `findByIdAndUpdate` behaves like PATCH, which is why these routes
 * are registered as `.patch()`.
 *
 * THE TWO OPTIONS — both are easy to forget, with very different symptoms:
 *
 *   `returnDocument: 'after'` — return the UPDATED document rather than the old
 *      one. Default is 'before', so leaving this out makes your API look broken:
 *      you PATCH a price to 500 and the response still shows the old price.
 *      (In older Mongoose this option was `new: true`. Same thing.)
 *
 *   `runValidators: true` — re-run the schema validators on this update.
 *      ⚠️ OFF BY DEFAULT. Without it you can PATCH a tour's price to -50 or its
 *      difficulty to "banana" and Mongoose saves it without complaint. This is
 *      one of the most common real-world holes in a Mongoose API. Turn it on
 *      always.
 *
 * ⚠️ THE LIMITATION YOU MUST KNOW: even with `runValidators`, this is a QUERY
 * update, so document middleware ('save' hooks) does NOT run, and custom
 * validators that use `this` (like tourModel's priceDiscount check) get an
 * undefined `this`. That is exactly why every password route in authController
 * uses `.save()` instead of this — going through here would skip the hashing
 * hook and store a plain-text password.
 */
exports.updateOne = (Model) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
      returnDocument: 'after',
      runValidators: true,
    });

    if (!doc) {
      return next(new AppError('No document found with that ID', 404));
    }

    res.status(200).json({
      status: 'success',
      data: doc,
    });
  });

/**
 * ---------------------------------------------------------------------------
 * CREATE ONE (POST)
 * ---------------------------------------------------------------------------
 * `Model.create(req.body)` builds the document AND saves it, running every
 * validator and every 'save' hook. If validation fails it throws a
 * ValidationError, `catchAsync` forwards it, and errorController turns it into
 * a readable 400 listing every field that was wrong. We write no validation
 * code here at all — that is the payoff of putting the rules in the schema.
 *
 * 201 = "Created", the correct status for a successful POST (not 200).
 *
 * ⚠️ SECURITY NOTE — MASS ASSIGNMENT: passing `req.body` straight in means the
 * client controls every field in the schema. For tours and reviews that is fine
 * because those routes are admin/auth-restricted and the schema drops unknown
 * fields. But it is why `signup` must never be allowed to set `role` (a user
 * could make themselves admin) and why `updateMe` whitelists fields by hand.
 * Whenever you pass raw `req.body` to a model, ask: "which field in this schema
 * would be dangerous for a stranger to choose?"
 */
exports.createOne = (Model) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.create(req.body);

    res.status(201).json({
      status: 'success',
      data: doc,
    });
  });

/**
 * ---------------------------------------------------------------------------
 * GET ONE
 * ---------------------------------------------------------------------------
 * `popOptions` is optional. When supplied — e.g. `factory.getOne(Tour,
 * { path: 'reviews' })` — we chain a `.populate()` onto the query. This is why
 * `GET /tours/:id` includes its reviews but `GET /tours` does not: fetching
 * every review for every tour in a list view would be a huge query for data
 * nobody reads there.
 *
 * Note the query is built up in a `let` and only awaited on the line after —
 * Mongoose queries are lazy, so nothing hits the database until the `await`.
 *
 * ⚠️ FIX: the original sent `results: doc.length` here. `doc` is a single
 * document, not an array, so `.length` was always `undefined` — a meaningless
 * field in every response. `results` only makes sense for a list, so it's gone.
 */
exports.getOne = (Model, popOptions) =>
  catchAsync(async (req, res, next) => {
    let query = Model.findById(req.params.id);
    if (popOptions) query = query.populate(popOptions);

    const doc = await query;

    if (!doc) {
      return next(new AppError('No document found with that ID', 404));
    }

    res.status(200).json({
      status: 'success',
      data: doc,
    });
  });

/**
 * ---------------------------------------------------------------------------
 * GET ALL
 * ---------------------------------------------------------------------------
 * Two things happen here.
 *
 * 1. THE NESTED-ROUTE FILTER.
 *    `GET /tours/:tourId/reviews` should return only that tour's reviews. That
 *    route is handled by reviewRouter, mounted inside tourRouter, so `tourId`
 *    reaches us via `req.params` (thanks to `mergeParams: true` on the review
 *    router — without it, `req.params.tourId` would be undefined).
 *    When it's absent, `filter` stays `{}` = "match everything", and the same
 *    handler serves the plain `GET /reviews`. One handler, two routes.
 *
 * 2. THE API FEATURES CHAIN. Filtering, sorting, field-limiting and pagination
 *    all come from the URL — see utils/apiFeatures.js. Each method returns the
 *    instance, so they chain, and the DB is contacted exactly once at the
 *    `await`.
 *
 * ADDED: `popOptions`, so a caller can opt into populating a list, and a `page`
 * / `limit` echo in the response so the front-end knows which page it received.
 *
 * ⚠️ NOTE ON `results`: it is the count of THIS PAGE, not the total number of
 * matching documents. A front-end that needs "page 3 of 12" also needs a
 * `countDocuments()` total. Deliberately left out — it costs a second query on
 * every list request, so add it only when the UI actually needs it.
 */
exports.getAll = (Model, popOptions) =>
  catchAsync(async (req, res, next) => {
    let filter = {};
    if (req.params.tourId) filter = { tour: req.params.tourId };

    const features = new APIFeatures(Model.find(filter), req.query)
      .filter()
      .sort()
      .limitFields()
      .paginate();

    if (popOptions) features.query = features.query.populate(popOptions);

    const doc = await features.query;

    res.status(200).json({
      status: 'success',
      results: doc.length,
      page: features.page,
      limit: features.limit,
      data: doc,
    });
  });
