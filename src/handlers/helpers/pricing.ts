import type { BigDecimal, Token } from "envio";
import type { Ctx, EventMeta } from "./types";
import { ZERO_BD, ONE_BD, bd, convertTokenToDecimal } from "./numbers";
import { tokenId, ammPairId, ammPairLookupId, bundleId } from "./ids";
import { getConstants } from "../../constants";
import { getMarketPrice } from "../../effects";

// minimum liquidity for a price to get tracked
const MINIMUM_LIQUIDITY_THRESHOLD_ETH = bd("2");

/** Strip the `${chainId}-` prefix from a namespaced token id, returning the raw address. */
function rawAddress(entityId: string): string {
  const idx = entityId.indexOf("-");
  return idx === -1 ? entityId : entityId.substring(idx + 1);
}

function convertPriceToDecimal(rawPrice: bigint, token: Token): BigDecimal {
  return convertTokenToDecimal(rawPrice, 36n - token.decimals);
}

/**
 * Ported from pricing.getTokenOraclePriceUSD. Reads DolomiteMargin.getMarketPrice via the
 * getMarketPrice effect and caches per token in the OraclePrice entity. The subgraph keyed
 * its cache on the block HASH; here we key on the block NUMBER (hash may not be selected).
 * `protocolType` is retained for signature parity — every protocol path hit the same
 * DolomiteMargin.getMarketPrice on-chain, so the effect call is identical.
 */
export async function getTokenOraclePriceUSD(
  context: Ctx,
  chainId: number,
  token: Token,
  meta: EventMeta,
  protocolType: string // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<BigDecimal> {
  const existing = await context.OraclePrice.get(token.id);
  const oldPrice = existing?.price ?? ZERO_BD;

  if (existing !== undefined && existing.blockNumber === meta.blockNumber) {
    return existing.price;
  }

  let price = oldPrice;
  try {
    const raw = await context.effect(getMarketPrice, {
      chainId,
      marginAddress: getConstants(chainId).dolomiteMargin,
      marketId: token.marketId,
    });
    price = convertPriceToDecimal(BigInt(raw), token);
  } catch {
    // getMarketPrice reverted — keep the previous price (mirrors subgraph try_ fallback)
    price = oldPrice;
  }

  context.OraclePrice.set({
    id: token.id,
    price,
    token_id: token.id,
    blockNumber: meta.blockNumber,
    blockHash: meta.blockHash,
  });

  return price;
}

/**
 * Ported from pricing.getEthPriceInUSD. Derives the ETH/USD price from the DAI/USDC/USDT
 * AMM pairs, weighting by each stablecoin's ETH reserves.
 */
export async function getEthPriceInUSD(context: Ctx, chainId: number): Promise<BigDecimal> {
  const c = getConstants(chainId);
  const wethId = tokenId(chainId, c.weth);

  const daiPair = await context.AmmPair.get(ammPairId(chainId, c.daiWethPair));
  const usdcPair = await context.AmmPair.get(ammPairId(chainId, c.wethUsdc));
  const usdtPair = await context.AmmPair.get(ammPairId(chainId, c.usdtWethPair));

  if (daiPair && usdcPair && usdtPair) {
    const daiReserveETH = daiPair.token0_id === wethId ? daiPair.reserve0 : daiPair.reserve1;
    const usdcReserveETH = usdcPair.token0_id === wethId ? usdcPair.reserve0 : usdcPair.reserve1;
    const usdtReserveETH = usdtPair.token0_id === wethId ? usdtPair.reserve0 : usdtPair.reserve1;
    const totalLiquidityETH = daiReserveETH.plus(usdcReserveETH).plus(usdtReserveETH);
    if (totalLiquidityETH.isEqualTo(ZERO_BD)) {
      return ZERO_BD;
    }
    const daiWeight = daiReserveETH.div(totalLiquidityETH);
    const usdcWeight = usdcReserveETH.div(totalLiquidityETH);
    const usdtWeight = usdtReserveETH.div(totalLiquidityETH);
    const daiPrice = daiPair.token0_id === wethId ? daiPair.token1Price : daiPair.token0Price;
    const usdcPrice = usdcPair.token0_id === wethId ? usdcPair.token1Price : usdcPair.token0Price;
    const usdtPrice = usdtPair.token0_id === wethId ? usdtPair.token1Price : usdtPair.token0Price;
    return daiPrice.times(daiWeight).plus(usdcPrice.times(usdcWeight)).plus(usdtPrice.times(usdtWeight));
  } else if (daiPair && usdcPair) {
    const daiReserveETH = daiPair.token0_id === wethId ? daiPair.reserve0 : daiPair.reserve1;
    const usdcReserveETH = usdcPair.token0_id === wethId ? usdcPair.reserve0 : usdcPair.reserve1;
    const totalLiquidityETH = daiReserveETH.plus(usdcReserveETH);
    if (totalLiquidityETH.isEqualTo(ZERO_BD)) {
      return ZERO_BD;
    }
    const daiWeight = daiReserveETH.div(totalLiquidityETH);
    const usdcWeight = usdcReserveETH.div(totalLiquidityETH);
    const daiPrice = daiPair.token0_id === wethId ? daiPair.token1Price : daiPair.token0Price;
    const usdcPrice = usdcPair.token0_id === wethId ? usdcPair.token1Price : usdcPair.token0Price;
    return daiPrice.times(daiWeight).plus(usdcPrice.times(usdcWeight));
  } else if (usdcPair) {
    return usdcPair.token0_id === wethId ? usdcPair.token1Price : usdcPair.token0Price;
  } else {
    return ZERO_BD;
  }
}

/**
 * Ported from pricing.findEthPerToken. Walks the whitelist looking for an AMM pair that
 * prices `token` against a whitelisted token with enough ETH liquidity.
 */
export async function findEthPerToken(context: Ctx, chainId: number, token: Token): Promise<BigDecimal> {
  const c = getConstants(chainId);
  if (token.id === tokenId(chainId, c.weth)) {
    return ONE_BD;
  }

  const rawToken = rawAddress(token.id);
  for (let i = 0; i < c.whitelist.length; i++) {
    const reverseLookup = await context.AmmPairReverseLookup.get(
      ammPairLookupId(chainId, rawToken, c.whitelist[i]!)
    );
    if (reverseLookup !== undefined) {
      const pair = await context.AmmPair.getOrThrow(reverseLookup.pair_id);
      if (pair.token0_id === token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        const token1 = await context.Token.getOrThrow(pair.token1_id);
        return pair.token1Price.times(token1.derivedETH ?? ZERO_BD);
      } else if (pair.token1_id === token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        const token0 = await context.Token.getOrThrow(pair.token0_id);
        return pair.token0Price.times(token0.derivedETH ?? ZERO_BD);
      }
    }
  }
  return ZERO_BD;
}

/**
 * Ported from pricing.getTrackedLiquidityUSD. Returns tracked liquidity value in USD based
 * on the token whitelist (double the whitelisted side, or sum when both are whitelisted).
 */
export async function getTrackedLiquidityUSD(
  context: Ctx,
  chainId: number,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): Promise<BigDecimal> {
  const bundle = await context.Bundle.getOrThrow(bundleId(chainId));
  const price0 = (token0.derivedETH ?? ZERO_BD).times(bundle.ethPrice);
  const price1 = (token1.derivedETH ?? ZERO_BD).times(bundle.ethPrice);

  const whitelist = getConstants(chainId).whitelist.map((a) => tokenId(chainId, a));
  const has0 = whitelist.includes(token0.id);
  const has1 = whitelist.includes(token1.id);

  if (has0 && has1) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1));
  }
  if (has0 && !has1) {
    return tokenAmount0.times(price0).times(bd("2"));
  }
  if (!has0 && has1) {
    return tokenAmount1.times(price1).times(bd("2"));
  }
  return ZERO_BD;
}
