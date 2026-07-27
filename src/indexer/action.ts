import type { ActionType } from "@prisma/client";

export function classifyAction(
  functionName?: string,
  eventName?: string,
  direction?: string
): ActionType {
  const value = `${functionName || ""} ${eventName || ""}`.toLowerCase();

  if (value.includes("create_account")) {
    return "ACCOUNT_CREATE";
  }

  if (value.includes("create_session")) {
    return "SESSION_CREATE";
  }

  if (value.includes("revoke_session")) {
    return "SESSION_REVOKE";
  }

  if (value.includes("recover")) {
    return "RECOVERY";
  }

  if (value.includes("guardian")) {
    return "GUARDIAN";
  }

  if (value.includes("unpause")) {
    return "UNPAUSE";
  }

  if (value.includes("pause")) {
    return "PAUSE";
  }

  if (value.includes("approve")) {
    return "APPROVE";
  }

  if (value.includes("swap")) {
    return "SWAP";
  }

  if (value.includes("withdraw")) {
    return "WITHDRAW";
  }

  if (value.includes("deposit")) {
    return "DEPOSIT";
  }

  if (value.includes("transfer")) {
    return direction === "IN" ? "RECEIVE" : "TRANSFER";
  }

  if (functionName) {
    return "CONTRACT_CALL";
  }

  return "UNKNOWN";
}
