# Connections and Pooling

## Q1: How does a database connection work in Node.js?

**Answer:**
When a Node.js app connects to a database, it establishes a TCP connection to the database server. PostgreSQL forks a **separate OS process per connection**, so each one costs several MB of memory plus a slot against `max_connections` (default: 100).

```javascript
// Single connection (not recommended for production)
const { Client } = require('pg');
const client = new Client({
  host: 'localhost',
  database: 'mydb',
  user: 'user',
  password: 'pass',
});
await client.connect();
const res = await client.query('SELECT * FROM users');
await client.end();
```

**Key point:** A single connection is fine for development but fails under load in production. Use a connection pool instead.

---

## Q2: What is connection pooling and why is it important?

**Answer:**
Connection pooling reuses a set of pre-established connections instead of creating/closing one per request.

**Why it matters:**
- Creating a new DB connection takes 10-100ms (TCP handshake, TLS, auth, backend process fork)
- DB servers have a hard limit (`max_connections`, default 100 — a few slots are reserved for superusers)
- Under load, without pooling, you hit the limit and requests fail with `too many clients already`

```javascript
const { Pool } = require('pg');
const pool = new Pool({
  max: 20,           // max connections in pool
  idleTimeoutMillis: 30000,  // close idle connections after 30s
  connectionTimeoutMillis: 2000, // fail fast if no available connection
});

// Reuse across requests
async function getUser(id) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0];
  } finally {
    client.release(); // returns to pool, does NOT close
  }
}
```

**Key point:** `client.release()` returns the connection to the pool. Always use `try/finally` to ensure release.

**Shortcut:** For a single query you don't need `connect()`/`release()` at all — `pool.query()` checks out a client, runs the query, and releases it for you:

```javascript
const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
```

Only use explicit `pool.connect()` when you need **several queries on the same connection** — transactions, `SET LOCAL`, advisory locks, or `LISTEN`.

---

## Q3: How do you determine the right pool size?

**Answer:**
Size the pool from the **database server's** capacity, not the app server's. The common starting formula (from HikariCP) is:

```
total_connections = (db_cpu_cores * 2) + effective_spindle_count
```

That is the budget for the *whole fleet*. Divide it across instances:

```
pool.max = total_connections / num_app_instances
```

For a 4-core DB on SSD: `(4 * 2) + 1 = 9` total. Running 3 app instances → `max: 3` each.

This surprises people — the instinct is to scale the pool with app traffic. But a connection only does useful work while a query is executing, and the DB can only execute `~num_cores` queries in parallel. Extra connections just queue *inside* the database, where you can't see or control the queue. Queuing in the app's pool is strictly better.

**Factors to adjust:**
- Increase modestly if queries are I/O-bound (connections spend time waiting, not on CPU)
- Decrease if the DB server is shared with other apps
- Leave headroom: `sum(all pool maxes) + migrations + admin tools < max_connections`
- Monitor with `SELECT count(*), state FROM pg_stat_activity GROUP BY state;`

**Key point:** More connections is NOT always better. Beyond the core count, throughput flattens and latency rises from context switching and lock contention.

---

## Q4: What happens when all pool connections are in use?

**Answer:**
New requests wait in a queue until a connection is released. If the wait exceeds `connectionTimeoutMillis`, the request fails with a timeout error.

**Common causes of pool exhaustion:**
- Forgetting `client.release()` (missing `finally` block)
- Long-running queries holding connections
- Connection leaks from unhandled errors
- Pool size too small for the workload

**How to debug:**
```javascript
console.log(pool.totalCount);   // total connections created
console.log(pool.idleCount);    // available in pool
console.log(pool.waitingCount); // requests waiting for a connection
```

---

## Q5: How do you handle database connections in a cluster/multi-worker setup?

**Answer:**
Each Node.js worker process gets its own connection pool. They do NOT share connections.

```javascript
const cluster = require('cluster');
const os = require('os');

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
} else {
  // Each worker creates its OWN pool
  const pool = new Pool({ max: 10 });
  app.get('/users', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users');
    res.json(rows);
  });
}
```

**Key point:** Total DB connections = `pool_size * num_workers`. Size your PostgreSQL `max_connections` accordingly.

---

## Q6: What is the difference between `pg`, `pg-pool`, and ORM connection management?

**Answer:**

| Library | Connection Handling |
|---|---|
| `pg.Client` | Single connection, manual lifecycle |
| `pg.Pool` | Pool of connections, manual acquire/release |
| `pg-pool` | The package `pg.Pool` is re-exported from — you never install it directly |
| `Knex` | Built-in pooling via `tarn`, wraps `pg` |
| `Sequelize` | Built-in pooling via `sequelize-pool` |
| `Prisma` | Pool managed by the Rust query engine (`connection_limit` in the DB URL) |
| `TypeORM` | Built-in pooling, delegates to the underlying `pg` pool |

```javascript
// Knex pooling configuration
const knex = require('knex')({
  client: 'pg',
  connection: { /* ... */ },
  pool: {
    min: 2,
    max: 10,
    acquireTimeoutMillis: 30000,
    createTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
  },
});
```

---

## Q7: How does async/await interact with database queries?

**Answer:**
Node.js is single-threaded but non-blocking. Database queries are I/O operations that don't block the event loop.

```javascript
// Sequential — each query waits for the previous
const user = await pool.query('SELECT * FROM users WHERE id = $1', [1]);
const posts = await pool.query('SELECT * FROM posts WHERE user_id = $1', [1]);

// Parallel — both queries run simultaneously
const [userRes, postsRes] = await Promise.all([
  pool.query('SELECT * FROM users WHERE id = $1', [1]),
  pool.query('SELECT * FROM posts WHERE user_id = $1', [1]),
]);
```

**Key point:** Use `Promise.all()` for independent queries. Each `pool.query()` checks out its own connection, so parallelism is capped by `pool.max` — firing 100 parallel queries at a pool of 10 just queues 90 of them.

**Caveat:** This does NOT apply inside a transaction. A transaction lives on one connection, and a single connection processes queries serially, so `Promise.all` on a `client` gains nothing and interleaves statements unpredictably:

```javascript
// ❌ Do not do this — same connection, no parallelism, confusing failure modes
await Promise.all([
  client.query('UPDATE a ...'),
  client.query('UPDATE b ...'),
]);
```

---

## Q8: How do you handle database connection failures gracefully?

**Answer:**
Implement retry logic with exponential backoff and circuit breaker pattern.

```javascript
// Only these are worth retrying — a constraint violation will fail identically forever
const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P03', // cannot_connect_now (DB starting up)
  '08006', // connection_failure
  '08003', // connection_does_not_exist
]);

function isRetryable(err) {
  return RETRYABLE.has(err.code) || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT';
}

async function queryWithRetry(query, params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await pool.query(query, params);
    } catch (err) {
      if (i === maxRetries - 1 || !isRetryable(err)) throw err;
      // Exponential backoff with full jitter — prevents a thundering herd
      // where every client retries in lockstep after an outage.
      const delay = Math.random() * Math.pow(2, i) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

**Two things interviewers listen for here:**

1. **Classify the error before retrying.** Blindly retrying a unique-constraint violation burns time and hides bugs. `pg` exposes the SQLSTATE on `err.code`.
2. **Only retry idempotent work.** Retrying a bare `INSERT` after a timeout can double-insert — the first attempt may have committed before the connection dropped. Wrap the whole unit in a transaction (so a failed attempt leaves nothing behind), or use an idempotency key with `ON CONFLICT DO NOTHING`.

**Production patterns:**
- Use a health check endpoint that runs `SELECT 1`
- Attach a pool-level error handler — idle clients can fail asynchronously and an unhandled `error` event crashes the process:
  ```javascript
  pool.on('error', (err) => logger.error({ err }, 'idle client error'));
  ```
- Monitor pool metrics (`waitingCount`, `idleCount`)
- Consider PgBouncer as an external pooler for high-traffic or serverless apps (see Q9)

---

## Q9: What is PgBouncer, and when do you need it on top of your app's pool?

**Answer:**
An application pool only pools connections for **one process**. PgBouncer sits between all your app instances and PostgreSQL and pools across them — 500 client connections might map to 20 real backend connections.

You need it when the *number of processes* is the problem, not the pool size:

- **Many app instances.** 50 pods × `max: 10` = 500 connections against a `max_connections` of 100.
- **Serverless / Lambda.** Every cold start opens a fresh connection and the pool never gets reused. This is the classic case where a Node app mysteriously exhausts a database that's barely doing any work.
- **Short-lived processes** — cron jobs, CLI scripts, workers.

**The critical detail is pooling mode:**

| Mode | Connection returned to pool | Safe for |
|---|---|---|
| `session` | On client disconnect | Everything; least pooling benefit |
| `transaction` | On COMMIT/ROLLBACK | Most apps — the usual choice |
| `statement` | After each statement | Autocommit only; no transactions |

**`transaction` mode breaks things you may be relying on**, because consecutive queries are no longer guaranteed to land on the same backend:

- Session-level `SET` (including the RLS pattern from `02_sql_injection_and_security.md` Q5 — use `set_config(..., true)`, which is transaction-scoped)
- `LISTEN`/`NOTIFY`
- Session advisory locks (use the `_xact_` variants)
- Server-side prepared statements — this is why Prisma requires `pgbouncer=true` in the URL and `pg` users often set `statement_cache_size: 0`
- Cursors declared `WITHOUT HOLD`

**Key point:** PgBouncer complements the app pool, it doesn't replace it. Keep a small `pg.Pool` per process to avoid the TCP handshake to PgBouncer, and let PgBouncer manage the scarce PostgreSQL backends. Managed equivalents: RDS Proxy, Supabase's pooler, Neon's pooled endpoint.
