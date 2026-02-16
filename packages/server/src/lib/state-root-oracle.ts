import type { PublicClient } from "viem";
import type { Logger } from "../util/logger";
import { MAX_STATE_ROOT_AGE_BLOCKS } from "./modules/eth-balance/constants";

interface CachedStateRoot {
  blockNumber: bigint;
  stateRoot: string;
}

export class StateRootOracle {
  private client: PublicClient;
  private logger: Logger;
  private cache: CachedStateRoot[] = [];
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private maxAge: number;

  constructor(client: PublicClient, logger: Logger, maxAge: number = MAX_STATE_ROOT_AGE_BLOCKS) {
    this.client = client;
    this.logger = logger;
    this.maxAge = maxAge;
  }

  async start(): Promise<void> {
    await this.refresh();
    // Refresh every 12 seconds (L1 block time)
    this.refreshInterval = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error({ err }, "Failed to refresh state roots");
      });
    }, 12_000);
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  private async refresh(): Promise<void> {
    const block = await this.client.getBlock({ blockTag: "latest" });
    if (!block.stateRoot) {
      this.logger.warn("Block missing stateRoot field");
      return;
    }

    const existing = this.cache.find((c) => c.blockNumber === block.number);
    if (existing) return;

    // Find the highest cached block to detect gaps
    const lastCached = this.cache.length > 0
      ? this.cache.reduce((max, c) => c.blockNumber > max ? c.blockNumber : max, 0n)
      : null;

    // Backfill any skipped blocks between last cached and current
    if (lastCached !== null && block.number > lastCached + 1n) {
      const gapStart = lastCached + 1n;
      const gapEnd = block.number - 1n;
      // Cap backfill to avoid flooding RPC on first large gap
      const maxBackfill = 10n;
      const fillFrom = gapEnd - maxBackfill + 1n > gapStart ? gapEnd - maxBackfill + 1n : gapStart;

      const fetches: Promise<void>[] = [];
      for (let n = fillFrom; n <= gapEnd; n++) {
        const blockNum = n;
        fetches.push(
          this.client.getBlock({ blockNumber: blockNum }).then((b) => {
            if (b.stateRoot && !this.cache.find((c) => c.blockNumber === b.number)) {
              this.cache.push({ blockNumber: b.number, stateRoot: b.stateRoot });
            }
          }).catch((err) => {
            this.logger.debug({ blockNumber: blockNum.toString(), err }, "Failed to backfill block");
          }),
        );
      }
      if (fetches.length > 0) {
        await Promise.all(fetches);
        this.logger.debug(
          { from: fillFrom.toString(), to: gapEnd.toString(), count: fetches.length },
          "Backfilled missed blocks",
        );
      }
    }

    // Add the latest block
    this.cache.push({
      blockNumber: block.number,
      stateRoot: block.stateRoot,
    });

    // Prune entries older than maxAge blocks
    const minBlock = block.number - BigInt(this.maxAge);
    this.cache = this.cache.filter((c) => c.blockNumber >= minBlock);

    this.logger.debug(
      {
        blockNumber: block.number.toString(),
        stateRoot: block.stateRoot,
        cacheSize: this.cache.length,
      },
      "State root cache updated",
    );
  }

  async getLatestStateRoot(): Promise<{ blockNumber: bigint; stateRoot: string }> {
    if (this.cache.length === 0) {
      await this.refresh();
    }
    if (this.cache.length === 0) {
      throw new Error("No state roots available");
    }
    // Return the most recent cached entry
    return this.cache[this.cache.length - 1];
  }

  async isValidStateRoot(stateRoot: string): Promise<boolean> {
    if (this.cache.length === 0) {
      await this.refresh();
    }
    const normalizedInput = stateRoot.toLowerCase();
    const match = this.cache.some((c) => c.stateRoot.toLowerCase() === normalizedInput);
    if (!match) {
      const latest = this.cache.length > 0 ? this.cache[this.cache.length - 1] : null;
      const oldest = this.cache.length > 0 ? this.cache[0] : null;
      this.logger.warn(
        {
          requestedStateRoot: stateRoot,
          cacheSize: this.cache.length,
          latestCachedBlock: latest?.blockNumber.toString(),
          latestCachedRoot: latest?.stateRoot,
          oldestCachedBlock: oldest?.blockNumber.toString(),
          oldestCachedRoot: oldest?.stateRoot,
        },
        "State root not found in cache",
      );
    }
    return match;
  }
}
