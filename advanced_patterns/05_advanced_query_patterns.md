# ADVANCED PATTERN 5: ADVANCED QUERY PATTERNS

CTEs, window functions, and LATERAL joins are the three tools that separate SQL beginners from professionals. Each one solves a class of problems that would otherwise require application-side looping or multiple round trips.

## THE SHORT VERSION

| Pattern | Solves | PostgreSQL version |
|---|---|---|
| CTE (`WITH`) | Breaking complex queries into named steps | All |
| Window functions | Row-level calculations across peers | 8.4+ |
| `RANK()` / `DENSE_RANK()` | Tie-aware ranking | 8.4+ |
| `ROW_NUMBER()` | Deterministic row ordering | 8.4+ |
| `LAG()` / `LEAD()` | Row-to-row comparisons | 8.4+ |
| Window frames | Aggregation over sliding windows | 8.4+ |
| `LATERAL` joins | Correlated subqueries as joins | 9.3+ |

---

## COMMON TABLE EXPRESSIONS (CTEs)

A CTE is a named subquery block that exists for the duration of a single statement. Think of it as a temporary view scoped to one query.

### BASIC CTE

```sql
with high_value_customers as (
    select customer_id, sum(amount) as total_spent
    from orders
    group by customer_id
    having sum(amount) > 10000
)
select c.name, h.total_spent
from customers c
join high_value_customers h on h.customer_id = c.id;
```

### CHAINED CTEs

CTEs can reference preceding CTEs in the same `WITH` clause, creating a pipeline.

```sql
with
    order_summary as (
        select customer_id, count(*) as order_count, avg(amount) as avg_amount
        from orders
        where order_date >= '2024-01-01'
        group by customer_id
    ),
    ranked as (
        select *,
               rank() over (order by order_count desc) as rank_by_volume
        from order_summary
    )
select *
from ranked
where rank_by_volume <= 10;
```

Execution flow:

```
orders table
    |
    v
[order_summary] --> aggregates per customer
    |
    v
[ranked]          --> adds rank() window function
    |
    v
final SELECT      --> filters top 10
```

### MATERIALIZED CTEs (PostgreSQL 12+)

By default, PostgreSQL may inline a CTE into the parent query for optimization. Use `MATERIALIZED` to force evaluation once, or `NOT MATERIALIZED` to force inlining.

```sql
with
    expensive_calc as materialized (
        -- Runs exactly once; result cached in a work table
        select id, heavy_computation(column) as result
        from large_table
    )
select *
from expensive_calc
where result > 50;
```

Use `MATERIALIZED` when the CTE is expensive and referenced multiple times. Without it, the planner might re-execute the CTE for each reference.

---

## WINDOW FUNCTIONS

Window functions compute values across a set of rows that are related to the current row. Unlike `GROUP BY`, they do not collapse rows.

### THE ANATOMY

```
function() OVER (
    PARTITION BY column   -- resets the window
    ORDER BY column       -- defines row order within the window
    FRAME_CLAUSE          -- controls which rows are included
)
```

### ROW_NUMBER, RANK, DENSE_RANK

These three functions answer the question "what position is this row in?"

```sql
select
    employee_id,
    department_id,
    salary,
    row_number() over (partition by department_id order by salary desc) as rn,
    rank()       over (partition by department_id order by salary desc) as rnk,
    dense_rank() over (partition by department_id order by salary desc) as drnk
from employees;
```

Output for a department with salaries 90000, 90000, 85000, 80000:

```
 employee_id | salary | rn | rnk | drnk
-------------+--------+----+-----+-----
 101         | 90000  |  1 |   1 |    1
 102         | 90000  |  2 |   1 |    1
 103         | 85000  |  3 |   3 |    2
 104         | 80000  |  4 |   4 |    3
```

Key difference: `RANK` skips numbers after ties; `DENSE_RANK` does not. Use `ROW_NUMBER` when you need a deterministic unique identifier per partition.

### LAG and LEAD

Access values from preceding or following rows without self-joins.

```sql
select
    order_id,
    order_date,
    amount,
    lag(amount, 1) over (partition by customer_id order by order_date) as prev_amount,
    lead(amount, 1) over (partition by customer_id order by order_date) as next_amount,
    amount - lag(amount, 1) over (partition by customer_id order by order_date) as amount_change
from orders;
```

Visual representation:

```
Row | order_date | amount | lag(1)  | lead(1)
----+------------+--------+---------+--------
  1 | 2024-01-05 |  100.0 |  NULL   |  250.0
  2 | 2024-02-10 |  250.0 |  100.0  |  175.0
  3 | 2024-03-15 |  175.0 |  250.0  |  300.0
  4 | 2024-04-20 |  300.0 |  175.0  |  NULL
```

Offset parameter defaults to 1. Use `lag(amount, 3)` to look three rows back. The third argument is a default value for out-of-bounds access: `lag(amount, 1, 0)`.

### WINDOW FRAMES

The frame clause controls which rows within the partition are included in the calculation. Default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` when `ORDER BY` is present.

```sql
select
    order_date,
    amount,
    -- Default: running total from first row to current row
    sum(amount) over (order by order_date) as running_total,
    -- Explicit ROWS frame: last 3 rows including current
    sum(amount) over (order by order_date rows between 2 preceding and current row) as moving_3_sum,
    -- RANGE frame: all rows with the same order_date value
    sum(amount) over (partition by date_trunc('month', order_date)::date
                      order by order_date
                      range between unbounded preceding and current row) as monthly_running,
    -- Full partition: total across the entire partition
    sum(amount) over (partition by customer_id) as customer_total
from orders;
```

Frame types:

```
ROWS:   counts physical rows (2 preceding = 2 rows back)
RANGE:  counts logical ties (all rows with same ORDER BY value)
GROUPS: counts peer groups (PostgreSQL 11+)
```

Bound options:
- `UNBOUNDED PRECEDING` -- start of partition
- `N PRECEDING` -- N rows/ranges before current
- `CURRENT ROW` -- the current row
- `N FOLLOWING` -- N rows/ranges after current
- `UNBOUNDED FOLLOWING` -- end of partition

### PRACTICAL WINDOW PATTERNS

**Detect gaps in a sequence:**

```sql
with ordered as (
    select
        event_id,
        event_time,
        lag(event_time) over (order by event_time) as prev_time
    from events
)
select *
from ordered
where prev_time is not null
  and event_time - prev_time > interval '1 hour';
```

**Top-N per group:**

```sql
with ranked as (
    select
        product_id,
        category_id,
        revenue,
        row_number() over (partition by category_id order by revenue desc) as rn
    from product_sales
)
select product_id, category_id, revenue
from ranked
where rn <= 3;
```

**Percentage of total:**

```sql
select
    department_id,
    count(*) as emp_count,
    round(count(*) * 100.0 / sum(count(*)) over (), 1) as pct_of_total
from employees
group by department_id;
```

---

## LATERAL JOINS

`LATERAL` allows a `FROM` item to reference columns from preceding `FROM` items. It is the SQL equivalent of a correlated loop.

### BASIC LATERAL

Without `LATERAL`, a subquery in `FROM` cannot reference outer columns. With `LATERAL`, it can.

```sql
select c.name, recent.order_date, recent.amount
from customers c
cross join lateral (
    select order_date, amount
    from orders
    where customer_id = c.id
    order by order_date desc
    limit 1
) as recent;
```

Execution model:

```
For each customer row:
    |
    +-- Execute the subquery with c.id substituted
    |
    +-- Emit joined row(s) (or none if subquery returns empty)
```

### INNER vs LEFT LATERAL

`CROSS JOIN LATERAL` drops outer rows when the lateral subquery returns nothing. `LEFT JOIN LATERAL` preserves them with NULLs.

```sql
-- Drops customers with no orders
select c.name, r.order_date
from customers c
cross join lateral (
    select order_date from orders where customer_id = c.id order by order_date desc limit 1
) r;

-- Keeps all customers; NULL for those without orders
select c.name, r.order_date
from customers c
left join lateral (
    select order_date from orders where customer_id = c.id order by order_date desc limit 1
) r on true;
```

### LATERAL WITH SET-RETURNING FUNCTIONS

This is the most common daily use case. Functions like `generate_series`, `jsonb_array_elements`, and `regexp_matches` return sets.

```sql
-- Expand a JSONB array into rows
select
    c.name,
    elem->>'tag' as tag
from customers c,
     lateral jsonb_array_elements(c.tags) as elem;

-- Generate a date range per order
select
    o.order_id,
    d.gen_date
from orders o,
     lateral generate_series(o.start_date, o.end_date, interval '1 day') as d(gen_date);

-- Split comma-separated values
select
    id,
    trim(elem) as value
from my_table,
     lateral regexp_split_to_table(tags, ',') as elem;
```

### LATERAL vs SUBQUERY

When to use which:

```
LATERAL JOIN:
  - You need LIMIT inside the correlated subquery
  - The subquery is a set-returning function
  - You want to join the result set, not just filter

Scalar subquery in SELECT:
  - You need a single value per row
  - Simpler syntax, no JOIN semantics

EXISTS / IN:
  - You only need a boolean check
  - No data from the subquery needed
```

Example where LATERAL is required:

```sql
-- Get the 2 most recent orders per customer
select c.name, o.order_id, o.order_date
from customers c,
     lateral (
         select order_id, order_date
         from orders
         where customer_id = c.id
         order by order_date desc
         limit 2
     ) o;
```

A scalar subquery cannot return multiple rows. A regular `JOIN` cannot use `LIMIT` correlated to the outer row. `LATERAL` is the only option.

---

## GOTCHAS

### CTEs and optimization

In PostgreSQL 12 and earlier, CTEs are optimization fences. The planner cannot push predicates from the outer query into a CTE. This means:

```sql
with all_orders as (
    select * from orders   -- Entire table is materialized
)
select *
from all_orders
where order_date = '2024-07-01';  -- Filter happens AFTER materialization
```

In PostgreSQL 14+, the planner can inline CTEs when safe, closing this gap. But never rely on it. Write CTEs that are efficient on their own.

### Window function evaluation order

Window functions execute after `WHERE`, `GROUP BY`, and `HAVING`. You cannot reference a window function in `WHERE`:

```sql
-- INVALID: window function in WHERE
select *
from orders
where row_number() over (order by amount desc) <= 10;

-- VALID: wrap in CTE or subquery
with ranked as (
    select *, row_number() over (order by amount desc) as rn
    from orders
)
select *
from ranked
where rn <= 10;
```

### Non-deterministic window ordering

`ROW_NUMBER()` without a deterministic `ORDER BY` produces unpredictable results:

```sql
-- Non-deterministic: ties in salary produce arbitrary ordering
row_number() over (partition by dept_id order by salary desc)

-- Deterministic: add a tiebreaker
row_number() over (partition by dept_id order by salary desc, employee_id)
```

### LATERAL with empty results

`CROSS JOIN LATERAL` behaves like `INNER JOIN` -- outer rows with no lateral matches are dropped. This is a frequent source of bugs when migrating from `LEFT JOIN` to `LATERAL`. Always verify with `LEFT JOIN LATERAL ... ON TRUE` when you need to preserve outer rows.

### Frame default trap

When you specify `ORDER BY` in `OVER()`, the default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. When you omit `ORDER BY`, the frame is the entire partition. This means:

```sql
-- Running total (default frame with ORDER BY)
sum(amount) over (order by order_date)

-- Grand total (no ORDER BY = entire partition)
sum(amount) over (partition by customer_id)
```

Both are correct but serve different purposes. Confusing them is a common mistake.

---

## KEY TAKEAWAYS

1. Use CTEs for readability and logical decomposition. They make complex queries maintainable. Be aware of the optimization fence behavior in PostgreSQL 12 and earlier.

2. Use `ROW_NUMBER()` when you need a unique sequential identifier within a partition. Use `RANK()` when ties should share a position and skip the next number. Use `DENSE_RANK()` when ties should share a position without skipping.

3. Use `LAG()`/`LEAD()` instead of self-joins for row-to-row comparisons. They are cleaner, more performant, and easier to read.

4. Specify window frames explicitly. Relying on defaults works until it does not -- and debugging an off-by-one frame error is tedious.

5. Use `LATERAL` whenever you need a correlated subquery that returns multiple rows or uses `LIMIT`. It replaces application-side loops with a single database round trip.

6. Always add a deterministic tiebreaker to `ORDER BY` inside window functions. The extra column costs nothing and prevents subtle bugs when data changes.

7. Prefer `LEFT JOIN LATERAL ... ON TRUE` over `CROSS JOIN LATERAL` when the lateral subquery might return zero rows and you need to preserve the outer row.

---

## QUICK REFERENCE

```sql
-- CTE pipeline
with step1 as (...), step2 as (select * from step1 where ...)
select * from step2;

-- Deduplicate with window function
with ranked as (
    select *, row_number() over (partition by email order by created_at) as rn
    from users
)
select * from ranked where rn = 1;

-- Running total
sum(value) over (order by ts rows between unbounded preceding and current row);

-- Previous row value
lag(value, 1, default_val) over (partition by group_col order by ts);

-- Top-N per group
with r as (
    select *, row_number() over (partition by group_col order by score desc) as rn
    from data
)
select * from r where rn <= N;

-- LATERAL with LIMIT
select a.id, b.*
from a
cross join lateral (
    select * from b where b.a_id = a.id order by created_at desc limit 1
) b;

-- LATERAL with set-returning function
select id, elem
from my_table,
     lateral jsonb_array_elements(data) as elem;
```
