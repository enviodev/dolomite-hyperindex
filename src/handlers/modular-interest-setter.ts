import { indexer } from "envio";
import {
  interestRateId,
  totalParId,
  interestIndexId,
  tokenId,
  dolomiteMarginId,
} from "./helpers/ids";
import { updateInterestRate } from "./helpers/interest-rate";
import { getConstants } from "../constants";

// Ported from modular-interest-setter.handleModularInterestSettingsChanged.
// Emitted by the ModularLinearStepFunctionInterestSetter. Updates the affected
// token's InterestRate optimal params, then recomputes the borrow/supply rates.
indexer.onEvent(
  { contract: "ModularLinearStepFunctionInterestSetter", event: "SettingsChanged" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const token = event.params.token;

    const interestRate = await context.InterestRate.get(interestRateId(chainId, token));
    if (
      interestRate !== undefined &&
      interestRate.interestSetter.toLowerCase() === event.srcAddress.toLowerCase()
    ) {
      context.InterestRate.set({
        ...interestRate,
        lowerOptimalRate: event.params.lowerOptimalPercent,
        upperOptimalRate: event.params.upperOptimalPercent,
        optimalUtilizationRate: event.params.optimalUtilization,
      });

      const totalPar = await context.TotalPar.getOrThrow(totalParId(chainId, token));
      const index = await context.InterestIndex.getOrThrow(interestIndexId(chainId, token));
      const marginAddress = getConstants(chainId).dolomiteMargin;
      const dolomiteMargin = await context.DolomiteMargin.getOrThrow(
        dolomiteMarginId(chainId, marginAddress)
      );
      const tokenEntity = await context.Token.getOrThrow(tokenId(chainId, token));

      await updateInterestRate(context, chainId, tokenEntity, totalPar, index, dolomiteMargin);
    }
  }
);
