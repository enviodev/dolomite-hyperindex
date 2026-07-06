import { indexer } from "envio";
import type { EventMeta, Ctx, Mutable } from "./helpers/types";
import { ProtocolType } from "./helpers/types";
import {
  ZERO_BD,
  ONE_BD,
  ONE_ETH_BD,
  ZERO_BI,
  INTEREST_PRECISION,
  _18_BI,
  bd,
  convertTokenToDecimal,
  truncate,
} from "./helpers/numbers";
import { tokenId, reverseLookupId, dolomiteMarginId } from "./helpers/ids";
import { getConstants, ADDRESS_ZERO } from "../constants";
import {
  getNumMarkets,
  getMarketPrice,
  getExpiryRampTime,
  getModularInterestRates,
  getLinearInterestConstants,
  fetchTokenNameForRegistration,
} from "../effects";
import { initializeToken } from "./helpers/token";
import { getOrCreateDolomiteMarginForCall } from "./helpers/margin";
import { updateInterestRate } from "./helpers/interest-rate";
import { getEffectiveUserForAddress } from "./helpers/isolation";
import { createUserIfNecessary } from "./helpers/user";
import { createLiquidityMiningVester } from "./helpers/liquidity-mining-helpers";

// The dfsGLP isolation-mode token edge-case (see token helper), lowercased.
const D_GLP_ADDRESS = "0x34df4e8062a8c8ae97e3382b452bd7bf60542698";

// Strip the `${chainId}-` prefix off an entity id to recover the bare (lowercased) address.
const bareAddress = (entityId: string): string => entityId.substring(entityId.indexOf("-") + 1);

function makeMeta(event: { block: { number: number; hash: string; timestamp: number }; transaction: { hash: string }; logIndex: number }): EventMeta {
  return {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
}

// ---------------------------------------------------------------------------
// Interest-setter optimal/lower/upper rate resolution (ported from
// interest-setter.ts getOptimalUtilizationRate / getLowerOptimalRate / getUpperOptimalRate).
// RPC binds are reimplemented via the getModularInterestRates / getLinearInterestConstants
// effects (which already carry the subgraph's revert fallbacks).
// ---------------------------------------------------------------------------

async function getOptimalUtilizationRate(
  context: Ctx,
  chainId: number,
  tokenAddress: string,
  interestSetter: string
): Promise<bigint> {
  const c = getConstants(chainId);
  if (interestSetter === c.modularInterestSetter) {
    const r = await context.effect(getModularInterestRates, { chainId, setter: interestSetter, token: tokenAddress });
    return BigInt(r.optimal);
  }
  const r = await context.effect(getLinearInterestConstants, { chainId, setter: interestSetter });
  return BigInt(r.optimal);
}

async function getLowerOptimalRate(
  context: Ctx,
  chainId: number,
  tokenAddress: string,
  interestSetter: string
): Promise<bigint> {
  const c = getConstants(chainId);
  if (interestSetter === c.doubleExponentInterestSetter) {
    return ZERO_BI;
  } else if (interestSetter === c.aaveAltInterestSetter) {
    return 70000000000000000n; // 0.07e18
  } else if (interestSetter === c.aaveStableInterestSetter) {
    return 40000000000000000n; // 0.04e18
  } else if (interestSetter === c.modularInterestSetter) {
    const r = await context.effect(getModularInterestRates, { chainId, setter: interestSetter, token: tokenAddress });
    return BigInt(r.lower);
  } else if (interestSetter === c.alwaysZeroInterestSetter) {
    return ZERO_BI;
  } else {
    const r = await context.effect(getLinearInterestConstants, { chainId, setter: interestSetter });
    return BigInt(r.lower);
  }
}

async function getUpperOptimalRate(
  context: Ctx,
  chainId: number,
  tokenAddress: string,
  interestSetter: string
): Promise<bigint> {
  const c = getConstants(chainId);
  if (interestSetter === c.doubleExponentInterestSetter) {
    return ZERO_BI;
  } else if (interestSetter === c.aaveAltInterestSetter) {
    return 930000000000000000n; // 0.93e18
  } else if (interestSetter === c.aaveStableInterestSetter) {
    return 960000000000000000n; // 0.96e18
  } else if (interestSetter === c.alwaysZeroInterestSetter) {
    return ZERO_BI;
  } else if (interestSetter === c.modularInterestSetter) {
    const r = await context.effect(getModularInterestRates, { chainId, setter: interestSetter, token: tokenAddress });
    return BigInt(r.upper);
  } else {
    const r = await context.effect(getLinearInterestConstants, { chainId, setter: interestSetter });
    return BigInt(r.upper);
  }
}

// ---------------------------------------------------------------------------
// LogAddMarket
// ---------------------------------------------------------------------------

/**
 * Dynamically register the isolation-mode vault factory when a newly added market's token
 * is an isolation-mode token (the subgraph did IsolationModeVaultTemplate.create here).
 */
indexer.contractRegister({ contract: "DolomiteMargin", event: "LogAddMarket" }, async ({ event, context }) => {
  // contractRegister context has no `context.effect` — do a direct async RPC read.
  const name = await fetchTokenNameForRegistration(event.chainId, event.params.token);
  const isIso = name.includes("Dolomite Isolation:") || event.params.token.toLowerCase() === D_GLP_ADDRESS;
  if (isIso) {
    context.chain.IsolationModeFactory.add(event.params.token);
  }
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogAddMarket" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  const marginAddress = getConstants(chainId).dolomiteMargin;

  context.log.info(
    `Adding market[${event.params.marketId}] for token ${event.params.token} for hash and index: ${meta.txHash}-${event.logIndex}`
  );

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.numberOfMarkets = await context.effect(getNumMarkets, { chainId, marginAddress });
  context.DolomiteMargin.set(dolomiteMargin);

  const tokenAddress = event.params.token;
  let token = await context.Token.get(tokenId(chainId, tokenAddress));
  if (token === undefined) {
    context.log.info(`Adding new token to store ${tokenAddress}`);
    const initialized = await initializeToken(context, chainId, tokenAddress, event.params.marketId);
    token = initialized.token;
  }

  // The subgraph re-ran initializeDolomiteMargin() on marketId 0 to register the EventEmitter
  // registries. Those are now FIXED contracts in config, so this is a no-op here.

  if (chainId === 42161) {
    const c = getConstants(chainId);
    if (tokenAddress === c.arb) {
      await createLiquidityMiningVester(context, chainId, c.oArbVester);
    } else if (tokenAddress === c.grai) {
      await createLiquidityMiningVester(context, chainId, c.goArbVester);
    }
  }

  context.InterestIndex.set({
    id: token.id,
    token_id: token.id,
    borrowIndex: ONE_BD,
    supplyIndex: ONE_BD,
    lastUpdate: BigInt(event.block.timestamp),
  });

  context.InterestRate.set({
    id: token.id,
    token_id: token.id,
    borrowInterestRate: ZERO_BD,
    supplyInterestRate: ZERO_BD,
    interestSetter: ADDRESS_ZERO,
    optimalUtilizationRate: ZERO_BI,
    lowerOptimalRate: ZERO_BI,
    upperOptimalRate: ZERO_BI,
  });

  context.MarketRiskInfo.set({
    id: token.id,
    token_id: token.id,
    liquidationRewardPremium: ZERO_BD,
    marginPremium: ZERO_BD,
    isBorrowingDisabled: false,
    oracle: "0x",
    supplyMaxWei: ZERO_BD,
    borrowMaxWei: undefined,
    earningsRateOverride: undefined,
  });

  const rawPrice = await context.effect(getMarketPrice, { chainId, marginAddress, marketId: event.params.marketId });
  context.OraclePrice.set({
    id: token.id,
    token_id: token.id,
    price: convertTokenToDecimal(BigInt(rawPrice), 36n - token.decimals),
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
  });

  context.TotalPar.set({
    id: token.id,
    token_id: token.id,
    borrowPar: ZERO_BD,
    supplyPar: ZERO_BD,
  });
});

// ---------------------------------------------------------------------------
// LogRemoveMarket
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogRemoveMarket" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);

  context.log.info(
    `Removing market[${event.params.marketId}] for token ${event.params.token} for hash and index: ${meta.txHash}-${event.logIndex}`
  );

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.numberOfMarkets += 1;
  context.DolomiteMargin.set(dolomiteMargin);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const id = lookup.token_id;
  // Mirrors the subgraph exactly: it removed TokenMarketIdReverseLookup by the TOKEN id (a
  // no-op, since the lookup is keyed by marketId), then removed the market-scoped entities.
  context.TokenMarketIdReverseLookup.deleteUnsafe(id);
  context.InterestIndex.deleteUnsafe(id);
  context.InterestRate.deleteUnsafe(id);
  context.MarketRiskInfo.deleteUnsafe(id);
  context.OraclePrice.deleteUnsafe(id);
  context.TotalPar.deleteUnsafe(id);
});

// ---------------------------------------------------------------------------
// Market risk-info updates (keyed by token id via the marketId reverse lookup)
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetIsClosing" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling set_market_closing for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  context.MarketRiskInfo.set({ ...marketInfo, isBorrowingDisabled: event.params.isClosing });
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetPriceOracle" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling price oracle change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  context.MarketRiskInfo.set({ ...marketInfo, oracle: event.params.priceOracle });
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetInterestSetter" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling interest setter change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const token = await context.Token.getOrThrow(lookup.token_id);
  const tokenAddress = bareAddress(token.id);
  const interestSetter = event.params.interestSetter;

  const interestRate = await context.InterestRate.getOrThrow(lookup.token_id);
  const optimalUtilizationRate = await getOptimalUtilizationRate(context, chainId, tokenAddress, interestSetter);
  const lowerOptimalRate = await getLowerOptimalRate(context, chainId, tokenAddress, interestSetter);
  const upperOptimalRate = await getUpperOptimalRate(context, chainId, tokenAddress, interestSetter);
  context.InterestRate.set({
    ...interestRate,
    interestSetter,
    optimalUtilizationRate,
    lowerOptimalRate,
    upperOptimalRate,
  });

  const totalPar = await context.TotalPar.getOrThrow(lookup.token_id);
  const index = await context.InterestIndex.getOrThrow(lookup.token_id);
  const dolomiteMargin = await context.DolomiteMargin.getOrThrow(
    dolomiteMarginId(chainId, getConstants(chainId).dolomiteMargin)
  );
  await updateInterestRate(context, chainId, token, totalPar, index, dolomiteMargin);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMarginPremium" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling margin premium change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const marginPremium = bd(event.params.marginPremium.value).div(ONE_ETH_BD);
  context.MarketRiskInfo.set({ ...marketInfo, marginPremium });
});

// LogSetSpreadPremium (V1)
indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetSpreadPremium" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(
    `Handling liquidation spread premium change for hash and index: ${event.transaction.hash}-${event.logIndex}`
  );

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const liquidationRewardPremium = bd(event.params.spreadPremium.value).div(ONE_ETH_BD);
  context.MarketRiskInfo.set({ ...marketInfo, liquidationRewardPremium });
});

// LogSetLiquidationSpreadPremium (V2)
indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetLiquidationSpreadPremium" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(
    `Handling liquidation spread premium change for hash and index: ${event.transaction.hash}-${event.logIndex}`
  );

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const liquidationRewardPremium = bd(event.params.liquidationSpreadPremium.value).div(ONE_ETH_BD);
  context.MarketRiskInfo.set({ ...marketInfo, liquidationRewardPremium });
});

// LogSetMaxWei (V1 supply max wei)
indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMaxWei" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling max wei change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const token = await context.Token.getOrThrow(lookup.token_id);
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const supplyMaxWei =
    event.params.maxWei.value === ZERO_BI ? undefined : convertTokenToDecimal(event.params.maxWei.value, token.decimals);
  context.MarketRiskInfo.set({ ...marketInfo, supplyMaxWei });
});

// LogSetMaxSupplyWei (V2)
indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMaxSupplyWei" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling max wei change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const token = await context.Token.getOrThrow(lookup.token_id);
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const supplyMaxWei =
    event.params.maxSupplyWei.value === ZERO_BI
      ? undefined
      : convertTokenToDecimal(event.params.maxSupplyWei.value, token.decimals);
  context.MarketRiskInfo.set({ ...marketInfo, supplyMaxWei });
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMaxBorrowWei" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling max wei change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const token = await context.Token.getOrThrow(lookup.token_id);
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const borrowMaxWei =
    event.params.maxBorrowWei.value === ZERO_BI
      ? undefined
      : convertTokenToDecimal(event.params.maxBorrowWei.value, token.decimals);
  context.MarketRiskInfo.set({ ...marketInfo, borrowMaxWei });
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetEarningsRateOverride" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling max wei change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, event.params.marketId));
  const marketInfo = await context.MarketRiskInfo.getOrThrow(lookup.token_id);
  const earningsRateOverride =
    event.params.earningsRateOverride.value === ZERO_BI
      ? undefined
      : convertTokenToDecimal(event.params.earningsRateOverride.value, _18_BI);
  context.MarketRiskInfo.set({ ...marketInfo, earningsRateOverride });
});

// ---------------------------------------------------------------------------
// DolomiteMargin singleton parameter updates
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMarginRatio" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling liquidation ratio change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.liquidationRatio = bd(event.params.marginRatio.value).div(ONE_ETH_BD).plus(ONE_BD);
  context.DolomiteMargin.set(dolomiteMargin);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetLiquidationSpread" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling liquidation ratio change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.liquidationReward = bd(event.params.liquidationSpread.value).div(ONE_ETH_BD).plus(ONE_BD);
  context.DolomiteMargin.set(dolomiteMargin);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetEarningsRate" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling earnings rate change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  let adj = ONE_BD;
  const oldEarningsRate = dolomiteMargin.earningsRate;
  if (oldEarningsRate.gt(ZERO_BD)) {
    adj = oldEarningsRate;
  }

  dolomiteMargin.earningsRate = bd(event.params.earningsRate.value).div(ONE_ETH_BD); // ratio where ONE_ETH is 100%
  context.DolomiteMargin.set(dolomiteMargin);

  const numberOfMarkets = dolomiteMargin.numberOfMarkets;
  for (let i = 0; i < numberOfMarkets; i++) {
    const map = await context.TokenMarketIdReverseLookup.get(reverseLookupId(chainId, BigInt(i))); // null for recycled markets
    if (map !== undefined) {
      const interestRate = await context.InterestRate.getOrThrow(map.token_id);
      // First undo the OLD supply interest rate by dividing by the old earnings rate, THEN
      // multiply by the new earnings rate to get the NEW supply rate.
      const supplyInterestRate = truncate(
        truncate(interestRate.supplyInterestRate.div(adj), INTEREST_PRECISION).times(dolomiteMargin.earningsRate),
        INTEREST_PRECISION
      );
      context.InterestRate.set({ ...interestRate, supplyInterestRate });
    }
  }
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMinBorrowedValue" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling min borrowed value change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.minBorrowedValue = bd(event.params.minBorrowedValue.value).div(ONE_ETH_BD).div(ONE_ETH_BD);
  context.DolomiteMargin.set(dolomiteMargin);
});

indexer.onEvent(
  { contract: "DolomiteMargin", event: "LogSetAccountMaxNumberOfMarketsWithBalances" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const meta = makeMeta(event);
    context.log.info(
      `Handling max # of markets with balances and debt change for hash and index: ${meta.txHash}-${event.logIndex}`
    );

    const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
    dolomiteMargin.accountMaxNumberOfMarketsWithBalances = event.params.accountMaxNumberOfMarketsWithBalances;
    context.DolomiteMargin.set(dolomiteMargin);
  }
);

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetOracleSentinel" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling oracle sentinel change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.oracleSentinel = event.params.oracleSentinel;
  context.DolomiteMargin.set(dolomiteMargin);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetCallbackGasLimit" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling callback gas limit change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
  dolomiteMargin.callbackGasLimit = event.params.callbackGasLimit;
  context.DolomiteMargin.set(dolomiteMargin);
});

indexer.onEvent(
  { contract: "DolomiteMargin", event: "LogSetDefaultAccountRiskOverrideSetter" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const meta = makeMeta(event);
    context.log.info(
      `Handling default account risk override setter change for hash and index: ${meta.txHash}-${event.logIndex}`
    );

    const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
    if (event.params.defaultAccountRiskOverrideSetter === ADDRESS_ZERO) {
      dolomiteMargin.defaultAccountRiskOverrideSetter = undefined;
    } else {
      dolomiteMargin.defaultAccountRiskOverrideSetter = event.params.defaultAccountRiskOverrideSetter;
    }
    context.DolomiteMargin.set(dolomiteMargin);
  }
);

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetAccountRiskOverrideSetter" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(
    `Handling account risk override setter change for hash and index: ${event.transaction.hash}-${event.logIndex}`
  );

  await createUserIfNecessary(context, chainId, event.params.accountOwner);
  const user = await getEffectiveUserForAddress(context, chainId, event.params.accountOwner);
  const updated: Mutable<typeof user> = { ...user };
  if (event.params.accountRiskOverrideSetter === ADDRESS_ZERO) {
    updated.accountRiskOverrideSetter = undefined;
  } else {
    updated.accountRiskOverrideSetter = event.params.accountRiskOverrideSetter;
  }
  context.User.set(updated);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetGlobalOperator" }, async ({ event, context }) => {
  const chainId = event.chainId;
  context.log.info(`Handling global operator change for hash and index: ${event.transaction.hash}-${event.logIndex}`);

  const id = `${chainId}-${event.params.operator.toLowerCase()}`;
  if (!event.params.approved) {
    context.GlobalOperator.deleteUnsafe(id);
  } else {
    const globalOperator = await context.GlobalOperator.get(id);
    if (globalOperator === undefined) {
      context.GlobalOperator.set({ id });
    }
  }
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetAutoTraderIsSpecial" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = makeMeta(event);
  context.log.info(`Handling special auto trader change for hash and index: ${meta.txHash}-${event.logIndex}`);

  const autoTraderAddress = event.params.autoTrader.toLowerCase();
  const id = `${chainId}-${autoTraderAddress}`;
  if (!event.params.isSpecial) {
    context.SpecialAutoTrader.deleteUnsafe(id);
  } else {
    const autoTrader = await context.SpecialAutoTrader.get(id);
    if (autoTrader === undefined) {
      context.SpecialAutoTrader.set({ id });
    }
    // The subgraph compared the bare autoTrader id against EXPIRY_ADDRESS.
    if (autoTraderAddress === getConstants(chainId).expiry) {
      const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Admin);
      const ramp = await context.effect(getExpiryRampTime, { chainId, expiryAddress: getConstants(chainId).expiry });
      dolomiteMargin.expiryRampTime = BigInt(ramp);
      context.DolomiteMargin.set(dolomiteMargin);
    }
  }
});
