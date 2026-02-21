#!/bin/bash
# Check Hubra vaults for idle funds
# Idle funds = totalValue - sum(allocations.positionValue)
# Values from API are in smallest units, divided by 10^decimals for display

set -e

VAULTS=(
  "HUBRA_USDC_VAULT:3maCuTJVPteZ2dFA8dADxz2EbpJHfoAG5txYhXDs6gNQ"
  "HUBRA_USDT_VAULT:3kzb6rcDJxSdkWCwXXP9PULSqBy6rVDNWanzw5dBCYCj"
  "HUBRA_USD1_VAULT:663azFYEnHDTLGf4CEk8KpNTje8XxZVLnQwo9LjbSejy"
  "HUBRA_USDS_VAULT:5mv1cURMSaPU3q3wFVoN4mKMWNFVvUtH3UZrG4Z2Mgfz"
  "HUBRA_USDG_VAULT:7VZ1XKK7Zns6UzRc1Wz54u6cypN7zaduasVXXr7NysxH"
)

# Tolerance in dollars (ignore dust below this threshold)
TOLERANCE=1.00

ISSUES=()

for vault_entry in "${VAULTS[@]}"; do
  IFS=':' read -r vault_name vault_address <<< "$vault_entry"
  
  # Fetch vault data
  response=$(curl -s "https://api.voltr.xyz/vault/${vault_address}")
  
  # Check if request was successful
  success=$(echo "$response" | jq -r '.success')
  if [ "$success" != "true" ]; then
    ISSUES+=("$vault_name ($vault_address): Failed to fetch vault data")
    continue
  fi
  
  # Get totalValue, allocated sum, and decimals
  total_raw=$(echo "$response" | jq -r '.vault.totalValue')
  allocated_raw=$(echo "$response" | jq '[.vault.allocations[].positionValue] | add // 0')
  decimals=$(echo "$response" | jq -r '.vault.token.decimals')
  
  # Calculate values in dollars (divide by 10^decimals)
  result=$(awk -v total="$total_raw" -v alloc="$allocated_raw" -v dec="$decimals" -v tol="$TOLERANCE" '
    BEGIN {
      divisor = 10 ^ dec
      total_usd = total / divisor
      alloc_usd = alloc / divisor
      idle_usd = total_usd - alloc_usd
      
      if (idle_usd > tol || idle_usd < -tol) {
        printf "IDLE:%.2f:%.2f:%.2f", total_usd, alloc_usd, idle_usd
      } else {
        print "OK"
      }
    }
  ')
  
  if [[ "$result" == IDLE:* ]]; then
    IFS=':' read -r _ total_fmt alloc_fmt idle_fmt <<< "$result"
    ISSUES+=("$vault_name: Idle funds detected! Total: \$${total_fmt}, Allocated: \$${alloc_fmt}, Idle: \$${idle_fmt}")
  fi
done

if [ ${#ISSUES[@]} -gt 0 ]; then
  echo "⚠️ Vault Idle Funds Alert"
  printf '%s\n' "${ISSUES[@]}"
  echo ""
  echo "📊 Grafana: https://falcon.hubra.app/grafana/?orgId=1&from=now-5m&to=now&timezone=browser&var-asset=\$__all&refresh=30s"
  exit 1
else
  echo "All vaults OK - no idle funds detected"
  exit 0
fi
