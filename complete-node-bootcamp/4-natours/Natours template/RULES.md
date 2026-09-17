# Backend Template — Project Rules

This file defines how every part of this project is structured.
When building a new feature with AI or manually, follow these rules exactly.
Do not deviate from these patterns unless you update this file first.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Data Flow](#2-data-flow)
3. [Models](#3-models)
4. [Controllers](#4-controllers)
5. [Routes](#5-routes)
6. [Utils](#6-utils)
7. [Error Handling](#7-error-handling)
8. [Authentication & Authorization](#8-authentication--authorization)
9. [Response Shape](#9-response-shape)
10. [Security Rules](#10-security-rules)
11. [Mongoose Rules (v9)](#11-mongoose-rules-v9)
12. [Adding a New Resource — Checklist](#12-adding-a-new-resource--checklist)

---

## 1. Project Structure

```
project/
├── controllers/
│   ├── authController.js      # signup, login, logout, protect, restrictTo, forgotPassword, resetPassword, updatePassword
│   ├── errorController.js     # global error handler — do not touch
│   ├── factoryHandler.js      # generic CRUD — reuse for every model
│   ├── userController.js      # user-specific logic (getMe, updateMe, deleteMe)
│   └── [resource]Controller.js  # one file per resource
├── models/
│   ├── userModel.js           # always present — auth depends on it
│   └── [resource]Model.js     # one file per resource
├── routes/
│   ├── userRoutes.js          # always present
│   └── [resource]Routes.js    # one file per resource
├── utils/
│   ├── appError.js            # custom error class — never modify
│   ├── catchAsync.js          # async wrapper — never modify
│   ├── apiFeatures.js         # filtering/sorting/pagination — never modify
│   └── email.js               # nodemailer email sender
├── app.js                     # express setup and middleware
├── server.js                  # entry point, DB connection, process handlers
└── config.env                 # environment variables — never commit
```

**Rules:**
- One model file per database collection
- One controller file per resource
- One route file per resource
- Never put business logic in route files
- Never put database queries directly in route files

---

## 2. Data Flow

Every request follows this exact path — no exceptions:

```
Request
  → app.js middleware (helmet, rate limit, body parser, sanitize, xss, hpp)
  → routes/[resource]Routes.js  (URL matching + auth middleware)
  → controllers/authController.js  (protect / restrictTo — if route is protected)
  → controllers/[resource]Controller.js  (business logic)
  → models/[resource]Model.js  (database operation)
  → factoryHandler.js  (if using generic CRUD)
  → Response sent
  → [if error] → next(err) → controllers/errorController.js → Response sent
```

**Rules:**
- `req.user` is set by `authController.protect` — only available on protected routes
- `req.body` is the parsed JSON body — always limited to 10kb
- `req.params` contains URL parameters (`:id`, `:tourId`, etc.)
- `req.query` contains query string parameters (`?sort=price&limit=5`)
- Never call `res.json()` more than once per request
- Always call `next(err)` instead of sending error responses manually

---

## 3. Models

### Structure of every model file

```js
const mongoose = require('mongoose');

const thingSchema = new mongoose.Schema(
  {
    // field definitions
  },
  {
    toJSON: { virtuals: true },   // always include both
    toObject: { virtuals: true },
  },
);

// indexes
// virtuals
// pre hooks
// post hooks
// static methods
// instance methods

const Thing = mongoose.model('Thing', thingSchema);
module.exports = Thing;
```

### Field definition rules

```js
fieldName: {
  type: String,                                    // always specify type
  required: [true, 'Human readable error message'], // use array form for custom message
  trim: true,                                       // add to all String fields
  default: Date.now,                                // pass function REFERENCE, never Date.now()
}
```

- `required` always uses array form `[true, 'message']` — never just `true`
- `enum` always uses object form with a `message` property
- Sensitive fields (`password`, `active`, `passwordResetToken`) must have `select: false`
- Timestamps (`createdAt`) use `default: Date.now` — no parentheses

### Pre hook rules (Mongoose 9)

**Mongoose 9 does NOT pass `next` to pre hooks. Do not use it.**

```js
// CORRECT — Mongoose 9
schema.pre('save', async function () {
  if (!this.isModified('password')) return;  // use return to exit early
  // ...
});

schema.pre(/^find/, function () {
  this.find({ active: { $ne: false } });
});

// WRONG — will crash with "next is not a function"
schema.pre('save', async function (next) {
  next(); // ← DO NOT DO THIS
});
```

- `pre('save')` — use for hashing, slug generation, setting computed fields
- `pre(/^find/)` — use for filtering (e.g. exclude secret/inactive documents) and populating references
- `pre(/^findOneAnd/)` — use to capture the document before update/delete (store as `this.r`)

### Post hook rules

```js
// post save — always async, always await side effects
schema.post('save', async function () {
  await this.constructor.someStaticMethod(this.fieldId);
});

// post find — for logging or post-processing
schema.post(/^find/, function (docs) {
  if (this.start) console.log(`Query took ${Date.now() - this.start}ms`);
});

// post findOneAnd — use this.r set in the pre hook
schema.post(/^findOneAnd/, async function () {
  if (this.r) await this.r.constructor.someStaticMethod(this.r.fieldId);
});
```

### Static method rules

- Use for operations that work on the collection, not a single document
- Example: `calcAverageRatings(tourId)` aggregates all reviews for a tour
- Always `await` static methods when called from post hooks

### Instance method rules

- Use for operations that work on a single document
- Example: `correctPassword()`, `changePasswordAfter()`, `crateResetPasswordToken()`
- Instance methods are defined on `schema.methods`

### Index rules

```js
schema.index({ price: 1, ratingsAverage: -1 }); // compound index
schema.index({ slug: 1 });                        // single field
schema.index({ startLocation: '2dsphere' });      // geospatial
```

- Add indexes on fields that are frequently queried or sorted
- Add `2dsphere` index on any GeoJSON location field
- Compound indexes go from most selective to least selective

---

## 4. Controllers

### When to use `factoryHandler` vs custom controller function

| Situation | Use |
|-----------|-----|
| Standard get all documents | `factory.getAll(Model)` |
| Standard get one by ID | `factory.getOne(Model)` or `factory.getOne(Model, { path: 'field' })` |
| Standard create | `factory.createOne(Model)` |
| Standard update by ID | `factory.updateOne(Model)` |
| Standard delete by ID | `factory.deleteOne(Model)` |
| Custom query / aggregation | Custom controller function |
| Logic that needs `req.user` | Custom controller function |
| File uploads, computed fields | Custom controller function |

### Structure of every custom controller function

```js
exports.doSomething = catchAsync(async (req, res, next) => {
  // 1. Get data from req (req.params, req.body, req.query, req.user)
  // 2. Validate / check conditions — return next(new AppError(...)) on failure
  // 3. Perform DB operation — always await
  // 4. Send response
  res.status(200).json({
    status: 'success',
    data: {
      resourceName: result,
    },
  });
});
```

**Rules:**
- Every async controller function MUST be wrapped in `catchAsync`
- Never use try/catch inside a controller — that is `catchAsync`'s job
- Always `return next(new AppError(...))` when stopping execution on error
- Never call `next()` without an error argument inside a controller (that is for middleware)
- Only call `res.json()` once — after all logic is complete

### Input filtering rule

When updating user-controlled data, always whitelist allowed fields:

```js
const filterObj = (obj, ...allowedFields) => {
  const newObj = {};
  Object.keys(obj).forEach((el) => {
    if (allowedFields.includes(el)) newObj[el] = obj[el];
  });
  return newObj;
};

const filteredBody = filterObj(req.body, 'name', 'email'); // only these fields
```

Never pass `req.body` directly to `findByIdAndUpdate` for user-editable endpoints.

---

## 5. Routes

### Structure of every route file

```js
const express = require('express');
const thingController = require('./../controllers/thingController');
const authController = require('./../controllers/authController');

const router = express.Router({ mergeParams: true }); // mergeParams only for nested routes

// Public routes (no auth)
router.route('/').get(thingController.getAll);

// Protected routes — apply authController.protect above the routes it should cover
router.use(authController.protect);

router.route('/').post(thingController.createOne);
router.route('/:id')
  .get(thingController.getOne)
  .patch(thingController.updateOne)
  .delete(thingController.deleteOne);

module.exports = router;
```

### Nested routes rule

When a resource belongs to another resource (e.g. reviews belong to tours):

```js
// In tourRoutes.js — mount the review router
router.use('/:tourId/reviews', reviewRouter);

// In reviewRoutes.js — enable mergeParams to access :tourId
const router = express.Router({ mergeParams: true });

// In reviewController.js — read the parent ID
if (!req.body.tour) req.body.tour = req.params.tourId;
if (!req.body.user) req.body.user = req.user.id; // from protect middleware
```

### Route protection rules

```js
// Single route protection
router.get('/me', authController.protect, userController.getMe);

// Protect all routes below this line
router.use(authController.protect);

// Restrict to specific roles
router.delete('/:id',
  authController.protect,
  authController.restrictTo('admin', 'lead-guide'),
  thingController.deleteOne
);
```

### Registering routes in app.js

```js
// Always prefix with /api/v1/
app.use('/api/v1/users', userRouter);
app.use('/api/v1/things', thingRouter);
```

---

## 6. Utils

### `catchAsync.js` — how it works

```js
// Wraps any async function so errors automatically go to next(err)
module.exports = (fn) => {
  return (req, res, next) => {
    fn(req, res, next).catch(next); // catches any thrown error or rejected promise
  };
};
```

**Rule:** Every async controller function must be wrapped: `exports.fn = catchAsync(async (req, res, next) => { ... })`

### `appError.js` — how it works

```js
// Creates an operational error with statusCode and status set automatically
new AppError('message', statusCode)
// statusCode 4xx → status = 'fail'
// statusCode 5xx → status = 'error'
// isOperational = true — means it's a known, expected error
```

**When to use `AppError`:**

| Situation | Code | Example |
|-----------|------|---------|
| Missing required input | 400 | `'Please provide email and password'` |
| Invalid input value | 400 | `'Token is invalid or has expired.'` |
| Not authenticated | 401 | `'You are not logged in.'` |
| Wrong credentials | 401 | `'Incorrect email or password'` |
| Password changed after token | 401 | `'User recently changed password.'` |
| No permission | 403 | `'You do not have permission.'` |
| Resource not found | 404 | `'No document found with that ID.'` |
| Duplicate value | 400 | handled automatically by errorController |
| Server/email failure | 500 | `'There was an error sending the email.'` |

**Rule:** Never throw a plain `new Error()` — always use `new AppError(message, statusCode)`.

### `apiFeatures.js` — how to use it

```js
// In factoryHandler.getAll or any custom getAll:
const features = new APIFeatures(Model.find(filter), req.query)
  .filter()       // ?difficulty=easy&price[gte]=500
  .sort()         // ?sort=price,-ratingsAverage
  .limitFields()  // ?fields=name,price,duration
  .paginate();    // ?page=2&limit=10

const docs = await features.query;
```

**Query string API for clients:**

| Feature | Query string | Example |
|---------|-------------|---------|
| Filter by field | `?field=value` | `?difficulty=easy` |
| Greater/less than | `?field[gte]=value` | `?price[gte]=500` |
| Sort ascending | `?sort=field` | `?sort=price` |
| Sort descending | `?sort=-field` | `?sort=-ratingsAverage` |
| Multiple sort | `?sort=field1,field2` | `?sort=price,-rating` |
| Select fields | `?fields=f1,f2` | `?fields=name,price` |
| Paginate | `?page=N&limit=N` | `?page=2&limit=10` |

### `email.js` — how to use it

```js
await sendEmail({
  email: user.email,
  subject: 'Subject line',
  message: 'Plain text body',
});
```

Always `await` inside a try/catch block because email failures should be caught and handled gracefully (see `forgotPassword` in authController for the pattern).

---

## 7. Error Handling

### How errors flow

```
controller calls next(new AppError('msg', 400))
  → errorController.js receives it as (err, req, res, next)
  → in development: sends full error + stack trace
  → in production:
      isOperational = true  → sends status + message to client
      isOperational = false → logs to console, sends generic 500 message
```

### Error types handled automatically by `errorController`

You never need to handle these manually — they are caught and converted:

| Mongoose/JWT Error | Trigger | Response |
|--------------------|---------|----------|
| `CastError` | Invalid MongoDB ObjectId (e.g. `/tours/abc`) | 400 |
| Duplicate key (`code 11000`) | Creating a document with a unique field that already exists | 400 |
| `ValidationError` | Mongoose schema validation fails | 400 |
| `JsonWebTokenError` | JWT signature is invalid | 401 |
| `TokenExpiredError` | JWT has expired | 401 |

### Where to use `next(new AppError(...))` in controllers

```js
exports.doSomething = catchAsync(async (req, res, next) => {
  // Missing input — check BEFORE any DB call
  if (!req.body.email) return next(new AppError('Email is required.', 400));

  // Resource not found — after DB query
  const doc = await Model.findById(req.params.id);
  if (!doc) return next(new AppError('No document found with that ID.', 404));

  // Permission check — after finding the doc
  if (doc.user.toString() !== req.user.id)
    return next(new AppError('You do not have permission.', 403));

  res.status(200).json({ status: 'success', data: { doc } });
});
```

**Rules:**
- Always `return next(new AppError(...))` — the `return` prevents code below from running
- Do not throw errors — always pass to `next()`
- Do not send a response AND call next — pick one
- 400 for bad input, 401 for auth failures, 403 for permission failures, 404 for missing docs

---

## 8. Authentication & Authorization

### Auth middleware available

```js
authController.protect          // verifies JWT, sets req.user — use on all protected routes
authController.restrictTo(...)  // checks req.user.role — always comes AFTER protect
```

### How `protect` works

1. Reads token from `Authorization: Bearer <token>` header OR `jwt` cookie
2. Verifies token signature using `JWT_SECRET`
3. Checks the user still exists in the database
4. Checks the user has not changed their password after the token was issued
5. Sets `req.user` to the full user document
6. Calls `next()` to proceed

### How to add a protected route

```js
// Option 1: single route
router.get('/dashboard', authController.protect, controller.getDashboard);

// Option 2: all routes below this line
router.use(authController.protect);
router.get('/dashboard', controller.getDashboard);

// Option 3: protected + role restricted
router.delete('/:id',
  authController.protect,
  authController.restrictTo('admin'),
  controller.deleteOne
);
```

### Signup security rule

Never pass `req.body` directly to `User.create`. Always pick only the allowed fields:

```js
// CORRECT
const newUser = await User.create({
  name: req.body.name,
  email: req.body.email,
  password: req.body.password,
  passwordConfirm: req.body.passwordConfirm,
  // role is NOT here — users cannot self-assign admin
});

// WRONG — allows role injection
const newUser = await User.create(req.body);
```

### Token response rule

Always use `createSendToken(user, statusCode, res)` — never send a token manually.
It handles: signing, cookie, stripping sensitive fields, and response format.

---

## 9. Response Shape

All responses follow this exact envelope. Never deviate.

### Success — single document

```json
{
  "status": "success",
  "data": {
    "tour": { ... }
  }
}
```

### Success — list of documents

```json
{
  "status": "success",
  "results": 9,
  "data": {
    "tours": [ ... ]
  }
}
```

### Success — delete

```json
// HTTP 204 — no body content
```

### Success — auth (login/signup)

```json
{
  "status": "success",
  "token": "eyJ...",
  "data": {
    "user": { ... }
  }
}
```

### Error — operational (4xx)

```json
{
  "status": "fail",
  "message": "No document found with that ID."
}
```

### Error — server (5xx)

```json
{
  "status": "error",
  "message": "Something went wrong!"
}
```

### HTTP status codes used

| Code | When |
|------|------|
| 200 | Successful GET, PATCH, login |
| 201 | Successful POST (created) |
| 204 | Successful DELETE (no body) |
| 400 | Bad request / validation error / missing input |
| 401 | Not authenticated |
| 403 | Authenticated but no permission |
| 404 | Resource not found |
| 500 | Unexpected server error |

---

## 10. Security Rules

These are already set up in `app.js` and `authController.js`. Do not remove them.

| Rule | Where | Detail |
|------|-------|--------|
| Security headers | `helmet()` in app.js | Sets X-Frame-Options, CSP, etc. |
| Rate limiting — API | `apiLimiter` in app.js | 100 req/hr per IP on all `/api` routes |
| Rate limiting — Auth | `authLimiter` in app.js | 20 req/15min on login, signup, forgotPassword |
| Body size limit | `express.json({ limit: '10kb' })` | Prevents large payload attacks |
| NoSQL injection | `mongoSanitize` in app.js | Strips `$` and `.` from `req.body` |
| XSS | `xss()` in app.js | Sanitizes HTML in `req.body` |
| Parameter pollution | `hpp()` in app.js | Prevents duplicate query params |
| CORS | Custom middleware in app.js | Set `CORS_ORIGIN` in `config.env` for production |
| JWT in cookie | `httpOnly: true, sameSite: strict` | Prevents JS access and CSRF |
| Password hashing | `bcryptjs` with cost 12 in userModel | Never store plain text passwords |
| Role injection blocked | `authController.signup` | Only specific fields picked from `req.body` |
| Email enumeration blocked | `authController.forgotPassword` | Same response for known and unknown emails |
| Sensitive fields hidden | `select: false` in schema | `password`, `active`, `passwordResetToken` |

**When adding a new route:**
- Ask: does this route need authentication? → add `authController.protect`
- Ask: does this route need a specific role? → add `authController.restrictTo(...roles)`
- Ask: does this route accept user input? → use `filterObj` to whitelist fields

---

## 11. Mongoose Rules (v9)

### Pre hooks — no `next` parameter

```js
// CORRECT
schema.pre('save', async function () { ... });
schema.pre(/^find/, function () { ... });

// WRONG — next is undefined in Mongoose 9
schema.pre('save', async function (next) { next(); });
```

### Async vs sync pre hooks

- Use `async function` when the hook does `await` (e.g. bcrypt, DB calls)
- Use regular `function` when the hook is synchronous (e.g. slugify, filtering)

### `this` context in hooks

| Hook | `this` refers to |
|------|-----------------|
| `pre('save')` | The document being saved |
| `pre(/^find/)` | The Query object |
| `pre(/^findOneAnd/)` | The Query object |
| Static method | The Model class |
| Instance method | The document instance |

### Common patterns

```js
// Exclude soft-deleted documents from all queries
schema.pre(/^find/, function () {
  this.find({ active: { $ne: false } });
});

// Auto-populate a reference field on all finds
schema.pre(/^find/, function () {
  this.populate({ path: 'user', select: 'name photo' });
});

// Capture document before findOneAndUpdate/Delete for post hook
schema.pre(/^findOneAnd/, async function () {
  this.r = await this.model.findOne(this.getQuery());
});

schema.post(/^findOneAnd/, async function () {
  if (this.r) await this.r.constructor.recalculate(this.r.refId);
});
```

---

## 12. Adding a New Resource — Checklist

Follow this exact order when adding a new resource (e.g. `Product`):

**Step 1 — Model** (`models/productModel.js`)
- [ ] Define schema with proper types, required messages, and validation
- [ ] Add `{ toJSON: { virtuals: true }, toObject: { virtuals: true } }` to schema options
- [ ] Add indexes for fields used in queries
- [ ] Add pre/post hooks if needed (no `next` param)
- [ ] Export: `module.exports = mongoose.model('Product', productSchema)`

**Step 2 — Controller** (`controllers/productController.js`)
- [ ] Import `factory` from `factoryHandler.js`
- [ ] Import `catchAsync`, `AppError`, and the Model
- [ ] Use `factory.getAll`, `factory.getOne`, `factory.createOne`, `factory.updateOne`, `factory.deleteOne` for standard CRUD
- [ ] Write custom functions only when factory is not enough
- [ ] Wrap every async function in `catchAsync`
- [ ] Use `return next(new AppError(...))` for all error cases

**Step 3 — Route** (`routes/productRoutes.js`)
- [ ] Create router with `express.Router()`
- [ ] Add `{ mergeParams: true }` only if it's a nested route
- [ ] Apply `authController.protect` and `authController.restrictTo` where needed
- [ ] Keep public routes before `router.use(authController.protect)`

**Step 4 — Register in `app.js`**
- [ ] `const productRouter = require('./routes/productRoutes')`
- [ ] `app.use('/api/v1/products', productRouter)`
- [ ] Add any new filterable fields to the HPP whitelist

**Step 5 — Verify**
- [ ] `node --check` on all new files
- [ ] Test each endpoint manually or with a test script
- [ ] Confirm response shape matches the envelope defined in Section 9
