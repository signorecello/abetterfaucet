import type { PublicClient } from "viem";
import type { Logger } from "../util/logger";
import { MAX_STATE_ROOT_AGE_MS } from "./modules/eth-balance/constants";

export class StateRootOracle {
  private client: PublicClient;
  private logger: Logger;

  constructor(client: PublicClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  async getLatestStateRoot(): Promise<{ blockNumber: bigint; stateRoot: string }> {
    const block = await this.client.getBlock({ blockTag: "latest" });
    if (!block.stateRoot) {
      throw new Error("Latest block missing stateRoot field");
    }
    return { blockNumber: block.number, stateRoot: block.stateRoot };
  }

  async isValidStateRoot(stateRoot: string, blockNumber: bigint): Promise<boolean> {
    const block = await this.client.getBlock({ blockNumber });
    if (!block.stateRoot) {
      this.logger.warn({ blockNumber: blockNumber.toString() }, "Block missing stateRoot field");
      return false;
    }

    if (block.stateRoot.toLowerCase() !== stateRoot.toLowerCase()) {
      this.logger.warn(
        {
          blockNumber: blockNumber.toString(),
          expectedStateRoot: stateRoot,
          actualStateRoot: block.stateRoot,
        },
        "State root mismatch for block",
      );
      return false;
    }

    const blockTimeMs = Number(block.timestamp) * 1000;
    const ageMs = Date.now() - blockTimeMs;
    if (ageMs > MAX_STATE_ROOT_AGE_MS) {
      this.logger.warn(
        {
          blockNumber: blockNumber.toString(),
          ageMs,
          maxAgeMs: MAX_STATE_ROOT_AGE_MS,
        },
        "Block too old",
      );
      return false;
    }

    return true;
  }
}
