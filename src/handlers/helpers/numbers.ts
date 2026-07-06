import { BigDecimal } from "envio";

// Ported from the subgraph's constants.template.ts + helpers.
export const ZERO_BI = 0n;
export const ONE_BI = 1n;
export const TEN_BI = 10n;
export const _100_BI = 100n;
export const _18_BI = 18n;
export const ONE_ETH_BI = 10n ** 18n;
export const SECONDS_IN_YEAR = 31536000n;
export const INTEREST_PRECISION = 18;
export const USD_PRECISION = 18;

export const ZERO_BD = new BigDecimal(0);
export const ONE_BD = new BigDecimal(1);
export const FIVE_BD = new BigDecimal(5);
export const ONE_ETH_BD = new BigDecimal("1000000000000000000"); // 1e18

/** Build a BigDecimal from a string or bigint (bignumber.js constructor doesn't take bigint). */
export function bd(value: string | bigint | number): BigDecimal {
  return new BigDecimal(value.toString());
}

export function exponentToBigDecimal(decimals: bigint): BigDecimal {
  return new BigDecimal(10).pow(Number(decimals));
}

/** Divide a raw token amount by 10^decimals. Matches subgraph convertTokenToDecimal. */
export function convertTokenToDecimal(tokenAmount: bigint, exchangeDecimals: bigint): BigDecimal {
  if (exchangeDecimals === 0n) {
    return bd(tokenAmount);
  }
  return bd(tokenAmount).div(exponentToBigDecimal(exchangeDecimals));
}

export function absBD(value: BigDecimal): BigDecimal {
  return value.lt(ZERO_BD) ? value.negated() : value;
}

/**
 * Round-toward-zero to `decimals` decimal places. Mirrors the subgraph's
 * BigDecimal.truncate(n) (graph-ts truncates toward zero). bignumber.js rounding
 * mode 1 === ROUND_DOWN (toward zero).
 */
export function truncate(value: BigDecimal, decimals: number | bigint): BigDecimal {
  return value.decimalPlaces(Number(decimals), 1);
}

/**
 * Round half away-from-zero to `decimals` places. Ported from margin-helpers.roundHalfUp:
 * add/subtract 0.5 * 10^-decimals then truncate toward zero.
 */
export function roundHalfUp(value: BigDecimal, decimals: bigint): BigDecimal {
  const amountToAdd = FIVE_BD.div(bd(TEN_BI ** (decimals + 1n)));
  if (value.lt(ZERO_BD)) {
    return truncate(value.minus(amountToAdd), decimals);
  }
  return truncate(value.plus(amountToAdd), decimals);
}

/**
 * Convert an integer-valued BigDecimal to a bigint (round toward zero).
 * Replaces the subgraph's `bd.digits.times(TEN_BI.pow(bd.exp))` reconstruction.
 */
export function bdToBigInt(value: BigDecimal): bigint {
  return BigInt(value.decimalPlaces(0, 1).toFixed());
}
