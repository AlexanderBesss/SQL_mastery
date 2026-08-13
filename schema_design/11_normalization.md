# PATTERN 11: NORMALIZATION (AND WHEN TO BREAK IT)

Every pattern in this directory is an application of normalization. This file is the theory underneath them — stated in a way you can actually apply, rather than as textbook definitions.

## THE ONE-SENTENCE VERSION

> Every non-key fact depends on **the key, the whole key, and nothing but the key.**

That covers 1NF through 3NF. The rest of this file is what it means in practice and when to deliberately ignore it.

## WHY IT MATTERS: UPDATE ANOMALIES

Normalization isn't about elegance. It's about three concrete failure modes. Take this denormalized table:

| enrollment_id | student_name | student_email | course_name | instructor | instructor_office |
|---|---|---|---|---|---|
| 1 | Alice | a@x.com | Databases | Dr. Chen | Room 12 |
| 2 | Bob | b@x.com | Databases | Dr. Chen | Room 12 |
| 3 | Alice | a@x.com | Networks | Dr. Patel | Room 8 |

- **Update anomaly.** Dr. Chen moves offices. You must update every row mentioning her, and if you miss one the database now holds two contradictory answers with no way to tell which is right.
- **Insertion anomaly.** You cannot record a new instructor until someone enrolls in their course — there's nowhere to put them.
- **Deletion anomaly.** If Bob and Alice both drop Databases, you lose the fact that Dr. Chen exists and where her office is.

Each anomaly traces to the same root cause: **one fact stored in more than one place, or facts glued to the wrong key.**

---

## 1NF — ATOMIC VALUES, NO REPEATING GROUPS

Every column holds a single value, and there are no `phone1`, `phone2`, `phone3` columns.

```sql
-- ❌ Violates 1NF: a list crammed into one column
create table contacts (
    id     int primary key,
    name   text,
    phones text        -- '555-1234, 555-5678'
);

-- ❌ Also violates 1NF: repeating group
create table contacts (
    id int primary key,
    phone1 text, phone2 text, phone3 text
);

-- ✅ 1NF
create table contacts (id int primary key, name text);
create table contact_phones (
    contact_id int not null references contacts (id) on delete cascade,
    phone      text not null,
    kind       text not null check (kind in ('mobile', 'home', 'work')),
    primary key (contact_id, phone)
);
```

The comma-separated version can't be indexed, can't be constrained, can't be joined, and requires string parsing for every query. The `phone1..3` version breaks the moment someone has four.

**Is a JSONB column a 1NF violation?** Strictly, yes. Practically, it's a deliberate tradeoff — see `08_jsonb_flexible.md`. The question to ask is whether you'll ever need to *query, constrain, or join on* the individual elements. If yes, they're rows.

**Arrays are the same judgment call.** `tags text[]` is defensible when tags are atomic labels with no attributes of their own. It stops being defensible the moment you need "who added this tag and when."

---

## 2NF — NO PARTIAL DEPENDENCIES

Applies only to tables with a **composite** primary key: every non-key column must depend on the *whole* key, not just part of it.

```sql
-- ❌ Violates 2NF
create table order_items (
    order_id     int,
    product_id   int,
    quantity     int,      -- depends on BOTH  ✓
    product_name text,     -- depends only on product_id  ✗
    product_price numeric, -- depends only on product_id  ✗
    primary key (order_id, product_id)
);
```

`product_name` is a fact about the product, not about this order line. Storing it here repeats it once per order and lets copies drift apart.

```sql
-- ✅ 2NF
create table products (
    product_id int primary key,
    name       text not null,
    price      numeric(10,2) not null
);
create table order_items (
    order_id   int not null references orders (order_id),
    product_id int not null references products (product_id),
    quantity   int not null check (quantity > 0),
    primary key (order_id, product_id)
);
```

**The important exception:** an order line legitimately stores the price *at the time of sale*. That looks identical to the violation above but isn't — `unit_price` is a fact about *this order line*, not about the product, because the product's current price may since have changed. Same for `product_name` if you must reprint the original invoice. See `../interview_sql_nodejs/07_practical_scenarios.md` Q2.

The test: **is this value about the relationship, or about one of the entities?** Historical snapshots are about the relationship. Current attributes are not.

---

## 3NF — NO TRANSITIVE DEPENDENCIES

No non-key column may depend on another non-key column.

```sql
-- ❌ Violates 3NF
create table employees (
    emp_id    int primary key,
    name      text,
    dept_id   int,
    dept_name text,      -- depends on dept_id, not emp_id
    dept_head text       -- depends on dept_id, not emp_id
);
```

`emp_id → dept_id → dept_name` is a transitive chain. Renaming a department means updating every employee in it.

```sql
-- ✅ 3NF
create table departments (
    dept_id   int primary key,
    name      text not null,
    head_id   int references employees (emp_id)
);
create table employees (
    emp_id  int primary key,
    name    text not null,
    dept_id int not null references departments (dept_id)
);
```

**3NF is the practical target for OLTP schemas.** If you reach 3NF you've eliminated essentially all update anomalies that matter.

**A common near-miss:** derived values. `total = quantity * unit_price` stored as a column is a 3NF violation of sorts — it depends on other non-key columns. The clean fix in PostgreSQL is a generated column, which cannot drift:

```sql
line_total numeric(12,2) generated always as (quantity * unit_price) stored
```

---

## BCNF — EVERY DETERMINANT IS A CANDIDATE KEY

A stricter 3NF, relevant when a table has **overlapping candidate keys**. Rare, but this is the standard example:

```sql
-- Each student has ONE advisor per subject; each advisor teaches ONE subject.
-- Candidate keys: (student, subject) and (student, advisor)
create table advising (student int, subject text, advisor int);
```

`advisor → subject` is a dependency, but `advisor` alone isn't a candidate key — so this is 3NF but not BCNF. The anomaly: you cannot record that an advisor teaches a subject until a student is assigned to them, and deleting the last student erases that fact.

```sql
-- ✅ BCNF
create table advisors (advisor_id int primary key, subject text not null);
create table student_advisors (
    student_id int, advisor_id int references advisors (advisor_id),
    primary key (student_id, advisor_id)
);
```

Worth recognizing; rarely worth chasing deliberately. If you model entities properly you land in BCNF most of the time.

*(4NF and 5NF handle multivalued and join dependencies. In practice: if you find yourself storing two independent multivalued facts in one junction table — a person's languages and their certifications in a single table — split them. That's 4NF, and it's the only one that comes up.)*

---

## DENORMALIZATION: WHEN TO BREAK THE RULES

Normalize first. Denormalize with a specific, measured reason. "It'll be faster" is not a reason until you've seen the query plan.

**Legitimate reasons:**

| Reason | Example | Keep consistent with |
|---|---|---|
| **Historical accuracy** | Invoice line stores price at sale time | Nothing — it's *supposed* to diverge |
| **Expensive aggregate read constantly** | `posts.comment_count` | Trigger, or periodic recompute |
| **Cross-table filter/sort** | `comments.post_author_id` to filter without a join | Trigger |
| **Read-model separation** | Materialized view for a dashboard | Scheduled `REFRESH` |
| **Write-heavy counters** | `users.follower_count` | Trigger, or an offline rollup |

The first row is a category apart: a stored historical value isn't really denormalization, because the current value and the historical value are *different facts*. The rest are genuine tradeoffs where you accept a consistency risk for read speed.

**The rule for the rest: every denormalized value needs a named owner that keeps it correct.**

```sql
alter table posts add column comment_count int not null default 0;

create or replace function sync_comment_count() returns trigger as $$
begin
    if tg_op = 'INSERT' then
        update posts set comment_count = comment_count + 1 where id = new.post_id;
    elsif tg_op = 'DELETE' then
        update posts set comment_count = comment_count - 1 where id = old.post_id;
    end if;
    return null;
end;
$$ language plpgsql;

create trigger trg_comment_count
    after insert or delete on comments
    for each row execute function sync_comment_count();
```

Two things to know before shipping that trigger:

- **It serializes writes on the parent row.** Every comment on a popular post now contends for the same `posts` row. At high volume, batch the updates or maintain the counter offline instead.
- **Add a reconciliation job.** Counters drift — from bulk operations that bypass triggers, from bugs, from restores. A nightly recompute that logs discrepancies is what keeps a denormalized value trustworthy.

**Prefer these before hand-maintained denormalization:**

- **Generated columns** for values derived from the same row — always correct, zero maintenance
- **Materialized views** for expensive aggregates that tolerate staleness (`../interview_sql_nodejs/05_performance_and_indexing.md` Q9)
- **A covering index** — often the actual fix for a slow join, at no consistency cost
- **A cache** — same tradeoff, but outside the database where staleness is expected

---

## THE PRACTICAL WORKFLOW

1. **List the facts** the system must record, in plain language. "A student enrolls in a course on a date and receives a grade."
2. **Give each independent entity a table**, each with a surrogate PK.
3. **Model the relationships** using the patterns in files 01–07.
4. **Check every column:** does this fact depend on the whole key and nothing else? Move it if not.
5. **Add constraints** for every rule you stated in step 1 (`10_keys_and_constraints.md`).
6. **Then, and only then,** look at query patterns and add indexes.
7. **Denormalize only** where a measured query is too slow and indexing didn't fix it — and give every denormalized value an owner and a reconciliation job.

---

### COMMON MISTAKES

- **Denormalizing preemptively** because normalized schemas "have too many joins." Joins on indexed integer keys are extremely fast; PostgreSQL is built for them. A ten-table join is not automatically a problem.
- **Confusing a historical snapshot with a normalization violation.** Order line prices *should* be copied.
- **Storing derived values that a generated column could compute.** Manual `total = qty * price` will drift; `GENERATED ALWAYS AS` cannot.
- **Adding a counter cache without a reconciliation job.** It will drift, and you'll find out from a user.
- **Over-normalizing enums into lookup tables** with one column. A `text` + `CHECK` is often clearer (see `09_data_types.md`).
- **Treating 3NF as a hard rule rather than the default.** It's the right default; the exceptions are real and listed above.
- **Normalizing an analytics schema.** Star schemas are deliberately denormalized because the workload is read-only aggregation, not concurrent updates. The rules here are for OLTP.

### KEY TAKEAWAYS

- "The key, the whole key, and nothing but the key" gets you to 3NF
- Normalization exists to prevent update/insert/delete anomalies — not for tidiness
- 3NF is the target for transactional schemas; BCNF usually comes free
- Denormalize deliberately, with an owner and a reconciliation job for every copied value
- Reach for generated columns, materialized views, and indexes before hand-maintained duplication
