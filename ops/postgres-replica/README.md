# Postgres read replica — operator runbook

The app's read-routing wiring already exists. Setting
`DATABASE_READ_URL` in the production `.env` flips the
analytics + archive reads onto whatever Postgres you point at;
falling back to the writer when unset.

This file documents the **operator-side** steps: standing up
the replica itself, creating the read-only user, wiring the
env var, and verifying the pipeline works.

## When to do this

Not yet, probably. On a single-VPS setup where the replica
would share the same disk and CPU as the primary, a read
replica gives near-zero benefit. Three signals it's time:

* `dive_recorder_db_pool_waiting > 0` sustained on the Grafana
  dashboard during meets (analytics queries are blocking
  live-scoring writes).
* `histogram_quantile(0.95, …)` on the diver-profile or archive
  routes climbs above ~500ms regularly.
* You stand up a second box for unrelated reasons (DR,
  geo-distribution, …) and it makes sense to put a Postgres
  replica there.

## Setup options

| | Effort | When |
|---|---|---|
| **Managed** (RDS, Crunchy, Neon, Supabase) | one click | you want zero ongoing maintenance |
| **Self-host on a separate box** | half a day | you have a second VPS and want full control |
| **Self-host on the same box** | half a day | almost never useful — same disk + CPU = no isolation |

This runbook covers self-host on a separate box. Managed-PG
setups give you a connection string directly; skip to the
"Wire the app" step.

## Self-host: streaming replication

### 1. Configure the primary

On the **primary** server (where Postgres already runs):

```bash
# Enable replication in postgresql.conf. Path varies by version
# and distro — adapt as needed. /etc/postgresql/<MAJOR>/main/
# is the Debian/Ubuntu convention.
PG_CONF=/etc/postgresql/$(pg_lsclusters -h | awk '{print $1; exit}')/main/postgresql.conf

sudo sed -i \
  -e "s/^#wal_level.*/wal_level = replica/" \
  -e "s/^#max_wal_senders.*/max_wal_senders = 5/" \
  -e "s/^#wal_keep_size.*/wal_keep_size = 256MB/" \
  -e "s/^#hot_standby.*/hot_standby = on/" \
  "$PG_CONF"

# Create the replication user. Pick a strong random password
# (this is the credential the replica uses to pull the WAL
# stream — don't reuse a human password).
REPL_PASSWORD=$(openssl rand -hex 24)
echo "REPLICATION_PASSWORD: $REPL_PASSWORD" >&2     # save this!
sudo -u postgres psql -c \
  "CREATE USER replicator WITH REPLICATION LOGIN PASSWORD '$REPL_PASSWORD';"

# Allow the replica's IP to connect for the replication
# protocol. Replace <REPLICA_IP> with the actual address.
PG_HBA=/etc/postgresql/$(pg_lsclusters -h | awk '{print $1; exit}')/main/pg_hba.conf
echo "host replication replicator <REPLICA_IP>/32 scram-sha-256" | \
  sudo tee -a "$PG_HBA"

sudo systemctl restart postgresql
```

Verify the primary is ready:

```bash
sudo -u postgres psql -c "SHOW wal_level;"           # expect: replica
sudo -u postgres psql -c "SHOW max_wal_senders;"     # expect: 5
sudo -u postgres psql -c "SELECT * FROM pg_roles WHERE rolname='replicator';"
```

### 2. Bootstrap the replica

On the **replica** server (Postgres of the same major version
installed but stopped):

```bash
sudo systemctl stop postgresql

# Wipe the data dir so pg_basebackup can start clean. PG
# refuses to write into a non-empty directory.
PG_DATA=/var/lib/postgresql/$(pg_lsclusters -h | awk '{print $1; exit}')/main
sudo -u postgres rm -rf "$PG_DATA"

# Pull a base backup and configure as a streaming replica.
# -R writes standby.signal + primary_conninfo automatically,
# so PG starts as a replica with no further config.
sudo -u postgres pg_basebackup \
  -h <PRIMARY_HOST> -p 5432 -U replicator \
  -D "$PG_DATA" \
  -P -R -X stream

sudo systemctl start postgresql
```

You'll be prompted for the replicator password — paste the one
saved from step 1.

Verify replication is live:

```bash
# On the replica
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"   # → t

# On the primary
sudo -u postgres psql -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
# → one row, state='streaming'
```

Smoke-test it: insert a row on the primary, confirm it's
visible on the replica within ~1 second.

### 3. Create the read-only user

On the **primary** (gets replicated to the replica
automatically):

```sql
CREATE USER reader WITH LOGIN PASSWORD '<PICK_ANOTHER_STRONG_PW>';
GRANT CONNECT ON DATABASE divinghq TO reader;
GRANT USAGE ON SCHEMA public TO reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO reader;
```

The `ALTER DEFAULT PRIVILEGES` line means future tables
(future migrations) automatically grant SELECT to the reader
too — no need to re-run the GRANT after every migration.

### 4. Wire the app

Edit `~/DivingHQ/.env` on the **app** server:

```
DATABASE_READ_URL=postgres://reader:<password>@<replica-host>:5432/divinghq
```

Restart: `pm2 restart dive-recorder`. You should see a log
line in the boot output:

```
INFO: read replica configured
   host: replica.example.com:5432
```

### 5. Verify the wiring

Run the verification script in this directory:

```bash
cd ops/postgres-replica
./verify.sh
```

It hits a sample of routes that should go to the replica
(`/api/archive`, `/api/divers/:id/profile`) and a sample that
should go to the writer (`/api/health`, `/api/users` for an
admin), and reports which DB each connected to. (Uses the
Postgres `application_name` connection parameter — set
differently for the two pools — so we can tell from
`pg_stat_activity` which side of the wiring served each
request.)

## Failover

Streaming replication doesn't promote the replica when the
primary dies. For real high-availability you'd add patroni,
repmgr, or move to a managed PG service. For now, the app
falls back gracefully:

* When `DATABASE_READ_URL` is unreachable, `readPool` still
  works (pg's Pool buffers + retries) but every analytics /
  archive request stalls until reconnect.
* You can flip back to the writer in seconds by removing
  `DATABASE_READ_URL` from `.env` and `pm2 restart`. The code
  pattern is `readPool || pool` — drop the env var, fall back
  to the primary.

## Replication lag

Acceptable for the routes wired to the replica today:
* `/api/archive*`            — historical, stale-by-seconds is fine
* `/api/divers/:id/profile`  — historical, stale-by-seconds is fine
* `/api/divers/:id/analytics` — historical, ditto

NEVER routed to the replica:
* `/api/scoreboard/:eventId` — "did my score just land?" needs
  to-the-millisecond freshness
* `/api/events/:id/roster`   — Control Room state must reflect
  the diver who just got added
* All write routes (POST/PUT/DELETE)

If you find yourself wanting a route on the replica that's in
the second list, audit the freshness requirement first.
