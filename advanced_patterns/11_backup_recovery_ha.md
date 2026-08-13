# PostgreSQL Backup, Recovery, and High Availability

## Table of Contents

1. [Backup Types](#backup-types)
2. [Point-in-Time Recovery (PITR)](#point-in-time-recovery-pitr)
3. [High Availability Patterns](#high-availability-patterns)
4. [Failover Strategies](#failover-strategies)
5. [Read Replicas](#read-replicas)
6. [Backup Best Practices](#backup-best-practices)
7. [Gotchas](#gotchas)
8. [Key Takeaways](#key-takeaways)

---

## Backup Types

### Logical Backups

Logical backups extract database content as SQL statements or custom formats. They operate at the SQL level and are database-version portable.

#### pg_dump

Backs up a single database. Supports multiple output formats.

```bash
# Plain SQL format
pg_dump -h localhost -U postgres mydb > mydb.sql

# Custom format (recommended for large databases)
pg_dump -Fc -Z 9 -h localhost -U postgres mydb > mydb.dump

# Directory format (parallel compression, resumable)
pg_dump -Fd -j 4 -h localhost -U postgres mydb -f mydb_dir/

# Schema only
pg_dump --schema-only -h localhost -U postgres mydb > mydb_schema.sql

# Data only
pg_dump --data-only -h localhost -U postgres mydb > mydb_data.sql

# Specific tables
pg_dump -t users -t orders -h localhost -U postgres mydb > selected_tables.dump
```

Restore from custom format:

```bash
pg_restore -Fc -h localhost -U postgres -d mydb mydb.dump

# With parallel workers and clean existing data
pg_restore -Fc -j 4 --clean --if-exists -h localhost -U postgres -d mydb mydb.dump
```

#### pg_dumpall

Backs up all databases plus global objects (roles, tablespaces).

```bash
pg_dumpall -h localhost -U postgres > all_databases.sql

# Restore (must run as superuser)
psql -h localhost -U postgres -f all_databases.sql
```

**Limitations of logical backups:**

- No WAL-level granularity; cannot do point-in-time recovery
- Slower for large databases
- Does not preserve binary identical data (float rounding, toast compression)
- `pg_dumpall` captures roles but not OS-level mappings (ident authentication)

### Physical Backups

Physical backups copy the raw data files. They are binary-identical and support PITR.

#### pg_basebackup

Creates a full base backup of the PostgreSQL cluster.

```bash
# Basic base backup
pg_basebackup -h localhost -U replicator -D /backups/base -Ft -z -P

# With WAL included (standalone backup)
pg_basebackup -h localhost -U replicator -D /backups/base -Ft -z -P -X fetch

# To a directory (tar format not needed)
pg_basebackup -h localhost -U replicator -D /backups/base_dir -Fp -X stream -P

# Verify backup checksums
pg_basebackup -h localhost -U replicator -D /backups/base -Ft -z -P -c fast
```

The `-c fast` option takes a checkpoint, minimizing I/O impact. Use `-c spread` during maintenance windows.

#### Continuous Archiving (WAL Archiving)

Continuous archiving ships WAL segments to a safe location, enabling PITR.

Configure in `postgresql.conf`:

```ini
wal_level = replica
archive_mode = on
archive_command = 'cp %p /srv/archived_wal/%f'
archive_timeout = 60
```

For cloud storage (using `aws-cli`):

```ini
archive_command = 'aws s3 cp %p s3://my-wal-archive/%f'
```

For a production-grade archive command with safety checks:

```bash
archive_command = 'test ! -f /srv/archived_wal/%f && cp %p /srv/archived_wal/%f'
```

Verify archiving is working:

```sql
SELECT pg_switch_wal();
SELECT * FROM pg_stat_archiver;
```

Expected output shows `archived_count` incrementing and `last_archived_wal` updating.

---

## Point-in-Time Recovery (PITR)

PITR restores the database to a specific moment by replaying WAL segments from a base backup.

### Architecture

```
Base Backup ----> WAL Segment 001 ----> WAL Segment 002 ----> WAL Segment 003
    |                 |                     |                     |
  t=10:00          t=10:05              t=10:10              t=10:15
                                                           ^
                                                         Restore
                                                         to 10:12
```

### Step-by-Step PITR Recovery

```bash
# 1. Stop PostgreSQL
systemctl stop postgresql

# 2. Move or remove the current data directory
mv /var/lib/postgresql/14/main /var/lib/postgresql/14/main.failed

# 3. Restore the base backup
mkdir -p /var/lib/postgresql/14/main
tar -xf /backups/base/base.tar.gz -C /var/lib/postgresql/14/main/

# 4. Configure recovery settings in postgresql.conf
# (PostgreSQL 12+ uses recovery.conf merged into postgresql.conf)
```

Add to `postgresql.conf`:

```ini
restore_command = 'cp /srv/archived_wal/%f %p'
recovery_target_time = '2025-01-15 14:30:00 UTC'
```

Alternative recovery targets:

```ini
# Recover to a named restore point
recovery_target_name = 'before_migration'

# Recover to a specific transaction ID
recovery_target_xid = '640A0001'

# Stop recovery as soon as a consistent state is reached (useful for failover testing)
recovery_target = 'immediate'

# To recover to the latest WAL position, don't set any recovery target

# Pause at recovery target for verification
recovery_target_action = 'promote'
```

```bash
# 5. Start PostgreSQL (enters recovery mode)
systemctl start postgresql

# 6. Verify recovery status
SELECT pg_is_in_recovery();
# Returns true while in recovery

# 7. Once satisfied, promote to primary (if recovery_target_action = 'pause')
SELECT pg_promote();
```

### Creating Restore Points

```sql
-- Create a named restore point before a risky operation
SELECT pg_create_restore_point('before_data_migration');

-- Force a WAL switch to ensure the restore point is archived
SELECT pg_switch_wal();
```

### PITR from Cloud Storage

```bash
# Using pgbackrest (recommended tool for production)
pgbackrest --stanza=mycluster --type=full backup

# Restore to specific time
pgbackrest --stanza=mycluster --type=stanza \
  --set=20250115-100000F \
  --type=time --target="2025-01-15 14:30:00" \
  restore
```

---

## High Availability Patterns

### Streaming Replication

Synchronous and asynchronous WAL shipping from primary to standby(s).

```
                    +-----------+
                    |  Primary  |
                    | (Writer)  |
                    +-----+-----+
                          | WAL stream
              +-----------+-----------+
              |                       |
      +-------v-------+       +-------v-------+
      |   Standby 1   |       |   Standby 2   |
      |   (Async)     |       |   (Sync)      |
      +---------------+       +---------------+
```

#### Primary Configuration (`postgresql.conf`)

```ini
wal_level = replica
max_wal_senders = 10
wal_keep_size = 1GB
hot_standby = on

# Synchronous replication settings
synchronous_standby_names = 'standby_sync'
# Options: 'standby1,standby2' (ANY 1 of 2)
#          'FIRST 2 (standby1,standby2,standby3)'
```

#### Standby Setup

```bash
# Method 1: pg_basebackup from primary
pg_basebackup -h primary_host -U replicator -D /var/lib/postgresql/14/main \
  -Fp -X stream -P -R

# The -R flag creates standby.signal and sets primary_conninfo

# Method 2: Filesystem-level copy (rsync, ZFS send, etc.)
rsync -avz --inplace primary_host:/var/lib/postgresql/14/main/ \
  /var/lib/postgresql/14/main/
touch /var/lib/postgresql/14/main/standby.signal
```

#### Standby Configuration (`postgresql.conf`)

```ini
primary_conninfo = 'host=primary_host port=5432 user=replicator password=secret'
hot_standby = on
hot_standby_feedback = on

# Recovery settings (merged into postgresql.conf in PG12+)
restore_command = 'cp /srv/archived_wal/%f %p'
```

The `standby.signal` file tells PostgreSQL to start in recovery mode. Remove it to promote.

#### Promotion Methods

```bash
# Method 1: pg_ctl promote (manual)
pg_ctl -D /var/lib/postgresql/14/main promote

# Method 2: Create promote signal file
touch /var/lib/postgresql/14/main/promote

# Method 3: SQL function
SELECT pg_promote();
```

#### Monitor Replication Lag

```sql
-- On primary
SELECT
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn,
  write_lag,
  flush_lag,
  replay_lag,
  sync_state
FROM pg_stat_replication;

-- On standby (pg_stat_replication is only available on the primary)
-- Use these scalar functions instead to check replication lag:
SELECT
  pg_current_wal_lsn() AS current_lsn,
  pg_last_wal_receive_lsn() AS last_received_lsn,
  pg_last_wal_replay_lsn() AS last_replayed_lsn,
  pg_wal_lsn_diff(pg_current_wal_lsn(), pg_last_wal_replay_lsn()) AS replay_lag_bytes;

-- Or check recovery state:
SELECT pg_is_in_recovery();
```

### Logical Replication

Replicates specific tables across clusters, potentially different PostgreSQL versions.

```
  +-----------+      +-----------+      +-----------+
  | Publisher |----->| Subscriber|      | Subscriber|
  | (Cluster A)|     | (Cluster B)|     | (Cluster C)|
  +-----------+      +-----------+      +-----------+
```

#### Setup

```sql
-- On publisher
ALTER SYSTEM SET max_replication_slots = 10;
ALTER SYSTEM SET wal_level = logical;
SELECT pg_reload_conf();

-- Create publication
CREATE PUBLICATION all_tables FOR ALL TABLES;
CREATE PUBLICATION user_pub FOR TABLE users, orders;
CREATE PUBLICATION filtered_pub FOR TABLE orders
  WITH (publish = 'insert, update');

-- Create replication slot
SELECT pg_create_logical_replication_slot('sub1_slot', 'pgoutput');
```

```sql
-- On subscriber
CREATE SUBSCRIPTION sub1
  CONNECTION 'host=publisher_host port=5432 dbname=mydb user=replicator'
  PUBLICATION all_tables
  WITH (copy_data = true, create_slot = true);

-- Pause/resume subscription
ALTER SUBSCRIPTION sub1 DISABLE;
ALTER SUBSCRIPTION sub1 ENABLE;

-- Check subscription status
SELECT * FROM pg_stat_subscription;
```

### Patroni

Patroni provides automatic failover with DCS (etcd, Consul, ZooKeeper, or PostgreSQL itself).

```
  +-----+     +----------+     +-----------+
  |App  |---> | Patroni  |---> | PostgreSQL |
  |     |     | Leader   |     | (Primary)  |
  +-----+     +----------+     +-----------+
                     |
              +------+------+
              |             |
       +------+------+  +---+------+
       | Patroni   |  | Patroni    |
       | Standby   |  | Standby    |
       +-----------+  +------------+
```

#### Minimal Configuration (`patroni.yml`)

```yaml
namespace: /service/
name: postgresql-1
scope: mycluster

restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.1.1:8008

etcd3:
  host: etcd-host:2379

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.1.1:5432
  data_dir: /var/lib/postgresql/14/main
  pgpass: /var/lib/postgresql/.pgpass
  authentication:
    replication:
      username: replicator
      password: secret
    superuser:
      username: postgres
      password: secret
  parameters:
    unix_socket_directories: "/var/run/postgresql"
    max_replication_slots: 10
    wal_level: replica
    hot_standby: "on"
  create_replica_methods:
    - basebackup
  basebackup:
    max_rate: 100M
  tags:
    nofailover: false
    noloadbalance: false
    clonefrom: false
    nosync: false
```

#### Patroni CLI

```bash
# Check cluster status
patronictl -c patroni.yml list

# Manual failover
patronictl -c patroni.yml failover mycluster

# Reload configuration
patronictl -c patroni.yml reload mycluster postgresql-2

# Pause automatic failover for maintenance
patronictl -c patroni.yml pause mycluster
```

### pgpool-II

Connection pooling and load balancing middleware for PostgreSQL.

```
  +-----+    +-----+    +-----+
  | App |    | App |    | App |
  +--+--+    +--+--+    +--+--+
     |         |         |
     +----+----+----+----+
          |         |
   +------v---------v------+
   |      pgpool-II        |
   |  (Pool + Load Balance)|
   +-------+-------+-------+
           |       |
   +-------v-+ +---v-------+
   | Primary | |  Standby  |
   | (Write) | | (Read)    |
   +---------+ +-----------+
```

#### Key Configuration (`pgpool.conf`)

```ini
listen_addresses = '*'
port = 9999

# Backend nodes
backend_hostname0 = 'primary_host'
backend_port0 = 5432
backend_weight0 = 1
backend_data_directory0 = '/var/lib/postgresql/14/main'
backend_flag0 = ALLOW_TO_FAILOVER

backend_hostname1 = 'standby_host'
backend_port1 = 5432
backend_weight1 = 1
backend_data_directory1 = '/var/lib/postgresql/14/main'
backend_flag1 = ALLOW_TO_FAILOVER

# Load balancing
load_balance_mode = on
replication_mode = off

# Health checks
health_check_period = 10
health_check_timeout = 20
health_check_user = 'pool_user'
health_check_password = 'secret'

# Connection pooling
max_pool = 4
child_life_time = 300
connection_life_time = 0
```

```bash
# Check node status
pcp_node_info -h localhost -p 9898 -U pcp_admin -n 0

# Attach/detach a node
pcp_attach_node -h localhost -p 9898 -U pcp_admin -n 1
pcp_detach_node -h localhost -p 9898 -U pcp_admin -n 1
```

---

## Failover Strategies

### Synchronous vs Asynchronous Replication Tradeoffs

| Aspect | Synchronous | Asynchronous |
|---|---|---|
| Data safety | No data loss | Potential data loss |
| Write latency | Higher (waits for standby ACK) | Lower |
| Availability | Standby failure blocks writes | Primary continues independently |
| Use case | Financial, compliance | Analytics, general purpose |

### Quorum Synchronous Replication (PostgreSQL 13+)

```ini
synchronous_standby_names = 'ANY 2 (standby1, standby2, standby3)'
```

This requires at least 2 of 3 standbys to acknowledge, tolerating 1 failure while preventing data loss.

### Failover Decision Tree

```
Primary fails
    |
    v
Is there a sync standby?
    |-- Yes --> Promote sync standby (zero data loss)
    |
    |-- No --> Check async standbys
                |
                v
            Any async standby?
                |-- Yes --> Promote most-up-to-date (check replay_lag)
                |           Accept potential data loss
                |
                |-- No --> PITR from latest backup + WAL archive
```

### Automated Failover with pg_auto_failover

```sql
-- Install extension (valid SQL — creates the extension in the current database)
-- Note: pg_auto_failover also requires a separate monitor service to be set up.
CREATE EXTENSION pg_auto_failover;
```

```bash
# Initialize monitor
pg_autoctl create monitor --auth trust \
  --dsn "postgres://monitor-host:5432" \
  -d postgres

# Create primary
pg_autoctl create primary --auth trust \
  --dsn "postgres://primary-host:5432" \
  --pgdata /var/lib/postgresql/14/main \
  -d mydb

# Create replica
pg_autoctl create replica --auth trust \
  --dsn "postgres://standby-host:5432" \
  --pgdata /var/lib/postgresql/14/main \
  -d mydb
```

---

## Read Replicas

### Routing Read Queries

Using `PGROUNDSNIP` connection string with application-level routing:

```python
# Example: Python with psycopg2
import psycopg2
import random

WRITER = "host=primary port=5432 dbname=mydb user=app"
READERS = [
    "host=standby1 port=5432 dbname=mydb user=app",
    "host=standby2 port=5432 dbname=mydb user=app",
]

def get_connection(read_only=True):
    if read_only:
        dsn = random.choice(READERS)
    else:
        dsn = WRITER
    return psycopg2.connect(dsn)
```

### Detecting Standby in Application

```sql
-- Check if current connection is on a standby
SELECT pg_is_in_recovery();
-- Returns: true on standby, false on primary

-- Check replication lag before routing reads
SELECT
  pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
FROM pg_stat_replication
WHERE application_name = 'standby1';
```

### Read Replica Gotchas

- Autovacuum runs on standbys but may conflict with replay; set `hot_standby_feedback = on`
- Long-running queries on standby can delay vacuum on primary
- Temporary tables and sequences behave differently on replicas
- `pg_stat_activity` shows queries from the local server only

---

## Backup Best Practices

### 3-2-1 Rule

- **3** copies of data (production + 2 backups)
- **2** different storage media
- **1** offsite copy

### Recommended Backup Schedule

```bash
# /etc/cron.d/postgres-backups

# Full base backup weekly (Sunday 2 AM)
0 2 * * 0 postgres pg_basebackup -h localhost -U replicator \
  -D /backups/weekly/$(date +\%Y\%m\%d) -Ft -z -P -c fast

# WAL archive continuously (handled by archive_command)

# pg_dump of critical databases daily (3 AM)
0 3 * * * postgres pg_dump -Fc -Z 9 -h localhost -U postgres \
  critical_db > /backups/daily/critical_$(date +\%Y\%m\%d).dump

# Verify backup integrity weekly
0 4 * * 1 postgres pg_restore --list /backups/daily/critical_latest.dump > /dev/null
```

### Backup Verification

```sql
-- Test restore to a separate cluster periodically
-- Automate with a script:
```

```bash
#!/bin/bash
# test_restore.sh - Verify backup integrity
TEST_DB="restore_test"
BACKUP_FILE="/backups/daily/critical_latest.dump"

psql -U postgres -c "DROP DATABASE IF EXISTS ${TEST_DB};"
psql -U postgres -c "CREATE DATABASE ${TEST_DB};"
pg_restore -Fc -d "${TEST_DB}" "${BACKUP_FILE}"

# Run a few verification queries
psql -U postgres -d "${TEST_DB}" -c "SELECT count(*) FROM users;"
psql -U postgres -c "DROP DATABASE ${TEST_DB};"
```

### Essential Monitoring Queries

```sql
-- Check WAL archive status
SELECT
  archived_count,
  failed_count,
  last_archived_wal,
  last_archived_time,
  last_failed_wal,
  last_failed_time
FROM pg_stat_archiver;

-- Check replication status
SELECT
  pid,
  usename,
  application_name,
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn,
  write_lag,
  flush_lag,
  replay_lag,
  sync_priority,
  sync_state
FROM pg_stat_replication;

-- Check replication slots (prevent WAL bloat)
SELECT
  slot_name,
  plugin,
  slot_type,
  active,
  restart_lsn,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes
FROM pg_replication_slots;

-- Check table bloat (indicates vacuum issues on replicas)
SELECT
  schemaname,
  relname,
  n_dead_tup,
  last_vacuum,
  last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;
```

### Tools Comparison

| Tool | Type | PITR | Compression | Parallel | Cloud |
|---|---|---|---|---|---|
| pg_dump | Logical | No | Basic | No (per table) | Manual |
| pg_basebackup | Physical | With WAL | gzip/zstd | No | Manual |
| pgBackRest | Physical | Yes | gzip/zstd/lz4 | Yes | S3, Azure, GCS |
| Barman | Physical | Yes | gzip/zstd | Yes | S3, Azure, GCS |
| WAL-G | Physical | Yes | gzip/zstd/lz4 | Yes | S3, GCS, Azure |

---

## Gotchas

### WAL Archive Gotchas

1. **archive_command must exit 0 on success.** Any non-zero exit code means the WAL segment is retried indefinitely, filling the WAL directory.

```ini
# WRONG: will fail silently on overwrite
archive_command = 'cp %p /archive/%f'

# CORRECT: check existence first
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
```

2. **WAL segments accumulate if archive_command fails.** Monitor `pg_wal` directory size. If it grows unbounded, archiving is broken.

3. **`archive_timeout` creates partial WAL segments.** Lower values mean faster PITR granularity but more archive traffic. Default is 0 (no forced switch).

### Replication Gotchas

4. **Replication slots prevent WAL cleanup.** An inactive slot holds all WAL since its `restart_lsn`, growing indefinitely. Always drop unused slots:

```sql
SELECT pg_drop_replication_slot('orphaned_slot');
```

5. **`max_slot_wal_keep_size`** (PG14+) limits WAL retention per slot. Set it to prevent disk exhaustion:

```ini
max_slot_wal_keep_size = 10GB
```

6. **Schema changes must go through the primary.** DDL on a standby is rejected. For logical replication, schema changes require careful ordering.

7. **Synchronous replication blocks writes if all sync standbys are down.** The primary hangs waiting for acknowledgment. Use `synchronous_standby_names = ''` temporarily during maintenance.

### Recovery Gotchas

8. **PITR requires a contiguous WAL archive.** If any WAL segment is missing, recovery stops at that point. Verify archive integrity regularly.

9. **`recovery_target_time` must be after the base backup's checkpoint time.** Check with:

```sql
SELECT pg_start_backup('check', true);
-- Note the timestamp, then:
SELECT pg_stop_backup();
```

10. **After PITR, the cluster is a new timeline.** Old WAL archives from the previous timeline are not replayable. The `backup_label` file records the timeline ID.

### Performance Gotchas

11. **Base backups cause a checkpoint.** Use `-c fast` for minimal impact, or schedule during low-traffic windows.

12. **Streaming replication adds network overhead.** On high-write workloads, ensure network bandwidth between primary and standby is sufficient.

13. **Logical replication has higher CPU overhead than streaming.** It parses and decodes WAL entries. Monitor `pg_stat_bgwriter` and CPU usage.

---

## Key Takeaways

1. **Always use physical backups for PITR capability.** Logical backups are supplementary for portability and selective restore.

2. **Test your backups regularly.** An untested backup is no backup. Automate restore verification.

3. **Monitor replication lag continuously.** Set alerts when `replay_lag` exceeds acceptable thresholds.

4. **Use Patroni or pg_auto_failover for production HA.** Manual failover is error-prone under stress.

5. **Protect replication slots.** They are the most common cause of disk exhaustion in replicated clusters.

6. **Follow the 3-2-1 backup rule.** Offsite, immutable backups protect against ransomware and catastrophic events.

7. **Document your RPO and RTO.** These determine your backup frequency, replication mode, and failover strategy.

8. **Keep `postgresql.conf` and backup scripts version-controlled.** Configuration drift is a silent failure mode.

9. **Use pgBackRest or Barman for production.** They handle compression, deduplication, verification, and cloud storage out of the box.

10. **Practice failover drills.** Run them quarterly at minimum. The first real failover should not be the first time you promote a standby.
