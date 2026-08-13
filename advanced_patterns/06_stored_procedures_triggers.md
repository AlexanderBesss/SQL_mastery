# PostgreSQL Stored Procedures, Triggers, and PL/pgSQL

## Table of Contents

1. [Functions vs Procedures](#functions-vs-procedures)
2. [PL/pgSQL Control Structures](#plpgsql-control-structures)
3. [Error Handling](#error-handling)
4. [Triggers](#triggers)
5. [Trigger Use Cases](#trigger-use-cases)
6. [Best Practices](#best-practices)
7. [Gotchas](#gotchas)
8. [Key Takeaways](#key-takeaways)

---

## Functions vs Procedures

PostgreSQL 11 introduced `CREATE PROCEDURE` to distinguish stored procedures from functions.

| Feature | Function | Procedure |
|---|---|---|
| Return value | Mandatory (`RETURNS`) | Optional (`OUT` parameters) |
| Transaction control | Cannot use `COMMIT`/`ROLLBACK` | Can use `COMMIT`/`ROLLBACK` |
| SQL call syntax | `SELECT fn()` | `CALL proc()` |
| Inline usage | Yes (in SELECT, WHERE, etc.) | No |
| Autocommit transactions | No | Yes (can manage own transactions) |

### Function

```sql
CREATE OR REPLACE FUNCTION calculate_tax(amount NUMERIC, rate NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN amount * rate;
END;
$$;

-- Usage
SELECT calculate_tax(100.00, 0.08);
```

### Procedure

```sql
CREATE OR REPLACE PROCEDURE bulk_update_prices(category_id INT, increase_pct NUMERIC)
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count INT;
BEGIN
    UPDATE products
    SET price = price * (1 + increase_pct / 100.0)
    WHERE category_id = category_id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Updated % rows', updated_count;
    COMMIT;
EXCEPTION
    WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
END;
$$;

-- Usage
CALL bulk_update_prices(5, 10.0);
```

### When to Use Which

```
Use FUNCTION when:
  - You need a return value inline in a query
  - The operation is a single atomic unit
  - You need determinism for indexing or views

Use PROCEDURE when:
  - You need explicit transaction control
  - The operation has multiple independent steps
  - You are doing bulk DML with commit points
```

---

## PL/pgSQL Control Structures

### Variables and Types

```sql
CREATE OR REPLACE FUNCTION process_order(p_order_id INT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_customer_id INT;
    v_total       NUMERIC(12, 2) := 0;
    v_status      TEXT DEFAULT 'pending';
    v_record      RECORD;
    v_items       INT[];
    v_cursor      REFCURSOR;
BEGIN
    -- Variable assignment
    v_customer_id := (SELECT customer_id FROM orders WHERE id = p_order_id);
END;
$$;
```

### IF-THEN-ELSIF-ELSE

```sql
IF v_total > 1000 THEN
    v_status := 'priority';
ELSIF v_total > 500 THEN
    v_status := 'standard';
ELSE
    v_status := 'economy';
END IF;
```

### CASE

```sql
CASE v_status
    WHEN 'priority' THEN
        RAISE NOTICE 'Priority processing for order %', p_order_id;
    WHEN 'standard' THEN
        RAISE NOTICE 'Standard processing for order %', p_order_id;
    ELSE
        RAISE NOTICE 'Economy processing for order %', p_order_id;
END CASE;
```

### Loops

#### Simple LOOP with EXIT

```sql
LOOP
    v_total := v_total + 1;
    EXIT WHEN v_total >= 100;
END LOOP;
```

#### WHILE LOOP

```sql
WHILE v_total < 100 LOOP
    v_total := v_total + 10;
END LOOP;
```

#### FOR LOOP (integer range)

```sql
FOR i IN 1..10 LOOP
    INSERT INTO log_table(msg) VALUES ('Iteration ' || i);
END LOOP;

-- Reverse with BY
FOR i IN REVERSE 10..1 BY 2 LOOP
    RAISE NOTICE 'Countdown: %', i;
END LOOP;
```

#### FOR LOOP (query)

```sql
FOR v_record IN
    SELECT id, name, price FROM products WHERE category_id = p_cat_id
LOOP
    RAISE NOTICE 'Product: % - % at %', v_record.id, v_record.name, v_record.price;
END LOOP;
```

### Cursors

```sql
FOR v_record IN
    SELECT id, amount FROM large_transactions WHERE created_at > NOW() - INTERVAL '7 days'
LOOP
    -- Process each row without locking the entire result set
    RAISE NOTICE 'Transaction: %, Amount: %', v_record.id, v_record.amount;
END LOOP;
```

---

## Error Handling

### Basic EXCEPTION Block

```sql
CREATE OR REPLACE FUNCTION safe_delete_order(p_order_id INT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_order_exists BOOLEAN;
BEGIN
    SELECT EXISTS(SELECT 1 FROM orders WHERE id = p_order_id) INTO v_order_exists;

    IF NOT v_order_exists THEN
        RAISE EXCEPTION 'Order % does not exist', p_order_id
            USING ERRCODE = '22023';
    END IF;

    DELETE FROM order_items WHERE order_id = p_order_id;
    DELETE FROM orders WHERE id = p_order_id;

    RETURN 'deleted';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'Cannot delete order %: has related records', p_order_id
            USING ERRCODE = SQLSTATE;
    WHEN OTHERS THEN
        RAISE LOG 'Failed to delete order %: %', p_order_id, SQLERRM;
        RAISE;
END;
$$;
```

### Stack Traces and Debugging

```sql
CREATE OR REPLACE FUNCTION debug_example()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'SQLSTATE: %, MESSAGE: %, DETAIL: %',
        SQLSTATE, SQLERRM, SQLERRD;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Error at line %, function %, message: %',
            ereturning, current_query(), SQLERRM
            USING HINT = 'Check input parameters';
END;
$$;
```

### Common SQLSTATE Codes

| Code | Name | Meaning |
|---|---|---|
| `00000` | `successful_completion` | No error |
| `23505` | `unique_violation` | Duplicate key |
| `23503` | `foreign_key_violation` | Referential integrity |
| `23502` | `not_null_violation` | Null in NOT NULL column |
| `23514` | `check_violation` | Constraint check failed |
| `42703` | `undefined_column` | Column does not exist |
| `57014` | `canceling_statement` | Query canceled by user |

### Custom Exception

```sql
CREATE OR REPLACE FUNCTION validate_age(p_age INT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    invalid_age EXCEPTION;
BEGIN
    IF p_age < 0 OR p_age > 150 THEN
        RAISE EXCEPTION 'Age % is out of valid range [0, 150]', p_age
            USING ERRCODE = '23514';
    END IF;
END;
$$;
```

---

## Triggers

### Trigger Architecture

```
              BEFORE/AFTER/INSTEAD OF
              /          |          \
             /           |           \
         ROW-LEVEL    STATEMENT     ROW-LEVEL
         (FOR EACH    (FOR EACH     (FOR EACH
          ROW)        STATEMENT)    ROW)

  Row-level: fires once per affected row
  Statement-level: fires once per SQL statement
```

### Trigger Types

| Type | Timing | Scope | Supported On |
|---|---|---|---|
| `BEFORE` | Before operation | ROW or STATEMENT | Tables |
| `AFTER` | After operation | ROW or STATEMENT | Tables, Views |
| `INSTEAD OF` | Replaces operation | ROW only | Views |

### BEFORE Trigger

Fires before the row change is applied. Can modify the row or cancel the operation.

```sql
CREATE OR REPLACE FUNCTION trg_set_audit_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.created_at := COALESCE(NEW.created_at, NOW());
    NEW.updated_at := NOW();
    NEW.created_by := COALESCE(NEW.created_by, CURRENT_USER);
    NEW.updated_by := CURRENT_USER;
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_audit_fields
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION trg_set_audit_fields();
```

### AFTER Trigger

Fires after the row change is committed to the table. Cannot modify the row.

```sql
CREATE OR REPLACE FUNCTION trg_log_user_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log(table_name, action, row_data, changed_at)
        VALUES ('users', 'INSERT', row_to_json(NEW)::TEXT, NOW());
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_log(table_name, action, old_data, new_data, changed_at)
        VALUES ('users', 'UPDATE', row_to_json(OLD)::TEXT, row_to_json(NEW)::TEXT, NOW());
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log(table_name, action, row_data, changed_at)
        VALUES ('users', 'DELETE', row_to_json(OLD)::TEXT, NOW());
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER log_user_change
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW
    EXECUTE FUNCTION trg_log_user_change();
```

### INSTEAD OF Trigger

Used on views to redirect operations to underlying tables.

```sql
CREATE VIEW active_users AS
SELECT id, username, email, status
FROM users
WHERE status = 'active';

CREATE OR REPLACE FUNCTION trg_insert_active_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO users (id, username, email, status, created_at)
    VALUES (NEW.id, NEW.username, NEW.email, 'active', NOW());
    RETURN NEW;
END;
$$;

CREATE TRIGGER insert_active_user
    INSTEAD OF INSERT ON active_users
    FOR EACH ROW
    EXECUTE FUNCTION trg_insert_active_user();

-- Now this works on the view:
INSERT INTO active_users (id, username, email) VALUES (1, 'alice', 'alice@example.com');
```

### Trigger Execution Order

```
BEFORE STATEMENT trigger
  |
  +-- BEFORE ROW trigger (row 1) --> modify NEW or RETURN NULL to skip
  |       DML on row 1
  |       AFTER ROW trigger (row 1)
  |
  +-- BEFORE ROW trigger (row 2) --> modify NEW or RETURN NULL to skip
  |       DML on row 2
  |       AFTER ROW trigger (row 2)
  |
  +-- ... (remaining rows)
  |
AFTER STATEMENT trigger
```

Multiple triggers of the same type on the same table fire in alphabetical order by trigger name.

---

## Trigger Use Cases

### 1. Audit Trails

```sql
-- Audit table
CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    table_name    TEXT NOT NULL,
    action        TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data      JSONB,
    new_data      JSONB,
    changed_by    TEXT NOT NULL DEFAULT CURRENT_USER,
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_table_action ON audit_log(table_name, action);
CREATE INDEX idx_audit_changed_at ON audit_log(changed_at);

-- Generic audit trigger function (works for any table)
CREATE OR REPLACE FUNCTION generic_audit_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log (table_name, action, new_data, changed_by)
        VALUES (TG_TABLE_NAME, 'INSERT', to_jsonb(NEW), CURRENT_USER);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Only log if something actually changed
        IF OLD IS DISTINCT FROM NEW THEN
            INSERT INTO audit_log (table_name, action, old_data, new_data, changed_by)
            VALUES (TG_TABLE_NAME, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), CURRENT_USER);
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log (table_name, action, old_data, changed_by)
        VALUES (TG_TABLE_NAME, 'DELETE', to_jsonb(OLD), CURRENT_USER);
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- Attach to any table
CREATE TRIGGER audit_orders
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW EXECUTE FUNCTION generic_audit_trigger();

CREATE TRIGGER audit_products
    AFTER INSERT OR UPDATE OR DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION generic_audit_trigger();
```

### 2. Computed Columns

```sql
CREATE TABLE products (
    id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    base_price    NUMERIC(10, 2) NOT NULL,
    discount_pct  NUMERIC(5, 2) DEFAULT 0,
    tax_rate      NUMERIC(5, 2) DEFAULT 0.08,
    final_price   NUMERIC(10, 2) GENERATED ALWAYS AS (
        ROUND(base_price * (1 - discount_pct / 100.0) * (1 + tax_rate), 2)
    ) STORED
);

-- For PostgreSQL 14+, use GENERATED ALWAYS AS STORED columns
-- For older versions or complex logic, use a BEFORE trigger:

CREATE OR REPLACE FUNCTION trg_compute_final_price()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.final_price := ROUND(
        NEW.base_price * (1 - NEW.discount_pct / 100.0) * (1 + NEW.tax_rate), 2
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER compute_final_price
    BEFORE INSERT OR UPDATE OF base_price, discount_pct, tax_rate ON products
    FOR EACH ROW
    EXECUTE FUNCTION trg_compute_final_price();
```

### 3. Validation

```sql
CREATE OR REPLACE FUNCTION trg_validate_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_total NUMERIC(12, 2);
    v_credit_limit NUMERIC(12, 2);
BEGIN
    -- Validate total is positive
    IF NEW.total_amount <= 0 THEN
        RAISE EXCEPTION 'Order total must be positive, got %', NEW.total_amount;
    END IF;

    -- Validate customer credit limit
    SELECT credit_limit INTO v_credit_limit
    FROM customers WHERE id = NEW.customer_id;

    IF v_credit_limit IS NOT NULL AND NEW.total_amount > v_credit_limit THEN
        RAISE EXCEPTION 'Order total % exceeds customer credit limit %',
            NEW.total_amount, v_credit_limit;
    END IF;

    -- Validate shipping date is not in the past
    IF NEW.shipping_date < CURRENT_DATE THEN
        RAISE EXCEPTION 'Shipping date cannot be in the past';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER validate_order
    BEFORE INSERT OR UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION trg_validate_order();
```

### 4. Cascading Updates

```sql
CREATE OR REPLACE FUNCTION trg_cascade_category_rename()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Update all products with the old category name
    UPDATE products
    SET category_name = NEW.name
    WHERE category_name = OLD.name;

    -- Log the cascade
    RAISE NOTICE 'Cascaded category rename from "%" to "%"', OLD.name, NEW.name;

    RETURN NEW;
END;
$$;

CREATE TRIGGER cascade_category_rename
    AFTER UPDATE OF name ON categories
    FOR EACH ROW
    EXECUTE FUNCTION trg_cascade_category_rename();
```

### 5. Soft Delete with Timestamp

```sql
CREATE TABLE employees (
    id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE,
    is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at    TIMESTAMPTZ,
    deleted_by    TEXT
);

CREATE OR REPLACE FUNCTION trg_soft_delete_employee()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE employees
    SET is_deleted = TRUE,
        deleted_at = NOW(),
        deleted_by = CURRENT_USER
    WHERE id = OLD.id;

    RETURN NULL;  -- Prevents the actual DELETE
END;
$$;

CREATE TRIGGER soft_delete_employee
    BEFORE DELETE ON employees
    FOR EACH ROW
    EXECUTE FUNCTION trg_soft_delete_employee();
```

---

## Best Practices

### 1. Prefer Constraints Over Triggers

```sql
-- Good: use a CHECK constraint
ALTER TABLE products ADD CONSTRAINT chk_positive_price CHECK (price > 0);

-- Avoid: doing the same in a trigger
-- Triggers are harder to discover and debug
```

### 2. Keep Trigger Functions Idempotent

```sql
-- Good: safe to fire multiple times
NEW.updated_at := NOW();

-- Bad: side effects compound on re-run
NEW.counter := NEW.counter + 1;
```

### 3. Use RETURN NEW / RETURN OLD Correctly

```
BEFORE INSERT/UPDATE:
  RETURN NEW    --> proceed with the row
  RETURN NULL   --> skip the row (silent cancel)

BEFORE DELETE:
  RETURN OLD    --> proceed with the delete
  RETURN NULL   --> skip the delete

AFTER triggers:
  RETURN value is ignored (return NULL conventionally)

INSTEAD OF triggers:
  RETURN NEW    --> signal success
  RETURN NULL   --> signal skip
```

### 4. Avoid Recursive Triggers

```sql
-- Bad: trigger on table fires UPDATE, which fires the same trigger again
-- Good: use WHEN condition or track state
CREATE TRIGGER safe_trigger
    BEFORE UPDATE ON my_table
    FOR EACH ROW
    WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION my_trigger_func();
```

### 5. Use TG_OP for Multi-Operation Triggers

```sql
-- Single function handling multiple operations
IF TG_OP = 'INSERT' THEN
    -- insert logic
ELSIF TG_OP = 'UPDATE' THEN
    -- update logic
ELSIF TG_OP = 'DELETE' THEN
    -- delete logic
END IF;
```

### 6. Performance Considerations

```
Row-level triggers fire ONCE PER ROW.
A bulk UPDATE of 100,000 rows = 100,000 trigger function calls.

Mitigation strategies:
  1. Use STATEMENT-level triggers when row detail is not needed
  2. Batch inserts into a staging table, then process in a single transaction
  3. Use pg_cron or a background worker for deferred processing
  4. Consider logical replication instead of triggers for cross-table sync
```

### 7. Naming Conventions

```
Trigger function:  trg_<table>_<action>
Trigger name:      <action>_<table>
Example:           trg_users_audit, audit_users
```

---

## Gotchas

### 1. Trigger Functions Cannot Be Called Directly

```sql
-- This will fail:
SELECT trg_set_audit_fields();

-- Trigger functions must be invoked through a trigger.
-- If you need reusable logic, separate it into a regular function.
```

### 2. AFTER Triggers See Committed Data Only

Within a transaction, an AFTER trigger on table A cannot see uncommitted
changes to table B from the same transaction. Use `NEW`/`OLD` records instead.

### 3. RETURN NULL in BEFORE Triggers Silently Skips Rows

```sql
-- This silently discards rows where age < 18
CREATE FUNCTION trg_filter_minors() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.age < 18 THEN
        RETURN NULL;  -- Row is silently skipped, no error
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Use RAISE EXCEPTION if you want the operation to fail visibly.
```

### 4. Trigger Order Is Alphabetical

```sql
-- These fire in alphabetical order:
-- 1. trg_a_first
-- 2. trg_b_second
-- 3. trg_c_third

-- Prefix with numbers if order matters:
-- trg_01_validate, trg_02_compute, trg_03_audit
```

### 5. INSTEAD OF Only Works on Views

```sql
-- This will fail:
CREATE TRIGGER my_trigger INSTEAD OF INSERT ON my_table ...

-- INSTEAD OF is only valid on views.
-- For tables, use BEFORE or AFTER.
```

### 6. Triggers and COPY

`COPY` **does** fire `BEFORE ROW` and `AFTER ROW` triggers in PostgreSQL 12+.
In earlier versions, row-level triggers were skipped. Use `COPY` freely when
you need row-level triggers to fire during bulk loads.

### 7. Recursive Triggers Require `ENABLE RECURSIVE TRIGGER`

```sql
ALTER TABLE my_table ENABLE RECURSIVE TRIGGER my_trigger;
-- Default is DISABLE RECURSIVE TRIGGER to prevent infinite loops.
```

### 8. JSON Serialization in Triggers

`row_to_json()` includes all columns, including system columns like `oid` if
present. Use `to_jsonb()` for better performance and omit nulls with
`jsonb_strip_nulls()`.

---

## Key Takeaways

1. Use **functions** for inline computations and **procedures** for transactional workflows with explicit commit control.

2. **BEFORE triggers** modify data before it is written; **AFTER triggers** react to completed changes; **INSTEAD OF triggers** redirect view operations.

3. Prefer **constraints** (CHECK, UNIQUE, FOREIGN KEY) over triggers for data validation. Triggers are harder to discover and maintain.

4. **Row-level triggers** on bulk operations are expensive. Use statement-level triggers or batch processing when possible.

5. Always include **error handling** in trigger functions. An unhandled exception in a trigger aborts the entire transaction.

6. Use **TG_OP**, **TG_TABLE_NAME**, and **TG_NARGS** to write generic trigger functions that work across multiple tables.

7. **Naming triggers with numeric prefixes** (trg_01_, trg_02_) gives you explicit control over execution order.

8. **Test triggers in isolation** using temporary tables and small datasets before applying them to production schemas.

9. Document trigger dependencies. Use `pg_trigger` and `pg_depend` system catalogs to audit trigger relationships.

10. For PostgreSQL 14+, prefer **GENERATED ALWAYS AS STORED** columns over triggers for simple computed values.
