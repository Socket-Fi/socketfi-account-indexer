import {
  Address,
  FeeBumpTransaction,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { Network } from "../config/env.js";
import type { ParsedInvocation, RpcTransactionItem } from "./types.js";
import { normalizeNative } from "../utils/scval.js";

type NormalTransaction = Transaction;

type AddressCredentialsLike = {
  address(): xdr.ScAddress;
};

type SorobanCredentialsLike = {
  switch(): {
    name: string;
    value?: number;
  };
  address?: () => AddressCredentialsLike;
  addressV2?: () => AddressCredentialsLike;
};

function getNetworkPassphrase(network: Network): string {
  return network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
}

function getInnerTransaction(
  network: Network,
  envelopeXdr: string
): NormalTransaction {
  const parsed = TransactionBuilder.fromXDR(
    envelopeXdr,
    getNetworkPassphrase(network)
  );

  if (parsed instanceof FeeBumpTransaction) {
    return parsed.innerTransaction;
  }

  return parsed;
}

function getTransactionXdr(envelopeXdr: string): xdr.Transaction {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");

  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().tx();

    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().tx().innerTx().v1().tx();

    default:
      throw new Error(
        `Unsupported transaction envelope type: ${envelope.switch().name}`
      );
  }
}

function readMemo(tx: xdr.Transaction): {
  memoType?: string;
  memoValue?: string;
} {
  const memo = tx.memo();
  const memoType = memo.switch().name;

  switch (memoType) {
    case "memoNone":
      return {};

    case "memoText":
      return {
        memoType: "text",
        memoValue: Buffer.from(memo.text()).toString("utf8"),
      };

    case "memoId":
      return {
        memoType: "id",
        memoValue: memo.id().toString(),
      };

    case "memoHash":
      return {
        memoType: "hash",
        memoValue: Buffer.from(memo.hash()).toString("hex"),
      };

    case "memoReturn":
      return {
        memoType: "return",
        memoValue: Buffer.from(memo.retHash()).toString("hex"),
      };

    default:
      return {};
  }
}

function scAddressToString(address: xdr.ScAddress): string | undefined {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return undefined;
  }
}

function readAuthorizationAddress(
  entry: xdr.SorobanAuthorizationEntry
): string | undefined {
  try {
    const credentials =
      entry.credentials() as unknown as SorobanCredentialsLike;

    const credentialType = credentials.switch().name;

    /*
     * Legacy Soroban address credentials:
     *
     * SOROBAN_CREDENTIALS_ADDRESS
     */
    if (
      credentialType === "sorobanCredentialsAddress" &&
      typeof credentials.address === "function"
    ) {
      return scAddressToString(credentials.address().address());
    }

    /*
     * Protocol 27 / CAP-71 address credentials:
     *
     * SOROBAN_CREDENTIALS_ADDRESS_V2
     *
     * The generated JavaScript accessor is expected to be addressV2().
     * The structural runtime check keeps this parser compatible even if
     * the concrete SDK typings differ between releases.
     */
    if (
      credentialType === "sorobanCredentialsAddressV2" &&
      typeof credentials.addressV2 === "function"
    ) {
      return scAddressToString(credentials.addressV2().address());
    }

    return undefined;
  } catch {
    /*
     * A malformed, unsupported, or future credential variant must not
     * stop the entire ledger from being indexed.
     */
    return undefined;
  }
}

function collectAuthorizationAddresses(
  entries: xdr.SorobanAuthorizationEntry[]
): string[] {
  const addresses = new Set<string>();

  for (const entry of entries) {
    const address = readAuthorizationAddress(entry);

    if (address) {
      addresses.add(address);
    }
  }

  return [...addresses];
}

export function parseInvocations(
  network: Network,
  item: RpcTransactionItem
): ParsedInvocation[] {
  const innerTransaction = getInnerTransaction(network, item.envelopeXdr);

  const tx = getTransactionXdr(item.envelopeXdr);
  const sourceAccount = innerTransaction.source;
  const txMemo = readMemo(tx);
  const parsed: ParsedInvocation[] = [];

  tx.operations().forEach((operation, operationIndex) => {
    const body = operation.body();

    if (body.switch() !== xdr.OperationType.invokeHostFunction()) {
      return;
    }

    const invoke = body.invokeHostFunctionOp();
    const hostFunction = invoke.hostFunction();

    if (
      hostFunction.switch() !==
      xdr.HostFunctionType.hostFunctionTypeInvokeContract()
    ) {
      return;
    }

    const invocation = hostFunction.invokeContract();

    const contractId = Address.fromScAddress(
      invocation.contractAddress()
    ).toString();

    const functionName = invocation.functionName().toString();

    const args = invocation
      .args()
      .map((argument) => normalizeNative(scValToNative(argument)));

    const authAddresses = collectAuthorizationAddresses(invoke.auth() ?? []);

    parsed.push({
      operationIndex,
      sourceAccount,
      contractId,
      functionName,
      args,
      authAddresses,
      ...txMemo,
    });
  });

  return parsed;
}
