# Deploy

Systemd-based deployment for running multiple vaults-rebalancer instances (one per asset), with Prometheus + Grafana monitoring.

## Prerequisites

- Linux server with systemd
- Node.js and pnpm installed
- Base `.env` + per-asset `.env-<asset>` files in `/home/copilot/vaults-rebalancer`

Docker is installed automatically if not present.

## Setup

```bash
sudo bash deploy/setup.sh
```

This will:
1. Run `pnpm i && pnpm run build`
2. Install the `vaults-rebalancer@.service` systemd template
3. Auto-discover all `.env-*` files and enable a service for each
4. Install CLI tools (`vaults-rebalancer-{logs,health,status,restart}`)
5. Install Docker if not present
6. Generate Prometheus config targeting all instance ports
7. Start Prometheus + Grafana via Docker Compose

## How It Works

`vaults-rebalancer@.service` is a systemd [template unit](https://www.freedesktop.org/software/systemd/man/systemd.unit.html#Description). The `%i` placeholder resolves to the instance name passed after `@`.

For `vaults-rebalancer@usdc`:
- Loads `.env` (base config) then `.env-usdc` (asset overrides)
- Sets `ENV_FILE=.env-usdc` so the app's dotenv layering in `config.ts` works
- Auto-restarts on failure with 5s delay
- Starts on boot

## Monitoring

After setup:
- **Grafana**: http://localhost:3000 (login: `admin` / `admin`)
- **Prometheus**: http://localhost:9091

The Grafana dashboard "Vault Rebalancer" is auto-provisioned with panels for:
- Rebalance decisions (rate, errors, fallbacks, winner APY/TVL, duration)
- Financial (vault total value, idle balance, per-strategy positions)
- Transactions (rate by type, duration, compute units, priority fees)
- System health (loop iterations, errors, yield API, worker restarts)

Prometheus scrapes each instance's `/metrics` endpoint (port from `HEALTH_SERVER_PORT` in each `.env-*`).

Monitoring files are generated at runtime in `$WORK_DIR/monitoring/` — not tracked in git.

## Commands

### Logs

```bash
vaults-rebalancer-logs              # tail all instances
vaults-rebalancer-logs usdc         # tail one instance
vaults-rebalancer-logs usdc usdt    # tail specific instances
```

### Health check

```bash
vaults-rebalancer-health            # quick OK/FAIL for all
vaults-rebalancer-health usdc usdt  # specific instances
```

### Status

```bash
vaults-rebalancer-status            # detailed status for all
vaults-rebalancer-status usdc       # specific instance
```

### Restart

```bash
vaults-rebalancer-restart           # restart all instances
vaults-rebalancer-restart usdc      # restart specific instance
```

## Adding a New Asset

1. Create `.env-<asset>` in the project root (set a unique `HEALTH_SERVER_PORT`)
2. Re-run `sudo bash deploy/setup.sh` — enables the new service and regenerates Prometheus targets

Or manually:
```bash
systemctl enable --now vaults-rebalancer@<asset>
```

## Removing an Asset

```bash
systemctl disable --now vaults-rebalancer@<asset>
```

Then re-run setup to update Prometheus targets, or manually edit `monitoring/prometheus.yml`.
