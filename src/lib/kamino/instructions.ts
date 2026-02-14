import {
  DEFAULT_KLEND_PROGRAM_ID,
  getSingleReserve,
  KaminoVault,
  KVAULTS_PROGRAM_ID,
} from "@kamino-finance/klend-sdk";
import {
  address,
  Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  Rpc,
  SolanaRpcApi,
} from "@solana/kit";
import {
  AccountMeta,
  Connection,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { Farms } from "@kamino-finance/farms-sdk";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "../../config";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  CLAIM_REWARD_DISCRIMINATOR,
  CLAIM_REWARD_KMARKET_DISCRIMINATOR,
  DEPOSIT_KMARKET_DISCRIMINATOR,
  DEPOSIT_VAULT_DISCRIMINATOR,
  WITHDRAW_KMARKET_DISCRIMINATOR,
  WITHDRAW_VAULT_DISCRIMINATOR,
  KAMINO_ADAPTOR_PROGRAM_ID,
  KAMINO_FARM_PROGRAM_ID,
  KAMINO_FARM_GLOBAL_CONFIG,
} from "../constants";
import { setupJupiterSwap } from "../jupiter";
import { getKaminoVaultReservesAccountMetas } from "./reserves";
import {
  toPublicKey,
  DEFAULT_ADDRESS,
  SYSTEM_PROGRAM_ADDR,
  TOKEN_PROGRAM_ADDR,
  SYSVAR_INSTRUCTIONS_ADDR,
  SYSVAR_RENT_ADDR,
} from "../convert";

const KLEND_PROGRAM_ADDR = address(DEFAULT_KLEND_PROGRAM_ID);
const KVAULTS_PROGRAM_ADDR = address(KVAULTS_PROGRAM_ID);

export async function createWithdrawKVaultStrategyIx(
  rpc: Rpc<SolanaRpcApi>,
  voltrClient: VoltrClient,
  kaminoVaultAddress: Address,
  manager: Address,
  withdrawAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const kaminoVault = new KaminoVault(kaminoVaultAddress);
  const vaultState = await kaminoVault.getState(rpc);

  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(kaminoVaultAddress)
  );

  const [globalConfig] = await getProgramDerivedAddress({
    seeds: [Buffer.from("global_config")],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const [sharesMint] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("shares"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const {
    vaultReservesAccountMetas,
    vaultReservesLendingMarkets,
    maxWithdrawableReserve,
  } = await getKaminoVaultReservesAccountMetas(rpc, vaultState);

  const [tokenVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("token_vault"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });
  const [baseVaultAuthority] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("authority"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });
  const [eventAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("__event_authority")],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const [lendingMarketAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("lma"), maxWithdrawableReserve.lendingMarket.toBuffer()],
    programAddress: KLEND_PROGRAM_ADDR,
  });

  const [ctokenVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("ctoken_vault"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
      maxWithdrawableReserve.reserve.toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const vaultStrategySharesAta = getAssociatedTokenAddressSync(
    toPublicKey(sharesMint),
    vaultStrategyAuth,
    true,
    toPublicKey(TOKEN_PROGRAM_ADDR)
  );

  const remainingAccounts: AccountMeta[] = [
    {
      pubkey: toPublicKey(kaminoVaultAddress),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(globalConfig), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(tokenVault), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(baseVaultAuthority), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(sharesMint), isSigner: false, isWritable: true },
    { pubkey: vaultStrategySharesAta, isSigner: false, isWritable: true },
    {
      pubkey: maxWithdrawableReserve.reserve,
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(ctokenVault), isSigner: false, isWritable: true },
    {
      pubkey: maxWithdrawableReserve.lendingMarket,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: toPublicKey(lendingMarketAuthority), isSigner: false, isWritable: false },
    {
      pubkey: maxWithdrawableReserve.liquiditySupply,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: maxWithdrawableReserve.collateralMint,
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(eventAuthority), isSigner: false, isWritable: false },
    {
      pubkey: toPublicKey(KLEND_PROGRAM_ADDR),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(KVAULTS_PROGRAM_ADDR),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: toPublicKey(TOKEN_PROGRAM_ADDR), isSigner: false, isWritable: false },
    {
      pubkey: toPublicKey(SYSVAR_INSTRUCTIONS_ADDR),
      isSigner: false,
      isWritable: false,
    },
    ...vaultReservesAccountMetas,
    ...vaultReservesLendingMarkets,
  ];

  const withdrawStrategyIx = await voltrClient.createWithdrawStrategyIx(
    {
      instructionDiscriminator: WITHDRAW_VAULT_DISCRIMINATOR,
      withdrawAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: toPublicKey(kaminoVaultAddress),
      remainingAccounts,
      adaptorProgram: toPublicKey(KAMINO_ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(withdrawStrategyIx);
  addressLookupTableAddresses.push(vaultState.vaultLookupTable);
  return {
    transactionIxs,
    addressLookupTableAddresses,
  };
}

export async function createDepositKVaultStrategyIx(
  rpc: Rpc<SolanaRpcApi>,
  voltrClient: VoltrClient,
  kaminoVaultAddress: Address,
  manager: Address,
  depositAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const kaminoVault = new KaminoVault(kaminoVaultAddress);
  const vaultState = await kaminoVault.getState(rpc);

  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(kaminoVaultAddress)
  );

  const [sharesMint] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("shares"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const { vaultReservesAccountMetas, vaultReservesLendingMarkets } =
    await getKaminoVaultReservesAccountMetas(rpc, vaultState);

  const [tokenVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("token_vault"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });
  const [baseVaultAuthority] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("authority"),
      toPublicKey(kaminoVaultAddress).toBuffer(),
    ],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });
  const [eventAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("__event_authority")],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const vaultStrategySharesAta = getAssociatedTokenAddressSync(
    toPublicKey(sharesMint),
    vaultStrategyAuth,
    true,
    toPublicKey(TOKEN_PROGRAM_ADDR)
  );

  const remainingAccounts: AccountMeta[] = [
    {
      pubkey: toPublicKey(kaminoVaultAddress),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: toPublicKey(tokenVault), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(baseVaultAuthority), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(sharesMint), isSigner: false, isWritable: true },
    { pubkey: vaultStrategySharesAta, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(eventAuthority), isSigner: false, isWritable: false },
    {
      pubkey: toPublicKey(KLEND_PROGRAM_ADDR),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(KVAULTS_PROGRAM_ADDR),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: toPublicKey(TOKEN_PROGRAM_ADDR), isSigner: false, isWritable: false },
    ...vaultReservesAccountMetas,
    ...vaultReservesLendingMarkets,
  ];

  const depositStrategyIx = await voltrClient.createDepositStrategyIx(
    {
      instructionDiscriminator: DEPOSIT_VAULT_DISCRIMINATOR,
      depositAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: toPublicKey(kaminoVaultAddress),
      remainingAccounts,
      adaptorProgram: toPublicKey(KAMINO_ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(depositStrategyIx);
  addressLookupTableAddresses.push(vaultState.vaultLookupTable);
  return {
    transactionIxs,
    addressLookupTableAddresses,
  };
}

export async function createDepositKMarketStrategyIx(
  rpc: Rpc<SolanaRpcApi>,
  voltrClient: VoltrClient,
  reserveAddress: Address,
  manager: Address,
  depositAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(reserveAddress)
  );
  const farms = new Farms(rpc);
  const reserveAccount = await getSingleReserve(reserveAddress, rpc, 400);
  const lendingMarket = toPublicKey(reserveAccount.state.lendingMarket);
  const [obligation] = await getProgramDerivedAddress({
    seeds: [
      new BN(0).toArrayLike(Buffer, "le", 1),
      new BN(0).toArrayLike(Buffer, "le", 1),
      vaultStrategyAuth.toBuffer(),
      lendingMarket.toBuffer(),
      toPublicKey(SYSTEM_PROGRAM_ADDR).toBuffer(),
      toPublicKey(SYSTEM_PROGRAM_ADDR).toBuffer(),
    ],
    programAddress: KLEND_PROGRAM_ADDR,
  });
  const [lendingMarketAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("lma"), lendingMarket.toBuffer()],
    programAddress: KLEND_PROGRAM_ADDR,
  });
  const reserveLiquiditySupply = toPublicKey(reserveAccount.state.liquidity.supplyVault);
  const reserveCollateralMint = toPublicKey(reserveAccount.state.collateral.mintPubkey);
  const reserveDestinationDepositCollateral = toPublicKey(reserveAccount.state.collateral.supplyVault);
  const farmCollateralStr = reserveAccount.state.farmCollateral.toString();
  const [reserveFarmState, obligationFarm] =
    (farmCollateralStr === DEFAULT_ADDRESS) ?
      [toPublicKey(KLEND_PROGRAM_ADDR), toPublicKey(KLEND_PROGRAM_ADDR)]
      :
      [toPublicKey(reserveAccount.state.farmCollateral), toPublicKey((await getProgramDerivedAddress({
        seeds: [Buffer.from("user"), toPublicKey(reserveAccount.state.farmCollateral).toBuffer(), toPublicKey(obligation).toBuffer()],
        programAddress: address(farms.getProgramID().toString()),
      }))[0])]

  const [userMetadata] = await getProgramDerivedAddress({
    seeds: [Buffer.from("user_meta"), vaultStrategyAuth.toBuffer()],
    programAddress: KLEND_PROGRAM_ADDR,
  });
  const scope = toPublicKey(reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed);

  const remainingAccounts = [
    { pubkey: toPublicKey(obligation), isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: toPublicKey(lendingMarketAuthority), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(reserveAddress), isSigner: false, isWritable: true },
    { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
    { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
    { pubkey: reserveDestinationDepositCollateral, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(TOKEN_PROGRAM_ADDR), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(SYSVAR_INSTRUCTIONS_ADDR), isSigner: false, isWritable: false },
    { pubkey: obligationFarm, isSigner: false, isWritable: true },
    { pubkey: reserveFarmState, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(userMetadata), isSigner: false, isWritable: true },
    { pubkey: scope, isSigner: false, isWritable: false },
    { pubkey: toPublicKey(SYSVAR_RENT_ADDR), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(SYSTEM_PROGRAM_ADDR), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(address(farms.getProgramID().toString())), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(KLEND_PROGRAM_ADDR), isSigner: false, isWritable: false },
  ];

  const depositStrategyIx = await voltrClient.createDepositStrategyIx(
    {
      instructionDiscriminator: DEPOSIT_KMARKET_DISCRIMINATOR,
      depositAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: toPublicKey(reserveAddress),
      remainingAccounts,
      adaptorProgram: toPublicKey(KAMINO_ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(depositStrategyIx);
  return {
    transactionIxs,
    addressLookupTableAddresses,
  };
}

export async function createWithdrawKMarketStrategyIx(
  rpc: Rpc<SolanaRpcApi>,
  voltrClient: VoltrClient,
  reserveAddress: Address,
  manager: Address,
  withdrawAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(reserveAddress)
  );
  const farms = new Farms(rpc);
  const reserveAccount = await getSingleReserve(reserveAddress, rpc, 400);
  const lendingMarket = toPublicKey(reserveAccount.state.lendingMarket);
  const [obligation] = await getProgramDerivedAddress({
    seeds: [
      new BN(0).toArrayLike(Buffer, "le", 1),
      new BN(0).toArrayLike(Buffer, "le", 1),
      vaultStrategyAuth.toBuffer(),
      lendingMarket.toBuffer(),
      toPublicKey(SYSTEM_PROGRAM_ADDR).toBuffer(),
      toPublicKey(SYSTEM_PROGRAM_ADDR).toBuffer(),
    ],
    programAddress: KLEND_PROGRAM_ADDR,
  });
  const [lendingMarketAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("lma"), lendingMarket.toBuffer()],
    programAddress: KLEND_PROGRAM_ADDR,
  });
  const reserveLiquiditySupply = toPublicKey(reserveAccount.state.liquidity.supplyVault);
  const reserveCollateralMint = toPublicKey(reserveAccount.state.collateral.mintPubkey);
  const reserveSourceCollateral = toPublicKey(reserveAccount.state.collateral.supplyVault);
  const farmCollateralStr = reserveAccount.state.farmCollateral.toString();
  const [reserveFarmState, obligationFarm] =
    (farmCollateralStr === DEFAULT_ADDRESS) ?
      [toPublicKey(KLEND_PROGRAM_ADDR), toPublicKey(KLEND_PROGRAM_ADDR)]
      :
      [toPublicKey(reserveAccount.state.farmCollateral), toPublicKey((await getProgramDerivedAddress({
        seeds: [Buffer.from("user"), toPublicKey(reserveAccount.state.farmCollateral).toBuffer(), toPublicKey(obligation).toBuffer()],
        programAddress: address(farms.getProgramID().toString()),
      }))[0])]
    ;
  const scope = toPublicKey(reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed);

  const remainingAccounts = [
    { pubkey: toPublicKey(obligation), isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: toPublicKey(lendingMarketAuthority), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(reserveAddress), isSigner: false, isWritable: true },
    { pubkey: reserveSourceCollateral, isSigner: false, isWritable: true },
    { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
    { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(TOKEN_PROGRAM_ADDR), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(SYSVAR_INSTRUCTIONS_ADDR), isSigner: false, isWritable: false },
    { pubkey: obligationFarm, isSigner: false, isWritable: true },
    { pubkey: reserveFarmState, isSigner: false, isWritable: true },
    { pubkey: scope, isSigner: false, isWritable: false },
    { pubkey: toPublicKey(address(farms.getProgramID().toString())), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(KLEND_PROGRAM_ADDR), isSigner: false, isWritable: false },
  ];

  const withdrawStrategyIx = await voltrClient.createWithdrawStrategyIx(
    {
      instructionDiscriminator: WITHDRAW_KMARKET_DISCRIMINATOR,
      withdrawAmount,
    },
    {
      manager: toPublicKey(manager),
      vault: toPublicKey(config.voltrVaultAddress),
      vaultAssetMint: toPublicKey(config.assetMintAddress),
      assetTokenProgram: toPublicKey(config.assetTokenProgram),
      strategy: toPublicKey(reserveAddress),
      remainingAccounts,
      adaptorProgram: toPublicKey(KAMINO_ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(withdrawStrategyIx);
  return {
    transactionIxs,
    addressLookupTableAddresses,
  };
}

export async function createClaimRewardKMarketStrategyIx(
  rpc: Rpc<SolanaRpcApi>,
  connection: Connection,
  voltrClient: VoltrClient,
  reserveAddress: Address,
  userStateAddress: Address,
  farmStateAddress: Address,
  rewardMintAddress: Address,
  rewardTokenProgram: Address,
  manager: Address,
  rewardAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const addressEncoder = getAddressEncoder();

  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(reserveAddress)
  );

  const userRewardAta = getAssociatedTokenAddressSync(
    toPublicKey(rewardMintAddress),
    vaultStrategyAuth,
    true,
    toPublicKey(rewardTokenProgram)
  );

  let initialUserRewardAmount: BN = new BN(0);

  try {
    initialUserRewardAmount = await getAccount(
      connection,
      userRewardAta,
      "confirmed",
      toPublicKey(rewardTokenProgram)
    ).then((account) => new BN(account.amount.toString()));
  } catch (_) {
    transactionIxs.push(
      createAssociatedTokenAccountInstruction(
        toPublicKey(manager),
        userRewardAta,
        vaultStrategyAuth,
        toPublicKey(rewardMintAddress),
        toPublicKey(rewardTokenProgram)
      )
    );
  }

  const [rewardsVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("rvault"),
      addressEncoder.encode(farmStateAddress),
      addressEncoder.encode(rewardMintAddress),
    ],
    programAddress: address(KAMINO_FARM_PROGRAM_ID),
  });

  const [farmVaultsAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("authority"), addressEncoder.encode(farmStateAddress)],
    programAddress: address(KAMINO_FARM_PROGRAM_ID),
  });

  const [rewardsTreasuryVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("tvault"),
      addressEncoder.encode(KAMINO_FARM_GLOBAL_CONFIG),
      addressEncoder.encode(rewardMintAddress),
    ],
    programAddress: address(KAMINO_FARM_PROGRAM_ID),
  });
  const reserveAccount = await getSingleReserve(reserveAddress, rpc, 400);
  const lendingMarket = toPublicKey(reserveAccount.state.lendingMarket);
  const [obligation] = await getProgramDerivedAddress({
    seeds: [
      new BN(0).toArrayLike(Buffer, "le", 1),
      new BN(0).toArrayLike(Buffer, "le", 1),
      vaultStrategyAuth.toBuffer(),
      lendingMarket.toBuffer(),
      toPublicKey(SYSTEM_PROGRAM_ADDR).toBuffer(),
      toPublicKey(SYSTEM_PROGRAM_ADDR).toBuffer(),
    ],
    programAddress: KLEND_PROGRAM_ADDR,
  });
  const scope = toPublicKey(reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed);
  const claimRewardsRemainingAccounts: AccountMeta[] = [
    { pubkey: toPublicKey(obligation), isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: true },
    { pubkey: toPublicKey(reserveAddress), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(userStateAddress), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(farmStateAddress), isSigner: false, isWritable: true },
    { pubkey: toPublicKey(KAMINO_FARM_GLOBAL_CONFIG), isSigner: false, isWritable: false },
    { pubkey: toPublicKey(rewardMintAddress), isSigner: false, isWritable: false },
    { pubkey: userRewardAta, isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(rewardsVault),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: toPublicKey(rewardsTreasuryVault),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: toPublicKey(farmVaultsAuthority),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: scope,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(rewardTokenProgram),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(KAMINO_FARM_PROGRAM_ID),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(KLEND_PROGRAM_ADDR),
      isSigner: false,
      isWritable: false,
    },
  ];

  const {
    jupiterSwapAddressLookupTableAddresses,
    jupiterSwapData,
    jupiterSwapAccountMetas,
  } = await setupJupiterSwap(
    rewardAmount.add(initialUserRewardAmount),
    address(vaultStrategyAuth.toBase58()),
    rewardMintAddress,
    config.assetMintAddress
  );

  const createClaimRewardStrategyIx =
    await voltrClient.createWithdrawStrategyIx(
      {
        instructionDiscriminator: CLAIM_REWARD_KMARKET_DISCRIMINATOR,
        withdrawAmount: new BN(0),
        additionalArgs: jupiterSwapData,
      },
      {
        manager: toPublicKey(manager),
        vault: toPublicKey(config.voltrVaultAddress),
        vaultAssetMint: toPublicKey(config.assetMintAddress),
        assetTokenProgram: toPublicKey(config.assetTokenProgram),
        strategy: toPublicKey(reserveAddress),
        remainingAccounts: [
          ...claimRewardsRemainingAccounts,
          ...jupiterSwapAccountMetas,
        ],
        adaptorProgram: toPublicKey(KAMINO_ADAPTOR_PROGRAM_ID),
      }
    );

  addressLookupTableAddresses.push(...jupiterSwapAddressLookupTableAddresses);

  transactionIxs.push(createClaimRewardStrategyIx);
}

export async function createClaimRewardKVaultStrategyIx(
  rpc: Rpc<SolanaRpcApi>,
  connection: Connection,
  voltrClient: VoltrClient,
  kaminoVaultAddress: Address,
  userStateAddress: Address,
  farmStateAddress: Address,
  rewardMintAddress: Address,
  rewardTokenProgram: Address,
  manager: Address,
  rewardAmount: BN,
  vaultReservesAccountMetas: AccountMeta[],
  vaultReservesLendingMarkets: AccountMeta[],
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  const kaminoVault = new KaminoVault(kaminoVaultAddress);
  const vaultState = await kaminoVault.getState(rpc);

  const addressEncoder = getAddressEncoder();

  const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
    toPublicKey(config.voltrVaultAddress),
    toPublicKey(kaminoVaultAddress)
  );

  const [sharesMint] = await getProgramDerivedAddress({
    seeds: [Buffer.from("shares"), toPublicKey(kaminoVaultAddress).toBuffer()],
    programAddress: KVAULTS_PROGRAM_ADDR,
  });

  const userSharesAta = getAssociatedTokenAddressSync(
    toPublicKey(sharesMint),
    vaultStrategyAuth,
    true,
    toPublicKey(TOKEN_PROGRAM_ADDR)
  );

  const userRewardAta = getAssociatedTokenAddressSync(
    toPublicKey(rewardMintAddress),
    vaultStrategyAuth,
    true,
    toPublicKey(rewardTokenProgram)
  );

  let initialUserRewardAmount: BN = new BN(0);

  try {
    initialUserRewardAmount = await getAccount(
      connection,
      userRewardAta,
      "confirmed",
      toPublicKey(rewardTokenProgram)
    ).then((account) => new BN(account.amount.toString()));
  } catch (_) {
    transactionIxs.push(
      createAssociatedTokenAccountInstruction(
        toPublicKey(manager),
        userRewardAta,
        vaultStrategyAuth,
        toPublicKey(rewardMintAddress),
        toPublicKey(rewardTokenProgram)
      )
    );
  }

  const [rewardsVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("rvault"),
      addressEncoder.encode(farmStateAddress),
      addressEncoder.encode(rewardMintAddress),
    ],
    programAddress: address(KAMINO_FARM_PROGRAM_ID),
  });

  const [farmVaultsAuthority] = await getProgramDerivedAddress({
    seeds: [Buffer.from("authority"), addressEncoder.encode(farmStateAddress)],
    programAddress: address(KAMINO_FARM_PROGRAM_ID),
  });

  const [rewardsTreasuryVault] = await getProgramDerivedAddress({
    seeds: [
      Buffer.from("tvault"),
      addressEncoder.encode(KAMINO_FARM_GLOBAL_CONFIG),
      addressEncoder.encode(rewardMintAddress),
    ],
    programAddress: address(KAMINO_FARM_PROGRAM_ID),
  });

  const claimRewardsRemainingAccounts: AccountMeta[] = [
    {
      pubkey: toPublicKey(kaminoVaultAddress),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: userSharesAta, isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(userStateAddress),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: toPublicKey(farmStateAddress),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: toPublicKey(KAMINO_FARM_GLOBAL_CONFIG),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(rewardMintAddress),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: userRewardAta, isSigner: false, isWritable: true },
    {
      pubkey: toPublicKey(rewardsVault),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: toPublicKey(rewardsTreasuryVault),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: toPublicKey(farmVaultsAuthority),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(config.kaminoScopeAddress),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(rewardTokenProgram),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(KAMINO_FARM_PROGRAM_ID),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: toPublicKey(KLEND_PROGRAM_ADDR),
      isSigner: false,
      isWritable: false,
    },
  ];

  const {
    jupiterSwapAddressLookupTableAddresses,
    jupiterSwapData,
    jupiterSwapAccountMetas,
  } = await setupJupiterSwap(
    rewardAmount.add(initialUserRewardAmount),
    address(vaultStrategyAuth.toBase58()),
    rewardMintAddress,
    config.assetMintAddress
  );

  const createClaimRewardStrategyIx =
    await voltrClient.createWithdrawStrategyIx(
      {
        instructionDiscriminator: Buffer.from(CLAIM_REWARD_DISCRIMINATOR),
        withdrawAmount: new BN(0),
        additionalArgs: jupiterSwapData,
      },
      {
        manager: toPublicKey(manager),
        vault: toPublicKey(config.voltrVaultAddress),
        vaultAssetMint: toPublicKey(config.assetMintAddress),
        assetTokenProgram: toPublicKey(config.assetTokenProgram),
        strategy: toPublicKey(kaminoVaultAddress),
        remainingAccounts: [
          ...claimRewardsRemainingAccounts,
          ...vaultReservesAccountMetas,
          ...vaultReservesLendingMarkets,
          ...jupiterSwapAccountMetas,
        ],
        adaptorProgram: toPublicKey(KAMINO_ADAPTOR_PROGRAM_ID),
      }
    );

  addressLookupTableAddresses.push(...jupiterSwapAddressLookupTableAddresses);
  addressLookupTableAddresses.push(vaultState.vaultLookupTable);

  transactionIxs.push(createClaimRewardStrategyIx);
}
