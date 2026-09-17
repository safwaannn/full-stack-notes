/**
 * ============================================================================
 * USER ROUTES
 * ============================================================================
 * Mounted at `/api/v1/users` in app.js, so every path below is relative to that.
 *
 * THE STAR OF THIS FILE IS `router.use(middleware)` WITH NO PATH.
 * ---------------------------------------------------------------
 * Used that way it applies the middleware to EVERY route declared BELOW it, and
 * none above it. Middleware runs in declaration order, so the file reads
 * top-to-bottom as three security zones:
 *
 *     ┌─────────────────────────────────────────────┐
 *     │ ZONE 1 — PUBLIC                             │
 *     │ signup, login, logout, forgot/resetPassword  │
 *     ├─────────────────────────────────────────────┤
 *     │ router.use(protect)      ← the first gate    │
 *     ├─────────────────────────────────────────────┤
 *     │ ZONE 2 — ANY LOGGED-IN USER                 │
 *     │ me, updateMe, deleteMe, updatePassword       │
 *     ├─────────────────────────────────────────────┤
 *     │ router.use(restrictTo('admin')) ← 2nd gate   │
 *     ├─────────────────────────────────────────────┤
 *     │ ZONE 3 — ADMINS ONLY                        │
 *     │ list all users, get/update/delete by id      │
 *     └─────────────────────────────────────────────┘
 *
 * WHY THIS IS BETTER THAN REPEATING `protect` ON EACH ROUTE: you cannot forget
 * it. Add a new route at the bottom of the file and it is protected and
 * admin-only automatically. With per-route middleware, the day you forget to
 * paste `protect` you have silently published an endpoint. Making the SAFE thing
 * the DEFAULT is the principle worth taking from this file — the same idea as
 * `select: false` on the password field.
 *
 * The flip side, and it is a real one: the protection is not visible on the route
 * line itself. Someone skimming `router.patch('/updateMe', ...)` sees no auth and
 * may assume it is public. Hence the zone comments below — they are load-bearing
 * documentation, not decoration.
 *
 * ZONE 1 MUST COME FIRST for an obvious reason: you cannot require a logged-in
 * user on the route whose entire job is logging you in.
 */
const express = require('express');
const userController = require('./../controllers/userController');
const authController = require('./../controllers/authController');

const router = express.Router();

/* ══════════════════════════ ZONE 1 — PUBLIC ══════════════════════════════ */

// Create an account. Note: `signup` explicitly picks name/email/password/
// passwordConfirm out of the body, so `role` cannot be set here.
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.get('/logout', authController.logout);

// The two halves of the password-reset flow.
//   POST /forgotPassword        → { email }            → emails a link
//   PATCH /resetPassword/:token → { password, passwordConfirm }
// PATCH, not POST, because it MODIFIES an existing user's password.
router.post('/forgotPassword', authController.forgotPassword);
router.patch('/resetPassword/:token', authController.resetPassword);

/* ═══════════════════ GATE 1: everything below needs a login ═══════════════ */
router.use(authController.protect);

/* ═════════════════ ZONE 2 — ANY AUTHENTICATED USER ═══════════════════════ */

// Change your own password. Requires `passwordCurrent` even though you are
// already logged in — see the reasoning in authController.updatePassword.
router.patch('/updatePassword', authController.updatePassword);

// TWO handlers chained: `getMe` copies `req.user.id` into `req.params.id`, then
// the generic `getUser` reads it. This is how we reuse the factory handler
// without ever trusting an id from the URL.
router.get('/me', userController.getMe, userController.getUser);

router.patch('/updateMe', userController.updateMe);
router.delete('/deleteMe', userController.deleteMe);

/* ══════════════════ GATE 2: everything below is admin-only ═══════════════ */
// `protect` (gate 1) has already set `req.user`, which `restrictTo` reads.
// Order between the two gates is therefore not optional.
router.use(authController.restrictTo('admin'));

/* ═════════════════════════ ZONE 3 — ADMINS ONLY ═════════════════════════ */

router
  .route('/')
  .get(userController.getAllUser)
  // Deliberately returns 501 and redirects you to /signup — see the comment on
  // `createUser`. One code path for account creation is one place to secure.
  .post(userController.createUser);

router
  .route('/:id')
  .get(userController.getUser)
  // The only route that can change a user's `role`. Do NOT use it to set
  // passwords: it goes through `findByIdAndUpdate`, which skips the hashing
  // hook, and the password would be stored in plain text.
  .patch(userController.updateUser)
  // A HARD delete (the document is removed). Contrast with `/deleteMe`, which is
  // a soft delete. Prefer soft deletes in production — a hard delete leaves
  // dangling references in reviews and tour guides.
  .delete(userController.deleteUser);

module.exports = router;
