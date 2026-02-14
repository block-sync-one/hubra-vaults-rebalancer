import { BN } from "@coral-xyz/anchor";
import { Address } from "@solana/kit";

export interface Allocation {
  strategyId: string;
  strategyType: string;
  strategyAddress: Address;
  positionValue: BN;
}
