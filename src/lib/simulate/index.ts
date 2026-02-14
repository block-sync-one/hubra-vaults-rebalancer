import { BN } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { config } from "../../config";
import { VoltrClient } from "@voltr/vault-sdk";
import { KaminoVault } from "@kamino-finance/klend-sdk";
import { address, Rpc, SolanaRpcApi } from "@solana/kit";
import {
  getAvailableWithdrawalLiquidityForKVaultMaxWithdrawableReserve,
} from "../kamino";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEFAULT_ADDRESS, toPublicKey } from "../convert";
import { Allocation } from "./types";
import {
  createEqualWeightAllocation,
  StrategyInput,
} from "./optimizer";
import {
  strategyRegistry,
  IDLE_ID,
} from "../strategy-config";

export * from "./types";

export async function getCurrentAndEqualAllocation(
  connection: Connection,
  rpc: Rpc<SolanaRpcApi>
): Promise<{
  prevAllocations: Allocation[];
  equalAllocations: Allocation[];
}> {
  const voltrClient = new VoltrClient(connection);

  const positionValues = await Promise.all(
    strategyRegistry.strategies.map((s) =>
      voltrClient
        .fetchStrategyInitReceiptAccount(
          voltrClient.findStrategyInitReceipt(
            toPublicKey(config.voltrVaultAddress),
            toPublicKey(s.address)
          )
        )
        .then((receipt) => receipt.positionValue)
    )
  );

  const idleAta = getAssociatedTokenAddressSync(
    toPublicKey(config.assetMintAddress),
    voltrClient.findVaultAssetIdleAuth(toPublicKey(config.voltrVaultAddress)),
    true,
    toPublicKey(config.assetTokenProgram)
  );

  const idleBalance = await getAccount(
    connection,
    idleAta,
    "confirmed",
    toPublicKey(config.assetTokenProgram)
  ).then((account) => new BN(account.amount.toString()));

  const prevAllocations: Allocation[] = strategyRegistry.strategies.map(
    (s, i) => ({
      strategyId: s.id,
      strategyType: s.type,
      strategyAddress: s.address,
      positionValue: positionValues[i],
    })
  );
  prevAllocations.push({
    strategyId: IDLE_ID,
    strategyType: "idle",
    strategyAddress: DEFAULT_ADDRESS,
    positionValue: idleBalance,
  });

  const totalPositionValue = prevAllocations.reduce(
    (acc, allocation) => acc.add(allocation.positionValue),
    new BN(0)
  );

  // Collect kvault withdrawal liquidity constraints
  type VaultState = Awaited<ReturnType<KaminoVault["getState"]>>;
  const kaminoVaultStates = new Map<string, VaultState>();
  for (const kvConfig of strategyRegistry.kaminoVaults) {
    const kv = new KaminoVault(address(kvConfig.address));
    const vs = await kv.getState(rpc);
    kaminoVaultStates.set(kvConfig.id, vs);
  }

  const kvaultLiquidityMap = new Map<string, BN>();
  for (const [id, vs] of kaminoVaultStates) {
    const liq = await getAvailableWithdrawalLiquidityForKVaultMaxWithdrawableReserve(
      rpc,
      vs
    ).then((l) => new BN(l.mul(0.98).floor().toString()));
    kvaultLiquidityMap.set(id, liq);
  }

  const strategyInputs: StrategyInput[] = strategyRegistry.strategies.map(
    (s, i) => ({
      strategyId: s.id,
      strategyType: s.type,
      strategyAddress: s.address,
      positionValue: positionValues[i],
      availableWithdrawableLiquidity:
        kvaultLiquidityMap.get(s.id) ?? new BN(Number.MAX_SAFE_INTEGER),
    })
  );

  const equalAllocations = createEqualWeightAllocation(
    totalPositionValue,
    strategyInputs
  );

  return {
    prevAllocations,
    equalAllocations,
  };
}
