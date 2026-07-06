import type { BigDecimal, AmmLiquidityPosition } from "envio";
import type { Ctx, EventMeta, Mutable, ValueStruct } from "./types";
import { ZERO_BD, ONE_BI, bd, exponentToBigDecimal } from "./numbers";
import { ammPairId, ammLiquidityPositionId } from "./ids";
import { getOrCreateInterestIndexSnapshotAndReturnId } from "./interest-index";

/**
 * Ported from amm-helpers.convertStructToDecimalAppliedValue. NOTE: faithfully preserves
 * the subgraph quirk that a 0-decimals token returns ZERO_BD (not the raw value).
 */
export function convertStructToDecimalAppliedValue(struct: ValueStruct, exchangeDecimals: bigint): BigDecimal {
  const value = struct.sign ? struct.value : -struct.value;
  if (exchangeDecimals === 0n) {
    return ZERO_BD;
  }
  return bd(value).div(exponentToBigDecimal(exchangeDecimals));
}

/**
 * Ported from amm-helpers.createLiquidityPosition. Creates the AmmLiquidityPosition (and
 * bumps the pair's liquidityProviderCount) if absent. Returns a mutable copy.
 */
export async function createLiquidityPosition(
  context: Ctx,
  chainId: number,
  exchange: string,
  userAddress: string
): Promise<Mutable<AmmLiquidityPosition>> {
  const positionId = ammLiquidityPositionId(chainId, exchange, userAddress);
  const existing = await context.AmmLiquidityPosition.get(positionId);
  if (existing !== undefined) {
    return { ...existing };
  }

  const pair = await context.AmmPair.getOrThrow(ammPairId(chainId, exchange));
  context.AmmPair.set({ ...pair, liquidityProviderCount: pair.liquidityProviderCount + ONE_BI });

  const user = await context.User.getOrThrow(`${chainId}-${userAddress}`);
  const position: Mutable<AmmLiquidityPosition> = {
    id: positionId,
    liquidityTokenBalance: ZERO_BD,
    pair_id: ammPairId(chainId, exchange),
    user_id: `${chainId}-${userAddress}`,
    effectiveUser_id: user.effectiveUser_id,
  };
  context.AmmLiquidityPosition.set(position);
  return position;
}

/**
 * Ported from amm-helpers.createLiquiditySnapshot. Captures the LP position's reserves /
 * balances at the current block into an AmmLiquidityPositionSnapshot.
 */
export async function createLiquiditySnapshot(
  context: Ctx,
  chainId: number,
  position: AmmLiquidityPosition,
  meta: EventMeta
): Promise<void> {
  const timestamp = Number(meta.timestamp);
  const bundle = await context.Bundle.getOrThrow(`${chainId}-1`);
  const pair = await context.AmmPair.getOrThrow(position.pair_id);
  const token0 = await context.Token.getOrThrow(pair.token0_id);
  const token1 = await context.Token.getOrThrow(pair.token1_id);
  const token0MarketIndex = await context.InterestIndex.getOrThrow(token0.id);
  const token1MarketIndex = await context.InterestIndex.getOrThrow(token1.id);

  const token0InterestIndex = await getOrCreateInterestIndexSnapshotAndReturnId(context, token0MarketIndex);
  const token1InterestIndex = await getOrCreateInterestIndexSnapshotAndReturnId(context, token1MarketIndex);

  // subgraph id: `${position.id}${timestamp}` (no separator).
  context.AmmLiquidityPositionSnapshot.set({
    id: `${position.id}${timestamp.toString()}`,
    liquidityPosition_id: position.id,
    timestamp,
    block: Number(meta.blockNumber),
    user_id: position.user_id,
    effectiveUser_id: position.effectiveUser_id,
    pair_id: position.pair_id,
    token0PriceUSD: (token0.derivedETH ?? ZERO_BD).times(bundle.ethPrice),
    token1PriceUSD: (token1.derivedETH ?? ZERO_BD).times(bundle.ethPrice),
    reserve0: pair.reserve0,
    reserve1: pair.reserve1,
    reserveUSD: pair.reserveUSD,
    liquidityTokenTotalSupply: pair.totalSupply,
    liquidityTokenBalance: position.liquidityTokenBalance,
    token0InterestIndex_id: token0InterestIndex,
    token1InterestIndex_id: token1InterestIndex,
  });
}
