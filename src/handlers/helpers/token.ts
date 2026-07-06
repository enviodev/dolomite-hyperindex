import type { Token } from "envio";
import type { Ctx } from "./types";
import { ZERO_BD, ZERO_BI } from "./numbers";
import { tokenId, reverseLookupId } from "./ids";
import { getConstants } from "../../constants";
import { getTokenMetadata } from "../../effects";

// dfsGLP doesn't have the "Dolomite Isolation:" prefix, so it's an edge-case (lowercased).
const D_GLP_ADDRESS = "0x34df4e8062a8c8ae97e3382b452bd7bf60542698";

export type InitializedToken = {
  token: Token;
  /**
   * True when this token is an isolation-mode vault token. The subgraph called
   * IsolationModeVaultTemplate.create(address) here; in Envio the CALLING HANDLER must
   * do the dynamic `contractRegister` for the IsolationModeVault contract — this helper
   * only reports the flag (it must not register contracts itself).
   */
  isIsolationMode: boolean;
};

/**
 * Ported from token-helpers.initializeToken (+ fetchToken{Symbol,Name,Decimals}, which
 * are folded into the getTokenMetadata effect). Fully populates a Token, writes it plus
 * its TokenMarketIdReverseLookup, and returns whether it is an isolation-mode token.
 */
export async function initializeToken(
  context: Ctx,
  chainId: number,
  tokenAddress: string,
  marketId: bigint
): Promise<InitializedToken> {
  const constants = getConstants(chainId);
  const meta = await context.effect(getTokenMetadata, { chainId, address: tokenAddress });

  let name = meta.name;
  let symbol = meta.symbol;

  if (chainId === 42161 && tokenAddress === constants.usdc) {
    name = "Bridged USDC";
    symbol = "USDC.e";
  } else if (chainId === 1101 && tokenAddress === constants.usdc) {
    name = "Bridged USDC";
    symbol = "USDC.E";
  }

  const isIsolationMode = name.includes("Dolomite Isolation:") || tokenAddress === D_GLP_ADDRESS;

  const id = tokenId(chainId, tokenAddress);
  const token: Token = {
    id,
    chainId,
    symbol,
    name,
    decimals: BigInt(meta.decimals),
    isIsolationMode,
    marketId,
    derivedETH: ZERO_BD,
    tradeVolume: ZERO_BD,
    tradeVolumeUSD: ZERO_BD,
    ammTradeLiquidity: ZERO_BD,
    borrowLiquidity: ZERO_BD,
    borrowLiquidityUSD: ZERO_BD,
    supplyLiquidity: ZERO_BD,
    supplyLiquidityUSD: ZERO_BD,
    transactionCount: ZERO_BI,
  };
  context.Token.set(token);

  context.TokenMarketIdReverseLookup.set({
    id: reverseLookupId(chainId, marketId),
    token_id: id,
  });

  return { token, isIsolationMode };
}
