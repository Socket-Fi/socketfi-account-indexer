import { type Network, type SocketFiWallet } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export class WalletRegistry {
  private readonly sets: Record<Network, Set<string>> = {
    TESTNET: new Set<string>(),
    PUBLIC: new Set<string>(),
  };

  async initialize(): Promise<void> {
    const rows = await prisma.socketFiWallet.findMany({ select: { network: true, address: true } });
    for (const row of rows) this.sets[row.network].add(row.address);
  }

  has(network: Network, address: string): boolean {
    return this.sets[network].has(address);
  }

  findFirst(network: Network, addresses: Iterable<string>): string | undefined {
    for (const address of addresses) if (this.has(network, address)) return address;
    return undefined;
  }

  async add(input: Omit<SocketFiWallet, "id" | "createdAt" | "updatedAt" | "transactions">): Promise<void> {
    await prisma.socketFiWallet.upsert({
      where: { network_address: { network: input.network, address: input.address } },
      create: input,
      update: {
        authType: input.authType,
        stellarSignerHex: input.stellarSignerHex,
        passkeyHex: input.passkeyHex,
        blsKeyCount: input.blsKeyCount,
        creationTxHash: input.creationTxHash,
        createdAtLedger: input.createdAtLedger,
        createdAtLedgerTime: input.createdAtLedgerTime,
      },
    });
    this.sets[input.network].add(input.address);
  }

  size(network: Network): number { return this.sets[network].size; }
}

export const walletRegistry = new WalletRegistry();
