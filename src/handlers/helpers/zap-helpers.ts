import type { Trade } from "envio";
import type { Ctx } from "./types";
import { encodeAbiParameters, keccak256, concat } from "viem";
import { reverseLookupId } from "./ids";

/**
 * Ported from zap-helpers.getZapAccountNumber. Reproduces:
 *   keccak256(accountOwner ++ abiEncode(tuple(accountNumber, block.timestamp)))
 * then interprets the 32-byte hash (subgraph reversed the bytes and read little-endian,
 * which is equivalent to reading the original hash big-endian => BigInt(hash)).
 */
export function getZapAccountNumber(accountOwner: string, accountNumber: bigint, timestamp: bigint): bigint {
  const encodedTuple = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [accountNumber, timestamp]
  );
  const packed = concat([accountOwner as `0x${string}`, encodedTuple]);
  return BigInt(keccak256(packed));
}

/**
 * Ported from zap-helpers.getTokenPathForZap. Resolves each marketId to its Token id via
 * the TokenMarketIdReverseLookup.
 */
export async function getTokenPathForZap(
  context: Ctx,
  chainId: number,
  marketIdsPath: readonly bigint[]
): Promise<string[]> {
  const tokenPath: string[] = [];
  for (let i = 0; i < marketIdsPath.length; i++) {
    const reverse = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, marketIdsPath[i]!));
    tokenPath[i] = reverse.token_id;
  }
  return tokenPath;
}

/** Ported from zap-helpers.getTradesByTrader. */
export function getTradesByTrader(trades: Trade[], trader: string): Trade[] {
  const t = trader.toLowerCase();
  return trades.filter((trade) => trade.traderAddress.toLowerCase() === t);
}
