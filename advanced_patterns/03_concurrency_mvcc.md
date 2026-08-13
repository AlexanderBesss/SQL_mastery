# Concurrency, MVCC & Isolation Levels

## Why This Matters

Every time two users touch the same data at the same time, PostgreSQL has to decide what each one sees and whether one blocks the other. Get this wrong and you get silent data corruption, endless waiting, or deadlocks that crash your application. Get it right and your database handles hundreds of concurrent users without them ever knowing the other is there.

This guide covers how PostgreSQL achieves concurrency, how to control it, and what goes wrong when you don't.

---

## 1. MVCC Fundamentals

### The Problem with Traditional Locking

In a traditional locking system, a `SELECT` acquires a shared lock and an `UPDATE` acquires an exclusive lock. They conflict. Readers block writers; writers block readers. At scale, this becomes a bottleneck.

### The MVCC Solution

PostgreSQL uses **Multiversion Concurrency Control**. Instead of locking rows for reads, it keeps multiple versions of each row. Each transaction sees a consistent snapshot of the data as of a point in time. Readers never block writers, and writers never block readers.

```
Traditional Locking:
  Reader ----[SHARED LOCK]----> Row
  Writer ----[EXCLUSIVE LOCK]--> Row    <-- CONFLICT!

MVCC:
  Tx1 sees:  Row v1 (balance = 100)
  Tx2 sees:  Row v2 (balance = 200)
  Both coexist. No conflict.
```

### How It Works at a Glance

Every row version (tuple) carries two system columns:

| Column | Meaning |
|---|---|
| `xmin` | Transaction ID that **created** this version |
| `xmax` | Transaction ID that **deleted** this version (0 = not yet deleted) |

When a transaction issues a `SELECT`, PostgreSQL checks each tuple version against the transaction's snapshot:

- If `xmin` is older than the snapshot and `xmax` is 0 or newer than the snapshot, the row is **visible**.
- Otherwise, the row is **invisible** to this transaction.

```
Timeline of row versions for id = 1:

  tx 100 creates row: balance = 100
  tx 101 updates row: balance = 200
  tx 102 deletes row

  On disk:
  +------+-------+-------+----------+
  | ctid | xmin  | xmax  | balance  |
  +------+-------+-------+----------+
  | (0,1)| 100   | 101   | 100      |  <- version 1 (xmax set by UPDATE in tx 101)
  | (0,2)| 101   | 102   | 200      |  <- version 2 (xmax set by DELETE in tx 102)
  +------+-------+-------+----------+

  Note: DELETE does NOT create a new heap tuple. It sets xmax on the
  existing tuple to the deleting transaction's XID. The tuple remains
  on disk until VACUUM reclaims the space.

  Transaction at snapshot 100.5 sees: version 1 (balance = 100)
  Transaction at snapshot 101.5 sees: version 2 (balance = 200)
  Transaction at snapshot 102.5 sees: nothing (row deleted)
```

### Key Insight

An `UPDATE` in PostgreSQL is actually a **DELETE + INSERT**. It marks the old version as deleted (`xmax` set) and writes a new version with a new `xmin`. The old version remains on disk until `VACUUM` cleans it up.

---

## 2. xmin, xmax, and the Visibility Map

### System Columns You Can Query

PostgreSQL exposes several hidden columns for inspection:

```sql
-- See the internal structure of a table
SELECT ctid, xmin, xmax, xmin IS NOT NULL AS is_visible,
       tableoid, cmax, cmin
FROM accounts
WHERE acctnum = 12345;

-- ctid  = physical location (block, offset) of the tuple
-- xmin  = transaction ID that inserted this version
-- xmax  = transaction ID that deleted this version (0 = still live)
-- cmin  = command ID within xmin that created this version
-- cmax  = command ID within xmax that deleted this version
```

### The Visibility Map

The visibility map is a bitmap structure that tracks which pages contain tuples visible to **all** running transactions. It has two bits per page:

- **All-visible bit**: Every tuple on this page is visible to all transactions.
- **All-frozen bit**: Every tuple on this page has been frozen (see transaction ID wraparound below).

```
Page 0  [all-visible=1, all-frozen=0]  -> VACUUM can skip this page
Page 1  [all-visible=0, all-frozen=0]  -> VACUUM must check this page
Page 2  [all-visible=1, all-frozen=1]  -> VACUUM can skip entirely
```

The visibility map speeds up:
- `VACUUM` (skip pages that need no work)
- Index-only scans (avoid heap fetch when all tuples are visible)
- Bitmap heap scans

---

## 3. The Four Isolation Levels

### Comparison Table

| Isolation Level | Dirty Read | Nonrepeatable Read | Phantom Read | Serialization Anomaly |
|---|---|---|---|---|
| READ UNCOMMITTED | Not possible (PG behavior) | Possible | Possible | Possible |
| READ COMMITTED (default) | Not possible | Possible | Possible | Possible |
| REPEATABLE READ | Not possible | Not possible | Not possible (PG behavior) | Possible |
| SERIALIZABLE | Not possible | Not possible | Not possible | Not possible |

**Important notes:**
- PostgreSQL's `READ UNCOMMITTED` behaves identically to `READ COMMITTED`. There is no way to read uncommitted data.
- PostgreSQL's `REPEATABLE READ` is stricter than the SQL standard requires: it also prevents phantom reads.

### Setting the Isolation Level

```sql
-- Set for a single transaction
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- or
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Set as session default
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- Check current setting
SHOW transaction_isolation;
```

---

## 4. What Each Level Prevents: Practical Examples

### Dirty Read (Prevented by All PG Levels)

A dirty read happens when Transaction A reads data written by Transaction B, and then B rolls back. A has read "dirty" (never-committed) data.

```
-- PostgreSQL never allows this. Even READ UNCOMMITTED blocks it.
-- This is a design decision: MVCC makes dirty reads impossible
-- because a transaction only sees its own uncommitted changes.
```

### Nonrepeatable Read (Prevented by REPEATABLE READ and SERIALIZABLE)

```
-- Session 1 (READ COMMITTED - the default)
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- returns 1000

-- Session 2
BEGIN;
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;

-- Session 1 (same transaction, second query)
SELECT balance FROM accounts WHERE id = 1;  -- returns 500 !!
-- The value changed between reads. This is a nonrepeatable read.

-- In REPEATABLE READ, the second SELECT would still return 1000.
```

**Real-world impact:** A reporting query that reads a total, does some computation, then reads the total again to verify -- gets different numbers at READ COMMITTED.

### Phantom Read (Prevented by REPEATABLE READ and SERIALIZABLE in PG)

```
-- Session 1 (READ COMMITTED)
BEGIN;
SELECT * FROM orders WHERE status = 'pending';  -- returns 3 rows

-- Session 2
BEGIN;
INSERT INTO orders (status, amount) VALUES ('pending', 99.99);
COMMIT;

-- Session 1
SELECT * FROM orders WHERE status = 'pending';  -- returns 4 rows !!
-- A "phantom" row appeared. This is a phantom read.

-- In REPEATABLE READ, the second SELECT would still return 3 rows.
```

**Real-world impact:** A batch processor that counts pending orders, processes them one by one, then checks the count again -- finds more orders than expected.

### Serialization Anomaly (Only Prevented by SERIALIZABLE)

This is the subtlest anomaly. Two transactions read overlapping data, each writes based on what it read, and the final result is inconsistent with any serial ordering.

```
-- Table: accounts (id, balance)
-- Initial state: id=1 balance=1000, id=2 balance=2000

-- Session A (REPEATABLE READ)
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT SUM(balance) FROM accounts WHERE id IN (1, 2);  -- 3000
-- ... decides to create a summary record with total = 3000
INSERT INTO summaries (total) VALUES (3000);

-- Session B (REPEATABLE READ) -- runs concurrently
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
UPDATE accounts SET balance = balance + 100 WHERE id = 1;  -- id=1 is now 1100
COMMIT;

-- Session A continues
INSERT INTO summaries (total) VALUES (3000);  -- based on old data
COMMIT;

-- Result: summaries table has a row with total=3000, but actual sum is 3100.
-- No serial ordering produces this result. This is a serialization anomaly.
-- REPEATABLE READ allows this. SERIALIZABLE would abort one transaction.
```

**With SERIALIZABLE, the above scenario:**

```sql
-- Session A
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT SUM(balance) FROM accounts WHERE id IN (1, 2);
INSERT INTO summaries (total) VALUES (3000);
COMMIT;

-- Session B
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
UPDATE accounts SET balance = balance + 100 WHERE id = 1;
COMMIT;
-- ERROR: could not serialize access due to read/write dependencies among transactions
-- SQLSTATE: 40001
-- Session B is aborted. Application must retry.
```

---

## 5. When to Use Each Isolation Level

| Level | When to Use | Performance Cost |
|---|---|---|
| READ COMMITTED | Default for most applications. Simple reads, simple writes, web requests. | Lowest |
| REPEATABLE READ | Batch processing, reporting, multi-step operations where consistency matters. | Low (no blocking, but may need retries on write conflicts) |
| SERIALIZABLE | Financial calculations, inventory management, any scenario requiring true serial equivalence. | Higher (predicate locking overhead, more retries) |

### Rule of Thumb

Start with READ COMMITTED. Move to REPEATABLE READ when you need stable snapshots across multiple queries. Move to SERIALIZABLE only when you have proven that REPEATABLE READ is insufficient for your consistency requirements.

---

## 6. Lock Types

### Table-Level Lock Modes

All of these are table-level, despite some names containing "row". The names are historical.

| Lock Mode | Blocks | Acquired By |
|---|---|---|
| ACCESS SHARE | ACCESS EXCLUSIVE only | `SELECT` |
| ROW SHARE | EXCLUSIVE, ACCESS EXCLUSIVE | `SELECT FOR UPDATE/SHARE` |
| ROW EXCLUSIVE | SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE | `INSERT`, `UPDATE`, `DELETE`, `MERGE` |
| SHARE UPDATE EXCLUSIVE | Self, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE | `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY` |
| SHARE | ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE | `CREATE INDEX` |
| SHARE ROW EXCLUSIVE | Self, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, EXCLUSIVE, ACCESS EXCLUSIVE | `CREATE TRIGGER`, some `ALTER TABLE` |
| EXCLUSIVE | Everything except ACCESS SHARE | `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| ACCESS EXCLUSIVE | Everything (including itself) | `DROP TABLE`, `TRUNCATE`, `VACUUM FULL`, `ALTER TABLE` |

### Lock Compatibility Matrix

X means the requested lock conflicts with the existing lock:

```
Requested \ Existing   AS   RS   RE   SUE  SH   SRE  EX   AX
ACCESS SHARE           .    .    .    .    .    .    .    X
ROW SHARE              .    .    .    .    .    .    X    X
ROW EXCLUSIVE          .    .    .    .    X    X    X    X
SHARE UPDATE EXCL.     .    .    .    X    X    X    X    X
SHARE                  .    .    X    X    .    X    X    X
SHARE ROW EXCL.        .    .    X    X    X    X    X    X
EXCLUSIVE              .    X    X    X    X    X    X    X
ACCESS EXCLUSIVE       X    X    X    X    X    X    X    X
```

**Key takeaway:** Only `ACCESS EXCLUSIVE` blocks a plain `SELECT`. This is why PostgreSQL can have many concurrent readers.

### Explicit Locking

```sql
-- Lock a table explicitly
LOCK TABLE accounts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE accounts IN SHARE MODE;

-- These are table-level. Use row-level locks for finer granularity.
```

---

## 7. Row-Level Locking

### SELECT FOR UPDATE

Locks selected rows as if for update. Other transactions trying to modify or lock these rows will wait.

```sql
BEGIN;
SELECT * FROM inventory WHERE product_id = 42 FOR UPDATE;
-- Row is now locked. Other FOR UPDATE/SHARE on this row will wait.
UPDATE inventory SET quantity = quantity - 1 WHERE product_id = 42;
COMMIT;
-- Lock released.
```

### SELECT FOR SHARE

Acquires a shared lock. Blocks `UPDATE`, `DELETE`, and `FOR UPDATE`, but allows concurrent `FOR SHARE`.

```sql
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR SHARE;
-- Another session can also FOR SHARE this row.
-- But another session cannot UPDATE or DELETE it until we COMMIT.
COMMIT;
```

### Lock Strength Comparison

```
Strongest
  FOR UPDATE          -- blocks everything else
  FOR NO KEY UPDATE   -- blocks everything except FOR KEY SHARE
  FOR SHARE           -- blocks UPDATE/DELETE/FOR UPDATE, allows FOR SHARE/KEY SHARE
  FOR KEY SHARE       -- blocks DELETE and key-changing UPDATEs
Weakest (plain SELECT)
```

### SKIP LOCKED (PostgreSQL 9.5+)

Skips rows that are already locked by another transaction. Ideal for work queues.

```sql
-- Work queue pattern: each worker grabs the next unprocessed job
BEGIN;
SELECT id, payload
FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- If row is locked by another worker, skip it and get the next one.
-- No waiting, no deadlock.
UPDATE jobs SET status = 'processing' WHERE id = <returned_id>;
COMMIT;
```

### NOWAIT (PostgreSQL 9.5+)

Returns immediately with an error if the row is locked, instead of waiting.

```sql
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE NOWAIT;
-- ERROR: could not obtain lock on row in table "accounts"
-- Use this when you want to handle contention yourself rather than wait.
```

### Choosing Between NOWAIT and SKIP LOCKED

| Scenario | Use |
|---|---|
| Work queue / job processor | `SKIP LOCKED` |
| "I want this row and I won't wait" | `NOWAIT` |
| Polling for availability | `NOWAIT` + application retry |
| Need to process ALL matching rows, just not locked ones | `SKIP LOCKED` |

---

## 8. Deadlocks

### How They Happen

A deadlock occurs when two or more transactions each hold a lock the other wants.

```
Session A                          Session B
---------                          ---------
BEGIN;                             BEGIN;
UPDATE accounts SET                UPDATE accounts SET
  balance = balance + 100            balance = balance + 200
WHERE acctnum = 11111;          -- holds lock on row 11111
                                 
                                 UPDATE accounts SET
                                   balance = balance - 200
                                 WHERE acctnum = 22222;  -- holds lock on row 22222

UPDATE accounts SET                 
  balance = balance - 100          
WHERE acctnum = 22222;          -- WAITS: row 22222 locked by B
                                 
                                 -- DEADLOCK!
                                 -- A holds 11111, wants 22222
                                 -- B holds 22222, wants 11111
```

PostgreSQL detects this automatically (default: 1 second timeout via `deadlock_timeout`) and aborts one transaction:

```
ERROR:  deadlock detected
DETAIL:  Process 1234 waits for ShareLock on transaction 5678; blocked by process 8901.
         Process 8901 waits for ShareLock on transaction 5679; blocked by process 1234.
HINT:  See server log for query details.
SQLSTATE: 40P01
```

### Visual Representation

```
  Lock Dependency Graph:

  A --holds--> [row 11111] <--wants-- B
  |                                    |
  wants                                holds
  |                                    |
  v                                    v
  [row 22222] <--holds-- B    A <--wants-- [row 22222]

  Cycle detected = deadlock
```

### How to Prevent Deadlocks

1. **Consistent lock ordering**: Always access rows/tables in the same order across all transactions.

```sql
-- BAD: Session A locks row 1 then row 2; Session B locks row 2 then row 1
-- GOOD: Both sessions always lock row 1 then row 2

UPDATE accounts SET balance = balance + 100 WHERE acctnum = 11111;
UPDATE accounts SET balance = balance - 100 WHERE acctnum = 22222;
-- Always process in ascending acctnum order.
```

2. **Keep transactions short**: The shorter a transaction holds locks, the less chance of overlap.

3. **Retry on deadlock**: Catch SQLSTATE `40P01` and retry the entire transaction.

```python
# Python example with psycopg2
import psycopg2
from psycopg2 import errors

MAX_RETRIES = 3

for attempt in range(MAX_RETRIES):
    try:
        cur = conn.cursor()
        cur.execute("BEGIN")
        cur.execute("UPDATE accounts SET balance = balance + %s WHERE acctnum = %s", (100, 11111))
        cur.execute("UPDATE accounts SET balance = balance - %s WHERE acctnum = %s", (100, 22222))
        conn.commit()
        break
    except errors.DeadlockDetected:
        conn.rollback()
        if attempt == MAX_RETRIES - 1:
            raise
        # Retry from the beginning
    except Exception as e:
        conn.rollback()
        raise
```

4. **Use `deadlock_timeout` wisely**: Default is 1 second. Increase only if legitimate lock waits are longer.

### Detecting Lock Waits

```sql
-- See who is waiting and who holds the lock
SELECT
    blocked_locks.pid AS blocked_pid,
    blocked_activity.usename AS blocked_user,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query AS blocked_statement,
    blocking_activity.query AS blocking_statement
FROM pg_catalog.pg_locks AS blocked_locks
JOIN pg_catalog.pg_locks AS blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity AS blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_stat_activity AS blocking_activity
    ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.GRANTED;
```

---

## 9. Advisory Locks

### What They Are

Advisory locks are application-level locks that PostgreSQL provides but does not enforce. The database won't stop you from reading or writing a row while an advisory lock is held -- it's up to your application to respect them.

### When to Use Them

- Implementing a custom locking scheme that doesn't fit MVCC
- Serializing access to an external resource (file, API, hardware)
- Preventing duplicate background job execution
- Coordinating between application processes

### Session-Level vs Transaction-Level

```sql
-- Session-level: persists until explicitly released or session ends
SELECT pg_advisory_lock(12345);          -- exclusive lock (blocks)
SELECT pg_advisory_lock(12345, 67890);   -- exclusive lock (two-int64 key)
SELECT pg_advisory_xlock(12345);         -- exclusive, same as pg_advisory_lock
SELECT pg_advisory_shared_lock(12345);   -- shared lock (multiple holders OK)

-- Release
SELECT pg_advisory_unlock(12345);
SELECT pg_advisory_unlock_all();         -- release ALL advisory locks for this session

-- Transaction-level: released automatically at transaction end
SELECT pg_advisory_lock_xact(12345);
SELECT pg_advisory_xlock_xact(12345);
SELECT pg_advisory_shared_lock_xact(12345);
```

### Non-Blocking Variants

```sql
-- Returns false instead of waiting
SELECT pg_try_advisory_lock(12345);          -- single int key
SELECT pg_try_advisory_lock(12345, 67890);   -- two-int key
SELECT pg_try_advisory_shared_lock(12345);
```

### Practical Example: Singleton Background Job

```sql
-- Only one session can run the daily report at a time
DO $$
BEGIN
    IF pg_try_advisory_lock(hashtext('daily_report')) THEN
        -- We got the lock. Run the report.
        PERFORM generate_daily_report();
        PERFORM pg_advisory_unlock(hashtext('daily_report'));
    ELSE
        RAISE NOTICE 'Daily report already running.';
    END IF;
END $$;
```

### Advisory Lock Pitfalls

- **Key collision**: Two unrelated parts of your app using the same integer key will interfere with each other. Use distinct, well-documented key ranges.
- **Session-level locks survive ROLLBACK**: If you lock in a transaction that rolls back, the lock persists. Use transaction-level locks or explicit `unlock`.
- **Forgotten locks**: Session-level locks held by a crashed connection are released when the session ends, but until then they block everyone.

---

## 10. VACUUM and MVCC

### Why Dead Tuples Exist

Every `UPDATE` creates a new row version and marks the old one as dead. Every `DELETE` marks the row as dead. These dead tuples remain on disk until `VACUUM` runs.

```
Before VACUUM:
  Page contains: [live row] [dead row] [dead row] [live row] [dead row]
  Table size: still includes all dead rows

After VACUUM:
  Page contains: [live row] [REUSABLE] [REUSABLE] [live row] [REUSABLE]
  Space is marked as reusable, but table file size stays the same.

After VACUUM FULL:
  Page contains: [live row] [live row]
  Table is rewritten. Space returned to OS. Requires ACCESS EXCLUSIVE lock.
```

### What VACUUM Does

1. Scans each page for dead tuples
2. Marks dead tuple space as reusable
3. Updates the visibility map
4. Freezes old transaction IDs (to prevent wraparound)
5. Optionally truncates empty pages at the end of the table

### Autovacuum

PostgreSQL runs `VACUUM` automatically via the autovacuum daemon. Key settings:

```sql
-- Check autovacuum status
SELECT relname, last_autovacuum, last_vacuum, n_dead_tup
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;

-- Tune per-table autovacuum thresholds
ALTER TABLE high_churn_table
SET (autovacuum_vacuum_threshold = 100,
     autovacuum_vacuum_scale_factor = 0.01);
```

### Transaction ID Wraparound

Transaction IDs in PostgreSQL are 32-bit integers. After about 4 billion transactions, the counter wraps around. If old tuples with "frozen" xmin values don't exist, the database cannot determine visibility correctly and will shut down to prevent data corruption.

```
Transaction ID lifecycle:
  1 -> 2 -> 3 -> ... -> 2,147,483,647 -> 2,147,483,648 -> ... -> 4,294,967,295 -> WRAP to 1

VACUUM "freezes" old transaction IDs by replacing them with a special
frozen XID that is visible to all transactions. This prevents wraparound.
```

### Preventing Wraparound

```sql
-- Check how close you are to wraparound
SELECT
    datname,
    age(datfrozenxid) AS xid_age,
    (SELECT current_setting('autovacuum_freeze_max_age')::int) AS max_age,
    round(100.0 * age(datfrozenxid) /
          current_setting('autovacuum_freeze_max_age')::int) AS pct_used
FROM pg_database;

-- If pct_used approaches 100, the database will shut down.
-- Default autovacuum_freeze_max_age is 200,000,000.
-- Safety margin starts at 160,000,000 (panic threshold at 170,000,000).
```

---

## 11. Common Mistakes and Gotchas

### Mistake 1: Assuming READ COMMITTED Prevents Phantoms

```sql
-- This is the #1 misconception.
-- READ COMMITTED does NOT prevent phantom reads.
-- Two SELECTs in the same transaction can return different row counts.

BEGIN;
SELECT COUNT(*) FROM orders WHERE status = 'new';  -- 10
-- concurrent transaction inserts a new order and commits
SELECT COUNT(*) FROM orders WHERE status = 'new';  -- 11
COMMIT;
-- This is expected behavior at READ COMMITTED.
```

### Mistake 2: Holding Transactions Open Too Long

```sql
-- BAD: User-facing transaction that waits for input
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;  -- locks the row
-- ... application waits 30 seconds for user to fill a form ...
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
-- During those 30 seconds, everyone else is blocked on this row.

-- GOOD: Lock only during the actual modification
-- Read without lock -> user fills form -> then lock and update
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

### Mistake 3: Ignoring Serialization Failures

```sql
-- At SERIALIZABLE or REPEATABLE READ, concurrent writes can abort your transaction.
-- If you don't handle the error, your application crashes.

-- Always wrap in a retry loop:
-- 1. BEGIN
-- 2. Do work
-- 3. COMMIT
-- 4. If error SQLSTATE 40001, go to step 1
```

### Mistake 4: Forgetting That UPDATE Is DELETE + INSERT

```sql
-- An UPDATE changes the ctid (physical location) of the row.
-- If you store ctid in another table as a reference, it becomes stale.

-- Also: an UPDATE that doesn't change any column values still creates
-- a new version and marks the old one dead. This generates bloat.

-- To avoid unnecessary bloat, check if the value actually changed:
UPDATE accounts
SET balance = :new_balance
WHERE id = 1 AND balance IS DISTINCT FROM :new_balance;
-- If balance is already :new_balance, zero rows are updated, no bloat.
```

### Mistake 5: Not Understanding Lock Escalation in SERIALIZABLE

```sql
-- SERIALIZABLE uses predicate locks (SIReadLock) that do NOT cause deadlocks.
-- They appear in pg_locks but are non-blocking.
-- Only regular locks (FOR UPDATE, etc.) can deadlock in SERIALIZABLE.

-- However, mixing SERIALIZABLE with explicit FOR UPDATE can be
-- counterproductive. SERIALIZABLE already provides consistency;
-- FOR UPDATE adds blocking without adding correctness.
```

### Mistake 6: Using VACUUM FULL in Production

```sql
-- VACUUM FULL requires ACCESS EXCLUSIVE lock.
-- This blocks ALL reads and writes on the table.
-- It also requires ~2x the disk space temporarily.

-- Use regular VACUUM instead. It runs concurrently and reclaims space
-- for reuse (just doesn't return it to the OS).
```

### Mistake 7: Inconsistent Lock Ordering Across Code Paths

```sql
-- Code path A:
UPDATE table_x SET ... WHERE id = 1;
UPDATE table_y SET ... WHERE id = 2;

-- Code path B (different function, different developer):
UPDATE table_y SET ... WHERE id = 2;
UPDATE table_x SET ... WHERE id = 1;
-- Deadlock risk when A and B run concurrently.

-- Fix: Establish a global ordering convention.
-- Always lock alphabetically by table name, then by primary key.
```

---

## 12. Quick Reference: Concurrent Transaction Outcomes

### Two Transactions, Same Row, READ COMMITTED

```
T1: UPDATE accounts SET balance = 500 WHERE id = 1;
T2: UPDATE accounts SET balance = 600 WHERE id = 1;

If T1 commits first:
  T2 sees the updated row (balance = 500), applies its change.
  Final: balance = 600.

If T2 commits first:
  T1 sees the updated row (balance = 600), applies its change.
  Final: balance = 500.

The last committer wins. No error, no deadlock.
```

### Two Transactions, Same Row, REPEATABLE READ

```
T1: BEGIN ISOLATION LEVEL REPEATABLE READ;
    UPDATE accounts SET balance = 500 WHERE id = 1;

T2: BEGIN ISOLATION LEVEL REPEATABLE READ;
    UPDATE accounts SET balance = 600 WHERE id = 1;

If T1 commits first:
  T2 gets: ERROR: could not serialize access due to concurrent update
  T2 must retry.

If T2 commits first:
  T1 gets: ERROR: could not serialize access due to concurrent update
  T1 must retry.

One wins, one retries. The winner's value is final.
```

### Two Transactions, Work Queue Pattern

```
-- Using SKIP LOCKED to avoid contention
T1: SELECT * FROM jobs WHERE status = 'pending' FOR UPDATE SKIP LOCKED LIMIT 1;
T2: SELECT * FROM jobs WHERE status = 'pending' FOR UPDATE SKIP LOCKED LIMIT 1;

T1 gets job #1, T2 gets job #2. No conflict, no waiting.
If T2 arrives after T1 has locked job #1, T2 skips it and gets job #2.
```

---

## Key Takeaways

1. **Reads never block writes in PostgreSQL.** MVCC makes this possible. This is the single most important thing to understand.

2. **READ COMMITTED is the default and sufficient for most applications.** Each statement sees a snapshot as of its start time.

3. **Use REPEATABLE READ for consistent multi-query operations.** It gives you a stable snapshot for the entire transaction.

4. **Use SERIALIZABLE only when you need true serial equivalence.** It adds overhead and requires retry logic.

5. **FOR UPDATE / FOR SHARE are for coordinating writes, not for consistency.** MVCC already provides isolation; locks are for ensuring you operate on the current version of a row.

6. **SKIP LOCKED is your friend for work queues.** It eliminates contention without application-level polling.

7. **Deadlocks are inevitable at scale.** Design for them: consistent lock ordering, short transactions, and retry logic.

8. **VACUUM is not optional.** Dead tuples accumulate. Autovacuum handles routine cleanup, but monitor `n_dead_tup` and tune thresholds for high-churn tables.

9. **Watch for transaction ID wraparound.** It can shut down your database. Autovacuum prevents it, but under extreme load, monitor `age(datfrozenxid)`.

10. **Test your concurrent code.** Run transactions in parallel sessions and verify the outcomes match your expectations. Theory and practice diverge at the edges.

---

## Further Reading

- PostgreSQL Docs: [Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- PostgreSQL Docs: [Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- PostgreSQL Docs: [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- PostgreSQL Docs: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- Cybertec: [PostgreSQL MVCC Deep Dive](https://www.cybertec-postgresql.com/en/mvcc-in-postgresql/)
- EnterpriseDB: [Understanding PostgreSQL Locks](https://www.enterprisedb.com/postgres-tutorials/understanding-postgresql-locks)
