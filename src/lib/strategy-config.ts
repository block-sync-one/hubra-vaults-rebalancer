import { readFileSync } from "fs";
import { join } from "path";
import { Address, address } from "@solana/kit";

export type StrategyType = "kaminoVault" | "kaminoMarket" | "driftEarn" | "jupiterLend";

interface BaseStrategyConfig {
  id: string;
  type: string;
  address: Address;
}

export interface KaminoVaultStrategyConfig extends BaseStrategyConfig {
  type: "kaminoVault";
}

export interface KaminoMarketStrategyConfig extends BaseStrategyConfig {
  type: "kaminoMarket";
}

export interface DriftEarnStrategyConfig extends BaseStrategyConfig {
  type: "driftEarn";
}

export interface JupiterLendStrategyConfig extends BaseStrategyConfig {
  type: "jupiterLend";
}

export type KnownStrategyConfig =
  | KaminoVaultStrategyConfig
  | KaminoMarketStrategyConfig
  | DriftEarnStrategyConfig
  | JupiterLendStrategyConfig;

export type StrategyConfig = KnownStrategyConfig | BaseStrategyConfig;

export interface StrategyRegistry {
  strategies: StrategyConfig[];
  byId: Map<string, StrategyConfig>;
  kaminoVaults: KaminoVaultStrategyConfig[];
  kaminoMarkets: KaminoMarketStrategyConfig[];
  driftEarns: DriftEarnStrategyConfig[];
}

export const IDLE_ID = "idle";

function loadStrategyRegistry(): StrategyRegistry {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "strategies.json"), "utf-8")
  );

  const strategies: StrategyConfig[] = raw.strategies.map((s: any) => {
    const base: BaseStrategyConfig = { id: s.id, type: s.type, address: address(s.address) };
    switch (s.type) {
      case "driftEarn":
        return { ...base, type: "driftEarn" } as DriftEarnStrategyConfig;
      case "kaminoVault":
        return { ...base, type: "kaminoVault" } as KaminoVaultStrategyConfig;
      case "kaminoMarket":
        return { ...base, type: "kaminoMarket" } as KaminoMarketStrategyConfig;
      case "jupiterLend":
        return { ...base, type: "jupiterLend" } as JupiterLendStrategyConfig;
      default:
        return base;
    }
  });

  const byId = new Map<string, StrategyConfig>();
  for (const s of strategies) {
    byId.set(s.id, s);
  }

  const kaminoVaults = strategies.filter(
    (s): s is KaminoVaultStrategyConfig => s.type === "kaminoVault"
  );

  const kaminoMarkets = strategies.filter(
    (s): s is KaminoMarketStrategyConfig => s.type === "kaminoMarket"
  );

  const driftEarns = strategies.filter(
    (s): s is DriftEarnStrategyConfig => s.type === "driftEarn"
  );

  return {
    strategies,
    byId,
    kaminoVaults,
    kaminoMarkets,
    driftEarns,
  };
}

export const strategyRegistry = loadStrategyRegistry();
