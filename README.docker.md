# Hubra Vaults Rebalancer - Docker Deployment

Automated yield optimization for Hubra vaults on Solana. Each vault has its own rebalancer instance that moves funds to the highest-yield strategies.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Network: hubra-vaults                               │
│                                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ rebalancer  │ │ rebalancer  │ │ rebalancer  │  ...      │
│  │ usdc:9090   │ │ usdt:9090   │ │ usd1:9090   │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
│         │               │               │                   │
│         └───────────────┼───────────────┘                   │
│                         │                                   │
│                 ┌───────────────┐                           │
│                 │    monitor    │                           │
│                 │ (checks idle, │                           │
│                 │  triggers     │                           │
│                 │  rebalance)   │                           │
│                 └───────────────┘                           │
│                         │                                   │
│         ┌───────────────┼───────────────┐                   │
│         │               │               │                   │
│  ┌─────────────┐ ┌─────────────┐                           │
│  │ prometheus  │ │  grafana    │                           │
│  │ :9091       │ │  :3001      │                           │
│  └─────────────┘ └─────────────┘                           │
│                                                             │
│  📁 config/vaults.yaml (shared config)                     │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Clone the repo
git clone https://github.com/block-sync-one/vaults-rebalancer.git
cd vaults-rebalancer

# Copy and configure environment files
cp .env.example .env-usdc
# Edit .env-usdc with your RPC endpoint and wallet

# Start all services
docker-compose up -d

# Check logs
docker-compose logs -f monitor

# View Grafana dashboard
open http://localhost:3001  # admin/admin
```

## Configuration

### Environment Files

Each vault needs an `.env-{symbol}` file:

```bash
# .env-usdc
ASSET_SYMBOL=USDC
VOLTR_VAULT_ADDRESS=3maCuTJVPteZ2dFA8dADxz2EbpJHfoAG5txYhXDs6gNQ
ASSET_MINT_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
ASSET_TOKEN_PROGRAM=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
VOLTR_LOOKUP_TABLE_ADDRESS=BdLKM6fiT13Eqm14gS3XjceQmPNWpSoEqYeQXBMc9Dsk

# RPC Configuration
RPC_URL=https://your-rpc-endpoint.com
RPC_WS_URL=wss://your-rpc-endpoint.com

# Wallet (base58 encoded private key)
WALLET_PRIVATE_KEY=your-wallet-private-key
```

### Strategies File

Each vault needs a `{symbol}-strategies.json`:

```json
[
  {
    "name": "Kamino Gauntlet Prime",
    "address": "..."
  },
  {
    "name": "Jupiter Lend",
    "address": "..."
  }
]
```

### Vaults Config

The monitor reads `config/vaults.yaml`:

```yaml
idle_threshold: 10.00  # Trigger rebalance if idle > $10
voltr_api: https://api.voltr.xyz

vaults:
  - symbol: USDC
    name: Hubra Copilot USDC
    address: 3maCuTJVPteZ2dFA8dADxz2EbpJHfoAG5txYhXDs6gNQ
    rebalancer_host: rebalancer-usdc
    rebalancer_port: 9090
```

## Adding a New Vault

1. **Create environment file:**
   ```bash
   cp .env.example .env-newvault
   # Edit with vault-specific config
   ```

2. **Create strategies file:**
   ```bash
   # Create newvault-strategies.json with strategy addresses
   ```

3. **Add service to docker-compose.yml:**
   ```yaml
   rebalancer-newvault:
     <<: *rebalancer-common
     container_name: rebalancer-newvault
     env_file: .env-newvault
     volumes:
       - ./newvault-strategies.json:/app/strategies.json:ro
     labels:
       - "hubra.rebalancer=true"
       - "hubra.vault.symbol=NEWVAULT"
       - "hubra.vault.address=your-vault-address"
   ```

4. **Add to vaults.yaml:**
   ```yaml
   - symbol: NEWVAULT
     name: Hubra Copilot NEWVAULT
     address: your-vault-address
     rebalancer_host: rebalancer-newvault
     rebalancer_port: 9090
   ```

5. **Start the new service:**
   ```bash
   docker-compose up -d rebalancer-newvault
   ```

## Services

| Service | Port | Description |
|---------|------|-------------|
| `rebalancer-*` | 9090 (internal) | Rebalancer instance per vault |
| `monitor` | - | Checks idle funds, triggers rebalances |
| `prometheus` | 9091 | Metrics collection with Docker SD |
| `grafana` | 3001 | Dashboards (admin/admin) |

## Monitoring

### Monitor Behavior

- Runs every 5 minutes (configurable via `CHECK_INTERVAL`)
- Fetches vault data from Voltr API
- Triggers rebalance if idle funds > threshold
- Logs all actions

### Prometheus Metrics

Prometheus auto-discovers rebalancers via Docker labels:
- Label: `hubra.rebalancer=true`
- Metrics endpoint: `http://{container}:9090/metrics`

### Grafana

Default credentials: `admin/admin`

Pre-configured dashboards show:
- Vault TVL and allocations
- Rebalance frequency
- APY trends

## Commands

```bash
# Start all
docker-compose up -d

# Start specific vault
docker-compose up -d rebalancer-usdc

# View logs
docker-compose logs -f monitor
docker-compose logs -f rebalancer-usdc

# Restart monitor
docker-compose restart monitor

# Stop all
docker-compose down

# Rebuild after code changes
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

**Rebalancer not starting:**
```bash
docker-compose logs rebalancer-usdc
# Check for missing env vars or RPC issues
```

**Monitor can't reach rebalancers:**
```bash
# Verify containers are on same network
docker network inspect vaults-rebalancer_hubra-vaults
```

**Prometheus not discovering containers:**
```bash
# Check Docker socket mount
docker-compose exec prometheus wget -qO- http://localhost:9090/api/v1/targets
```

## Security Notes

- Wallet private keys are stored in `.env-*` files - keep these secure
- Docker socket is mounted to Prometheus for service discovery
- Internal network (hubra-vaults) is not exposed externally
- Only Prometheus (9091) and Grafana (3001) are exposed to host

## License

MIT
