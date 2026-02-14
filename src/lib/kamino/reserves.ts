import {
  DEFAULT_KLEND_PROGRAM_ID,
  DEFAULT_PUBLIC_KEY,
  getMedianSlotDurationInMsFromLastEpochs,
  getSingleReserve,
  getTokenOracleData,
  KaminoManager,
  KaminoReserve,
  KaminoVault,
  KVAULTS_PROGRAM_ID,
  lamportsToDecimal,
  parseTokenSymbol,
  Reserve,
  VaultState,
} from "@kamino-finance/klend-sdk";
import {
  Address,
  Rpc,
  Slot,
  SolanaRpcApi,
} from "@solana/kit";
import {
  AccountMeta,
} from "@solana/web3.js";
import { DEFAULT_ADDRESS, toPublicKey } from "../convert";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import { FarmAndKey, Farms, FarmState } from "@kamino-finance/farms-sdk";
import { logger } from "../utils";
import { getTokensBatchPrice } from "../price";

export function getReserveSupplyTvlLamports(reserve: KaminoReserve): Decimal {
  return reserve
    .getLiquidityAvailableAmount()
    .add(reserve.getBorrowedAmount())
    .sub(reserve.getAccumulatedProtocolFees())
    .sub(reserve.getAccumulatedReferrerFees());
}

export async function getSimulatedReserveSupplyFarmAPY(
  depositAmountDelta: BN,
  reserve: KaminoReserve,
  farmsClient: Farms,
  farmsToFarmStateMap: Map<Address, FarmState>,
  pricesMap: Map<Address, Decimal>
): Promise<Decimal> {
  const farmCollateralAddress = reserve.state.farmCollateral;
  const farmState = farmsToFarmStateMap?.get(farmCollateralAddress);
  if (!farmState) {
    return new Decimal(0);
  }

  const farmAndKey: FarmAndKey = { key: farmCollateralAddress, farmState };
  const liquidityTokenPrice = pricesMap!.get(reserve.state.liquidity.mintPubkey);
  if (!liquidityTokenPrice) {
    return new Decimal(0);
  }
  const reserveCtokenPrice = liquidityTokenPrice.div(reserve.getCollateralExchangeRate());
  const tokenDecimals = reserve.state.liquidity.mintDecimals.toNumber();
  const simulatedReserveSupplyFarmAPYAndStats = await farmsClient.simulateFarmIncentivesApy(
    farmAndKey,
    new Decimal(depositAmountDelta.toString()).div(new Decimal(10).pow(tokenDecimals)),
    async (mint) => pricesMap.get(mint)!,
    reserveCtokenPrice,
    tokenDecimals,
    pricesMap
  );
  return new Decimal(simulatedReserveSupplyFarmAPYAndStats.totalIncentivesApy);
}


export async function evaluateKaminoReserveYield(
  reserve: KaminoReserve,
  depositAmountDelta: BN,
  currentSlot: Slot,
  farmsClient: Farms,
  farmsToFarmStateMap: Map<Address, FarmState>,
  pricesMap: Map<Address, Decimal>
): Promise<number> {
  const action = depositAmountDelta.gtn(0) ? 'deposit' : 'withdraw';
  const simulatedReserveAPR = new Decimal(reserve.calcSimulatedSupplyAPR(
    new Decimal(depositAmountDelta.abs().toString()),
    action,
    currentSlot,
    0
  ));

  const simulatedReserveSupplyFarmAPY = await getSimulatedReserveSupplyFarmAPY(
    depositAmountDelta,
    reserve,
    farmsClient,
    farmsToFarmStateMap,
    pricesMap
  );

  return simulatedReserveAPR.add(simulatedReserveSupplyFarmAPY).toNumber();
}

/**
 * Gets the reserve accounts for a Kamino vault formatted as AccountMeta,
 * required for CPI calls into the strategy adaptor.
 */
export const getKaminoVaultReservesAccountMetas = async (
  rpc: Rpc<SolanaRpcApi>,
  vaultState: VaultState
) => {
  let slotDuration = 400;
  try {
    slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
  } catch (error) {
    logger.error(
      { err: error },
      "Error getting median slot duration in ms from last epochs"
    );
  }
  const kaminoManager = new KaminoManager(rpc, slotDuration);
  const currentSlot = await kaminoManager.getRpc().getSlot().send();
  const investedInReserves = await kaminoManager
    .getVaultHoldings(vaultState)
    .then((holdings) => holdings.investedInReserves);

  const vaultAllocations = vaultState.vaultAllocationStrategy.filter(
    (vaultAllocation) =>
      vaultAllocation.reserve !== DEFAULT_ADDRESS
  );
  const vaultReserves = vaultAllocations.map(
    (allocation) => allocation.reserve
  );
  const reserveAccounts = await rpc
    .getMultipleAccounts(vaultReserves, {
      commitment: "processed",
    })
    .send();
  const deserializedReserves = reserveAccounts.value.map((reserve, i) => {
    if (reserve === null) {
      throw new Error(`Reserve account ${vaultReserves[i]} was not found`);
    }
    const reserveAccount = Reserve.decode(
      Buffer.from(reserve.data[0], "base64")
    );
    if (!reserveAccount) {
      throw Error(`Could not parse reserve ${vaultReserves[i]}`);
    }
    return reserveAccount;
  });

  const reservesAndOracles = await getTokenOracleData(
    rpc,
    deserializedReserves
  );
  const kaminoReserves = new Map<Address, KaminoReserve>();
  reservesAndOracles.forEach(([reserve, oracle], index) => {
    if (!oracle) {
      throw Error(
        `Could not find oracle for ${parseTokenSymbol(
          reserve.config.tokenInfo.name
        )} reserve`
      );
    }
    const kaminoReserve = KaminoReserve.initialize(
      vaultReserves[index],
      reserve,
      oracle,
      rpc,
      slotDuration
    );
    kaminoReserves.set(kaminoReserve.address, kaminoReserve);
  });
  let vaultReservesAccountMetas: AccountMeta[] = [];
  let vaultReservesLendingMarkets: AccountMeta[] = [];
  let maxWithdrawableReserve: Address = DEFAULT_ADDRESS;
  let maxWithdrawableReserveLiquiditySupply: Address = DEFAULT_ADDRESS;
  let maxWithdrawableReserveCollateralMint: Address = DEFAULT_ADDRESS;
  let maxWithdrawableLendingMarket: Address = DEFAULT_ADDRESS;
  let maxWithdrawableAmount: Decimal = new Decimal(0);
  vaultReserves.forEach((reserve) => {
    const reserveState = kaminoReserves.get(reserve);
    if (reserveState === undefined) {
      throw new Error(`Reserve ${reserve.toString()} not found`);
    }
    vaultReservesAccountMetas = vaultReservesAccountMetas.concat([
      { pubkey: toPublicKey(reserve), isSigner: false, isWritable: true },
    ]);
    vaultReservesLendingMarkets = vaultReservesLendingMarkets.concat([
      {
        pubkey: toPublicKey(reserveState.state.lendingMarket),
        isSigner: false,
        isWritable: false,
      },
    ]);

    const availableLiquidityInReserve = lamportsToDecimal(
      reserveState.getLiquidityAvailableAmount(),
      reserveState.state.liquidity.mintDecimals.toNumber()
    );
    const reserveWithdrawalCapCapacity = lamportsToDecimal(
      reserveState.getDepositWithdrawalCapCapacity(),
      reserveState.state.liquidity.mintDecimals.toNumber()
    );
    const reserveWithdrawalCapCurrent = lamportsToDecimal(
      reserveState.getDepositWithdrawalCapCurrent(currentSlot),
      reserveState.state.liquidity.mintDecimals.toNumber()
    );
    const totalWithdrawableAmountReserve = Decimal.min(
      availableLiquidityInReserve,
      Decimal.max(
        reserveWithdrawalCapCapacity.sub(reserveWithdrawalCapCurrent),
        0
      )
    );
    const investedInReserve = investedInReserves.get(reserve) ?? new Decimal(0);
    const vaultWithdrawableAmountReserve = Decimal.min(
      investedInReserve,
      totalWithdrawableAmountReserve
    );

    if (vaultWithdrawableAmountReserve.gt(maxWithdrawableAmount)) {
      maxWithdrawableAmount = vaultWithdrawableAmountReserve;
      maxWithdrawableReserve = reserve;
      maxWithdrawableLendingMarket = reserveState.state.lendingMarket;
      maxWithdrawableReserveLiquiditySupply =
        reserveState.state.liquidity.supplyVault;
      maxWithdrawableReserveCollateralMint =
        reserveState.state.collateral.mintPubkey;
    }
  });

  return {
    vaultReservesAccountMetas,
    vaultReservesLendingMarkets,
    maxWithdrawableReserve: {
      reserve: toPublicKey(maxWithdrawableReserve),
      lendingMarket: toPublicKey(maxWithdrawableLendingMarket),
      liquiditySupply: toPublicKey(maxWithdrawableReserveLiquiditySupply),
      collateralMint: toPublicKey(maxWithdrawableReserveCollateralMint),
    },
  };
};

async function getReserveSupplyFarmAPY(
  reserve: KaminoReserve,
  farmsClient: Farms,
  farmsToFarmStateMap: Map<Address, FarmState>,
  pricesMap: Map<Address, Decimal>
): Promise<Decimal> {
  const farmCollateralAddress = reserve.state.farmCollateral;
  const farmState = farmsToFarmStateMap?.get(farmCollateralAddress);
  if (!farmState) {
    logger.error(
      `Farm state for reserve ${reserve.address} not found, needs to be fetched`
    );
    return new Decimal(0);
  }

  const farmAndKey: FarmAndKey = { key: farmCollateralAddress, farmState };
  const liquidityTokenPrice = pricesMap!.get(
    reserve.state.liquidity.mintPubkey
  );
  if (!liquidityTokenPrice) {
    return new Decimal(0);
  }
  const reserveCtokenPrice = liquidityTokenPrice.div(
    reserve.getCollateralExchangeRate()
  );
  const tokenDecimals = reserve.state.liquidity.mintDecimals.toNumber();
  const calculatedReserveSupplyFarmAPYAndStats =
    await farmsClient.calculateFarmIncentivesApy(
      farmAndKey,
      async (mint) => pricesMap.get(mint)!,
      reserveCtokenPrice,
      tokenDecimals,
      pricesMap!
    );
  return new Decimal(calculatedReserveSupplyFarmAPYAndStats.totalIncentivesApy);
}

/**
 * Gets the APY for the current allocated reserves in a Kamino vault.
 */
export async function getApyForCurrentAllocatedReserves(
  rpc: Rpc<SolanaRpcApi>,
  vaultState: VaultState
): Promise<{
  grossAPY: number;
  netAPY: number;
  deposits: BN;
}> {
  const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
  const kaminoManager = new KaminoManager(rpc, slotDuration);
  const vaultReservesState = await kaminoManager.loadVaultReserves(vaultState);
  const slot = await rpc.getSlot().send();
  const farmsClient = new Farms(rpc);

  let totalAUM = new Decimal(vaultState.tokenAvailable.toString());
  let totalAPY = new Decimal(0);

  let reservesSupplyFarms = new Set<Address>();
  vaultState.vaultAllocationStrategy.forEach((allocationStrategy) => {
    const vaultResertState = vaultReservesState.get(allocationStrategy.reserve);
    const vaultReserveFarmCollateral = vaultResertState?.state.farmCollateral;
    if (vaultResertState && vaultReserveFarmCollateral !== DEFAULT_PUBLIC_KEY) {
      reservesSupplyFarms.add(vaultReserveFarmCollateral!);
    }
  });

  const farmsList = Array.from(reservesSupplyFarms);
  const farmsStates = await FarmState.fetchMultiple(rpc, farmsList);
  const farmToFarmStateMap = new Map<Address, FarmState>();
  const allTokensMintsIncludingFarms: Set<Address> = new Set();
  farmsStates.forEach((farmState, index) => {
    if (farmState) {
      farmToFarmStateMap.set(farmsList[index], farmState);

      farmState.rewardInfos.forEach((rewardInfo) => {
        if (rewardInfo.token.mint !== DEFAULT_PUBLIC_KEY) {
          allTokensMintsIncludingFarms.add(rewardInfo.token.mint);
        }
      });
    }
  });
  allTokensMintsIncludingFarms.add(vaultState.tokenMint);

  const pricesMap = await getTokensBatchPrice(
    Array.from(allTokensMintsIncludingFarms)
  );

  for (const allocationStrategy of vaultState.vaultAllocationStrategy) {
    if (allocationStrategy.reserve === DEFAULT_ADDRESS) {
      continue;
    }

    const reserve = vaultReservesState.get(allocationStrategy.reserve);
    if (reserve === undefined) {
      throw new Error(
        `Reserve ${allocationStrategy.reserve.toString()} not found`
      );
    }

    let reserveAPY = new Decimal(reserve.totalSupplyAPY(slot));
    const exchangeRate = reserve.getEstimatedCollateralExchangeRate(slot, 0);
    const investedInReserve = exchangeRate.mul(
      new Decimal(allocationStrategy.ctokenAllocation.toString())
    );

    if (reserve.state.farmCollateral !== DEFAULT_PUBLIC_KEY) {
      const farmIncentives = await getReserveSupplyFarmAPY(
        reserve,
        farmsClient,
        farmToFarmStateMap,
        pricesMap
      );
      reserveAPY = reserveAPY.add(farmIncentives);
    }

    const weightedAPY = reserveAPY.mul(investedInReserve);
    totalAPY = totalAPY.add(weightedAPY);
    totalAUM = totalAUM.add(investedInReserve);
  }
  if (totalAUM.isZero()) {
    return {
      grossAPY: 0,
      netAPY: 0,
      deposits: new BN(0),
    };
  }

  const grossAPY = totalAPY.div(totalAUM);
  const netAPY = grossAPY
    .mul(
      new Decimal(1).sub(
        new Decimal(vaultState.performanceFeeBps.toString()).div(10_000)
      )
    )
    .mul(
      new Decimal(1).sub(
        new Decimal(vaultState.managementFeeBps.toString()).div(10_000)
      )
    );
  return {
    grossAPY: grossAPY.toNumber(),
    netAPY: netAPY.toNumber(),
    deposits: new BN(totalAUM.toNumber()),
  };
}

/**
 * Gets the available liquidity for withdrawal from the vault's reserve with the highest
 * actual withdrawable amount (considering liquidity, caps, and vault holdings).
 */
export async function getAvailableWithdrawalLiquidityForKVaultMaxWithdrawableReserve(
  rpc: Rpc<SolanaRpcApi>,
  vaultState: VaultState
): Promise<Decimal> {
  let slotDuration = 400;
  try {
    slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
  } catch (error) {
    logger.error(error, "Error getting median slot duration");
  }

  const kaminoManager = new KaminoManager(rpc, slotDuration);
  const currentSlot = await kaminoManager.getRpc().getSlot().send();

  const investedInReserves = await kaminoManager
    .getVaultHoldings(vaultState)
    .then((holdings) => holdings.investedInReserves);

  const vaultReserves = vaultState.vaultAllocationStrategy
    .filter((a) => a.reserve !== DEFAULT_ADDRESS)
    .map((a) => a.reserve);

  const reserveAccounts = await rpc
    .getMultipleAccounts(vaultReserves, { commitment: "processed" })
    .send();
  const deserializedReserves = reserveAccounts.value.map((acc, i) => {
    if (!acc) throw new Error(`Reserve ${vaultReserves[i]} not found`);
    return Reserve.decode(Buffer.from(acc.data[0], "base64"))!;
  });

  const reservesAndOracles = await getTokenOracleData(
    rpc,
    deserializedReserves
  );

  let maxWithdrawableAmount = new Decimal(0);

  reservesAndOracles.forEach(([reserveState, oracle], index) => {
    const reserveAddress = vaultReserves[index];
    const kaminoReserve = KaminoReserve.initialize(
      reserveAddress,
      reserveState,
      oracle!,
      rpc,
      slotDuration
    );

    const availableLiquidity = kaminoReserve.getLiquidityAvailableAmount();
    const capCapacity = kaminoReserve.getDepositWithdrawalCapCapacity();
    const capCurrent =
      kaminoReserve.getDepositWithdrawalCapCurrent(currentSlot);

    const marketWithdrawableLimit = Decimal.min(
      availableLiquidity,
      Decimal.max(capCapacity.sub(capCurrent), 0)
    );

    const vaultInvested =
      investedInReserves.get(reserveAddress) ?? new Decimal(0);
    const vaultWithdrawable = Decimal.min(
      vaultInvested,
      marketWithdrawableLimit
    );

    if (vaultWithdrawable.gt(maxWithdrawableAmount)) {
      maxWithdrawableAmount = vaultWithdrawable;
    }
  });

  return maxWithdrawableAmount.mul(
    new Decimal(10).pow(new Decimal(vaultState.tokenMintDecimals.toString()))
  );
}
