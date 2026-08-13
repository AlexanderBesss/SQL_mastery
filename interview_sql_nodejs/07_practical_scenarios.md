# Practical Scenarios

## Q1: Design a schema for a blog with posts, comments, and tags.

**Answer:**

```sql
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  author_id INT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  title VARCHAR(300) NOT NULL,
  slug VARCHAR(300) UNIQUE NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL
);

CREATE TABLE post_tags (
  post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id INT REFERENCES authors(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  parent_id INT REFERENCES comments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_posts_author ON posts (author_id);
-- Partial index: `status` is constant within it, so keep it OUT of the key
-- columns — indexing it would waste bytes on every entry.
CREATE INDEX idx_posts_published ON posts (published_at DESC) WHERE status = 'published';
CREATE INDEX idx_comments_post ON comments (post_id, created_at);
CREATE INDEX idx_post_tags_tag ON post_tags (tag_id); -- for "all posts with tag X"
```

**Key decisions:**
- `post_tags` as junction table for the M:N relationship. Its PK is `(post_id, tag_id)`, which indexes lookups in that direction only — the reverse lookup needs its own index.
- `comments.parent_id` for nested replies (self-referencing). Note `ON DELETE CASCADE` here means deleting a comment silently removes its entire subtree; use `ON DELETE SET NULL` plus a "[deleted]" placeholder if replies should survive. Query threads with a recursive CTE.
- Partial index on published posts for the homepage query
- `author_id` is nullable on comments with `ON DELETE SET NULL`, so deleting an author preserves their comments as anonymous — deliberately different from posts, which cascade

**Worth raising unprompted:** `SERIAL` is legacy. Prefer `GENERATED ALWAYS AS IDENTITY`, which is the SQL standard and avoids `SERIAL`'s quirks around sequence ownership and permissions:

```sql
id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
```

Use `UUID` instead when ids are exposed publicly (sequential ids leak volume and allow enumeration) or generated client-side. If you do, use UUIDv7 rather than v4 — v4 is random, so inserts scatter across the B-tree and cause page splits; v7 is time-ordered and keeps inserts local.

---

## Q2: How would you design an e-commerce order system?

**Answer:**

```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(300) NOT NULL,
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  total NUMERIC(10, 2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id), -- no CASCADE: never delete order history
  product_name VARCHAR(300) NOT NULL,              -- snapshot, product may be renamed
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 2) NOT NULL,
  UNIQUE (order_id, product_id)
);

CREATE INDEX idx_orders_user ON orders (user_id, created_at DESC);
CREATE INDEX idx_order_items_order ON order_items (order_id);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key decisions:**
- **`order_items` snapshots price and name at order time.** This is the single most important decision here, and the one interviewers are checking for: an order is a historical record, so joining to `products` for the price would silently rewrite past invoices whenever someone edits a product. Same reason `product_id` has no `ON DELETE CASCADE` — deleting a product must never delete order history (use `is_active = false` instead).
- `orders.total` is denormalized from the items on purpose — it must reflect what the customer actually agreed to pay, including discounts, tax, and shipping that don't decompose into line items.
- Separate `payments` table for multiple attempts per order (a failed card then a successful one)
- **`NUMERIC`, never `FLOAT`, for money.** `0.1 + 0.2 !== 0.3` in binary floating point; `NUMERIC` is exact decimal. Note `pg` returns `NUMERIC` as a **JavaScript string** to avoid precision loss — don't `parseFloat` it and do arithmetic; use a decimal library or compute in SQL. Storing integer cents is the other common approach.
- Stock reservation uses `SELECT FOR UPDATE` during checkout (see Q6)

---

## Q3: Design a schema for a multi-tenant SaaS application.

**Answer:**

```sql
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  subdomain VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  plan VARCHAR(20) NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE tenant_users (
  id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(200) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  UNIQUE (tenant_id, email)
);

CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  owner_id INT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE
);

CREATE INDEX idx_projects_tenant ON projects (tenant_id);

-- Row Level Security for defense in depth
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY; -- also applies to the table owner
CREATE POLICY tenant_isolation ON projects
  USING (tenant_id = current_setting('app.tenant_id', true)::INT);
```

**Key decisions:**
- `tenant_id` on every business table, and **indexed** — every query filters on it, and RLS appends that filter automatically
- RLS prevents accidental cross-tenant data leaks. Note the `true` in `current_setting` (returns NULL instead of erroring when unset → policy fails closed) and `FORCE ROW LEVEL SECURITY` (without it, the table owner bypasses every policy). See `02_sql_injection_and_security.md` Q5 for the full set of traps.
- Unique constraints scoped per tenant: `UNIQUE (tenant_id, email)`, not `UNIQUE (email)` — the same person may belong to two tenants
- Composite FKs are worth considering (`FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_users(tenant_id, id)`) so the database itself makes a cross-tenant reference impossible

**The question behind the question** is which isolation model you chose. There are three, and naming the tradeoff matters more than the DDL:

| Model | Isolation | Cost |
|---|---|---|
| **Shared schema** (`tenant_id` column, above) | Weakest — one missing WHERE leaks data | Cheapest; scales to many tenants; migrations run once |
| **Schema per tenant** | Better; accidental cross-tenant queries are impossible | Migrations × N schemas; PG strains past a few thousand |
| **Database per tenant** | Strongest; per-tenant backup/restore, easy compliance story | Most expensive; connection pooling gets hard |

Shared schema plus RLS is the standard default. Move to database-per-tenant when a specific enterprise customer's compliance requirements demand it — hybrids (most tenants shared, a few isolated) are common.

---

## Q4: How would you track user activity and generate analytics?

**Answer:**

```sql
-- Raw events table (append-only)
CREATE TABLE user_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_user ON user_events (user_id, event_type, created_at);
CREATE INDEX idx_events_type ON user_events (event_type, created_at);

-- Materialized view for daily aggregates
CREATE MATERIALIZED VIEW mv_daily_stats AS
SELECT
  date_trunc('day', created_at) as day,
  event_type,
  count(DISTINCT user_id) as unique_users,
  count(*) as total_events
FROM user_events
GROUP BY date_trunc('day', created_at), event_type;

-- UNIQUE index is required for CONCURRENTLY (refresh without blocking readers)
CREATE UNIQUE INDEX idx_mv_daily ON mv_daily_stats (day, event_type);

-- GIN index if you filter on properties, e.g. WHERE properties @> '{"plan":"pro"}'
CREATE INDEX idx_events_props ON user_events USING GIN (properties);
```

**Key decisions:**
- JSONB `properties` for flexible event data — event shapes change constantly and you don't want a migration per new event type
- Append-only table for audit trail
- Materialized view for fast dashboard queries

**The scaling answer they're looking for: partition the events table.** An events table is the classic case — it grows without bound, is almost always queried by time range, and old data is eventually dropped. Declarative range partitioning by month makes each query touch one or two partitions instead of the whole table, and — crucially — retention becomes `DROP TABLE` (instant, no bloat) instead of a `DELETE` of 50M rows (slow, generates enormous WAL, leaves dead tuples for VACUUM).

```sql
CREATE TABLE user_events (
  id BIGSERIAL,
  user_id INT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)  -- partition key MUST be in the PK
) PARTITION BY RANGE (created_at);

CREATE TABLE user_events_2026_07 PARTITION OF user_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Retention: drop a whole month instantly
DROP TABLE user_events_2026_01;
```

Two constraints to mention: the partition key must be part of every unique constraint (hence the composite PK), and you need automation — `pg_partman`, or a cron job — to create next month's partition before rows arrive for it.

**Also worth saying:** at real analytics volume, don't do this in your transactional database at all. Ship events to a columnar store (ClickHouse, BigQuery, Redshift) and keep PostgreSQL for OLTP. Aggregations that scan millions of rows compete with your application's queries for the same buffer cache.

---

## Q5: Design a notification system with multiple channels.

**Answer:**

```sql
CREATE TABLE notification_preferences (
  user_id INT PRIMARY KEY,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sms_enabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE TABLE notification_channels (
  id SERIAL PRIMARY KEY,
  notification_id INT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'push', 'sms')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ
);

CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_unread ON notifications (user_id, created_at DESC) WHERE NOT is_read;
```

**Key decisions:**
- Separate channels table to track delivery per channel, so a failed SMS doesn't lose the successful email
- Partial index on unread for the inbox badge query — usually a tiny fraction of rows, so the index stays small
- Retry/observability columns on `notification_channels` are worth adding: `attempts INT NOT NULL DEFAULT 0`, `last_error TEXT`, `next_attempt_at TIMESTAMPTZ`. That turns the table into a work queue you can drive with `FOR UPDATE SKIP LOCKED` (see `04_transactions_and_concurrency.md` Q6).

**One thing to flag:** `is_read` and `read_at` encode the same fact twice, and they can disagree — a bug that sets one but not the other gives you a row that is unread with a read timestamp. Prefer a single nullable `read_at`, with `WHERE read_at IS NULL` for unread:

```sql
read_at TIMESTAMPTZ,  -- NULL means unread
CREATE INDEX idx_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
```

Redundant state is only worth it when you need the index or query simplicity badly enough to also add a `CHECK ((is_read) = (read_at IS NOT NULL))` to keep them honest.

**Scale note:** `notifications` grows unboundedly like an events table — partition by `created_at` and drop old partitions (see Q4).

---

## Q6: How do you handle concurrent inventory updates (prevent overselling)?

**Answer:**

```javascript
// Approach 1: Pessimistic locking (SELECT FOR UPDATE)
async function reserveStock(productId, quantity) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT stock FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );

    if (!rows[0]) throw new Error('Product not found');   // FOR UPDATE locks nothing
    if (rows[0].stock < quantity) throw new Error('Insufficient stock');

    await client.query(
      'UPDATE products SET stock = stock - $1 WHERE id = $2',
      [quantity, productId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Approach 2 (PREFERRED): conditional atomic update — one statement, no explicit
// transaction, no lock held across round trips.
//
//   ALTER TABLE products ADD CONSTRAINT chk_stock CHECK (stock >= 0);
//
async function reserveStockAtomic(productId, quantity) {
  const { rowCount } = await pool.query(
    'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1',
    [quantity, productId]
  );

  if (rowCount === 0) throw new Error('Insufficient stock');
}
```

**Why approach 2 is better in most cases:** the check and the decrement happen in one statement, so there is no window between them. PostgreSQL takes a row lock for the duration of the `UPDATE` automatically — it's just held for microseconds rather than across application round trips. It's also one query instead of four.

It works because of how Read Committed handles write conflicts: if two transactions update the same row concurrently, the second blocks, then **re-evaluates its WHERE clause against the updated row** before proceeding. So the second `stock >= $1` check sees the already-decremented value. This re-check behavior is specific to `UPDATE`/`DELETE` — a plain `SELECT` would still see the old snapshot.

The `CHECK (stock >= 0)` constraint is a backstop, not the mechanism. It guarantees the invariant even if some other code path forgets the `WHERE` guard.

**Key decisions:**
- Atomic conditional update for nearly everything — simplest and fastest
- `SELECT FOR UPDATE` only when you must **read** a value and act on it in application code before writing (e.g. pricing logic that depends on current stock)
- Never check-then-update across two statements outside a transaction — that's a TOCTOU race
- Note that neither is truly "optimistic locking," which specifically means a version column and a retry (see `04_transactions_and_concurrency.md` Q5)

**In practice, overselling is usually a business problem, not a locking one.** Real systems reserve stock with a TTL at cart/checkout time, so the row lock isn't held while the customer enters their card details:

```sql
CREATE TABLE stock_reservations (
  id BIGSERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  quantity INT NOT NULL CHECK (quantity > 0),
  order_id INT REFERENCES orders(id),
  expires_at TIMESTAMPTZ NOT NULL
);
-- available = products.stock - SUM(active reservations)
-- A sweeper deletes expired rows, returning the stock automatically.
```
