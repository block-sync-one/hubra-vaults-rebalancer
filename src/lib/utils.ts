import crypto from "crypto";
import pino from "pino";
import { config } from "../config";

const sessionId = crypto.randomBytes(4).toString("hex");

export const logger = pino({
  level: config.logLevel,
  base: { sessionId },
  ...(process.env.NODE_ENV === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          },
        },
      }),
});

// --- Shutdown infrastructure ---
let _isShuttingDown = false;

export function isShuttingDown(): boolean {
  return _isShuttingDown;
}

export function setShuttingDown(): void {
  _isShuttingDown = true;
}

// Interruptible sleep that resolves early when shutting down
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (_isShuttingDown) {
      resolve();
      return;
    }
    const checkInterval = 500;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (_isShuttingDown || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });

// A wrapper to make a function retry forever with exponential backoff
export async function recursiveTryCatch(
  f: () => Promise<void>,
  name: string,
  options?: { baseDelayMs?: number; maxDelayMs?: number; jitter?: number }
) {
  const baseDelay = options?.baseDelayMs ?? 1000;
  const maxDelay = options?.maxDelayMs ?? 60000;
  const jitter = options?.jitter ?? 0.25;
  let consecutiveFailures = 0;

  while (!isShuttingDown()) {
    try {
      await f();
      consecutiveFailures = 0;
    } catch (e) {
      if (isShuttingDown()) break;
      consecutiveFailures++;
      const exponentialDelay = Math.min(
        baseDelay * Math.pow(2, consecutiveFailures - 1),
        maxDelay
      );
      const jitterFactor = 1 + (Math.random() * 2 - 1) * jitter;
      const retryInMs = Math.round(exponentialDelay * jitterFactor);
      logger.error(
        { loop: name, attempt: consecutiveFailures, retryInMs, err: e },
        `Error in loop [${name}]. Retrying in ${retryInMs}ms...`
      );
      await sleep(retryInMs);
    }
  }
  logger.info({ loop: name }, `Loop [${name}] exiting due to shutdown`);
}
