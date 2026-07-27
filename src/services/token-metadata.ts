import { Contract, Networks, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import type { Network } from "../config/env.js";
import { networkConfig } from "../config/env.js";
import { prisma } from "../db/prisma.js";

export class TokenMetadataService {
  async get(network: Network, contract: string) {
    const existing = await prisma.tokenMetadata.findUnique({ where: { network_contract: { network, contract } } });
    if (existing?.resolved) return existing;
    return this.resolve(network, contract, existing?.id);
  }

  async resolve(network: Network, contractId: string, existingId?: string) {
    const config = networkConfig[network];
    try {
      const server = new rpc.Server(config.rpcUrl);
      const account = await server.getAccount(config.simulationSource);
      const contract = new Contract(contractId);
      const passphrase = network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
      const calls = ["symbol", "decimals"] as const;
      const results: Record<string, unknown> = {};
      for (const fn of calls) {
        const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
          .addOperation(contract.call(fn))
          .setTimeout(30)
          .build();
        const simulation = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simulation) || !simulation.result?.retval) {
          throw new Error(`Unable to simulate ${fn}: ${rpc.Api.isSimulationError(simulation) ? simulation.error : "missing retval"}`);
        }
        results[fn] = scValToNative(simulation.result.retval);
      }
      const symbol = String(results.symbol || "UNKNOWN");
      const decimals = Number(results.decimals ?? 7);
      return prisma.tokenMetadata.upsert({
        where: { network_contract: { network, contract: contractId } },
        create: { network, contract: contractId, symbol, decimals, resolved: true, lastResolvedAt: new Date() },
        update: { symbol, decimals, resolved: true, lastError: null, lastResolvedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return prisma.tokenMetadata.upsert({
        where: { network_contract: { network, contract: contractId } },
        create: { network, contract: contractId, symbol: "UNKNOWN", decimals: 7, resolved: false, lastError: message },
        update: { resolved: false, lastError: message },
      });
    }
  }

  async setClassicMapping(network: Network, contract: string, input: { classicCode: string; classicIssuer?: string | null; symbol?: string; decimals?: number; icon?: string | null }) {
    return prisma.tokenMetadata.upsert({
      where: { network_contract: { network, contract } },
      create: {
        network, contract, symbol: input.symbol || input.classicCode, decimals: input.decimals ?? 7,
        classicCode: input.classicCode, classicIssuer: input.classicIssuer, icon: input.icon, resolved: true, lastResolvedAt: new Date(),
      },
      update: {
        symbol: input.symbol || input.classicCode, decimals: input.decimals ?? 7,
        classicCode: input.classicCode, classicIssuer: input.classicIssuer, icon: input.icon, resolved: true, lastResolvedAt: new Date(),
      },
    });
  }
}

export const tokenMetadataService = new TokenMetadataService();
