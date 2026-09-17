/**
 * ============================================================================
 * APIFeatures — turns URL query strings into Mongoose queries
 * ============================================================================
 *
 * WHAT IT DOES, IN ONE SENTENCE
 * -----------------------------
 * It lets a client shape the response purely from the URL:
 *
 *   /api/v1/tours?difficulty=easy&price[lt]=1500&sort=-price&fields=name,price&page=2&limit=10
 *   \____________________________/ \__________/ \_________/ \______________/
 *          filter()                    sort()    limitFields()   paginate()
 *
 * THE KEY IDEA: LAZY QUERIES
 * --------------------------
 * A Mongoose query is NOT executed when you build it. `Tour.find()` returns a
 * Query *object* — think of it as a shopping list, not the shopping trip. You
 * can keep adding to that list (`.sort()`, `.select()`, `.skip()`), and Mongo
 * is only contacted when you finally `await` it.
 *
 * That is what makes this class possible: we store the half-built query on
 * `this.query`, each method adds one more instruction to it, and the caller
 * awaits it at the very end:
 *
 *   const features = new APIFeatures(Tour.find(), req.query)
 *     .filter().sort().limitFields().paginate();
 *   const tours = await features.query;   // <-- the DB is hit HERE, once
 *
 * WHY DOES EVERY METHOD `return this`?
 * ------------------------------------
 * `this` is the APIFeatures instance. Returning it means the next method can be
 * called directly on the result — that is "method chaining" (the same trick
 * jQuery and Mongoose itself use). Without `return this`, `.filter()` would
 * return `undefined` and `.sort()` would crash with
 * "Cannot read properties of undefined".
 */
class APIFeatures {
  /**
   * @param {mongoose.Query} query       An un-awaited query, e.g. `Tour.find()`
   * @param {object}         queryString `req.query` — Express's parsed URL query
   */
  constructor(query, queryString) {
    this.query = query;
    this.queryString = queryString;
  }

  /**
   * ---------------------------------------------------------------------------
   * 1) FILTERING — ?difficulty=easy&duration[gte]=5
   * ---------------------------------------------------------------------------
   *
   * Two jobs here.
   *
   * JOB A: remove the query params that are NOT filters.
   * `page`, `sort`, `limit`, `fields` control *presentation*, not *which*
   * documents we want. If we left them in, Mongo would search for a tour whose
   * `sort` field equals "-price" and find nothing.
   *
   * We copy with `{ ...this.queryString }` first. Why? Because `delete` mutates
   * the object, and `this.queryString` IS `req.query`. Deleting from it would
   * break any later middleware that expects those params to still be there.
   * (Note: this is a SHALLOW copy — enough here, since we only delete
   * top-level keys.)
   *
   * JOB B: translate URL operators into MongoDB operators.
   * Express parses `?duration[gte]=5` into `{ duration: { gte: '5' } }`.
   * MongoDB wants `{ duration: { $gte: 5 } }` — with a dollar sign.
   *
   * The classic trick is stringify → regex-replace → parse:
   *
   *   JSON.stringify({duration:{gte:'5'}})  →  '{"duration":{"gte":"5"}}'
   *   .replace(/\b(gte|gt|lte|lt)\b/g, ...) →  '{"duration":{"$gte":"5"}}'
   *   JSON.parse(...)                       →  { duration: { $gte: '5' } }
   *
   * `\b` means "word boundary", so `gt` inside a word like "budget" is not
   * touched. `/g` = replace every occurrence, not just the first.
   *
   * ⚠️ WHY WE DON'T USE THAT TRICK HERE — AND WHY IT MATTERS
   * The stringify/replace approach rewrites *values* too, not just keys. A
   * search like `?name[regex]=gte` or a tour literally named "gte" would get
   * silently corrupted into "$gte". It also happily forwards ANY operator the
   * client invents — including dangerous ones like `$where` (server-side JS
   * execution) or `$ne` used for auth bypass.
   *
   * So instead we walk the object ourselves and allow only a known safe list of
   * operators. This is both correct AND a real security improvement: an
   * allow-list can never be tricked into passing something we didn't approve.
   * Anything not on the list is dropped.
   */
  filter() {
    // --- JOB A: strip the non-filter params -----------------------------
    const queryObj = { ...this.queryString };
    const excludedFields = ['page', 'sort', 'limit', 'fields'];
    excludedFields.forEach((el) => delete queryObj[el]);

    // --- JOB B: translate operators, safely -----------------------------
    // Only these comparison operators may come from the URL. Note that
    // $ne / $nin / $where are deliberately NOT here: `?role[ne]=admin` is a
    // well-known NoSQL-injection pattern for slipping past filters.
    const ALLOWED_OPERATORS = ['gte', 'gt', 'lte', 'lt', 'in', 'nin'];

    const mongoFilter = {};

    Object.entries(queryObj).forEach(([field, value]) => {
      // Case 1: a plain equality filter, e.g. ?difficulty=easy
      // (`typeof null === 'object'`, hence the extra null check.)
      if (value === null || typeof value !== 'object') {
        mongoFilter[field] = value;
        return;
      }

      // Case 2: an operator object, e.g. ?price[gte]=500 → { gte: '500' }
      const operators = {};
      Object.entries(value).forEach(([op, opValue]) => {
        if (!ALLOWED_OPERATORS.includes(op)) return; // silently ignore
        // `$in`/`$nin` expect an array: ?difficulty[in]=easy&difficulty[in]=hard
        // Express may give us a single string if only one value was sent, so we
        // normalise it into an array.
        if (op === 'in' || op === 'nin') {
          operators[`$${op}`] = Array.isArray(opValue) ? opValue : [opValue];
        } else {
          operators[`$${op}`] = opValue;
        }
      });

      // Only add the field if at least one operator survived the allow-list.
      if (Object.keys(operators).length > 0) mongoFilter[field] = operators;
    });

    // Mongoose casts the strings for us: because `price` is a Number in the
    // schema, the string '500' becomes the number 500 automatically. That is
    // why we don't convert types by hand here.
    this.query = this.query.find(mongoFilter);

    return this;
  }

  /**
   * ---------------------------------------------------------------------------
   * 2) SORTING — ?sort=-price,ratingsAverage
   * ---------------------------------------------------------------------------
   * URL format:    -price,ratingsAverage      (comma separated)
   * Mongoose wants: '-price ratingsAverage'   (space separated)
   * A leading `-` means DESCENDING (high → low); no `-` means ascending.
   *
   * Multiple fields act as tie-breakers: sort by price first, and whenever two
   * tours have the same price, order those by ratingsAverage.
   *
   * IMPROVEMENT over the original: the fallback used to be `-createdAt`, but
   * the Tour schema has no `createdAt` field, so Mongo was sorting on a field
   * that doesn't exist — effectively random, unstable order across pages
   * (the same tour could appear on page 1 AND page 2). We now fall back to
   * `-_id`, which always exists and is monotonically increasing, so pagination
   * is stable and predictable.
   */
  sort() {
    if (this.queryString.sort) {
      const sortBy = this.queryString.sort.split(',').join(' ');
      this.query = this.query.sort(sortBy);
    } else {
      this.query = this.query.sort('-_id');
    }

    return this;
  }

  /**
   * ---------------------------------------------------------------------------
   * 3) FIELD LIMITING / PROJECTION — ?fields=name,price
   * ---------------------------------------------------------------------------
   * Send back only the fields the client asked for. This is a real performance
   * win: less data read from disk, less JSON serialised, less bandwidth. It is
   * called a "projection" in database language.
   *
   * Same comma → space conversion as sorting.
   *
   * The default `-select('-__v')` hides `__v`, Mongoose's internal document
   * version counter. It is used for tracking array updates and is useless to
   * API clients, so we always strip it.
   *
   * ONE RULE TO REMEMBER: you cannot mix inclusion and exclusion in the same
   * projection. `select('name -price')` throws. It's either "only these" or
   * "everything except these".
   */
  limitFields() {
    if (this.queryString.fields) {
      const fields = this.queryString.fields.split(',').join(' ');
      this.query = this.query.select(fields);
    } else {
      this.query = this.query.select('-__v');
    }

    return this;
  }

  /**
   * ---------------------------------------------------------------------------
   * 4) PAGINATION — ?page=2&limit=10
   * ---------------------------------------------------------------------------
   * `skip(n)`  = ignore the first n documents
   * `limit(n)` = return at most n documents
   *
   * The formula: to show page 2 with 10 per page, skip (2-1)*10 = 10 documents.
   *
   * `this.queryString.page * 1` is a quick string→number conversion, because
   * everything in a URL is a string. Multiplying by 1 coerces '2' into 2.
   * `|| 1` supplies the default when `page` is missing (undefined * 1 = NaN,
   * and NaN is falsy, so `|| 1` kicks in). `Number()` would be clearer, but
   * `* 1` is the idiom you will see in most Node tutorials.
   *
   * ⚠️ THE BUG TO WATCH FOR (it was in the commented-out code at the bottom of
   * the original file): `const skip = page - 1 * limit`. Operator precedence
   * means `*` runs first, so that computes `page - (1 * limit)` — completely
   * wrong. The parentheses in `(page - 1) * limit` are essential.
   *
   * IMPROVEMENT: we now clamp the values. Without this, `?limit=1000000` lets
   * one request try to load the whole collection into memory (a cheap
   * denial-of-service), and `?page=-5` produces a negative skip, which Mongo
   * rejects with a confusing error. We also floor the numbers so `?page=1.7`
   * doesn't reach Mongo as a decimal.
   */
  paginate() {
    const MAX_LIMIT = 100; // hard ceiling, whatever the client asks for

    // Math.max(1, ...) guarantees at least page 1 / at least 1 result.
    const page = Math.max(1, Math.floor(this.queryString.page * 1) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.floor(this.queryString.limit * 1) || 100),
    );
    const skip = (page - 1) * limit;

    this.query = this.query.skip(skip).limit(limit);

    // Stored so the controller can echo them back to the client. Handy for the
    // front-end to know which page it is actually looking at.
    this.page = page;
    this.limit = limit;

    return this;
  }
}

module.exports = APIFeatures;
