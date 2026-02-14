import { Address } from "@solana/kit/";
import Decimal from "decimal.js";
import { logger } from "./utils";

const KSWAP_BASE_API = "https://api.kamino.finance/kswap";

interface TokenPriceData {
  isScaledUiToken: boolean;
  value: number;
  updateUnixTime: number;
  updateHumanTime: string;
  priceInNative: number;
  priceChange24h: number;
}

interface BatchPriceResponse {
  success: boolean;
  data: { [key: string]: TokenPriceData | null };
}

export class PriceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceFetchError";
  }
}

export async function getTokensBatchPrice(
  tokens: Address[]
): Promise<Map<Address, Decimal>> {
  const tokensParams = tokens
    .map((token) => `tokens=${encodeURIComponent(token)}`)
    .join("&");
  const url = `${KSWAP_BASE_API}/batch-token-prices?${tokensParams}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const data = (await response.json()) as BatchPriceResponse;

  if (!data.success) {
    throw new PriceFetchError("Batch price API response indicates failure");
  }

  const prices = new Map<Address, Decimal>();
  const missingTokens: Address[] = [];
  for (const token of tokens) {
    const tokenData = data.data[token];
    if (
      tokenData &&
      tokenData.value !== null &&
      tokenData.value !== undefined
    ) {
      const price = new Decimal(tokenData.value);
      prices.set(token, price);
    } else {
      missingTokens.push(token);
    }
  }

  if (missingTokens.length > 0) {
    throw new PriceFetchError(
      `No price data for tokens: ${missingTokens.join(", ")}`
    );
  }

  return prices;
}
