# Observability stack

Logs (Loki) + metrics (Prometheus) + UI (Grafana), all running in
Docker on the same VPS as the dive-recorder app. Everything is
configured by files in this directory; no click-ops.

```
┌─────────────────────────────────────────────────────────────┐
│  dive-recorder app  (PM2, port 3000)                        │
│   ├── Pino → stdout / logs/pm2-out.log  ─────► Promtail ──► Loki ──┐
│   └── /metrics endpoint  ◄──────────  Prometheus (scrape every 30s) │
│                                                                    │
│                               Grafana (port 3030, localhost only)  ◄┘
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

* Docker + Compose v2 installed (`docker compose version` works).
* The dive-recorder app already running on port 3000 (the default).
* The PM2 ecosystem writes logs to the project's `./logs/`
  directory (already configured in `ecosystem.config.js`).

## First-time setup

```bash
# From the repo root
cd ops/observability

# Optional: pick a real Grafana admin password before bringing it up
echo "GRAFANA_ADMIN_PASSWORD=your-strong-password-here" > .env

# Bring all four services up. First boot pulls images (~400MB total).
docker compose up -d

# Wait ~10 seconds for everything to start, then verify
docker compose ps
```

You should see four containers in state `running`:

```
NAME                          STATUS
dive-recorder-grafana         Up
dive-recorder-loki            Up
dive-recorder-prometheus      Up
dive-recorder-promtail        Up
```

## Accessing Grafana

The stack binds everything to `127.0.0.1` so it's not internet-
accessible. Two reasonable ways to view Grafana from your laptop:

### Option A — SSH tunnel (zero-config)

```bash
# On your laptop
ssh -N -L 3030:127.0.0.1:3030 you@your-server
# Now open http://localhost:3030 in your browser
```

### Option B — Cloudflare Tunnel

If you already use Cloudflare in front of the app, add a second
hostname (e.g. `grafana.example.com`) pointing to `localhost:3030`
and gate it with a Cloudflare Access policy.

Either way, log in as `admin` / the password you set in `.env`
above (or `change-me-on-first-login` if you skipped it). Change it
on first login regardless.

## What's already configured

* **Two datasources** — Prometheus (default) and Loki — auto-loaded
  via `grafana/provisioning/datasources/all.yml`. No need to add
  them through the UI.
* **One starter dashboard** at `Dashboards → Dive Recorder → Dive
  Recorder`, with nine panels:
  * Score submissions / minute (stat)
  * Connected sockets (stat)
  * DB pool waiting (stat — saturation signal)
  * Scoreboard cache hit ratio (stat)
  * HTTP request rate by route (timeseries)
  * HTTP latency p50 / p95 / p99 (timeseries)
  * Accepted vs rejected score submissions (timeseries)
  * Process resident memory (timeseries)
  * Recent application logs (live tail with structured-field
    inspection)

## Useful Grafana queries

Once you're past the starter dashboard, the four queries you'll
re-use day-to-day:

| Question | Query |
|---|---|
| Are scores landing? | `rate(dive_recorder_scores_submitted_total[1m]) * 60` |
| Which routes are slow? | `histogram_quantile(0.95, sum by (le, route) (rate(dive_recorder_http_request_duration_seconds_bucket[5m])))` |
| Is the DB pool saturated? | `dive_recorder_db_pool_waiting` |
| Are there errors right now? | (Loki) `{job="dive-recorder"} \| json \| level="error"` |

## Day-2 operations

```bash
# Tail Loki ingestion
docker compose logs -f loki

# Restart just one service after a config edit
docker compose restart promtail

# Stop everything (data persists in named volumes)
docker compose down

# Wipe everything including history
docker compose down -v

# Upgrade to a new image version — bump in docker-compose.yml,
# then:
docker compose pull
docker compose up -d
```

## Disk usage

Bounded by:

* Loki: 30-day retention (`limits_config.retention_period: 720h`
  in `loki/local-config.yaml`)
* Prometheus: 30-day retention
  (`--storage.tsdb.retention.time=30d` in `docker-compose.yml`)

For a single VPS with light meet activity that's typically
~1-2GB. Keep an eye on `df -h /var/lib/docker/volumes/` if you
ever extend either retention window.

## Security notes

* `/metrics` on the app is unauthenticated. Prometheus reaches it
  via `host.docker.internal:3000` from the same box, so the public
  internet doesn't see it as long as your firewall blocks port
  3000 from outside (which it should already — Cloudflare hits the
  app via 80/443).
* Grafana's admin password is read from `.env` next to this
  compose file (or defaults to `change-me-on-first-login`). Don't
  commit `.env`.
* Loki + Prometheus + Grafana ports are bound to `127.0.0.1` only,
  so they're not internet-reachable without an SSH tunnel or
  Cloudflare Access.
