/**
 * ============================================================================
 * AUTH CONTROLLER — signup, login, and the two guards that protect everything
 * ============================================================================
 *
 * HOW JWT AUTHENTICATION WORKS, IN PLAIN LANGUAGE
 * -----------------------------------------------
 * A JWT (JSON Web Token) is like a festival wristband. At the entrance you show
 * ID once (email + password) and get a wristband. After that you just show the
 * wristband — nobody re-checks your ID. The wristband is tamper-proof because it
 * is signed with a secret only the venue knows.
 *
 * A token is three base64 parts joined by dots:  header.payload.signature
 *   header    — which algorithm signed this
 *   payload   — the data. Ours holds `{ id: <userId>, iat, exp }`
 *   signature — HMAC-SHA256(header + payload, JWT_SECRET)
 *
 * ⚠️ THE PAYLOAD IS NOT ENCRYPTED — only SIGNED. Anyone can paste a token into
 * jwt.io and read it. Signing guarantees it was not *modified*, not that it is
 * *private*. So never put anything secret in a JWT payload. We store only the
 * user id, which is why `protect` re-fetches the user from the database on every
 * request instead of trusting details baked into the token.
 *
 * WHY "STATELESS" MATTERS: the server keeps no session store. Everything needed
 * to verify a token is in the token plus the secret, so any server instance can
 * validate any token — that is what makes it scale.
 *
 * THE COST OF STATELESSNESS: you cannot revoke a token. Once signed, it is valid
 * until it expires; there is no list to delete it from. Our mitigation is
 * `changedPasswordAfter` — changing your password invalidates every token issued
 * before that moment, giving us a "log out everywhere" button.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

const catchAsync = require('./../utils/catchAsync.js');
const sendEmail = require('./../utils/email.js');
const User = require('./../models/userModel.js');
const AppError = require('../utils/appError.js');

/**
 * Sign a token containing the user's id.
 *
 * `expiresIn` accepts a readable string ('90d', '1h', '30m') or a number of
 * SECONDS. Shorter is safer (a stolen token dies sooner) but more annoying
 * (users get logged out). 90 days is typical for a hobby app; a bank uses
 * minutes plus refresh tokens.
 *
 * `{ id }` is shorthand for `{ id: id }`.
 */
const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIREIN,
  });

/**
 * Create a token, put it in an httpOnly cookie, and send it in the JSON body.
 *
 * WHY BOTH A COOKIE AND THE BODY?
 *   - The JSON `token` is for API clients: Postman, a mobile app, anything that
 *     will send it back as an `Authorization: Bearer ...` header.
 *   - The COOKIE is for browsers, and it is the more secure of the two.
 *
 * THE COOKIE OPTIONS, AND WHY EACH ONE MATTERS:
 *
 *   `httpOnly: true` — JavaScript cannot read this cookie (`document.cookie`
 *      won't show it). This is the defence against XSS: even if an attacker
 *      injects a script into your page, it cannot steal the token. A token kept
 *      in `localStorage` has no such protection — which is why httpOnly cookies
 *      are the recommended place for tokens in a browser.
 *
 *   `secure: true` — only send over HTTPS, so the token can't be read off a
 *      plain-HTTP connection. Only enabled in production, because localhost is
 *      HTTP and the cookie would never be set during development.
 *
 *   `sameSite: 'strict'` — ADDED. The browser won't attach this cookie to
 *      requests originating from other sites, which is the main defence against
 *      CSRF (a malicious page silently making requests as the logged-in user).
 *      Its absence was a real gap.
 *
 * `Date.now() + days * 24 * 60 * 60 * 1000` — days → milliseconds. The `* 1000`
 * at the end is the usual place people slip up: JS dates are in milliseconds.
 *
 * ⚠️ FIX — THE PASSWORD HASH WAS BEING SENT TO THE CLIENT. On `signup`, the user
 * object comes from `User.create()`, which returns the in-memory document — and
 * `select: false` only filters QUERY results, not a document you just built. So
 * the bcrypt hash was included in the signup response body. Setting it to
 * undefined before serialising fixes it. (Same on resetPassword and
 * updatePassword, which use `.select('+password')` and so also hold the hash.)
 */
const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);

  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIREIN * 24 * 60 * 60 * 1000,
    ),
    httpOnly: true,
    sameSite: 'strict',
  };
  if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;

  res.cookie('jwt', token, cookieOptions);

  // Hide the hash from the response body. Purely in-memory — we are not saving,
  // so this does not touch the database.
  user.password = undefined;

  res.status(statusCode).json({
    status: 'success',
    token,
    data: { user },
  });
};

/**
 * ---------------------------------------------------------------------------
 * SIGN UP
 * ---------------------------------------------------------------------------
 * ⚠️ THE ORIGINAL HAD A PRIVILEGE-ESCALATION HOLE: `User.create(req.body)`
 * passes EVERY field the client sent, including `role`. So anybody could POST
 * `{"name":"x","email":"x@x.com","password":"...","passwordConfirm":"...",
 *   "role":"admin"}` and become an administrator with full delete rights over
 * every tour and user. This is called MASS ASSIGNMENT, and it is one of the most
 * commonly exploited API flaws in the wild.
 *
 * THE FIX: never hand raw `req.body` to a model on a public route. Pick the
 * fields explicitly — an allow-list. Anything else the client sends is ignored,
 * and `role` falls back to the schema default of 'user'. Promoting someone to
 * admin now requires the admin-only `PATCH /users/:id` route.
 *
 * Note we still pass `passwordConfirm`: the schema validator needs it, and the
 * pre-save hook deletes it before saving.
 */
exports.signup = catchAsync(async (req, res, next) => {
  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
  });

  createSendToken(newUser, 201, res);
});

/**
 * ---------------------------------------------------------------------------
 * LOG IN
 * ---------------------------------------------------------------------------
 * Three steps, and each has a security detail worth understanding.
 *
 * 1. Are both fields present? Without this check, a request with no password
 *    would reach bcrypt.compare with `undefined` and throw an unhelpful 500.
 *
 * 2. `.select('+password')` — the password is `select: false` in the schema, so
 *    it is normally excluded. The `+` adds it back for this one query. Without
 *    it, `user.password` is undefined and every login fails.
 *
 * 3. THE COMBINED CHECK, and this is the important part:
 *
 *      if (!user || !(await user.correctPassword(...)))
 *          → 'Incorrect email or password'
 *
 *    We deliberately do NOT say which one was wrong. Separate messages ("no
 *    such user" vs "wrong password") turn the login form into a tool for
 *    discovering which email addresses have accounts — USER ENUMERATION. That
 *    is a genuine privacy leak (imagine a medical site) and it hands an attacker
 *    a list of valid targets to brute-force.
 *
 *    JavaScript's `||` SHORT-CIRCUITS: if `!user` is true, the right side never
 *    runs. That matters here — calling `user.correctPassword` on null would
 *    throw. The order of the two conditions is not accidental.
 *
 * We return 401 (Unauthorized = "I don't know who you are"), not 403
 * (Forbidden = "I know who you are, and you're not allowed").
 */
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError('Please provide email and password', 400));
  }

  const user = await User.findOne({ email }).select('+password');

  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Incorrect email or password', 401));
  }

  createSendToken(user, 200, res);
});

/**
 * ---------------------------------------------------------------------------
 * LOG OUT  (ADDED — it was missing entirely)
 * ---------------------------------------------------------------------------
 * You cannot invalidate a JWT server-side, so "logging out" means removing the
 * client's copy. For the cookie we overwrite it with a junk value that expires
 * in 10 seconds. An API client simply discards its token.
 */
exports.logout = (req, res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.status(200).json({ status: 'success' });
};

/**
 * ===========================================================================
 * `protect` — THE GATEKEEPER. The most important middleware in the app.
 * ===========================================================================
 * Put it in front of a route and that route requires a logged-in user. It also
 * sets `req.user`, which everything downstream relies on (`getMe`, `updateMe`,
 * `restrictTo`, review ownership...).
 *
 * FOUR STEPS:
 *
 * 1. FIND THE TOKEN. The standard is the header
 *    `Authorization: Bearer eyJhbGci...`; `.split(' ')[1]` takes the part after
 *    the space. ADDED: we also accept the `jwt` cookie, so a browser session
 *    works without the front-end having to attach a header by hand. Without the
 *    cookie fallback, the httpOnly cookie we so carefully set was never actually
 *    used for anything.
 *
 * 2. VERIFY IT. `jwt.verify` re-computes the signature with our secret and
 *    compares. If a single character of the payload was altered, the signatures
 *    disagree and it throws `JsonWebTokenError`. If `exp` has passed, it throws
 *    `TokenExpiredError`. Both are translated into clean 401s by
 *    errorController.js.
 *
 *    WHY `promisify`? `jwt.verify` is old-style callback-based. `promisify` (from
 *    Node's built-in `util`) wraps it so it returns a promise and we can `await`
 *    it — keeping this function flat instead of nesting a callback. There is a
 *    synchronous form (`jwt.verify(token, secret)` with no callback) that throws
 *    on failure, which would also work; promisify is shown here because it is
 *    the pattern you will need for any callback-based library.
 *
 * 3. DOES THE USER STILL EXIST? A token stays valid after its owner deletes
 *    their account. Without this check, a deleted user's token would still get
 *    in and `req.user` would be null, crashing everything downstream. This is
 *    also why we only store the id in the payload — the user's data is always
 *    fresh from the database, so a role change takes effect immediately rather
 *    than at token expiry.
 *
 * 4. WAS THE PASSWORD CHANGED AFTER THE TOKEN WAS ISSUED? Our "log out
 *    everywhere" mechanism. See `changedPasswordAfter` in userModel.js.
 *
 * ⚠️ FIX: the method was called as `freshUser.changePasswordAfter(...)`. It has
 * been renamed to `changedPasswordAfter` in the model (past tense — it asks a
 * question, it doesn't perform an action), and the call is updated to match.
 * Calling a non-existent method throws "is not a function", so the two names
 * MUST agree.
 */
exports.protect = catchAsync(async (req, res, next) => {
  // --- 1) Get the token ----------------------------------------------------
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(
      new AppError('You are not logged in. Please log in to get access.', 401),
    );
  }

  // --- 2) Verify it --------------------------------------------------------
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // --- 3) Does the user still exist? --------------------------------------
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError('The user belonging to this token no longer exists.', 401),
    );
  }

  // --- 4) Password changed since the token was issued? -------------------
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User recently changed password. Please log in again.', 401),
    );
  }

  // Attach the user to the request so later middleware and controllers can use
  // it. This is how data is passed along an Express chain — there is no other
  // shared context between middleware.
  req.user = currentUser;
  next();
});

/**
 * ===========================================================================
 * `restrictTo` — AUTHORISATION (as opposed to authentication)
 * ===========================================================================
 * AUTHENTICATION = "who are you?"       → `protect`
 * AUTHORISATION  = "are you allowed?"   → `restrictTo`
 *
 * Usage:  router.delete('/:id', protect, restrictTo('admin', 'lead-guide'), deleteTour)
 *
 * WHY IS IT A FUNCTION THAT RETURNS A FUNCTION? Because Express only ever calls
 * handlers with `(req, res, next)` — there is no way to pass extra arguments.
 * So we call `restrictTo('admin')` ourselves at startup, and it returns a normal
 * middleware that has `roles` captured in its closure. Same pattern as the
 * handler factory.
 *
 * `...roles` is a REST PARAMETER: it gathers all arguments into an array, so
 * `restrictTo('admin', 'lead-guide')` gives `roles = ['admin', 'lead-guide']`.
 *
 * ⚠️ IT MUST ALWAYS COME AFTER `protect` IN THE CHAIN. It reads `req.user.role`,
 * and `req.user` is only set by `protect`. Putting it first throws "Cannot read
 * properties of undefined (reading 'role')" — a 500 where you intended a 403.
 *
 * 403 Forbidden is the right code: we know exactly who you are, and the answer
 * is still no.
 */
exports.restrictTo =
  (...roles) =>
  (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403),
      );
    }
    next();
  };

/**
 * ===========================================================================
 * PASSWORD RESET — part 1 of 2: request a reset link
 * ===========================================================================
 * The flow: user gives their email → we email them a one-time link → they PATCH
 * a new password to that link.
 *
 * `{ validateBeforeSave: false }` — we are saving a user document while setting
 * only the two reset fields. Full validation would fail because
 * `passwordConfirm` is `required` but was deleted by the pre-save hook after
 * signup. This option skips validators for this one save. Use it sparingly and
 * only when you know exactly which fields you are touching.
 *
 * THE try/catch IS THE POINT OF THIS FUNCTION. We have already saved the reset
 * token to the database. If the email then fails to send, the user has a live
 * reset token they never received — invisible, and valid for 10 minutes. So on
 * failure we must UNDO the save. This is one of the few places where an explicit
 * try/catch is right even though `catchAsync` exists: we need to clean up before
 * handing the error on.
 *
 * ⚠️ FIX: the method name was `crateResetPasswordToken` ("crate"). Renamed to
 * `createPasswordResetToken` in the model, and updated here.
 *
 * ⚠️ A NOTE ON THE 404. Replying "There is no user with that email" is again
 * USER ENUMERATION — a stranger can test which emails have accounts. The
 * privacy-preserving alternative is to always reply "if that address exists, a
 * link has been sent". It is left as a 404 here because it is far friendlier
 * while learning (you immediately see that you typo'd the address), but for
 * anything public, change it.
 */
exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Find the user by the posted email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with that email address', 404));
  }

  // 2) Generate the random reset token (plain returned, hash stored)
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // 3) Email it. We build the URL from the request itself, so it works on
  //    localhost and in production without a hardcoded domain.
  const resetURL = `${req.protocol}://${req.get(
    'host',
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}\n\nThis link is valid for 10 minutes.\nIf you didn't forget your password, please ignore this email.`;

  try {
    await sendEmail({
      email: user.email,
      subject: 'Your password reset token (valid for 10 min)',
      message,
    });

    // Note: we do NOT return the token in the response. That would completely
    // defeat the purpose — proving control of the inbox is the whole mechanism.
    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!',
    });
  } catch (err) {
    // ROLLBACK: the email failed, so the token must not remain usable.
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    // Log the real cause for ourselves — the client gets a generic message.
    console.error('📧 Email sending failed:', err.message);

    return next(
      new AppError(
        'There was an error sending the email. Try again later!',
        500,
      ),
    );
  }
});

/**
 * ===========================================================================
 * PASSWORD RESET — part 2 of 2: use the link
 * ===========================================================================
 * The user PATCHes `{ password, passwordConfirm }` to
 * `/resetPassword/:token`, where `:token` is the PLAIN token from the email.
 *
 * STEP 1 IS THE CLEVER BIT: we hash what we received and search for THAT. The
 * database only ever stored the hash, so a leaked database contains no usable
 * reset tokens. Same principle as password storage.
 *
 * `passwordResetExpires: { $gt: Date.now() }` folds the expiry check into the
 * query itself: "find a user with this token whose expiry is still in the
 * future". If either condition fails we get null, and one message covers both
 * cases — which also avoids telling an attacker whether a token was real but
 * stale, or simply wrong.
 *
 * WHY `user.save()` AND NOT `findByIdAndUpdate`? Because `.save()` is the only
 * path that runs document middleware and validators. It:
 *   - runs the `passwordConfirm` match validator
 *   - runs the bcrypt hashing hook
 *   - runs the `passwordChangedAt` hook
 * `findByIdAndUpdate` would skip all three and store the new password in PLAIN
 * TEXT. This is the single most important rule when handling passwords in
 * Mongoose: **always `.save()`, never a query update.**
 *
 * Clearing the two reset fields makes the token single-use.
 *
 * Finally we log them straight in — they just proved they own the inbox, so
 * making them log in again adds nothing.
 */
exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Hash the incoming plain token and look it up
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) No user → token was wrong or has expired
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }

  // 3) Set the new password and burn the token
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // 4) Log the user in with a fresh token
  createSendToken(user, 200, res);
});

/**
 * ===========================================================================
 * UPDATE PASSWORD (for a user who is already logged in)
 * ===========================================================================
 * Distinct from `resetPassword`: this one requires the CURRENT password.
 *
 * WHY ASK FOR THE CURRENT PASSWORD IF THEY'RE ALREADY LOGGED IN? Because a
 * logged-in session might not be the real owner — a borrowed laptop, an
 * unlocked phone, a stolen token. Re-confirming the password means a token alone
 * is not enough to lock the true owner out of their own account. Every serious
 * site does this, and it is worth understanding why rather than treating it as
 * ceremony.
 *
 * ⚠️ ADDED GUARD: the original went straight to `user.correctPassword(
 * req.body.passwordCurrent, ...)`. If the client omitted `passwordCurrent`,
 * bcrypt received `undefined` and threw "data and hash arguments required" — a
 * confusing 500 where a 400 belongs. Always validate that required input is
 * actually present before passing it to a library.
 *
 * Again `.select('+password')` to load the hash, and again `.save()` rather than
 * `findByIdAndUpdate` so the hashing hook runs.
 *
 * A NEW TOKEN IS ISSUED AT THE END, and this is not optional: the
 * `passwordChangedAt` hook has just invalidated the token the client is holding.
 * Skip `createSendToken` and the user is instantly logged out by their own
 * password change.
 */
exports.updatePassword = catchAsync(async (req, res, next) => {
  // `req.user` was set by `protect`, so we know who is asking.
  const user = await User.findById(req.user.id).select('+password');

  // 1) Is the required input present?
  if (!req.body.passwordCurrent || !req.body.password) {
    return next(
      new AppError(
        'Please provide passwordCurrent, password and passwordConfirm',
        400,
      ),
    );
  }

  // 2) Is the current password correct?
  if (!(await user.correctPassword(req.body.passwordCurrent, user.password))) {
    return next(new AppError('Your current password is wrong.', 401));
  }

  // 3) Update it — via .save() so hooks and validators run
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  await user.save();

  // 4) Issue a fresh token, or they are logged out immediately
  createSendToken(user, 200, res);
});
