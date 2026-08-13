-- ============================================
-- PostgreSQL Server Commands Reference
-- ============================================

-- Server Information
show all; -- display all runtime configuration parameters
show server_encoding; -- show server character encoding
show timezone; -- show current time zone setting
show server_version; -- show PostgreSQL version string
select version(); -- detailed version info as query result

-- Configuration Settings
show data_directory; -- show data directory path
show hba_file; -- show pg_hba.conf location
show config_file; -- show postgresql.conf location
show port; -- show listening port
show max_connections; -- show maximum allowed connections
show shared_buffers; -- show shared memory buffer size
show work_mem; -- show memory per sort/hash operation
show maintenance_work_mem; -- show memory for maintenance operations
show effective_cache_size; -- show estimated OS cache size
show random_page_cost; -- show cost of sequential vs random page fetch
show seq_page_cost; -- show cost of sequential page fetch
show log_statement; -- show SQL statement logging level
show log_min_duration_statement; -- show threshold for slow query logging
show statement_timeout; -- show query execution timeout
show lock_timeout; -- show lock acquisition timeout
show idle_in_transaction_session_timeout; -- show idle transaction timeout

-- Database Information
select datname from pg_database; -- list all databases
select datname, pg_database_size(datname) as size, pg_get_userbyid(datdba) as owner, datcollate, datctype
from pg_database; -- list databases with details
select current_database(); -- show current database
select current_schema(); -- show current schema
select schema_name from information_schema.schemata; -- list all schemas

-- Table Information
select table_name from information_schema.tables where table_schema = 'public'; -- list public tables
select table_name, table_schema, table_type
from information_schema.tables where table_schema = 'public'; -- list tables with details
select column_name, data_type, character_maximum_length, is_nullable, column_default
from information_schema.columns where table_name = 'table_name' order by ordinal_position; -- describe table structure
select indexname, indexdef from pg_indexes where tablename = 'table_name'; -- list indexes for a table
select relname as table_name, indexrelname as index_name, idx_scan, idx_tup_read, idx_tup_fetch,
pg_size_pretty(pg_relation_size(i.indexrelid)) as index_size
from pg_stat_user_indexes i
join pg_stat_user_tables t on i.relid = t.relid
where t.relname = 'table_name'; -- list indexes with usage stats and size

-- Column Information
select column_name, data_type, is_nullable, column_default
from information_schema.columns where table_name = 'table_name'; -- list columns with details
select attname, format_type(atttypid, atttypmod) as data_type, attnotnull
from pg_attribute where attrelid = 'table_name'::regclass and attnum > 0; -- detailed column info from system catalog

-- User and Role Management
select usename from pg_user; -- list all users
select r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
array_agg(parent.rolname) filter (where parent.rolname is not null) as member_of
from pg_roles r
left join pg_auth_members m on r.oid = m.member
left join pg_roles parent on m.roleid = parent.oid
group by r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin; -- list roles with memberships
create user username with password 'password'; -- create new user
alter user username with password 'newpassword'; -- change user password
alter user username with superuser; -- grant superuser privileges
alter user username with createdb; -- grant database creation privilege
drop user username; -- drop user
revoke all privileges on all tables in schema public from username; -- revoke privileges

-- Connection Management
select pid, usename, datname, state, query, query_start, state_change
from pg_stat_activity; -- show all active connections
select count(*) from pg_stat_activity; -- count active connections
select pg_terminate_backend(pid); -- terminate a specific connection
select pg_terminate_backend(pid) from pg_stat_activity where state = 'idle' and query_start < now() - interval '1 hour'; -- terminate idle connections older than 1 hour
select pg_cancel_backend(pid); -- cancel current query without terminating connection

-- Database Operations
create database dbname owner username; -- create database with owner
alter database dbname rename to newdbname; -- rename database
drop database dbname; -- drop database
vacuum verbose; -- reclaim storage and update statistics
vacuum analyze; -- reclaim storage and update query planner statistics
analyze; -- update query planner statistics only

-- Index Operations
create index idx_name on table_name(column_name); -- create standard B-tree index
create unique index idx_name on table_name(column_name); -- create unique index
create index idx_name on table_name using hash(column_name); -- create hash index
create index idx_name on table_name using gin(column_name); -- create GIN index (for full-text search, arrays, JSON)
create index idx_name on table_name using gist(column_name); -- create GiST index (for geometric, range types)
create index idx_name on table_name(column_name asc nulls last); -- create index with sort order
create index idx_name on table_name(column1, column2); -- create composite index
create index idx_name on table_name((lower(column_name))); -- create functional index
drop index idx_name; -- drop index
drop index if exists idx_name; -- drop index if exists
reindex index idx_name; -- rebuild index
reindex table table_name; -- rebuild all indexes on table
reindex database dbname; -- rebuild all indexes in database

-- View Operations
create view view_name as select * from table_name where condition; -- create view
create or replace view view_name as select * from table_name; -- create or replace view
create view view_name as select * from table_name with check option; -- create view with insert/update checks
create view view_name as select * from table_name with cascaded check option; -- propagate checks to underlying views
create or replace view view_name with (security_invoker = true) as select * from table_name; -- view runs with invoker's privileges
create or replace view view_name with (security_invoker = false) as select * from table_name; -- default: view uses owner's privileges
drop view view_name; -- drop view
drop view if exists view_name cascade; -- drop view and dependent objects

-- Sequence Operations
create sequence seq_name start with 1 increment by 1; -- create sequence
alter sequence seq_name restart with 100; -- restart sequence
drop sequence seq_name; -- drop sequence
select nextval('seq_name'); -- get next value (increments)
select currval('seq_name'); -- get current value in session
select setval('seq_name', 100); -- set current value (without incrementing)
select setval('seq_name', 100, true); -- set current value (as if already consumed)

-- Constraint Operations
alter table table_name add constraint fk_name foreign key (column_id) references other_table(id); -- add foreign key
alter table table_name add constraint chk_name check (condition); -- add check constraint
alter table table_name add constraint uq_name unique (column1, column2); -- add unique constraint
alter table table_name drop constraint constraint_name; -- drop constraint
set constraints all deferred; -- defer all constraints to end of transaction
set constraints constraint_name deferred; -- defer specific constraint

-- Performance and Query Analysis
explain select * from table_name; -- show query execution plan
explain analyze select * from table_name; -- show execution plan with actual runtime stats
explain (analyze, buffers, timing, format json) select * from table_name; -- detailed execution plan as JSON
explain (analyze, format text) select * from table_name; -- detailed execution plan as text
select * from pg_stat_user_tables order by seq_scan desc; -- tables with most sequential scans
select * from pg_stat_user_indexes where idx_scan = 0; -- unused indexes
select schemaname, relname, seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del
from pg_stat_user_tables order by (n_tup_ins + n_tup_upd + n_tup_del) desc; -- most modified tables

-- Backup and Restore (run outside psql, in shell)
-- pg_dump dbname > backup.sql -- logical backup of single database
-- pg_dump --format=custom dbname > backup.dump -- compressed custom format backup
-- pg_dump --format=directory --file=backup_dir dbname -- directory format for parallel restore
-- pg_dumpall > all_databases.sql -- backup all databases including roles
-- pg_restore --dbname=dbname backup.dump -- restore from custom format
-- pg_restore --clean --if-exists --dbname=dbname backup.dump -- restore with clean existing objects
-- pg_basebackup --format=tar --gzip --pgdata=backup_dir -- physical backup for point-in-time recovery

-- Point-in-Time Recovery Settings
show wal_level; -- show WAL level (needs 'replica' or 'logical' for PITR)
show max_wal_size; -- show maximum WAL size before forced checkpoint
show min_wal_size; -- show minimum WAL size to retain
show checkpoint_completion_target; -- show checkpoint spread target (0.0-1.0)
show max_wal_senders; -- show maximum WAL sender processes
show wal_keep_size; -- show WAL retention size

-- Full-Text Search
select to_tsvector('english', 'The quick brown fox'); -- tokenize text into tsvector
select to_tsquery('english', 'quick & fox'); -- create search query
select text_column @@ to_tsquery('english', 'search & terms') from table_name; -- full-text search
select ts_rank(to_tsvector('english', text_column), to_tsquery('english', 'search & terms')) as rank, text_column
from table_name where text_column @@ to_tsquery('english', 'search & terms') order by rank desc; -- ranked search
select websearch_to_tsquery('english', '"exact phrase" & word1 | word2'); -- natural language search query

-- JSON Operations
select jsonb_pretty('{"key": [1, 2, 3]}'::jsonb); -- format JSONB for display
select '{"key": "value"}'::jsonb -> 'key'; -- get JSON value as JSON
select '{"key": "value"}'::jsonb ->> 'key'; -- get JSON value as text
select '{"key": [1, 2, 3]}'::jsonb @> '{"key": [2]}'; -- check whether a nested array contains a value
select jsonb_path_query('{"key": [1, 2, 3]}', '$.key[*]'); -- JSON path query

-- Partitioning
select parent.relname as parent_table, child.relname as child_table
from pg_inherits
join pg_class parent on pg_inherits.inhparent = parent.oid
join pg_class child on pg_inherits.inhrelid = child.oid; -- list partitioned tables and partitions
alter table table_name attach partition partition_name for values from (start) to (end); -- attach partition
alter table table_name detach partition partition_name; -- detach partition

-- Advisory Locks (application-level locking)
select pg_try_advisory_lock(12345); -- try to acquire lock (non-blocking)
select pg_advisory_lock(12345); -- acquire lock (blocking)
select pg_advisory_unlock(12345); -- release lock
select pg_advisory_unlock_all(); -- release all advisory locks in session

-- Server Maintenance
select pg_checkpoint(); -- request immediate checkpoint (superuser only)
select pg_switch_wal(); -- switch to new WAL segment (superuser only)
select pg_rotate_logfile(); -- rotate log file (superuser only)
select pg_reload_conf(); -- reload configuration files (superuser only)
select pg_is_in_recovery(); -- check if server is in recovery mode
select pg_current_wal_lsn(); -- show current WAL position
select pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as lag_bytes
from pg_stat_replication; -- show replication lag

-- Extension Management
select name, default_version, installed_version from pg_available_extensions; -- list available extensions
select e.extname, e.extversion, e.extrelocatable, r.rolname as owner
from pg_extension e
join pg_roles r on e.extowner = r.oid; -- list installed extensions with details
create extension if not exists pg_trgm; -- create extension (trigram matching)
create extension if not exists hstore; -- create extension (key-value pairs)
create extension if not exists tablefunc; -- create extension (table-returning functions)
create extension if not exists btree_gin; -- create extension (B-tree operators in GIN)
create extension if not exists btree_gist; -- create extension (B-tree operators in GiST)
alter extension ext_name update; -- update extension
drop extension if exists ext_name; -- drop extension

-- Listen/Notify (pub-sub messaging)
listen channel_name; -- listen for notifications on channel
notify channel_name; -- send notification on channel
notify channel_name, 'payload_data'; -- send notification with payload
unlisten channel_name; -- stop listening on channel
unlisten *; -- stop listening on all channels
