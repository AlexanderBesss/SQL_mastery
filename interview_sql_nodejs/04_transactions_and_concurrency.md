# Transactions and Concurrency

## Q1: How do you handle transactions in Node.js with PostgreSQL?

**Answer:** Transactions ensure multiple queries succeed or fail together (atomicity).

```javascript
// Raw pg — manual transaction
async function transferMoney(fromId, toId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromId]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toId]);
    await client.query('COMMIT');
  } catch (err) {
    // .catch() guard: if the connection itself died, ROLLBACK throws too and
    // would mask the original error.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// With knex — built-in transaction API
async function transferMoney(fromId, toId, amount) {
  await knex.transaction(async (trx) => {
    await trx('accounts').where('id', fromId).decrement('balance', amount);
    await trx('accounts').where('id', toId).increment('balance', amount);
  });
}

// With Prisma
async function transferMoney(fromId, toId, amount) {
  await prisma.$transaction([
    prisma.account.update({ where: { id: fromId }, data: { balance: { decrement: amount } } }),
    prisma.account.update({ where: { id: toId }, data: { balance: { increment: amount } } }),
  ]);
}
```

**Key point:** Always use try/catch/finally with raw pg. ORM/Knex transaction helpers handle rollback automatically.

**The single most important rule:** a transaction must run on **one connection**. Using `pool.query()` for the statements inside a transaction is the classic bug — each call may check out a *different* connection, so your `BEGIN` lands on one connection and the `UPDATE` on another, which runs in autocommit and is never rolled back:

```javascript
// ❌ Silently broken — no transaction at all
await pool.query('BEGIN');
await pool.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromId]);
await pool.query('COMMIT');
```

A reusable wrapper is worth writing once:

```javascript
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

await withTransaction(async (client) => {
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromId]);
  await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toId]);
});
```

**On the Prisma example:** the array form of `$transaction` only accepts independent queries — you cannot read a value and use it in a later statement. When you need that, use the interactive form:

```javascript
await prisma.$transaction(async (tx) => {
  const from = await tx.account.findUnique({ where: { id: fromId } });
  if (from.balance < amount) throw new Error('Insufficient funds');
  await tx.account.update({ where: { id: fromId }, data: { balance: { decrement: amount } } });
  await tx.account.update({ where: { id: toId }, data: { balance: { increment: amount } } });
});
```

---

## Q2: What are the ACID properties?

**Answer:**

| Property | Meaning | Example |
|---|---|---|
| **A**tomicity | All or nothing | Transfer: both debits/credits succeed or neither |
| **C**onsistency | DB stays valid | Balance never goes negative (CHECK constraint) |
| **I**solation | Concurrent txns do not interfere | Two transfers from same account handled correctly |
| **D**urability | Committed data survives crash | WAL ensures data on disk |

---

## Q3: What are the isolation levels and when do you use each?

**Answer:**

The SQL standard defines four levels by which anomalies they *permit*:

| Level | Dirty Read | Non-repeatable Read | Phantom Read |
|---|---|---|---|
| Read Uncommitted | Allowed | Allowed | Allowed |
| Read Committed | Prevented | Allowed | Allowed |
| Repeatable Read | Prevented | Prevented | Allowed |
| Serializable | Prevented | Prevented | Prevented |

- **Dirty read:** Reading uncommitted data from another transaction
- **Non-repeatable read:** Re-reading the same row gives different values
- **Phantom read:** Re-running the same query returns a different *set* of rows

**What PostgreSQL actually does** — and this is the detail interviewers probe:

| Level | PostgreSQL behavior | Use case |
|---|---|---|
| Read Uncommitted | **Behaves as Read Committed.** PG never allows dirty reads. | n/a |
| **Read Committed** (default) | Each *statement* sees a fresh snapshot | Default, most apps |
| **Repeatable Read** | Snapshot isolation — one snapshot for the whole txn. **Also prevents phantom reads**, unlike the standard. Can fail with `40001`. | Reports, multi-query consistency |
| **Serializable** | Repeatable Read + Serializable Snapshot Isolation (SSI) — detects true serialization anomalies (e.g. write skew) | Critical invariants |

Two consequences worth stating out loud:

- PG's Repeatable Read is stricter than the standard requires. The one thing it does *not* catch is **write skew**: two transactions each read a set, check an invariant, and write disjoint rows — both commit, invariant broken (classic case: "at least one doctor must stay on call", both resign simultaneously). Only Serializable catches that.
- **Above Read Committed, transactions can fail and must be retried.** Repeatable Read and Serializable abort with SQLSTATE `40001` (`could not serialize access`). This isn't an error condition you log — it's the normal contract:

```javascript
async function inSerializable(fn, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code !== '40001' || i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.random() * 50 * 2 ** i));
    } finally {
      client.release();
    }
  }
}
```

**Key point:** Read Committed is sufficient for most apps. Raise the level only for a specific anomaly you can name — and when you do, ship the retry loop with it, or you've traded a rare wrong answer for a frequent 500.

---

## Q4: What is a deadlock and how do you prevent it?

**Answer:** A deadlock occurs when two transactions each hold a lock the other needs.

```
Transaction A: LOCK row 1, then waits for row 2
Transaction B: LOCK row 2, then waits for row 1
Result: Neither can proceed, DB aborts one
```

**Prevention:**
1. Always lock rows in the same order (e.g., by ID ascending)
2. Keep transactions short
3. Use consistent locking strategy

```javascript
// Safe approach — every transaction locks in the same (ascending ID) order,
// so a cycle can never form. Must be inside a transaction: locks are held
// until COMMIT/ROLLBACK, so `pool.query` here would release them immediately.
await client.query('BEGIN');
const ids = [fromId, toId].sort((a, b) => a - b);
await client.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
// ... now do the updates in any order
await client.query('COMMIT');
```

A single `ORDER BY id ... FOR UPDATE` is better than a loop: it's one round trip, and PostgreSQL locks rows in the order the query returns them.

When a deadlock occurs, PostgreSQL detects the cycle (after `deadlock_timeout`, default 1s) and aborts one transaction with SQLSTATE **`40P01`**, message `deadlock detected`. The other proceeds. Since the victim is chosen arbitrarily, **retry is mandatory** — see the retry helper in Q3, matching on `40P01`.

**Debugging:** the PostgreSQL log records both queries involved in the cycle. Check `pg_stat_activity` for `wait_event_type = 'Lock'` to catch contention before it deadlocks.

---

## Q5: What is optimistic locking and when do you use it?

**Answer:** Optimistic locking assumes conflicts are rare. Uses a version column instead of database locks.

```sql
ALTER TABLE posts ADD COLUMN version INT NOT NULL DEFAULT 0;
```

```javascript
// User A saves: version 3 -> 4 (success)
await pool.query(
  'UPDATE posts SET title = $1, version = version + 1 WHERE id = $2 AND version = $3',
  ['New Title', postId, 3]
);

// User B saves: version is now 4, not 3 — affects 0 rows (conflict detected)
const { rowCount } = await pool.query(
  'UPDATE posts SET title = $1, version = version + 1 WHERE id = $2 AND version = $3',
  ['Other Title', postId, 3]
);
if (rowCount === 0) throw new Error('Conflict: post was modified by another user');
```

**Use when:** Read-heavy apps, rare conflicts, collaborative editing.
**Do not use when:** High-conflict scenarios, financial transactions.

---

## Q6: What is SELECT FOR UPDATE and when do you use it?

**Answer:** SELECT FOR UPDATE locks selected rows for the current transaction (pessimistic locking).

```javascript
// Reserve inventory for an order
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    'SELECT * FROM products WHERE id = $1 AND stock > 0 FOR UPDATE',
    [productId]
  );
  if (rows.length === 0) throw new Error('Out of stock');
  await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [quantity, productId]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

**Variations:**
- `FOR UPDATE` — exclusive lock, blocks others
- `FOR SHARE` — shared lock, allows other shared locks
- `SKIP LOCKED` — skips locked rows (job queue pattern)

```javascript
// ❌ BROKEN job queue — pool.query() runs in autocommit, so the transaction ends
//    the instant the SELECT returns and every lock is released. Two workers
//    polling at the same moment both get the same jobs.
const { rows } = await pool.query(
  'SELECT * FROM jobs WHERE status = $1 ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED',
  ['pending']
);
```

`FOR UPDATE` is only meaningful inside an explicit transaction — locks live until COMMIT or ROLLBACK. Two correct versions:

```javascript
// ✅ Claim and process inside one transaction (lock held for the whole job)
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(`
    SELECT * FROM jobs
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  `);
  for (const job of rows) {
    await handle(job);
    await client.query('UPDATE jobs SET status = $1 WHERE id = $2', ['done', job.id]);
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
}
```

```sql
-- ✅ Better for slow jobs: claim atomically in ONE statement, then release the
-- connection and process outside any transaction. No long-held locks.
UPDATE jobs SET status = 'processing', claimed_at = NOW(), claimed_by = $1
WHERE id IN (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

The second form is the standard "PostgreSQL as a job queue" pattern. Because the claim commits immediately, a worker that crashes leaves rows stuck in `processing` — pair it with a reaper that resets rows whose `claimed_at` is older than some timeout.

**Note on ordering:** PostgreSQL skips locked tuples before satisfying `LIMIT`, so it keeps scanning until it finds the requested number of unlocked rows or exhausts the eligible rows. A short batch therefore means fewer than `LIMIT` unlocked matches were available at that moment.

---

## Q7: How do you handle long-running transactions in Node.js?

**Answer:** Keep transactions short. Long transactions hold locks, consume resources, and increase deadlock risk.

```javascript
// BAD — external API call inside transaction
async function badProcessOrder(orderId) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('UPDATE inventory SET stock = stock - 1 WHERE product_id = $1', [prodId]);
  const charge = await stripe.charges.create({ amount: 1000 }); // SLOW — holds lock!
  await client.query('INSERT INTO orders ...');
  await client.query('COMMIT');
  client.release();
}

// GOOD — external calls outside transaction
async function goodProcessOrder(orderId) {
  const charge = await stripe.charges.create({ amount: 1000 }); // Do this FIRST
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE inventory SET stock = stock - 1 WHERE product_id = $1', [prodId]);
    await client.query('INSERT INTO orders (stripe_charge_id) VALUES ($1)', [charge.id]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
```

**Key point:** Never do external API calls, file I/O, or user notifications inside a transaction. A transaction holds row locks, pins a connection, and (on the DB side) holds back `xmin`, which prevents VACUUM from cleaning dead tuples database-wide.

**Follow-up the interviewer will ask:** the "GOOD" version still isn't correct — if the `INSERT` fails after Stripe succeeded, the customer is charged with no order. You cannot make an external API and a database atomic. The standard answers:

- **Idempotency keys.** Send one to Stripe so a retry can't double-charge, and store it with a unique constraint so a retried request maps to the same order.
- **Transactional outbox.** Commit the order and a row in an `outbox` table in the same transaction; a separate worker reads the outbox and calls the external API. The DB write is atomic, the side effect is at-least-once.
- **Two-phase intent.** Insert the order as `pending` first, call Stripe, then update to `paid`. A reconciliation job sweeps up orders stuck in `pending`.

Recognizing that "atomic across a network boundary" is impossible — and reaching for at-least-once delivery plus idempotency — is what the question is really testing.

**Related setting:** `idle_in_transaction_session_timeout` kills sessions that hold a transaction open while doing nothing. Set it (e.g. `30s`) as a backstop against exactly this bug.

---

## Q8: What is savepoint and when do you use it?

**Answer:** Savepoints allow partial rollback within a transaction.

```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');

  // Use RETURNING to get the generated id — one round trip, and unlike
  // currval() it is unambiguous about which row you mean.
  const { rows } = await client.query(
    'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING id',
    [1, 99.99]
  );
  const orderId = rows[0].id;

  await client.query('SAVEPOINT payment');
  try {
    await client.query('INSERT INTO payments (order_id, amount) VALUES ($1, $2)', [orderId, 99.99]);
  } catch (paymentErr) {
    // Roll back only to the savepoint — the order INSERT survives
    await client.query('ROLLBACK TO SAVEPOINT payment');
    await client.query('UPDATE orders SET status = $1 WHERE id = $2', ['payment_failed', orderId]);
  }

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
}
```

**Why the savepoint is required here, not just convenient:** once *any* statement errors inside a PostgreSQL transaction, the whole transaction enters an aborted state and every subsequent statement fails with `current transaction is aborted, commands ignored until end of transaction block`. So you cannot simply catch the payment error and carry on — without `ROLLBACK TO SAVEPOINT`, the follow-up `UPDATE` and the `COMMIT` would both fail. The savepoint is what makes the transaction usable again.

**Use when:** Some operations in a transaction are optional or have fallback behavior.

**Note:** ORMs use savepoints to implement nested transactions. `knex.transaction()` inside another `knex.transaction()` issues `SAVEPOINT`, not a second `BEGIN` — PostgreSQL has no true nested transactions.
