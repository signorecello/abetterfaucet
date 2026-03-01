import { Hono } from "hono";
import * as v from "valibot";
import { ClaimRequestSchema } from "../util/schemas";
import { AppError } from "../util/errors";
import type { ModuleRegistry } from "../lib/modules/registry";
import type { NullifierStore } from "../lib/nullifier-store";
import type { FundDispatcher } from "../lib/fund-dispatcher";
import type { ClaimStore } from "../lib/claim-store";
import type { Logger } from "../util/logger";
import type { PublicInputs } from "../lib/modules/types";

export interface ClaimDeps {
  registry: ModuleRegistry;
  nullifierStore: NullifierStore;
  claimStore: ClaimStore;
  dispatcher: FundDispatcher;
  logger: Logger;
}

export function createClaimRouter(deps: ClaimDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const t0 = performance.now();

    // Parse and validate the request body
    const body = await c.req.json();
    const parseResult = v.safeParse(ClaimRequestSchema, body);
    if (!parseResult.success) {
      const issues = parseResult.issues.map((i) => i.message).join("; ");
      throw AppError.invalidPublicInputs(issues);
    }

    const { moduleId, proof, publicInputs, recipient, targetNetwork } = parseResult.output;
    deps.logger.debug({ moduleId, recipient, targetNetwork }, "Claim request received");

    // Look up the proof module
    const module = deps.registry.get(moduleId);
    if (!module) {
      throw AppError.invalidModule(moduleId);
    }

    // Validate public inputs (state root freshness, epoch, min balance)
    const pi: PublicInputs = {
      stateRoot: publicInputs.stateRoot,
      epoch: publicInputs.epoch,
      minBalance: publicInputs.minBalance,
      nullifier: publicInputs.nullifier,
      blockNumber: publicInputs.blockNumber,
    };

    const t1 = performance.now();
    const validation = await module.validatePublicInputs(pi);
    if (!validation.valid) {
      throw AppError.invalidPublicInputs(validation.error ?? "Unknown validation error");
    }
    deps.logger.debug({ durationMs: Math.round(performance.now() - t1) }, "Public inputs validated");

    // Decode proof from hex (bound size to prevent memory exhaustion)
    const MAX_PROOF_BYTES = 100_000;
    const proofHex = proof.startsWith("0x") ? proof.slice(2) : proof;
    if (proofHex.length === 0) {
      throw AppError.invalidProof("Proof is empty");
    }
    if (proofHex.length > MAX_PROOF_BYTES * 2) {
      throw AppError.invalidProof("Proof exceeds maximum size");
    }
    const proofBytes = new Uint8Array(
      proofHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    deps.logger.debug({ proofSize: proofBytes.length }, "Proof decoded");

    // Verify the ZK proof
    const t2 = performance.now();
    const isValid = await module.verifyProof(proofBytes, pi);
    const verifyMs = Math.round(performance.now() - t2);
    deps.logger.info({ durationMs: verifyMs }, "Proof verification completed");
    if (!isValid) {
      throw AppError.invalidProof();
    }

    // Atomically check and record nullifier (prevents concurrent double-spend)
    const spent = deps.nullifierStore.spend(module.nullifierGroup, publicInputs.nullifier, publicInputs.epoch, recipient);
    if (!spent) {
      throw AppError.alreadyClaimed();
    }

    // Dispatch funds — roll back nullifier if dispatch fails (C1 fix)
    const t3 = performance.now();
    let result: { txHash: string; claimId: string };
    try {
      result = await deps.dispatcher.dispatch(
        targetNetwork,
        recipient as `0x${string}`,
      );
    } catch (err) {
      // Roll back the nullifier so the user can retry
      deps.nullifierStore.unspend(module.nullifierGroup, publicInputs.nullifier);
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err, recipient, targetNetwork }, "Fund dispatch failed");
      throw AppError.dispatchFailed(message);
    }
    deps.logger.debug({ durationMs: Math.round(performance.now() - t3), txHash: result.txHash }, "Funds dispatched");

    // Record claim status in SQLite
    deps.claimStore.insert({
      claimId: result.claimId,
      status: "confirmed",
      txHash: result.txHash,
      network: targetNetwork,
      moduleId,
      recipient,
      createdAt: Date.now(),
    });

    const network = deps.dispatcher.getNetwork(targetNetwork);
    const totalMs = Math.round(performance.now() - t0);

    deps.logger.info(
      { claimId: result.claimId, txHash: result.txHash, network: targetNetwork, totalMs },
      "Claim successful",
    );

    return c.json({
      claimId: result.claimId,
      txHash: result.txHash,
      network: targetNetwork,
      amount: network?.dispensationWei ?? "0",
    });
  });

  return app;
}
