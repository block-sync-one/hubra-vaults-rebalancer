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
  createYieldBasedAllocation,
  StrategyInput,
} from "./optimizer";
import {
  strategyRegistry,
  IDLE_ID,
} from "../strategy-config";
import { getTokensBatchPrice } from "../price";
import {
  fetchYieldMarkets,
  matchMarketsToStrategies,
  selectWinner,
} from "../yield-api";
import { logger } from "../utils";
import Decimal from "decimal.js";

export * from "./types";

export async function getCurrentAndTargetAllocation(
  connection: Connection,
  rpc: Rpc<SolanaRpcApi>
): Promise<{
  prevAllocations: Allocation[];
  targetAllocations: Allocation[];
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

  const winnerId = await resolveYieldWinner(totalPositionValue);

  const targetAllocations = createYieldBasedAllocation(
    totalPositionValue,
    strategyInputs,
    winnerId
  );

  return {
    prevAllocations,
    targetAllocations,
  };
}

async function resolveYieldWinner(
  totalPositionValue: BN
): Promise<string | null> {
  try {
    const assetMint = config.assetMintAddress as string;
    const markets = await fetchYieldMarkets(assetMint);

    const matched = matchMarketsToStrategies(markets);
    logger.info(
      { fetched: markets.length, matched: matched.length },
      "Yield market matching complete"
    );

    if (matched.length === 0) {
      logger.warn("No yield markets matched any registered strategy, falling back to equal-weight");
      return null;
    }

    const prices = await getTokensBatchPrice([config.assetMintAddress]);
    const assetPrice = prices.get(config.assetMintAddress) ?? new Decimal(1);
    const decimals = 6;
    const totalUsd = new Decimal(totalPositionValue.toString())
      .div(new Decimal(10).pow(decimals))
      .mul(assetPrice)
      .toNumber();

    const winner = selectWinner(matched, totalUsd);
    if (!winner) {
      logger.warn("All candidates filtered out by TVL/dilution, falling back to equal-weight");
      return null;
    }

    logger.info(
      {
        winnerId: winner.strategy.id,
        apy: `${(winner.market.depositApy * 100).toFixed(2)}%`,
        tvl: `$${Math.round(winner.market.totalDepositUsd).toLocaleString()}`,
        ourDeposit: `$${Math.round(totalUsd).toLocaleString()}`,
        provider: winner.market.provider.name,
      },
      "Yield winner selected — allocating 100%"
    );

    return winner.strategy.id;
  } catch (error) {
    logger.error(error, "Yield API failed, falling back to equal-weight");
    return null;
  }
}
