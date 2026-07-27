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

type NormalTransaction = Transaction<unknown>;

function getInnerTransaction(
  network: Network,
  envelopeXdr: string
): NormalTransaction {
  const passphrase = network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
  const parsed = TransactionBuilder.fromXDR(envelopeXdr, passphrase);

  return parsed instanceof FeeBumpTransaction
    ? (parsed.innerTransaction as NormalTransaction)
    : (parsed as NormalTransaction);
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
  const type = memo.switch().name;

  if (type === "memoNone") return {};
  if (type === "memoText") {
    return {
      memoType: "text",
      memoValue: Buffer.from(memo.text()).toString("utf8"),
    };
  }
  if (type === "memoId") {
    return { memoType: "id", memoValue: memo.id().toString() };
  }
  if (type === "memoHash") {
    return {
      memoType: "hash",
      memoValue: Buffer.from(memo.hash()).toString("hex"),
    };
  }
  if (type === "memoReturn") {
    return {
      memoType: "return",
      memoValue: Buffer.from(memo.retHash()).toString("hex"),
    };
  }

  return {};
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
    if (body.switch() !== xdr.OperationType.invokeHostFunction()) return;

    const invoke = body.invokeHostFunctionOp();
    const host = invoke.hostFunction();
    if (
      host.switch() !==
      xdr.HostFunctionType.hostFunctionTypeInvokeContract()
    ) {
      return;
    }

    const invocation = host.invokeContract();
    const contractId = Address.fromScAddress(
      invocation.contractAddress()
    ).toString();
    const functionName = invocation.functionName().toString();
    const args = invocation
      .args()
      .map((arg) => normalizeNative(scValToNative(arg)));

    const authAddresses = new Set<string>();
    for (const entry of invoke.auth() || []) {
      try {
        if (
          entry.credentials().switch() ===
          xdr.SorobanCredentialsType.sorobanCredentialsAddress()
        ) {
          authAddresses.add(
            Address.fromScAddress(
              entry.credentials().address().address()
            ).toString()
          );
        }
      } catch {
        // An unrelated malformed auth entry must not stop ledger ingestion.
      }
    }

    parsed.push({
      operationIndex,
      sourceAccount,
      contractId,
      functionName,
      args,
      authAddresses: [...authAddresses],
      ...txMemo,
    });
  });

  return parsed;
}
