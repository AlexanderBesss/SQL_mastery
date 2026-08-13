# Common Patterns

## Q1: How do you implement soft deletes in Node.js?

**Answer:** Add an is_deleted or deleted_at column instead of physically deleting rows.

```sql
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX idx_users_deleted ON users (created_at) WHERE deleted_at IS NULL;
```

```javascript
// Soft delete
await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [userId]);

// Query only active users
const { rows } = await pool.query(
  'SELECT * FROM users WHERE deleted_at IS NULL AND email = $1',
  [email]
);

// With Sequelize — `paranoid` mode does soft deletes natively
const User = sequelize.define('User', { /* ... */ }, {
  paranoid: true,
  deletedAt: 'deleted_at',
});
await user.destroy();               // sets deleted_at
await User.findAll();               // excludes soft-deleted rows
await User.findAll({ paranoid: false }); // includes them
```

Note that `addScope('default', ...)` does **not** work — Sequelize reserves that name and throws. The default scope is declared in the model options as `defaultScope`, or you use `paranoid: true` as above.

**Key point:** Always add a partial index on active rows to avoid scanning deleted data.

**The part people miss — unique constraints break.** If `users.email` is `UNIQUE`, a soft-deleted user permanently blocks that address from being reused. Fix with a partial unique index:

```sql
-- Uniqueness applies only among live rows
CREATE UNIQUE INDEX idx_users_email_active ON users (email) WHERE deleted_at IS NULL;
```

**And foreign keys don't understand soft deletes.** `ON DELETE CASCADE` never fires, so soft-deleting a user leaves their orders pointing at a "deleted" row. You must cascade manually, and every join in the codebase needs the `deleted_at IS NULL` filter — forgetting it in one place leaks deleted data.

Given that cost, consider the alternatives: move rows to an archive table, or use an audit/history table (see `schema_design/07_temporal.md`). Soft delete is a good default only when undelete is a real product requirement.

---

## Q2: How do you implement a retry mechanism for database operations?

**Answer:**

```javascript
async function withRetry(fn, maxRetries = 3, baseDelay = 100) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === maxRetries) throw err;

      const delay = Math.random() * baseDelay * Math.pow(2, attempt - 1);
      console.warn(`Retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Match on SQLSTATE, not message text — messages are localized by the server's
// lc_messages setting and change between PostgreSQL versions.
const RETRYABLE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P03', // cannot_connect_now
  '08006', // connection_failure
]);

function isRetryable(err) {
  return RETRYABLE_CODES.has(err.code) || err.code === 'ECONNREFUSED';
}

// Usage
const user = await withRetry(() => pool.query('SELECT * FROM users WHERE id = $1', [id]));
```

**Two things to get right:**

- **Check retryability before the attempt count.** Retrying a unique-violation three times just delays a guaranteed failure by 700ms.
- **Only retry idempotent operations.** A `SELECT` is always safe. A bare `INSERT` is not: if the connection dropped *after* the server committed, retrying inserts a duplicate. Retry whole transactions rather than individual statements, so a failed attempt leaves nothing behind — or use an idempotency key with `ON CONFLICT DO NOTHING`.

---

## Q3: How do you handle database migrations in a deployment pipeline?

**Answer:**

```yaml
# GitHub Actions example
name: Deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run migrations
        run: npx knex migrate:latest
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
      - name: Deploy application
        run: ./deploy.sh
```

**Rules:**
1. Run migrations BEFORE deploying new code (for additive changes)
2. For breaking changes, use the expand/contract pattern (see `03_orms_and_query_builders.md` Q6)
3. Always test migrations against a copy of production data — a migration that takes 200ms on your 1000-row dev DB can take 40 minutes on 50M rows
4. Keep migrations backward compatible: the previous version of the app must keep working against the new schema, because that's the state during a rolling deploy and after a rollback
5. **Never run migrations from application startup.** With N replicas booting simultaneously you get N concurrent migration runs. Knex takes an advisory lock so they serialize rather than corrupt, but every replica then blocks on boot and a failure mid-migration leaves a partially deployed fleet. Run them as a separate, single-instance CI step (as above) or a Kubernetes `Job`/init container guarded to one pod.
6. Migrations run with a **different, higher-privileged DB role** than the app (see `02_sql_injection_and_security.md` Q7)

**Rollbacks are the hard part.** `down` migrations are useful in development, but rolling back in production usually means data loss — a `down` that drops a column throws away everything written since deploy. In practice, mature teams roll *forward*: keep every migration additive and backward compatible so a bad deploy is fixed by reverting the **code**, leaving the schema alone.

---

## Q4: How do you seed a database with realistic test data?

**Answer:**

```javascript
// Using faker library
const { faker } = require('@faker-js/faker');

exports.seed = async function (knex) {
  // Truncate children first (or use CASCADE) — plain DELETE fails on FK references
  await knex.raw('TRUNCATE TABLE orders, users RESTART IDENTITY CASCADE');

  // Deterministic output: same data every run, so tests are reproducible
  faker.seed(12345);

  const users = Array.from({ length: 100 }, () => ({
    email: faker.internet.email(),
    name: faker.person.fullName(),
    created_at: faker.date.past(),
  }));

  // RETURNING gives us the generated ids to build the FK relationship
  const inserted = await knex('users').insert(users).returning('id');

  // Build ALL orders first, then insert once — not one INSERT per user
  const orders = inserted.flatMap(({ id }) =>
    Array.from({ length: faker.number.int({ min: 1, max: 10 }) }, () => ({
      user_id: id,
      total: faker.number.float({ min: 10, max: 500, fractionDigits: 2 }),
      status: faker.helpers.arrayElement(['pending', 'shipped', 'delivered']),
      created_at: faker.date.past(),
    }))
  );

  await knex.batchInsert('orders', orders, 500); // chunks to stay under param limits
};
```

Note `faker.number.int({ min, max })` — it takes an options object, not an array. And seeding related data by a natural key like `user_email` instead of the real FK is a common seed-script smell; use `.returning('id')`.

---

## Q5: How do you implement caching with database queries?

**Answer:**

```javascript
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

async function getUserWithCache(userId) {
  const cacheKey = `user:${userId}`;

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Database query
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];

  // Cache the miss too (as null) so repeated lookups of a nonexistent id
  // don't hit the DB every time — this defends against cache PENETRATION.
  cache.set(cacheKey, user ?? null, user ? 300 : 30);
  return user;
}

// Invalidate cache on update
async function updateUser(userId, data) {
  await pool.query('UPDATE users SET email = $1 WHERE id = $2', [data.email, userId]);
  cache.del(`user:${userId}`); // invalidate AFTER the write commits, never before
}
```

**Three failure modes, often confused with each other:**

| Problem | What happens | Fix |
|---|---|---|
| **Penetration** | Requests for keys that don't exist bypass the cache entirely, every time | Cache the negative result (above), with a short TTL |
| **Stampede / dogpile** | A hot key expires; 1,000 concurrent requests all miss and hit the DB at once | Lock/single-flight so one request refills while others wait; or refresh early in the background |
| **Avalanche** | Many keys expire simultaneously (e.g. all warmed at deploy) | Jitter the TTLs: `stdTTL + Math.random() * 60` |

Single-flight is the one worth being able to sketch — it's just deduplicating in-flight promises:

```javascript
const inFlight = new Map();

async function getUserCoalesced(userId) {
  const key = `user:${userId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (inFlight.has(key)) return inFlight.get(key); // join the existing fetch

  const promise = (async () => {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    cache.set(key, rows[0] ?? null);
    return rows[0];
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}
```

**Cache strategies:**
- **Cache-aside (lazy loading):** app checks cache, falls back to DB, populates. Most common; tolerates cache failure.
- **Write-through:** write to cache and DB together — cache always fresh, writes slower.
- **Write-behind:** write to cache, flush to DB asynchronously — fast, risks data loss.

**Note on `node-cache`:** it's per-process. With multiple instances each has its own copy, so an invalidation on instance A leaves stale data on B. Use Redis once you have more than one replica.

**Invalidation ordering matters:** delete the cache *after* the DB write commits. If you delete first, a concurrent read can repopulate the cache with the old value before your write lands.

---

## Q6: How do you batch insert large amounts of data?

**Answer:**

```javascript
// ❌ Slow — one query per row
for (const item of items) {
  await pool.query('INSERT INTO events (type, data) VALUES ($1, $2)', [item.type, item.data]);
}

// ✅ Fast — multi-row VALUES. Must CHUNK: PostgreSQL's wire protocol caps a
//    statement at 65535 bind parameters, so with 2 columns the ceiling is
//    32767 rows. Exceeding it fails with "bind message has N parameter formats".
const CHUNK = 1000;
for (let c = 0; c < items.length; c += CHUNK) {
  const batch = items.slice(c, c + CHUNK);
  const values = batch.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`);
  await pool.query(
    `INSERT INTO events (type, data) VALUES ${values.join(', ')}`,
    batch.flatMap(item => [item.type, item.data])
  );
}

// ✅ Cleaner — UNNEST takes arrays, so it's ONE parameter per column
//    regardless of row count. No chunking math, no giant SQL string.
await pool.query(
  `INSERT INTO events (type, data)
   SELECT * FROM UNNEST($1::text[], $2::jsonb[])`,
  [items.map(i => i.type), items.map(i => JSON.stringify(i.data))]
);

// ✅ With knex — batchInsert handles chunking for you
await knex.batchInsert('events', items, 1000);

// ✅ Fastest for very large datasets (100k+ rows) — COPY
const { from: copyFrom } = require('pg-copy-streams');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const client = await pool.connect();
try {
  const stream = client.query(copyFrom('COPY events (type, data) FROM STDIN'));
  const rows = Readable.from(items.map(i => `${escapeCopy(i.type)}\t${escapeCopy(i.data)}\n`));
  await pipeline(rows, stream);
} finally {
  client.release();
}

// COPY text format is tab/newline delimited — values containing those must be
// escaped or the row structure breaks (and \N means NULL).
function escapeCopy(v) {
  if (v == null) return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
```

**Rough ordering:** one-INSERT-per-row ≪ multi-row VALUES (~10-50x faster) < `COPY` (another ~2-5x). The reason is round trips: each `await` in a loop costs a full network round trip, so 10,000 inserts is 10,000 sequential round trips regardless of how fast the DB is.

**Other levers for bulk loads:** wrap the batch in a single transaction (otherwise each statement is its own commit and `fsync`), and for a one-time load consider dropping non-essential indexes first and rebuilding after.

---

## Q7: How do you implement a rate limiter using the database?

**Answer:**

```sql
CREATE TABLE rate_limits (
  key VARCHAR(255) PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL
);
```

The whole thing collapses into a **single atomic statement** — no explicit transaction, no `FOR UPDATE`, no read-then-write race:

```javascript
async function checkRateLimit(key, maxRequests, windowMs) {
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (key, count, window_start)
     VALUES ($1, 1, NOW())
     ON CONFLICT (key) DO UPDATE SET
       -- If the stored window has expired, start a new one; else increment.
       count = CASE
         WHEN rate_limits.window_start < NOW() - ($2::int * INTERVAL '1 millisecond')
         THEN 1
         ELSE rate_limits.count + 1
       END,
       window_start = CASE
         WHEN rate_limits.window_start < NOW() - ($2::int * INTERVAL '1 millisecond')
         THEN NOW()
         ELSE rate_limits.window_start
       END
     RETURNING count, window_start`,
    [key, windowMs]
  );

  const { count, window_start } = rows[0];
  const resetAt = new Date(window_start.getTime() + windowMs);

  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    retryAfter: count > maxRequests ? Math.ceil((resetAt - Date.now()) / 1000) : 0,
  };
}
```

**Three bugs the naive read-then-write version has** — worth knowing because they're easy to write and hard to see:

1. **No `COMMIT`.** A `BEGIN` followed by `release()` with no commit means `pg` issues a rollback when returning the client to the pool, so the counter never increments and the limiter allows everything.
2. **`Date + number` is string concatenation** in JavaScript. `record.window_start + windowMs` produces `"Mon Jul 31 2026 ...60000"`, and subtracting a Date from that gives `NaN`. Use `.getTime()`.
3. **`SELECT ... FOR UPDATE` locks nothing when the row doesn't exist**, so first-request-for-a-key still races. `INSERT ... ON CONFLICT` is what actually serializes it.

**Key point:** Prefer one atomic statement over read-then-write whenever you can express it. The DB serializes it for you, there's no lock to hold, and it's one round trip instead of three.

**Caveats:**
- This is a **fixed window**, so it allows up to 2× the limit across a boundary (all requests at 0:59, all again at 1:01). A sliding window log or token bucket smooths that out.
- The table gets one row per key forever — sweep expired rows periodically.
- **Every rate-limit check is a write**, which means WAL, replication traffic, and dead tuples on your primary DB. Fine at modest scale; at high traffic use Redis, which is designed for this.
