import { BN } from "@coral-xyz/anchor";
import { Address } from "@solana/kit";
import { DEFAULT_ADDRESS } from "../convert";
import { IDLE_ID } from "../strategy-config";
import { Allocation } from "./types";

export interface StrategyInput {
  strategyId: string;
  strategyType: string;
  strategyAddress: Address;
  positionValue: BN;
  availableWithdrawableLiquidity: BN;
}

export function createInitialAllocation(
  totalPositionValue: BN,
  inputs: StrategyInput[]
): Allocation[] {
  const allocations: Allocation[] = inputs.map((input) => {
    const locked = BN.max(
      input.positionValue.sub(input.availableWithdrawableLiquidity),
      new BN(0)
    );
    return {
      strategyId: input.strategyId,
      strategyType: input.strategyType,
      strategyAddress: input.strategyAddress,
      positionValue: locked,
    };
  });

  const sumLocked = allocations.reduce(
    (acc, a) => acc.add(a.positionValue),
    new BN(0)
  );

  allocations.push({
    strategyId: IDLE_ID,
    strategyType: "idle",
    strategyAddress: DEFAULT_ADDRESS,
    positionValue: totalPositionValue.sub(sumLocked),
  });

  return allocations;
}

/**
 * Creates an equal-weight target allocation across all strategies.
 *
 * Given N strategies and total funds T, with some locked amounts L_i:
 * 1. Compute locked amounts per strategy (position - withdrawable, floored at 0)
 * 2. distributable = T - sum(L_i)
 * 3. target_per_strategy = T / N (equal split of total)
 * 4. For strategies with L_i > target: allocation = L_i (locked, can't reduce)
 * 5. Remaining distributable is split equally among non-locked strategies
 * 6. Idle = 0 (all funds allocated)
 */
export function createEqualWeightAllocation(
  totalPositionValue: BN,
  inputs: StrategyInput[]
): Allocation[] {
  const n = inputs.length;
  if (n === 0) {
    return [{
      strategyId: IDLE_ID,
      strategyType: "idle",
      strategyAddress: DEFAULT_ADDRESS,
      positionValue: totalPositionValue,
    }];
  }

  // Step 1: Compute locked amounts per strategy
  const locked = inputs.map((input) =>
    BN.max(
      input.positionValue.sub(input.availableWithdrawableLiquidity),
      new BN(0)
    )
  );

  // Step 2: Compute equal target per strategy
  const targetPerStrategy = totalPositionValue.divn(n);

  // Step 3: Identify over-locked strategies and compute remaining distributable
  let overLockedTotal = new BN(0);
  let nonLockedCount = 0;

  for (let i = 0; i < n; i++) {
    if (locked[i].gt(targetPerStrategy)) {
      overLockedTotal = overLockedTotal.add(locked[i]);
    } else {
      nonLockedCount++;
    }
  }

  // Step 4: Compute per-strategy allocation for non-locked strategies
  const remainingForNonLocked = totalPositionValue.sub(overLockedTotal);
  const perNonLocked = nonLockedCount > 0
    ? remainingForNonLocked.divn(nonLockedCount)
    : new BN(0);

  // Step 5: Build allocations
  const allocations: Allocation[] = [];
  let allocated = new BN(0);

  for (let i = 0; i < n; i++) {
    let allocationValue: BN;
    if (locked[i].gt(targetPerStrategy)) {
      // Strategy is over-locked, keep its locked amount
      allocationValue = locked[i];
    } else {
      // Assign equal share, but at least the locked amount
      allocationValue = BN.max(perNonLocked, locked[i]);
    }
    allocations.push({
      strategyId: inputs[i].strategyId,
      strategyType: inputs[i].strategyType,
      strategyAddress: inputs[i].strategyAddress,
      positionValue: allocationValue,
    });
    allocated = allocated.add(allocationValue);
  }

  // Step 6: Handle rounding remainder — assign to idle (should be near 0)
  const remainder = totalPositionValue.sub(allocated);
  allocations.push({
    strategyId: IDLE_ID,
    strategyType: "idle",
    strategyAddress: DEFAULT_ADDRESS,
    positionValue: BN.max(remainder, new BN(0)),
  });

  return allocations;
}
