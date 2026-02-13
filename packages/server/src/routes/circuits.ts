import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { ModuleRegistry } from "../lib/modules/registry";
import type { FundDispatcher } from "../lib/fund-dispatcher";
import { AppError } from "../util/errors";

export interface CircuitsDeps {
  registry: ModuleRegistry;
  dispatcher: FundDispatcher;
  startTime: number;
}

export function createModulesRouter(deps: CircuitsDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const modules = deps.registry.list().map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      currentEpoch: m.currentEpoch(),
      epochDurationSeconds: m.epochDurationSeconds,
    }));
    return c.json({ modules });
  });

  return app;
}

export function createCircuitsRouter(deps: CircuitsDeps): Hono {
  const app = new Hono();

  app.get("/:moduleId/artifact.json", (c) => {
    const moduleId = c.req.param("moduleId");
    const module = deps.registry.get(moduleId);
    if (!module) {
      throw AppError.notFound(`Module ${moduleId}`);
    }

    if (moduleId !== "eth-balance") {
      throw AppError.notFound(`Circuit artifact for ${moduleId}`);
    }

    const artifactPath =
      process.env.CIRCUIT_ARTIFACT_PATH ??
      resolve(
        process.cwd(),
        "packages/circuits/bin/eth_balance/target/eth_balance.json",
      );

    if (!existsSync(artifactPath)) {
      throw AppError.notFound(
        `Circuit artifact not found at ${artifactPath}. Run 'nargo compile' to generate it.`,
      );
    }

    const artifact = readFileSync(artifactPath, "utf-8");
    return c.json(JSON.parse(artifact));
  });

  return app;
}

export function createNetworksRouter(deps: CircuitsDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const networks = deps.dispatcher.getNetworks().map((n) => ({
      id: n.id,
      name: n.name,
      chainId: n.chainId,
      explorerUrl: n.explorerUrl,
      enabled: n.enabled,
      dispensationWei: n.dispensationWei,
    }));
    return c.json({ networks });
  });

  return app;
}

export function createHealthRouter(deps: CircuitsDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const uptimeMs = Date.now() - deps.startTime;
    return c.json({
      status: "ok",
      uptime: uptimeMs,
      version: "0.1.0",
    });
  });

  return app;
}
