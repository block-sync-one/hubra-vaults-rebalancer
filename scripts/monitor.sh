#!/bin/bash
# Hubra Vaults Monitor
# Checks idle funds and triggers rebalance when threshold exceeded
#
# Reads config from VAULTS_CONFIG (default: /app/config/vaults.yaml)
# Runs every CHECK_INTERVAL seconds (default: 300 = 5 minutes)

set -e

CONFIG_FILE="${VAULTS_CONFIG:-/app/config/vaults.yaml}"
CHECK_INTERVAL="${CHECK_INTERVAL:-300}"

log() {
  echo "[$(date -Iseconds)] $1"
}

check_vaults() {
  log "Starting vault check..."
  
  # Read config
  VOLTR_API=$(yq -r '.voltr_api' "$CONFIG_FILE")
  THRESHOLD=$(yq -r '.idle_threshold' "$CONFIG_FILE")
  VAULT_COUNT=$(yq -r '.vaults | length' "$CONFIG_FILE")
  
  ISSUES=()
  REBALANCED=()
  
  for i in $(seq 0 $((VAULT_COUNT - 1))); do
    SYMBOL=$(yq -r ".vaults[$i].symbol" "$CONFIG_FILE")
    ADDRESS=$(yq -r ".vaults[$i].address" "$CONFIG_FILE")
    REBALANCER_HOST=$(yq -r ".vaults[$i].rebalancer_host" "$CONFIG_FILE")
    REBALANCER_PORT=$(yq -r ".vaults[$i].rebalancer_port" "$CONFIG_FILE")
    
    log "Checking $SYMBOL vault ($ADDRESS)..."
    
    # Fetch vault data from Voltr API
    RESPONSE=$(curl -s "${VOLTR_API}/vault/${ADDRESS}" 2>&1)
    
    # Check if request was successful
    SUCCESS=$(echo "$RESPONSE" | jq -r '.success' 2>/dev/null)
    if [ "$SUCCESS" != "true" ]; then
      ISSUES+=("$SYMBOL: Failed to fetch vault data")
      continue
    fi
    
    # Get values
    TOTAL_RAW=$(echo "$RESPONSE" | jq -r '.vault.totalValue')
    ALLOCATED_RAW=$(echo "$RESPONSE" | jq '[.vault.allocations[].positionValue] | add // 0')
    DECIMALS=$(echo "$RESPONSE" | jq -r '.vault.token.decimals')
    
    # Calculate USD values
    RESULT=$(awk -v total="$TOTAL_RAW" -v alloc="$ALLOCATED_RAW" -v dec="$DECIMALS" -v tol="$THRESHOLD" '
      BEGIN {
        divisor = 10 ^ dec
        total_usd = total / divisor
        alloc_usd = alloc / divisor
        idle_usd = total_usd - alloc_usd
        
        if (idle_usd > tol) {
          printf "IDLE:%.2f:%.2f:%.2f", total_usd, alloc_usd, idle_usd
        } else {
          print "OK"
        }
      }
    ')
    
    if [[ "$RESULT" == IDLE:* ]]; then
      IFS=':' read -r _ TOTAL_FMT ALLOC_FMT IDLE_FMT <<< "$RESULT"
      
      log "$SYMBOL: Idle funds detected (\$${IDLE_FMT}) - triggering rebalance..."
      
      # Trigger rebalance via internal Docker network
      REBALANCE_URL="http://${REBALANCER_HOST}:${REBALANCER_PORT}/rebalance"
      REBALANCE_RESULT=$(curl -s -X POST "$REBALANCE_URL" --connect-timeout 10 2>&1)
      
      if echo "$REBALANCE_RESULT" | grep -qi "triggered\|success\|ok"; then
        REBALANCED+=("$SYMBOL: Idle \$${IDLE_FMT} → Rebalance triggered")
        log "$SYMBOL: Rebalance triggered successfully"
      else
        ISSUES+=("$SYMBOL: Idle \$${IDLE_FMT} — Rebalance FAILED: ${REBALANCE_RESULT}")
        log "$SYMBOL: Rebalance FAILED: $REBALANCE_RESULT"
      fi
    else
      log "$SYMBOL: OK (no significant idle funds)"
    fi
  done
  
  # Summary
  echo ""
  if [ ${#REBALANCED[@]} -gt 0 ]; then
    log "🔄 Auto-Rebalance Summary:"
    printf '  %s\n' "${REBALANCED[@]}"
  fi
  
  if [ ${#ISSUES[@]} -gt 0 ]; then
    log "⚠️ Issues:"
    printf '  %s\n' "${ISSUES[@]}"
  fi
  
  if [ ${#REBALANCED[@]} -eq 0 ] && [ ${#ISSUES[@]} -eq 0 ]; then
    log "✅ All vaults OK - no idle funds above \$${THRESHOLD}"
  fi
  
  log "Check complete. Next check in ${CHECK_INTERVAL}s"
}

# Main loop
log "Hubra Vaults Monitor starting..."
log "Config: $CONFIG_FILE"
log "Check interval: ${CHECK_INTERVAL}s"

while true; do
  check_vaults
  sleep "$CHECK_INTERVAL"
done
