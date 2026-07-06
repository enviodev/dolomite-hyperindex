import type { User } from "envio";
import type { Ctx } from "./types";
import { ZERO_BD, ZERO_BI, ONE_BI } from "./numbers";
import { userId, dolomiteMarginId } from "./ids";
import { getConstants } from "../../constants";

/**
 * Ported from user-helpers.createUserIfNecessary. Creates the User (self-effective
 * until an IsolationMode event rebinds it) and bumps DolomiteMargin.userCount.
 *
 * NOTE: the subgraph loaded DolomiteMargin with a non-null assertion. Here we guard
 * so early user creation (before the DolomiteMargin singleton exists) does not throw;
 * the count is bumped only once the singleton is present.
 */
export async function createUserIfNecessary(context: Ctx, chainId: number, address: string): Promise<void> {
  const id = userId(chainId, address);
  const existing = await context.User.get(id);
  if (existing !== undefined) {
    return;
  }

  const user: User = {
    id,
    effectiveUser_id: id, // self-reflective until an IsolationMode event fires
    accountRiskOverrideSetter: undefined,
    totalBorrowVolumeOriginatedUSD: ZERO_BD,
    totalCollateralLiquidatedUSD: ZERO_BD,
    totalTradeVolumeUSD: ZERO_BD,
    totalZapVolumeUSD: ZERO_BD,
    totalBorrowPositionCount: ZERO_BI,
    totalLiquidationCount: ZERO_BI,
    totalMarginPositionCount: ZERO_BI,
    totalTradeCount: ZERO_BI,
    totalZapCount: ZERO_BI,
    isEffectiveUser: true,
    isolationModeVault_id: undefined,
  };
  context.User.set(user);

  const marginAddress = getConstants(chainId).dolomiteMargin;
  const dm = await context.DolomiteMargin.get(dolomiteMarginId(chainId, marginAddress));
  if (dm !== undefined) {
    context.DolomiteMargin.set({ ...dm, userCount: dm.userCount + ONE_BI });
  }
}
