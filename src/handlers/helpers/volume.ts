import type { DolomiteMargin, Token, Trade } from "envio";
import type { Mutable } from "./types";
import { ONE_BI } from "./numbers";

/**
 * Ported from volume-helpers.updateAndSaveVolumeForTrade. Mutates the passed (mutable)
 * DolomiteMargin / maker / taker tokens in place; the CALLER persists them (matches the
 * subgraph, which mutated and let the caller save).
 */
export function updateAndSaveVolumeForTrade(
  trade: Trade,
  dolomiteMargin: Mutable<DolomiteMargin>,
  makerToken: Mutable<Token>,
  takerToken: Mutable<Token>
): void {
  dolomiteMargin.totalTradeVolumeUSD = dolomiteMargin.totalTradeVolumeUSD.plus(trade.takerAmountUSD);
  dolomiteMargin.tradeCount = dolomiteMargin.tradeCount + ONE_BI;

  makerToken.tradeVolume = makerToken.tradeVolume.plus(trade.makerTokenDeltaWei);
  makerToken.tradeVolumeUSD = makerToken.tradeVolumeUSD.plus(trade.makerAmountUSD);

  takerToken.tradeVolume = takerToken.tradeVolume.plus(trade.takerTokenDeltaWei);
  takerToken.tradeVolumeUSD = takerToken.tradeVolumeUSD.plus(trade.takerAmountUSD);
}
