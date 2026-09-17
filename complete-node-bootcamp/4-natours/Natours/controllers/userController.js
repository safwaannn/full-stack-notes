/**
 * ============================================================================
 * USER CONTROLLER
 * ============================================================================
 *
 * TWO DISTINCT GROUPS OF ROUTES LIVE HERE, and keeping them apart is the whole
 * design of this file:
 *
 *   "ME" ROUTES  — a logged-in user acting on their OWN account.
 *                  /me, /updateMe, /deleteMe.
 *                  The id comes from `req.user` (i.e. from the verified token),
 *                  NEVER from the URL.
 *
 *   ADMIN ROUTES — an administrator acting on ANY account.
 *                  /users, /users/:id. Built by the factory.
 *
 * WHY THE DISTINCTION IS A SECURITY BOUNDARY: if users had to call
 * `PATCH /users/:id` to edit themselves, the server would have to trust an id
 * from the URL — and nothing stops someone putting *your* id there. Taking the
 * id from the token instead makes that whole class of attack (called IDOR,
 * Insecure Direct Object Reference) impossible by construction.
 */
const AppError = require('../utils/appError');
const User = require('./../models/userModel');
const catchAsync = require('./../utils/catchAsync');
const factory = require('./factoryHandler.js');

/**
 * Keep only the allowed keys from an object — an ALLOW-LIST.
 *
 * `...allowedFields` is a rest parameter, so you call it as
 * `filterObj(req.body, 'name', 'email')` and get back an object containing at
 * most those two keys.
 *
 * WHY AN ALLOW-LIST AND NOT A DENY-LIST? A deny-list ("remove `role` and
 * `password`") is a list you must remember to extend every time you add a
 * sensitive field to the schema — and the day you forget, it becomes a
 * vulnerability. An allow-list fails safe: a new field is excluded until you
 * deliberately add it. Prefer allow-lists for anything security-related.
 */
const filterObj = (obj, ...allowedFields) => {
  const newObj = {};
  Object.keys(obj).forEach((el) => {
    if (allowedFields.includes(el)) newObj[el] = obj[el];
  });
  return newObj;
};

/**
 * ---------------------------------------------------------------------------
 * GET /users/me
 * ---------------------------------------------------------------------------
 * A tiny piece of middleware that reuses the generic `getOne` handler.
 *
 * THE TRICK: `getOne` reads the id from `req.params.id`. So instead of writing a
 * whole new handler, we set `req.params.id` from the authenticated user and hand
 * off to the factory. In the router:
 *
 *   router.get('/me', userController.getMe, userController.getUser);
 *
 * The URL has no `:id` at all, so `req.params.id` starts out undefined and we
 * fill it in. Neat: no duplicated code, and the id can only ever be the caller's
 * own.
 *
 * ⚠️ FIX — THIS ENDPOINT WAS COMPLETELY BROKEN. The original line was:
 *
 *       next;        // ← a reference to the function. Does nothing.
 *
 * instead of:
 *
 *       next();      // ← actually CALLS it
 *
 * Writing `next;` on its own is a valid JavaScript expression statement that
 * evaluates the variable and discards the result. No syntax error, no warning,
 * no crash — the middleware simply never continues. `GET /users/me` hung until
 * the client timed out.
 *
 * This is worth remembering as a class of bug: **a hanging request with no error
 * message is almost always a `next()` that was never called.** Look for a
 * missing `()`, a forgotten `next()` on an early-return path, or a `next()`
 * inside an `if` that didn't match.
 */
exports.getMe = (req, res, next) => {
  req.params.id = req.user.id;
  next();
};

/**
 * ---------------------------------------------------------------------------
 * PATCH /users/updateMe — update your own name / email
 * ---------------------------------------------------------------------------
 * TWO GUARDS, and both are essential.
 *
 * GUARD 1: reject any attempt to change the password here. Not because it is
 * forbidden, but because `findByIdAndUpdate` (used below) does NOT run the
 * pre-save hooks — so a password sent here would be stored in PLAIN TEXT, and
 * `passwordConfirm` would never be validated. Rather than silently doing the
 * wrong thing, we point the user at the route that handles it correctly.
 *
 * GUARD 2: `filterObj`. Without it, `req.body` goes straight into the update, so
 * a user could send `{"role": "admin"}` and promote themselves — or overwrite
 * `passwordResetToken`, or flip `active`. The allow-list means only `name` and
 * `email` can ever change through this route.
 *
 * WHY IS `findByIdAndUpdate` FINE HERE, when it was wrong for passwords? Because
 * we are not touching a field that depends on a hook. Name and email need only
 * their schema validators, which `runValidators: true` gives us. For anything
 * involving the password, `.save()` is mandatory.
 */
exports.updateMe = catchAsync(async (req, res, next) => {
  // 1) Passwords do not belong on this route
  if (req.body.password || req.body.passwordConfirm) {
    return next(
      new AppError(
        'This route is not for password updates. Please use /updatePassword.',
        400,
      ),
    );
  }

  // 2) Allow-list the fields that may change
  const filteredBody = filterObj(req.body, 'name', 'email');

  // 3) Update — the id comes from the token, never from the URL
  const updatedUser = await User.findByIdAndUpdate(req.user.id, filteredBody, {
    returnDocument: 'after', // return the NEW document, not the old one
    runValidators: true, // e.g. re-check that the email is valid
  });

  res.status(200).json({
    status: 'success',
    data: { user: updatedUser },
  });
});

/**
 * ---------------------------------------------------------------------------
 * DELETE /users/deleteMe — deactivate your own account
 * ---------------------------------------------------------------------------
 * A SOFT DELETE: we set `active: false` rather than removing the document.
 *
 * WHY? Because other documents reference this user. Reviews have a
 * `user: ObjectId`, tours have `guides`. Hard-deleting the document leaves those
 * references dangling, and `populate` then yields `null`, which crashes any
 * front-end doing `review.user.name`. Soft deletes also let a user come back, and
 * keep your historical data honest.
 *
 * The user disappears from the API anyway, because userModel has a
 * `pre(/^find/)` hook that filters out `active: false` on EVERY query. That is
 * what makes the soft delete airtight — you cannot forget to apply it, because
 * it lives in the model rather than in each controller.
 *
 * ⚠️ 204 means "No Content" — the response must have an EMPTY body. The original
 * used `res.status(204).json({...})`, which sends a body with a status code that
 * promises none; some HTTP clients treat that as a protocol error. `.send()`
 * with no argument is correct.
 */
exports.deleteMe = catchAsync(async (req, res, next) => {
  await User.findByIdAndUpdate(req.user.id, { active: false });

  res.status(204).send();
});

/**
 * ---------------------------------------------------------------------------
 * ADMIN ROUTES
 * ---------------------------------------------------------------------------
 * All of these sit behind `protect` + `restrictTo('admin')` in userRoutes.js.
 *
 * `updateUser` is the ONLY way to change someone's `role`, which is exactly
 * right: promoting to admin must be an admin's decision.
 *
 * ⚠️ NOTE: `updateUser` uses `findByIdAndUpdate`, so it must NOT be used to set
 * passwords — the hashing hook wouldn't run. The route is documented as being
 * for role and profile data only.
 *
 * ⚠️ `createUser` is INTENTIONALLY a 501. It looks like it should exist for
 * completeness, but a user created through the generic factory would bypass
 * `signup`, so nothing would validate `passwordConfirm`... except that it
 * actually would, because `create()` runs hooks. The real reason to block it is
 * different and more interesting: creating a user without going through signup
 * means no welcome email, no token, and an admin choosing someone else's
 * password — all of which are bad. Pointing admins at `/signup` keeps ONE code
 * path for account creation, and one path is one place to get security right.
 * (The original silently duplicated signup's logic here, minus the role
 * protection — so it was in fact a second privilege-escalation route.)
 */
exports.createUser = (req, res) => {
  res.status(501).json({
    status: 'error',
    message: 'This route is not defined. Please use /signup instead.',
  });
};

exports.getAllUser = factory.getAll(User);
exports.getUser = factory.getOne(User);
exports.updateUser = factory.updateOne(User);
exports.deleteUser = factory.deleteOne(User);
