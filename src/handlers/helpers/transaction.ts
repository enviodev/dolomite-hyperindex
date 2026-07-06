import type { Transaction } from "envio";
import type { Ctx } from "./types";
import { transactionId } from "./ids";

/**
 * Ported from amm-core.getOrCreateTransaction. Creates the Transaction singleton for
 * this tx hash if absent (with empty intermittent AMM arrays).
 */
export async function getOrCreateTransaction(
  context: Ctx,
  chainId: number,
  hash: string,
  blockNumber: bigint,
  timestamp: bigint
): Promise<Transaction> {
  const id = transactionId(chainId, hash);
  let transaction = await context.Transaction.get(id);
  if (transaction === undefined) {
    transaction = {
      id,
      blockNumber,
      timestamp,
      intermittentAmmMints: [],
      intermittentAmmBurns: [],
      intermittentAmmTrades: [],
    };
    context.Transaction.set(transaction);
  }
  return transaction;
}
