import { Connection } from "@solana/web3.js";
import {
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  Rpc,
  SolanaRpcApi,
} from "@solana/kit";
import { config } from "../config";
import { logger } from "./utils";

export class ConnectionManager {
  private primaryUrl: string;
  private fallbackUrl: string | undefined;
  private activeUrl: string;
  private connection: Connection;
  private rpc: Rpc<SolanaRpcApi>;

  constructor() {
    this.primaryUrl = config.rpcUrl;
    this.fallbackUrl = config.rpcFallbackUrl;
    this.activeUrl = this.primaryUrl;
    this.connection = new Connection(this.activeUrl, "confirmed");
    this.rpc = this.createRpcInstance(this.activeUrl);

    logger.info(
      { primaryUrl: this.primaryUrl, hasFallback: !!this.fallbackUrl },
      "ConnectionManager initialized"
    );
  }

  private createRpcInstance(url: string): Rpc<SolanaRpcApi> {
    const api = createSolanaRpcApi<SolanaRpcApi>({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: "processed",
    });
    return createRpc({
      api,
      transport: createDefaultRpcTransport({ url }),
    });
  }

  getConnection(): Connection {
    return this.connection;
  }

  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  getRpcUrl(): string {
    return this.activeUrl;
  }

  switchToFallback(): boolean {
    if (!this.fallbackUrl) {
      logger.warn("No fallback RPC URL configured");
      return false;
    }
    logger.info("Switching to fallback RPC");
    this.activeUrl = this.fallbackUrl;
    this.connection = new Connection(this.activeUrl, "confirmed");
    this.rpc = this.createRpcInstance(this.activeUrl);
    return true;
  }

  switchToPrimary(): void {
    logger.info("Switching to primary RPC");
    this.activeUrl = this.primaryUrl;
    this.connection = new Connection(this.activeUrl, "confirmed");
    this.rpc = this.createRpcInstance(this.activeUrl);
  }

  destroy(): void {
    logger.info("ConnectionManager destroyed");
  }
}

let instance: ConnectionManager | null = null;

export function getConnectionManager(): ConnectionManager {
  if (!instance) {
    instance = new ConnectionManager();
  }
  return instance;
}

export function destroyConnectionManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
