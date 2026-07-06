import type { InterestIndex } from "envio";
import type { Ctx } from "./types";
import { interestIndexSnapshotId } from "./ids";

/**
 * Ported from helpers.getOrCreateInterestIndexSnapshotAndReturnId. Creates (once) an
 * InterestIndexSnapshot capturing the index's borrow/supply values at its lastUpdate.
 * Returns the snapshot id. (The subgraph's loadInBlock optimisation is dropped — a
 * plain get() is functionally equivalent here.)
 */
export async function getOrCreateInterestIndexSnapshotAndReturnId(
  context: Ctx,
  interestIndex: InterestIndex
): Promise<string> {
  const snapshotId = interestIndexSnapshotId(interestIndex.token_id, interestIndex.lastUpdate);
  const existing = await context.InterestIndexSnapshot.get(snapshotId);
  if (existing === undefined) {
    context.InterestIndexSnapshot.set({
      id: snapshotId,
      token_id: interestIndex.token_id,
      borrowIndex: interestIndex.borrowIndex,
      supplyIndex: interestIndex.supplyIndex,
      updateTimestamp: interestIndex.lastUpdate,
    });
  }
  return snapshotId;
}
