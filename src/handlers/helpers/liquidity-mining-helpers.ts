import type { LiquidityMiningVestingPosition } from "envio";
import { type Ctx, LiquidityMiningVestingPositionStatus } from "./types";
import { ZERO_BD, convertTokenToDecimal, _18_BI } from "./numbers";
import {
  liquidityMiningVesterId,
  liquidityMiningVestingPositionId,
  liquidityMiningClaimId,
  liquidityMiningSeasonId,
  tokenId,
  userId,
} from "./ids";
import { getConstants, ADDRESS_ZERO, OARB_TOKEN_ADDRESS, GOARB_TOKEN_ADDRESS } from "../../constants";
import { getOrCreateEffectiveUserTokenValue } from "./margin";
import { createUserIfNecessary } from "./user";

export { LiquidityMiningVestingPositionStatus };

export function getVestingPositionId(chainId: number, vester: string, nftId: bigint): string {
  return liquidityMiningVestingPositionId(chainId, vester, nftId);
}

export async function getVestingPosition(
  context: Ctx,
  chainId: number,
  vester: string,
  nftId: bigint
): Promise<LiquidityMiningVestingPosition | undefined> {
  return context.LiquidityMiningVestingPosition.get(getVestingPositionId(chainId, vester, nftId));
}

export function getLiquidityMiningSeasonId(
  chainId: number,
  distributor: string,
  user: string,
  season: bigint
): string {
  return liquidityMiningSeasonId(chainId, distributor, user, season);
}

/** Ported from liquidity-mining-helpers.handleVestingPositionClose. */
export async function handleVestingPositionClose(
  context: Ctx,
  position: LiquidityMiningVestingPosition
): Promise<void> {
  const vester = await context.LiquidityMiningVester.getOrThrow(position.vester_id);
  const pairToken = await context.Token.getOrThrow(vester.pairToken_id);
  const effectiveUserTokenValue = await getOrCreateEffectiveUserTokenValue(context, position.owner_id, pairToken);
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.minus(position.pairAmountPar);
  context.UserParValue.set(effectiveUserTokenValue);
}

/** Ported from liquidity-mining-helpers.handleClaim. */
export async function handleClaim(
  context: Ctx,
  chainId: number,
  distributor: string,
  user: string,
  epoch: bigint,
  seasonNumber: bigint,
  amount: bigint
): Promise<void> {
  await createUserIfNecessary(context, chainId, user);

  const claimId = liquidityMiningClaimId(chainId, distributor, user, epoch);
  const claimAmount = convertTokenToDecimal(amount, _18_BI);
  context.LiquidityMiningClaim.set({
    id: claimId,
    distributor,
    user_id: userId(chainId, user),
    epoch: Number(epoch),
    seasonNumber: Number(seasonNumber),
    amount: claimAmount,
  });

  const seasonId = liquidityMiningSeasonId(chainId, distributor, user, seasonNumber);
  const existing = await context.LiquidityMiningSeason.get(seasonId);
  const totalClaimAmount = (existing?.totalClaimAmount ?? ZERO_BD).plus(claimAmount);
  context.LiquidityMiningSeason.set({
    id: seasonId,
    distributor,
    user_id: userId(chainId, user),
    seasonNumber: Number(seasonNumber),
    totalClaimAmount,
  });
}

/**
 * Ported from liquidity-mining-helpers.createLiquidityMiningVester. Creates the
 * LiquidityMiningVester entity for the OARB / GOARB vester proxies. The subgraph also called
 * LiquidityMiningVesterTemplate.create(...) — in Envio the CALLING HANDLER must do the
 * dynamic `contractRegister` for the LiquidityMiningVester contract. Returns whether a vester
 * was created (so the caller knows to register the template).
 */
export async function createLiquidityMiningVester(context: Ctx, chainId: number, vesterAddress: string): Promise<boolean> {
  if (vesterAddress === ADDRESS_ZERO) {
    return false;
  }
  const c = getConstants(chainId);

  let oTokenAddress: string;
  let pairTokenAddr: string;
  let paymentTokenAddr: string;
  if (vesterAddress === c.oArbVester) {
    oTokenAddress = OARB_TOKEN_ADDRESS;
    pairTokenAddr = c.arb;
    paymentTokenAddr = c.weth;
  } else if (vesterAddress === c.goArbVester) {
    oTokenAddress = GOARB_TOKEN_ADDRESS;
    pairTokenAddr = c.grai;
    paymentTokenAddr = c.grai;
  } else {
    // Unknown vester — the subgraph would have created it with unset token fields; here we
    // skip to keep the entity valid (only OARB/GOARB vesters are ever registered).
    return false;
  }

  context.LiquidityMiningVester.set({
    id: liquidityMiningVesterId(chainId, vesterAddress),
    oTokenAddress,
    pairToken_id: tokenId(chainId, pairTokenAddr),
    paymentToken_id: tokenId(chainId, paymentTokenAddr),
  });
  return true;
}
