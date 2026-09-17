/**
 * ============================================================================
 * USER MODEL — identity, passwords and the security rules around them
 * ============================================================================
 *
 * This is the most security-sensitive file in the project. Three ideas drive
 * every decision in it:
 *
 *   1. NEVER store a password. Store a one-way HASH of it. If your database
 *      leaks, the attacker must still crack every hash individually.
 *   2. NEVER send the hash to the client either. Hence `select: false`.
 *   3. Put the security logic in the MODEL, not the controller — so it runs no
 *      matter which route caused the write. A controller you forget to update
 *      is a vulnerability; a pre-save hook cannot be forgotten.
 */
const crypto = require('crypto'); // built into Node, no install needed
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please tell us your name'],
    trim: true,
  },

  email: {
    type: String,
    required: [true, 'Please provide your email'],

    // Creates a unique index in MongoDB. Remember: this is NOT a Mongoose
    // validator, so a duplicate produces a raw MongoServerError code 11000,
    // which errorController.js translates into a friendly 400.
    unique: true,

    // Stores 'JOHN@Mail.COM' as 'john@mail.com'. Essential — without it,
    // 'John@mail.com' and 'john@mail.com' become two different accounts and
    // login silently fails for anyone who capitalises their email.
    lowercase: true,
    trim: true,

    // The array form: [validatorFunction, errorMessage]. `validator.isEmail`
    // is from the `validator` package — writing a correct email regex yourself
    // is famously hard, so don't.
    validate: [validator.isEmail, 'Please provide a valid email'],
  },

  photo: {
    type: String,
    // A default means the front-end never has to handle a missing image.
    default: 'default.jpg',
  },

  role: {
    type: String,
    // FIX: this was ['user', 'lead', 'lead-guide', 'admin'] — but 'lead' is not
    // a real role anywhere in the app, and the actual role used by the seed
    // data (dev-data/data/users.json) is 'guide', which was MISSING. So any
    // guide created through the API was rejected with a validation error, while
    // the imported ones only slipped through because the import script uses
    // `.collection.insertMany()`, which bypasses Mongoose entirely.
    enum: {
      values: ['user', 'guide', 'lead-guide', 'admin'],
      message: 'Role must be: user, guide, lead-guide or admin',
    },
    default: 'user',
  },

  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: [8, 'A password must be at least 8 characters'],

    // ⚠️ THE MOST IMPORTANT LINE IN THIS FILE.
    // `select: false` means the field is excluded from EVERY query result by
    // default, so a password hash can never leak through an API response by
    // accident. Even `GET /users` cannot expose it.
    //
    // The consequence you must remember: when you genuinely need it — in
    // login, to compare it — you have to ask for it explicitly:
    //     User.findOne({ email }).select('+password')
    // The `+` means "add this normally-hidden field back in".
    select: false,
  },

  passwordConfirm: {
    type: String,
    required: [true, 'Please confirm your password'],
    /**
     * Custom validator: does the confirmation match the password?
     *
     * TWO THINGS TO NOTE:
     *
     * 1. Regular `function`, not an arrow — we need `this` = the document.
     *
     * 2. This runs on SAVE only. It will NOT run on `findByIdAndUpdate`,
     *    because there is no document in memory during a query update. That is
     *    precisely why authController's password routes use `user.save()` and
     *    never `findByIdAndUpdate` — using the latter would silently skip both
     *    this check AND the hashing hook below, storing a plain-text password.
     */
    validate: {
      validator: function (el) {
        return el === this.password;
      },
      message: 'Passwords do not match',
    },
  },

  // When the password was last changed. Used to invalidate tokens issued
  // before that moment — see `changedPasswordAfter` below.
  passwordChangedAt: Date,

  // The SHA-256 hash of the reset token, plus its expiry. See
  // `createPasswordResetToken` for why we store a hash and not the token.
  passwordResetToken: String,
  passwordResetExpires: Date,

  active: {
    type: Boolean,
    default: true,
    // Hidden from responses — it is an internal flag, not user-facing data.
    select: false,
  },
});

/**
 * ============================================================================
 * MIDDLEWARE
 * ============================================================================
 */

/**
 * --- 1) HASH THE PASSWORD BEFORE SAVING ------------------------------------
 *
 * WHY A HASH AND NOT ENCRYPTION?
 * Encryption is reversible — with the key you get the original back. A hash is
 * one-way: there is no "unhash". To check a login we hash the attempt and
 * compare the two hashes. This means even we cannot read our users' passwords,
 * which is exactly what you want.
 *
 * WHY BCRYPT SPECIFICALLY?
 * A fast hash (MD5, SHA-256) is a liability here: a GPU can try billions of
 * SHA-256 guesses per second. bcrypt is deliberately SLOW and, crucially,
 * *tunable*: the cost factor 12 means 2^12 = 4096 internal rounds, taking
 * roughly a quarter of a second. Unnoticeable for one login, ruinous for an
 * attacker trying millions. As hardware gets faster you raise the number.
 *
 * bcrypt also SALTS automatically — it mixes in random bytes, so two users with
 * the same password get completely different hashes. That defeats "rainbow
 * tables" (giant precomputed hash lookups). The salt is stored inside the
 * resulting hash string, which is why `bcrypt.compare` needs no separate salt.
 *
 * WHY THE `isModified` GUARD?
 * This hook fires on EVERY save — including saves that have nothing to do with
 * the password, like `deleteMe` flipping `active`. Without the guard we would
 * hash the already-hashed password again, and the user could never log in
 * again. `isModified('password')` is true only when the field actually changed.
 */
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  // `await` matters: hashing is CPU-heavy, and the async version hands the work
  // to Node's thread pool instead of freezing the whole event loop. The sync
  // version (`bcrypt.hashSync`) would block every other request for ~250ms.
  this.password = await bcrypt.hash(this.password, 12);

  // Throw away the confirmation. It was only needed for validation — validators
  // have already run by this point, so we can safely delete it, and it never
  // touches the database. Setting a field to `undefined` is how you tell
  // Mongoose "do not persist this".
  this.passwordConfirm = undefined;
});

/**
 * --- 2) RECORD *WHEN* THE PASSWORD CHANGED ---------------------------------
 *
 * Needed so that changing your password invalidates all previously issued JWTs
 * (see `changedPasswordAfter`). Think "someone stole my laptop, log everything
 * else out".
 *
 * TWO GUARDS, TWO DIFFERENT REASONS:
 *   `!this.isModified('password')` — nothing to record if the password didn't change.
 *   `this.isNew` — on SIGNUP the password is "modified", but there is no
 *                  earlier session to invalidate, and stamping this field would
 *                  make the brand-new token look older than the password change.
 *
 * WHY `- 1000`? A subtle timing bug. Saving to MongoDB takes a few
 * milliseconds, and the JWT is signed just after. So `passwordChangedAt` can
 * end up a hair LATER than the token's issued-at time — and `changedPasswordAfter`
 * would then decide the fresh token is stale, immediately locking the user out
 * of the response they just received. Backdating by one second removes the race.
 * It is a hack, but it is the standard hack.
 */
userSchema.pre('save', async function () {
  if (!this.isModified('password') || this.isNew) return;

  this.passwordChangedAt = Date.now() - 1000;
});

/**
 * --- 3) HIDE DEACTIVATED USERS FROM EVERY QUERY ----------------------------
 *
 * `deleteMe` does a SOFT delete: it sets `active: false` instead of removing the
 * document, so reviews and bookings that reference the user don't break. This
 * hook makes those users invisible everywhere, so soft-deleted really does mean
 * deleted as far as the API is concerned.
 *
 * `/^find/` covers find, findOne, findById, findOneAndUpdate — all of them.
 *
 * `$ne: false` rather than `true`: users created before this field existed have
 * no `active` key at all, and `{ active: true }` would not match a missing
 * field, hiding legitimate users.
 *
 * ⚠️ FIX — MONGOOSE 9 BREAKING CHANGE: the original was
 * `function (next) { ...; next(); }`. Mongoose 9 (used here, 9.8.1) no longer
 * passes `next` into middleware, so that threw "next is not a function" and
 * broke every user query — including the one inside `protect`, which meant no
 * request to a protected route could succeed. A hook with no parameters is
 * treated as synchronous and simply continues when it returns.
 */
userSchema.pre(/^find/, function () {
  this.find({ active: { $ne: false } });
});

/**
 * ============================================================================
 * INSTANCE METHODS — helper functions available on every user document
 * ============================================================================
 * `schema.methods.x` puts `x` on each document (`user.x()`), whereas
 * `schema.statics.x` puts it on the model (`User.x()`). Methods are the right
 * home for logic about ONE user.
 */

/**
 * Compare a login attempt against the stored hash.
 *
 * We cannot hash the attempt and compare strings ourselves, because bcrypt
 * embeds a random salt in each hash — hashing the same password twice gives two
 * different strings. `bcrypt.compare` reads the salt out of the stored hash,
 * applies it to the candidate, and then compares. It also compares in constant
 * time, which prevents timing attacks (inferring the password from how long the
 * comparison takes).
 *
 * `userPassword` is passed in rather than read from `this.password` because the
 * field is `select: false` — the caller had to fetch it explicitly with
 * `.select('+password')`, so it hands it over directly.
 */
userSchema.methods.correctPassword = async function (
  candidatePassword,
  userPassword,
) {
  return bcrypt.compare(candidatePassword, userPassword);
};

/**
 * Was the password changed AFTER this token was issued?
 *
 * WHY THIS EXISTS: JWTs are stateless — once signed, a token stays valid until
 * it expires, and there is no server-side list we can delete it from. So if a
 * token is stolen, changing your password would normally do nothing. This check
 * gives us a "log out everywhere" ability: compare the token's issue time
 * against the last password change, and reject anything older.
 *
 * THE UNIT MISMATCH TO WATCH FOR: a JWT's `iat` ("issued at") is in SECONDS
 * since 1970, but JavaScript's `getTime()` returns MILLISECONDS. Comparing them
 * directly would be wrong by a factor of 1000 — every token would look ancient
 * and nobody could ever log in. Hence the `/ 1000`.
 *
 * `parseInt(x, 10)` drops the fractional part. The `10` is the radix (base 10)
 * — always pass it; without it, older engines could interpret a leading zero as
 * octal.
 *
 * Returns false when `passwordChangedAt` is unset (a user who never changed
 * their password), which correctly means "your token is fine".
 *
 * RENAMED from `changePasswordAfter` → `changedPasswordAfter`. Past tense: it
 * asks a question about the past, it doesn't perform a change. The old name
 * read like a command and invited misuse.
 */
userSchema.methods.changedPasswordAfter = function (JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(
      this.passwordChangedAt.getTime() / 1000,
      10,
    );
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

/**
 * Create a password-reset token.
 *
 * THE CLEVER PART — and the reason this is not just `crypto.randomBytes`:
 * we send the PLAIN token to the user by email, but store only its SHA-256
 * HASH in the database. It is the same principle as passwords: if someone dumps
 * your users collection, they hold hashes that cannot be used to reset anyone's
 * password. Only the real email recipient has the usable value.
 *
 * When the user comes back with the token in the URL, `resetPassword` hashes
 * what it received and looks up THAT — see authController.
 *
 * WHY SHA-256 HERE BUT BCRYPT FOR PASSWORDS? Because this token is 32 random
 * bytes (2^256 possibilities) and lives for 10 minutes. It cannot be guessed or
 * brute-forced, so the deliberate slowness of bcrypt buys nothing. Passwords,
 * by contrast, are short and human-chosen — that is what needs the slow hash.
 *
 * NOTE: this method only SETS the fields on the document — it does not save.
 * The caller must `await user.save({ validateBeforeSave: false })`. Easy to
 * forget, and then the reset link mysteriously never matches anything.
 *
 * RENAMED from `crateResetPasswordToken` (typo: "crate") to
 * `createPasswordResetToken`, matching the field names it sets.
 */
userSchema.methods.createPasswordResetToken = function () {
  // 32 cryptographically-secure random bytes as hex.
  // ⚠️ Use `crypto.randomBytes`, never `Math.random()` — Math.random is
  // predictable and completely unsuitable for anything security-related.
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  // REMOVED: the original had `console.log({ resetToken }, ...)` here, which
  // printed a live password-reset token into the server logs. Logs get shipped
  // to third-party services and read by people who should not be able to take
  // over accounts. Never log secrets.

  // Valid for 10 minutes. A short window limits the damage if the email is
  // intercepted or the inbox is later compromised.
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000;

  // The caller emails THIS value. The database only ever sees the hash above.
  return resetToken;
};

const User = mongoose.model('User', userSchema);

module.exports = User;
