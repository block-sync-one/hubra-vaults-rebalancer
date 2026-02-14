import { parentPort } from "worker_threads";
import { logger, recursiveTryCatch, setShuttingDown } from "./lib/utils";
import { runRebalanceLoop } from "./rebalance_loop";

// Listen for shutdown message from parent
parentPort?.on("message", (msg: { type: string }) => {
  if (msg.type === "shutdown") {
    logger.info("Rebalance worker received shutdown signal");
    setShuttingDown();
  }
});

// Notify parent that the worker has started
parentPort?.postMessage({ type: "started" });

// Run the rebalance loop with retry wrapper
recursiveTryCatch(() => runRebalanceLoop(), "rebalance-worker").catch(
  (error) => {
    logger.error({ err: error }, "Fatal error in rebalance worker");
    process.exit(1);
  }
);
