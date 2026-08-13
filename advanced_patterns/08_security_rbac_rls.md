# PostgreSQL Security: RBAC, Row-Level Security, and Authentication

## Table of Contents

1. [Roles and Privileges](#roles-and-privileges)
2. [Schema-Level Permissions](#schema-level-permissions)
3. [Object-Level Permissions](#object-level-permissions)
4. [Row-Level Security Policies](#row-level-security-policies)
5. [Security Definer Functions](#security-definer-functions)
6. [Connection Authentication](#connection-authentication)
7. [Multi-Tenant Application Patterns](#multi-tenant-application-patterns)
8. [Gotchas](#gotchas)
9. [Key Takeaways](#key-takeaways)

---

## Roles and Privileges

PostgreSQL uses a role-based access control model. Roles serve dual purpose: they are both users (login-capable) and groups (collection of roles).

### Creating Roles

```sql
-- Login role (equivalent to CREATE USER)
CREATE ROLE app_user LOGIN PASSWORD 'strong_password';

-- Group role (no login, used for permission grouping)
CREATE ROLE readers NOLOGIN;
CREATE ROLE writers NOLOGIN;
CREATE ROLE admins NOLOGIN;

-- Role with expiration
CREATE ROLE contractor LOGIN PASSWORD 'temp_pass' VALID UNTIL '2025-12-31';

-- Role inheriting from groups
GRANT readers TO app_user;
```

### Privilege Hierarchy

```
                     SUPERUSER
                        |
                        v
    +------------------+------------------+
    |                  |                  |
   CREATOR          OWNTOBJ            BY GRANT
    |                  |                  |
    v                  v                  v
  Implicit         Implicit            Explicit
  Privileges       Privileges          Privileges
```

### GRANT and REVOKE

```sql
-- Standard privileges
GRANT SELECT ON orders TO readers;
GRANT INSERT, UPDATE ON orders TO writers;
GRANT ALL PRIVILEGES ON orders TO admins;

-- Column-level grants (available since PostgreSQL 9.0)
GRANT SELECT (customer_email, ssn) ON customers TO hr_role;

-- Grant with grant option (allows the role to delegate)
GRANT SELECT ON orders TO app_user WITH GRANT OPTION;

-- Revoke
REVOKE INSERT ON orders FROM writers;
REVOKE ALL ON orders FROM contractor;

-- Revoke grant option without revoking the privilege itself
REVOKE GRANT OPTION FOR SELECT ON orders FROM app_user;
```

### Role Membership and Inheritance

```sql
-- By default, roles have INHERIT ON and automatically inherit privileges
CREATE ROLE app_user LOGIN;  -- INHERIT is ON by default
GRANT readers TO app_user;
-- app_user automatically gets readers' privileges (no extra steps needed)

-- To disable inheritance (requires explicit SET ROLE):
ALTER ROLE app_user NOINHERIT;
-- Now app_user must explicitly activate inherited privileges:
SET ROLE readers;
-- Now app_user operates with readers' privileges
RESET ROLE;
-- Returns to original role
```

### Default Privileges

```sql
-- Set default privileges for future objects created by a role
ALTER DEFAULT PRIVILEGES FOR ROLE db_owner
    IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO readers;

-- Scope default privileges to a specific schema
ALTER DEFAULT PRIVILEGES
    IN SCHEMA app_data
    GRANT EXECUTE ON FUNCTIONS TO app_role;
```

---

## Schema-Level Permissions

Schemas are the first boundary for access control. A role needs USAGE on a schema to access objects within it.

```sql
-- Create isolated schemas per tenant or application
CREATE SCHEMA tenant_a;
CREATE SCHEMA tenant_b;
CREATE SCHEMA shared;

-- Grant schema access
GRANT USAGE ON SCHEMA tenant_a TO tenant_a_app;
GRANT USAGE ON SCHEMA shared TO tenant_a_app, tenant_b_app;

-- Grant CREATE to allow object creation within the schema
GRANT CREATE ON SCHEMA tenant_a TO tenant_a_admin;

-- Restrict public schema (PostgreSQL 15+ disables this by default)
REVOKE ALL ON SCHEMA public FROM PUBLIC;
```

### Schema Isolation Pattern

```
Database
  |-- public (restricted)
  |     |-- shared_config  (SELECT only for tenants)
  |     |-- audit_log      (INSERT only for tenants)
  |
  |-- tenant_a
  |     |-- orders          (full access for tenant_a_app)
  |     |-- customers       (full access for tenant_a_app)
  |
  |-- tenant_b
        |-- orders          (full access for tenant_b_app)
        |-- customers       (full access for tenant_b_app)
```

---

## Object-Level Permissions

### Table Permissions

```sql
-- Standard table privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO app_role;
GRANT TRIGGER ON orders TO trigger_role;
GRANT REFERENCES ON customers TO reporting_role;  -- for foreign keys
GRANT ALL ON orders TO db_owner;

-- Sequence permissions
GRANT USAGE, SELECT ON SEQUENCE orders_id_seq TO app_role;

-- View permissions
GRANT SELECT ON v_order_summary TO reporting_role;
```

### Function Permissions

```sql
-- Functions default to PUBLIC EXECUTE; restrict explicitly
GRANT EXECUTE ON FUNCTION calculate_tax(DECIMAL) TO app_role;
REVOKE EXECUTE ON FUNCTION admin_purge_data() FROM PUBLIC;

-- Ownership determines default access
ALTER FUNCTION admin_purge_data() OWNER TO db_admin;
```

### Ownership Transfer

```sql
-- Transfer ownership of a table
ALTER TABLE orders OWNER TO new_owner;

-- Transfer ownership of all tables in a schema
-- (requires scripting; no single SQL command exists)
DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'tenant_a'
    LOOP
        EXECUTE format('ALTER TABLE tenant_a.%I OWNER TO tenant_a_owner', rec.tablename);
    END LOOP;
END $$;
```

---

## Row-Level Security Policies

Row-Level Security (RLS) filters rows at query time based on policies attached to a table.

### Enabling RLS

```sql
-- Enable RLS on a table
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- FORCE RLS so even table owners are subject to policies
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
```

### Creating Policies

```sql
-- Basic policy: users see only their own rows
CREATE POLICY tenant_isolation_policy ON orders
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER);

-- Policy with per-operation conditions
CREATE POLICY tenant_insert_policy ON orders
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::INTEGER);

CREATE POLICY tenant_update_policy ON orders
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::INTEGER);

CREATE POLICY tenant_delete_policy ON orders
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER);
```

### Policy Types and Precedence

```
Policy Evaluation Flow (RLS enabled):

  Query arrives
       |
       v
  +-------------------+
  | Is user the       |---- Yes (and FORCE is OFF) ---> Bypass policies
  | table owner?      |
  +-------------------+
       |
       No
       v
  +-------------------+
  | Match policies    |
  | for this role     |
  | and operation?    |
  +-------------------+
       |
       v
  +-------------------+     +-------------------+
  | No matching       |     | At least one      |
  | policy?           |     | policy passes?    |
  +-------------------+     +-------------------+
       |                        |
       v                        v
  Return nothing           Return matching rows
```

### Per-Role Policies

```sql
-- Admin sees everything
CREATE POLICY admin_full_access ON orders
    FOR ALL
    TO admin_role
    USING (true);

-- Regular users see only their tenant
CREATE POLICY tenant_scoped_access ON orders
    FOR ALL
    TO app_role
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER);

-- Read-only role with restricted columns via view
CREATE POLICY readonly_limited ON orders
    FOR SELECT
    TO reporting_role
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER);
```

### Using session_variables for Tenant Context

```sql
-- Set tenant context at connection time
SET app.current_tenant = '42';

-- RLS policy references the session variable
CREATE POLICY tenant_policy ON orders
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER);

-- Verify RLS is active
SELECT * FROM pg_policies WHERE tablename = 'orders';
```

### FORCE ROW LEVEL SECURITY

```sql
-- Without FORCE: table owner bypasses all policies
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- Owner can still see all rows

-- With FORCE: even the owner is subject to policies
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
-- Owner must satisfy policy conditions like everyone else

-- Common pattern: create a dedicated owner role
CREATE ROLE table_owner NOLOGIN;
ALTER TABLE orders OWNER TO table_owner;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
-- Application roles never own the table, so RLS always applies
```

---

## Security Definer Functions

Security definer functions execute with the privileges of the function owner, not the caller.

### Basic Pattern

```sql
-- Create a function that runs as its owner
CREATE OR REPLACE FUNCTION get_tenant_orders(p_tenant_id INTEGER)
RETURNS TABLE (order_id INTEGER, total DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_schema  -- Critical: prevent search_path injection
AS $$
BEGIN
    RETURN QUERY
    SELECT o.order_id, o.total
    FROM app_schema.orders o
    WHERE o.tenant_id = p_tenant_id;
END;
$$;

-- Restrict who can call it
REVOKE EXECUTE ON FUNCTION get_tenant_orders(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_tenant_orders(INTEGER) TO app_role;
```

### Search Path Injection Prevention

```sql
-- DANGEROUS: attacker can create a malicious table in a prior search_path schema
CREATE OR REPLACE FUNCTION unsafe_update(p_id INTEGER, p_amount DECIMAL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- If attacker creates temp_table in their own schema, this writes there
    INSERT INTO temp_table VALUES (p_id, p_amount);
END;
$$;

-- SAFE: lock the search path
CREATE OR REPLACE FUNCTION safe_update(p_id INTEGER, p_amount DECIMAL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app_schema, pg_temp  -- Explicit, no public
AS $$
BEGIN
    INSERT INTO temp_table VALUES (p_id, p_amount);
END;
$$;
```

### Privileged Data Access Pattern

```sql
-- Function owned by a privileged role
ALTER FUNCTION get_sensitive_data(INTEGER) OWNER TO data_admin;
ALTER FUNCTION get_sensitive_data(INTEGER) SECURITY DEFINER;

-- Caller: app_role (limited privileges)
-- Function runs as: data_admin (full privileges)
-- Result: app_role gets data it could not access directly

-- Caller executes:
SELECT * FROM get_sensitive_data(42);

-- Internally, data_admin runs:
-- SELECT * FROM sensitive_table WHERE id = 42;
```

### Security Invoker (Default)

```sql
-- Default behavior: function runs as the caller
CREATE OR REPLACE FUNCTION get_my_orders()
RETURNS TABLE (order_id INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER  -- This is the default; explicit for clarity
AS $$
BEGIN
    -- Runs with the caller's privileges
    RETURN QUERY
    SELECT order_id FROM orders
    WHERE tenant_id = current_setting('app.current_tenant')::INTEGER;
END;
$$;
```

---

## Connection Authentication

### pg_hba.conf Configuration

The `pg_hba.conf` file controls client authentication. Rules are evaluated top to bottom; first match wins.

```
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local superuser connections (Unix socket)
local   all             postgres                                peer

# Local application connections
local   app_db          app_user                                scram-sha-256

# Trusted internal network
host    app_db          app_user        10.0.0.0/8              scram-sha-256
host    app_db          reader_user     10.0.0.0/8              scram-sha-256

# External connections require client certificates
hostssl app_db          ext_api_user    0.0.0.0/0               cert

# Reject everything else
host    all             all             0.0.0.0/0               reject
```

### Authentication Methods

| Method | Description | Security Level |
|--------|-------------|----------------|
| `trust` | No password required | Low (development only) |
| `reject` | Always deny | N/A |
| `scram-sha-256` | SCRAM authentication (recommended) | High |
| `md5` | MD5 password hash | Medium (deprecated) |
| `password` | Cleartext password (requires SSL) | Medium |
| `cert` | Client certificate | High |
| `peer` | OS user matches DB user (local only) | High |
| `gss` | Kerberos/GSSAPI | High |

### SSL/TLS Configuration

```sql
-- In postgresql.conf
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
ssl_ciphers = 'HIGH:!aNULL:!3DES'  # Exclude weak ciphers (default includes vulnerable 3DES)
ssl_prefer_server_ciphers = on

-- Verify SSL status
SELECT ssl FROM pg_stat_activity WHERE pid = pg_backend_pid();

-- Require SSL for specific connections in pg_hba.conf
hostssl app_db app_user 0.0.0.0/0 scram-sha-256
```

### Connection String Patterns

```
# Application connection (SSL required, SCRAM auth)
postgresql://app_user:password@db.example.com:5432/app_db?sslmode=require

# Read replica with SSL verification
postgresql://reader:password@replica.example.com:5432/app_db?sslmode=verify-full&sslrootcert=ca.crt

# With connection pooling (PgBouncer in transaction mode)
postgresql://app_user:password@pgbouncer.example.com:6432/app_db?sslmode=require
```

---

## Multi-Tenant Application Patterns

### Pattern 1: Single Schema with RLS

Best for: Many small tenants, shared infrastructure.

```sql
-- Unified schema, RLS enforces isolation
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON orders
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant')::INTEGER);

-- Application sets tenant context on every request
-- Middleware: SET app.current_tenant = request.tenant_id;
```

Pros:
- Single codebase, single deployment
- Easy to add/remove tenants
- Shared indexes, shared statistics

Cons:
- RLS adds query planning overhead
- Cross-tenant queries require policy bypass
- Harder to isolate noisy tenants

### Pattern 2: Schema-per-Tenant

Best for: Fewer tenants with strong isolation requirements.

```sql
-- Create tenant schema and migrate objects
CREATE SCHEMA tenant_42;
GRANT USAGE ON SCHEMA tenant_42 TO tenant_42_app;

-- Application routes queries to correct schema
-- Middleware: SET search_path = tenant_42, public;
```

Pros:
- Strong isolation at schema level
- No RLS overhead
- Per-tenant backup and restore

Cons:
- Schema management complexity
- Cross-tenant reporting requires UNION across schemas
- Connection pool fragmentation

### Pattern 3: Database-per-Tenant

Best for: Enterprise tenants with compliance requirements.

```
PostgreSQL Cluster
  |-- db_tenant_a (full isolation)
  |     |-- all tables, dedicated roles
  |-- db_tenant_b (full isolation)
  |     |-- all tables, dedicated roles
  |-- db_reporting (read-only cross-tenant via FDW)
        |-- foreign data wrappers to each tenant DB
```

Pros:
- Maximum isolation
- Independent backup, scaling, and migration
- Compliance-friendly

Cons:
- Highest operational overhead
- Cross-tenant analytics require FDW or ETL
- Resource fragmentation

### Hybrid Pattern: RLS + Schema Segmentation

```sql
-- Sensitive data in restricted schema
CREATE SCHEMA sensitive;
GRANT USAGE ON SCHEMA sensitive TO privileged_app_role;
REVOKE ALL ON SCHEMA sensitive FROM app_role;

-- Standard data with RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Sensitive data accessed via security definer function
CREATE OR REPLACE FUNCTION get_billing_info(p_tenant_id INTEGER)
RETURNS TABLE (billing_id INTEGER, amount DECIMAL)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sensitive, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT billing_id, amount
    FROM sensitive.billing
    WHERE tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_billing_info(INTEGER) TO app_role;
```

---

## Gotchas

### 1. RLS Does Not Apply to Table Owners (Unless Forced)

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
-- The owner of 'orders' bypasses all policies
-- Solution: ALTER TABLE orders FORCE ROW LEVEL SECURITY;
-- Or: transfer ownership to a dedicated role
```

### 2. CASCADE Deletes and RLS

RLS policies on the parent table do not automatically restrict rows deleted via foreign key cascade from a child table. If child deletion triggers parent row removal, the parent RLS policy is not evaluated during the cascade.

### 3. NOINHERIT Roles Require SET ROLE

```sql
CREATE ROLE app_user LOGIN;  -- INHERIT is ON by default
GRANT reader_role TO app_user;
-- app_user automatically inherits reader_role privileges

-- If NOINHERIT is set, privileges are not active until explicitly requested:
ALTER ROLE app_user NOINHERIT;
-- Now app_user must SET ROLE reader_role; explicitly
```

### 4. Security Definer and search_path

A security definer function without an explicit `SET search_path` is vulnerable to search path injection. Always set it explicitly.

```sql
-- Bad
CREATE FUNCTION f() ... SECURITY DEFINER AS $$ ... $$;

-- Good
CREATE FUNCTION f() ... SECURITY DEFINER SET search_path = app, pg_temp AS $$ ... $$;
```

### 5. GRANT ON ALL TABLES Does Not Cover Future Tables

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader;
-- Only covers tables that exist NOW
-- New tables require: ALTER DEFAULT PRIVILEGES ...
```

### 6. RLS and Bulk Operations

RLS policies apply to `COPY`, `INSERT ... SELECT`, and `CREATE TABLE ... AS` when the role is subject to RLS. This can silently filter data during bulk operations.

### 7. pg_hba.conf First Match Wins

Rules are evaluated in order. A broad `trust` rule placed before a specific `scram-sha-256` rule will authenticate all matching connections without a password.

### 8. Temporary Tables and RLS

RLS policies do not apply to temporary tables. If an application uses temp tables for intermediate processing, data from other tenants could leak if the temp table is populated from a non-RLS-protected source.

### 9. REVOKE Does Not Terminate Active Sessions

```sql
REVOKE ALL ON orders FROM app_user;
-- Existing connections retain their current privileges until disconnected
-- To enforce immediately, terminate sessions:
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = 'app_user';
```

### 10. SUPERUSER Bypasses Everything

A superuser bypasses all permission checks, RLS policies, and security definer restrictions. Never grant superuser to application roles.

---

## Key Takeaways

1. **Principle of least privilege**: Grant only the permissions each role actually needs. Start with nothing and add explicitly.

2. **Use roles as groups**: Create group roles (NOLOGIN) for permission management, then assign them to login roles. This avoids per-user permission drift.

3. **FORCE ROW LEVEL SECURITY when ownership is shared**: If the application connection role owns tables, use FORCE or transfer ownership to a dedicated role.

4. **Always set search_path in security definer functions**: This is the most common security vulnerability in PostgreSQL applications.

5. **Prefer scram-sha-256 over md5**: PostgreSQL 14+ defaults to scram-sha-256, which provides stronger password authentication.

6. **Use ALTER DEFAULT PRIVILEGES**: Prevents the common mistake of granting permissions on existing tables but forgetting future ones.

7. **Restrict the public schema**: Revoke all permissions on the public schema from the PUBLIC role to prevent accidental object creation and access.

8. **Test RLS as the target role**: Always verify policies by connecting as the restricted role, not as a superuser. Use `SET ROLE` for quick testing.

9. **Audit with pg_stat_activity and pg_stat_user_tables**: Monitor who is accessing what and when to detect permission issues early.

10. **Document your permission model**: As the role hierarchy grows, maintain a diagram of role relationships and their intended access boundaries.

### Quick Reference: Permission Checklist

```
[ ] Revoke ALL on SCHEMA public FROM PUBLIC
[ ] Create group roles (NOLOGIN) for each access tier
[ ] Grant schema USAGE only to roles that need it
[ ] Set ALTER DEFAULT PRIVILEGES for new objects
[ ] Enable RLS on multi-tenant tables
[ ] Set FORCE ROW LEVEL SECURITY where appropriate
[ ] Set search_path on all SECURITY DEFINER functions
[ ] Configure pg_hba.conf with scram-sha-256
[ ] Enable SSL for all external connections
[ ] Remove SUPERUSER from application roles
[ ] Audit pg_hba.conf ordering (first match wins)
[ ] Test all policies as the target role
```
