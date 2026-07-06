import type {
  BigDecimal,
  DolomiteMargin,
  InterestIndex,
  MarginAccount,
  MarginAccountTokenValue,
  MarginPosition,
  Token,
  TotalPar,
  Trade,
  Transfer,
  UserParValue,
} from "envio";
import {
  type Ctx,
  type EventMeta,
  type Mutable,
  type BalanceUpdate,
  ProtocolType,
  MarginPositionStatus,
  ValueStruct,
} from "./types";
import {
  ZERO_BD,
  ONE_BD,
  ZERO_BI,
  ONE_BI,
  ONE_ETH_BD,
  USD_PRECISION,
  _100_BI,
  absBD,
  truncate,
  roundHalfUp,
  bd,
} from "./numbers";
import {
  marginAccountTokenValueId,
  userParValueId,
  transactionId,
  dolomiteMarginId,
} from "./ids";
import { getConstants } from "../../constants";
import { getRiskParams, getExpiryRampTime } from "../../effects";
import { createUserIfNecessary } from "./user";
import { getEffectiveUserForUserId } from "./isolation";
import { userId } from "./ids";
import { getTokenOraclePriceUSD } from "./pricing";
import { updateInterestRate } from "./interest-rate";
import { convertStructToDecimalAppliedValue } from "./amm";
import { updateBorrowPositionForBalanceUpdate } from "./borrow-position";

export { roundHalfUp };

// ---------------------------------------------------------------------------
// getOrCreate helpers
// ---------------------------------------------------------------------------

/** Ported from margin-helpers.getOrCreateTokenValue. Does NOT persist (caller decides). */
export async function getOrCreateTokenValue(
  context: Ctx,
  marginAccount: MarginAccount,
  token: Token
): Promise<Mutable<MarginAccountTokenValue>> {
  const id = marginAccountTokenValueId(marginAccount.user_id, marginAccount.accountNumber, token.marketId);
  const existing = await context.MarginAccountTokenValue.get(id);
  if (existing !== undefined) {
    return { ...existing };
  }
  return {
    id,
    marginAccount_id: marginAccount.id,
    effectiveUser_id: marginAccount.effectiveUser_id,
    token_id: token.id,
    valuePar: ZERO_BD,
    expirationTimestamp: undefined,
    expiryAddress: undefined,
  };
}

/** Ported from margin-helpers.deleteTokenValueIfNecessary. */
export function deleteTokenValueIfNecessary(context: Ctx, tokenValue: MarginAccountTokenValue): boolean {
  if (
    tokenValue.valuePar.isEqualTo(ZERO_BD) &&
    tokenValue.expirationTimestamp === undefined &&
    tokenValue.expiryAddress === undefined
  ) {
    context.MarginAccountTokenValue.deleteUnsafe(tokenValue.id);
    return true;
  }
  return false;
}

/** Ported from margin-helpers.deleteUserParValueIfNecessary. */
export function deleteUserParValueIfNecessary(context: Ctx, userParValue: UserParValue): boolean {
  if (userParValue.totalSupplyPar.isEqualTo(ZERO_BD) && userParValue.totalBorrowPar.isEqualTo(ZERO_BD)) {
    context.UserParValue.deleteUnsafe(userParValue.id);
    return true;
  }
  return false;
}

/** Ported from margin-helpers.getOrCreateMarginAccount. Does NOT persist (caller decides). */
export async function getOrCreateMarginAccount(
  context: Ctx,
  chainId: number,
  owner: string,
  accountNumber: bigint,
  meta: EventMeta
): Promise<Mutable<MarginAccount>> {
  const uid = userId(chainId, owner);
  const id = `${uid}-${accountNumber.toString()}`;
  const existing = await context.MarginAccount.get(id);

  let marginAccount: Mutable<MarginAccount>;
  if (existing === undefined) {
    await createUserIfNecessary(context, chainId, owner);
    const effectiveUser = await getEffectiveUserForUserId(context, uid);
    marginAccount = {
      id,
      user_id: uid,
      effectiveUser_id: effectiveUser.id,
      accountNumber,
      lastUpdatedTimestamp: meta.timestamp,
      lastUpdatedBlockNumber: meta.blockNumber,
      hasBorrowValue: false,
      hasSupplyValue: false,
      hasExpiration: false,
      borrowTokens: [],
      supplyTokens: [],
      expirationTokens: [],
    };
  } else {
    marginAccount = { ...existing };
  }

  marginAccount.lastUpdatedBlockNumber = meta.blockNumber;
  marginAccount.lastUpdatedTimestamp = meta.timestamp;

  return marginAccount;
}

/** Ported from margin-helpers.getOrCreateEffectiveUserTokenValue. Persists on creation. */
export async function getOrCreateEffectiveUserTokenValue(
  context: Ctx,
  effectiveUserId: string,
  token: Token
): Promise<Mutable<UserParValue>> {
  const id = userParValueId(effectiveUserId, token.id);
  const existing = await context.UserParValue.get(id);
  if (existing !== undefined) {
    return { ...existing };
  }
  const tokenValue: Mutable<UserParValue> = {
    id,
    user_id: effectiveUserId,
    token_id: token.id,
    totalSupplyPar: ZERO_BD,
    totalBorrowPar: ZERO_BD,
  };
  context.UserParValue.set(tokenValue);
  return tokenValue;
}

/** Ported from margin-helpers.getOrCreateMarginPosition. Does NOT persist (caller decides). */
export async function getOrCreateMarginPosition(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  account: MarginAccount
): Promise<Mutable<MarginPosition>> {
  const existing = await context.MarginPosition.get(account.id);
  if (existing !== undefined) {
    return { ...existing };
  }
  const effectiveUser = await getEffectiveUserForUserId(context, account.user_id);
  return {
    id: account.id,
    effectiveUser_id: effectiveUser.id,
    marginAccount_id: account.id,
    isInitialized: false,
    status: MarginPositionStatus.Open,
    openTimestamp: meta.timestamp,
    openTransaction_id: transactionId(chainId, meta.txHash),
    marginDeposit: ZERO_BD,
    marginDepositUSD: ZERO_BD,
    initialMarginDeposit: ZERO_BD,
    initialMarginDepositUSD: ZERO_BD,
    heldToken_id: undefined,
    initialHeldAmountPar: ZERO_BD,
    initialHeldAmountWei: ZERO_BD,
    initialHeldAmountUSD: ZERO_BD,
    // NOTE: subgraph left these unset (schema now requires them) — default to ZERO_BD.
    initialHeldPrice: ZERO_BD,
    initialHeldPriceUSD: ZERO_BD,
    closeHeldPrice: undefined,
    closeHeldPriceUSD: undefined,
    closeHeldAmountWei: undefined,
    closeHeldAmountUSD: undefined,
    closeHeldAmountSeized: undefined,
    closeHeldAmountSeizedUSD: undefined,
    heldAmountPar: ZERO_BD,
    owedToken_id: undefined,
    initialOwedAmountPar: ZERO_BD,
    initialOwedAmountWei: ZERO_BD,
    initialOwedAmountUSD: ZERO_BD,
    initialOwedPrice: ZERO_BD,
    initialOwedPriceUSD: ZERO_BD,
    closeOwedPrice: undefined,
    closeOwedPriceUSD: undefined,
    closeOwedAmountWei: undefined,
    closeOwedAmountUSD: undefined,
    owedAmountPar: ZERO_BD,
    closeTimestamp: undefined,
    closeTransaction_id: undefined,
    expirationTimestamp: undefined,
  };
}

/**
 * Ported from margin-helpers.getOrCreateDolomiteMarginForCall. On first creation reads risk
 * params (Admin path) via effects. NOTE: the subgraph additionally read oracleSentinel /
 * callbackGasLimit / defaultAccountRiskOverrideSetter over RPC on non-arbitrum chains; no
 * effect exists for those so they are left undefined (see report).
 */
export async function getOrCreateDolomiteMarginForCall(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  isAction: boolean,
  protocolType: string
): Promise<Mutable<DolomiteMargin>> {
  const marginAddress = getConstants(chainId).dolomiteMargin;
  const id = dolomiteMarginId(chainId, marginAddress);
  const existing = await context.DolomiteMargin.get(id);

  let dolomiteMargin: Mutable<DolomiteMargin>;
  if (existing === undefined) {
    dolomiteMargin = {
      id,
      supplyLiquidityUSD: ZERO_BD,
      borrowLiquidityUSD: ZERO_BD,
      numberOfMarkets: 0,
      userCount: ZERO_BI,
      marginPositionCount: ZERO_BI,
      borrowPositionCount: ZERO_BI,
      liquidationRatio: ZERO_BD,
      liquidationReward: ZERO_BD,
      earningsRate: ZERO_BD,
      minBorrowedValue: ZERO_BD,
      accountMaxNumberOfMarketsWithBalances: ZERO_BI,
      expiryRampTime: ZERO_BI,
      oracleSentinel: undefined,
      callbackGasLimit: undefined,
      defaultAccountRiskOverrideSetter: undefined,
      totalBorrowVolumeUSD: ZERO_BD,
      totalLiquidationVolumeUSD: ZERO_BD,
      totalSupplyVolumeUSD: ZERO_BD,
      totalTradeVolumeUSD: ZERO_BD,
      totalVaporizationVolumeUSD: ZERO_BD,
      totalZapVolumeUSD: ZERO_BD,
      lastTransactionHash: "0x",
      actionCount: ZERO_BI,
      liquidationCount: ZERO_BI,
      tradeCount: ZERO_BI,
      transactionCount: ZERO_BI,
      vaporizationCount: ZERO_BI,
      zapCount: ZERO_BI,
      vestingPositionTransferCount: ZERO_BI,
    };

    if (protocolType === ProtocolType.Admin) {
      const rp = await context.effect(getRiskParams, { chainId, marginAddress });
      dolomiteMargin.liquidationRatio = bd(rp.marginRatio).div(ONE_ETH_BD).plus(ONE_BD);
      dolomiteMargin.liquidationReward = bd(rp.liquidationSpread).div(ONE_ETH_BD).plus(ONE_BD);
      dolomiteMargin.earningsRate = bd(rp.earningsRate).div(ONE_ETH_BD);
      dolomiteMargin.minBorrowedValue = bd(rp.minBorrowedValue).div(ONE_ETH_BD).div(ONE_ETH_BD);
      dolomiteMargin.accountMaxNumberOfMarketsWithBalances = BigInt(rp.accountMaxNumberOfMarketsWithBalances);

      const ramp = await context.effect(getExpiryRampTime, {
        chainId,
        expiryAddress: getConstants(chainId).expiry,
      });
      dolomiteMargin.expiryRampTime = BigInt(ramp);
    }
  } else {
    dolomiteMargin = { ...existing };
  }

  if (dolomiteMargin.lastTransactionHash.toLowerCase() !== meta.txHash.toLowerCase()) {
    dolomiteMargin.lastTransactionHash = meta.txHash;
    dolomiteMargin.transactionCount = dolomiteMargin.transactionCount + ONE_BI;
  }

  if (isAction) {
    dolomiteMargin.actionCount = dolomiteMargin.actionCount + ONE_BI;
    context.DolomiteMargin.set(dolomiteMargin);
  }

  return dolomiteMargin;
}

// ---------------------------------------------------------------------------
// par/wei conversion
// ---------------------------------------------------------------------------

export function canBeMarginPosition(marginAccount: MarginAccount): boolean {
  return marginAccount.accountNumber >= _100_BI;
}

export function weiToPar(wei: BigDecimal, index: InterestIndex, decimals: bigint): BigDecimal {
  if (wei.gte(ZERO_BD)) {
    return roundHalfUp(wei.div(index.supplyIndex), decimals);
  }
  return roundHalfUp(wei.div(index.borrowIndex), decimals);
}

export function parToWei(par: BigDecimal, index: InterestIndex, decimals: bigint): BigDecimal {
  if (par.isEqualTo(ZERO_BD)) {
    return ZERO_BD;
  } else if (par.gt(ZERO_BD)) {
    return roundHalfUp(par.times(index.supplyIndex), decimals);
  }
  return roundHalfUp(par.times(index.borrowIndex), decimals);
}

// ---------------------------------------------------------------------------
// balance updates
// ---------------------------------------------------------------------------

async function handleTotalParChange(
  context: Ctx,
  totalPar: TotalPar,
  oldPar: BigDecimal,
  newPar: BigDecimal
): Promise<void> {
  const next: Mutable<TotalPar> = { ...totalPar };
  // roll-back oldPar
  if (oldPar.gte(ZERO_BD)) {
    next.supplyPar = next.supplyPar.minus(oldPar);
  } else {
    next.borrowPar = next.borrowPar.minus(absBD(oldPar));
  }
  // roll-forward newPar
  if (newPar.gte(ZERO_BD)) {
    next.supplyPar = next.supplyPar.plus(newPar);
  } else {
    next.borrowPar = next.borrowPar.plus(absBD(newPar));
  }
  context.TotalPar.set(next);
}

export type MarginAccountWithValueParChange = {
  marginAccount: Mutable<MarginAccount>;
  deltaPar: BigDecimal;
};

/** Ported from margin-helpers.handleDolomiteMarginBalanceUpdateForAccount. */
export async function handleDolomiteMarginBalanceUpdateForAccount(
  context: Ctx,
  chainId: number,
  balanceUpdate: BalanceUpdate,
  meta: EventMeta
): Promise<MarginAccountWithValueParChange> {
  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    balanceUpdate.accountOwner,
    balanceUpdate.accountNumber,
    meta
  );
  const token = balanceUpdate.token;
  const tokenValue = await getOrCreateTokenValue(context, marginAccount, token);
  const effectiveUserTokenValue = await getOrCreateEffectiveUserTokenValue(
    context,
    marginAccount.effectiveUser_id,
    token
  );

  const totalPar = await context.TotalPar.getOrThrow(token.id);
  await handleTotalParChange(context, totalPar, tokenValue.valuePar, balanceUpdate.valuePar);

  if (tokenValue.valuePar.lt(ZERO_BD) && balanceUpdate.valuePar.gte(ZERO_BD)) {
    const index = marginAccount.borrowTokens.indexOf(token.id);
    if (index !== -1) {
      const copy = [...marginAccount.borrowTokens];
      copy.splice(index, 1);
      marginAccount.borrowTokens = copy;
    }
  } else if (tokenValue.valuePar.gte(ZERO_BD) && balanceUpdate.valuePar.lt(ZERO_BD)) {
    marginAccount.borrowTokens = [...marginAccount.borrowTokens, token.id];
  }
  marginAccount.hasBorrowValue = marginAccount.borrowTokens.length > 0;

  if (tokenValue.valuePar.lte(ZERO_BD) && balanceUpdate.valuePar.gt(ZERO_BD)) {
    marginAccount.supplyTokens = [...marginAccount.supplyTokens, token.id];
  } else if (tokenValue.valuePar.gt(ZERO_BD) && balanceUpdate.valuePar.lte(ZERO_BD)) {
    const index = marginAccount.supplyTokens.indexOf(token.id);
    if (index !== -1) {
      const copy = [...marginAccount.supplyTokens];
      copy.splice(index, 1);
      marginAccount.supplyTokens = copy;
    }
  }
  marginAccount.hasSupplyValue = marginAccount.supplyTokens.length > 0;

  if (balanceUpdate.valuePar.lt(ZERO_BD) && balanceUpdate.valuePar.lt(tokenValue.valuePar)) {
    let amountParBorrowed = absBD(balanceUpdate.valuePar).minus(tokenValue.valuePar);
    if (amountParBorrowed.gt(absBD(balanceUpdate.valuePar))) {
      amountParBorrowed = absBD(balanceUpdate.valuePar);
    }
    const interestIndex = await context.InterestIndex.getOrThrow(token.id);
    const priceUSD = await getTokenOraclePriceUSD(context, chainId, token, meta, ProtocolType.Core);
    const amountBorrowedUSD = truncate(
      parToWei(amountParBorrowed, interestIndex, token.decimals).times(priceUSD),
      USD_PRECISION
    );

    const user = await context.User.getOrThrow(marginAccount.user_id);
    context.User.set({
      ...user,
      totalBorrowVolumeOriginatedUSD: user.totalBorrowVolumeOriginatedUSD.plus(amountBorrowedUSD),
    });
    if (user.effectiveUser_id !== user.id) {
      const effectiveUser = await context.User.getOrThrow(user.effectiveUser_id);
      context.User.set({
        ...effectiveUser,
        totalBorrowVolumeOriginatedUSD: effectiveUser.totalBorrowVolumeOriginatedUSD.plus(amountBorrowedUSD),
      });
    }
  }

  const deltaPar = balanceUpdate.valuePar.minus(tokenValue.valuePar);
  if (tokenValue.valuePar.gt(ZERO_BD)) {
    if (deltaPar.lt(ZERO_BD) && absBD(deltaPar).gt(tokenValue.valuePar)) {
      effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.minus(tokenValue.valuePar);
      const borrowDelta = absBD(deltaPar).minus(tokenValue.valuePar);
      effectiveUserTokenValue.totalBorrowPar = effectiveUserTokenValue.totalBorrowPar.plus(borrowDelta);
    } else {
      effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(deltaPar);
    }
  } else if (tokenValue.valuePar.lt(ZERO_BD)) {
    if (deltaPar.gt(ZERO_BD) && deltaPar.gt(absBD(tokenValue.valuePar))) {
      effectiveUserTokenValue.totalBorrowPar = effectiveUserTokenValue.totalBorrowPar.minus(
        absBD(tokenValue.valuePar)
      );
      const supplyDelta = deltaPar.minus(absBD(tokenValue.valuePar));
      effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(supplyDelta);
    } else {
      effectiveUserTokenValue.totalBorrowPar = effectiveUserTokenValue.totalBorrowPar.minus(deltaPar);
    }
  } else {
    if (deltaPar.gt(ZERO_BD)) {
      effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(deltaPar);
    } else if (deltaPar.lt(ZERO_BD)) {
      effectiveUserTokenValue.totalBorrowPar = effectiveUserTokenValue.totalBorrowPar.minus(deltaPar);
    }
  }

  tokenValue.valuePar = balanceUpdate.valuePar;

  context.MarginAccount.set(marginAccount);
  if (!deleteUserParValueIfNecessary(context, effectiveUserTokenValue)) {
    context.UserParValue.set(effectiveUserTokenValue);
  }
  if (!deleteTokenValueIfNecessary(context, tokenValue)) {
    context.MarginAccountTokenValue.set(tokenValue);
  }

  await updateBorrowPositionForBalanceUpdate(context, chainId, marginAccount, balanceUpdate, meta);

  return { marginAccount, deltaPar };
}

/** Ported from margin-helpers.saveMostRecentTrade. Keyed on token id. */
export function saveMostRecentTrade(context: Ctx, trade: Trade): void {
  context.MostRecentTrade.set({ id: trade.takerToken_id, trade_id: trade.id });
  context.MostRecentTrade.set({ id: trade.makerToken_id, trade_id: trade.id });
}

// ---------------------------------------------------------------------------
// protocol balance / liquidity accounting
// ---------------------------------------------------------------------------

/** Ported from margin-helpers.changeProtocolBalanceApplied. Mutates + persists token & dolomiteMargin. */
export async function changeProtocolBalanceApplied(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  token: Mutable<Token>,
  deltaWei: BigDecimal,
  index: InterestIndex,
  isVirtualTransfer: boolean,
  protocolType: string,
  dolomiteMargin: Mutable<DolomiteMargin>
): Promise<void> {
  if (token.id !== index.token_id) {
    context.log.error(
      `Token ${token.id} does not match index ${index.token_id} for tx ${meta.txHash} log ${meta.logIndex}`
    );
  }

  const totalPar = await context.TotalPar.getOrThrow(token.id);
  await updateInterestRate(context, chainId, token, totalPar, index, dolomiteMargin);

  const tokenPriceUSD = await getTokenOraclePriceUSD(context, chainId, token, meta, protocolType);

  const isPol = token.symbol.startsWith("pol-");
  if (!isPol) {
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.minus(token.borrowLiquidityUSD);
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.minus(token.supplyLiquidityUSD);
  }

  const tokenBorrowLiquidity = absBD(parToWei(totalPar.borrowPar.negated(), index, token.decimals));
  const tokenBorrowLiquidityUSD = truncate(token.borrowLiquidity.times(tokenPriceUSD), USD_PRECISION);

  if (tokenBorrowLiquidity.gt(token.borrowLiquidity)) {
    const borrowVolumeToken = tokenBorrowLiquidity.minus(token.borrowLiquidity);
    const borrowVolumeUsd = truncate(borrowVolumeToken.times(tokenPriceUSD), USD_PRECISION);
    dolomiteMargin.totalBorrowVolumeUSD = dolomiteMargin.totalBorrowVolumeUSD.plus(borrowVolumeUsd);
  }

  token.borrowLiquidity = tokenBorrowLiquidity;
  token.borrowLiquidityUSD = tokenBorrowLiquidityUSD;
  token.supplyLiquidity = parToWei(totalPar.supplyPar, index, token.decimals);
  token.supplyLiquidityUSD = truncate(token.supplyLiquidity.times(tokenPriceUSD), USD_PRECISION);

  if (!isPol) {
    dolomiteMargin.borrowLiquidityUSD = dolomiteMargin.borrowLiquidityUSD.plus(token.borrowLiquidityUSD);
    dolomiteMargin.supplyLiquidityUSD = dolomiteMargin.supplyLiquidityUSD.plus(token.supplyLiquidityUSD);
  }

  if (!isVirtualTransfer) {
    if (deltaWei.gt(ZERO_BD)) {
      const deltaWeiUSD = deltaWei.times(tokenPriceUSD);
      dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deltaWeiUSD);
    }
  }

  context.DolomiteMargin.set(dolomiteMargin);
  context.Token.set(token);
}

/** Ported from margin-helpers.changeProtocolBalance (ValueStruct wrapper). */
export async function changeProtocolBalance(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  token: Mutable<Token>,
  deltaWeiStruct: ValueStruct,
  index: InterestIndex,
  isVirtualTransfer: boolean,
  protocolType: string,
  dolomiteMargin: Mutable<DolomiteMargin>
): Promise<void> {
  await changeProtocolBalanceApplied(
    context,
    chainId,
    meta,
    token,
    convertStructToDecimalAppliedValue(deltaWeiStruct, token.decimals),
    index,
    isVirtualTransfer,
    protocolType,
    dolomiteMargin
  );
}

/** Ported from margin-helpers.invalidateMarginPosition. */
export async function invalidateMarginPosition(context: Ctx, marginAccount: MarginAccount): Promise<void> {
  if (canBeMarginPosition(marginAccount)) {
    const position = await context.MarginPosition.get(marginAccount.id);
    if (position !== undefined && position.isInitialized) {
      context.MarginPosition.set({ ...position, status: MarginPositionStatus.Unknown });
    }
  }
}

/** Ported from margin-helpers.getLiquidationSpreadForPair. */
export async function getLiquidationSpreadForPair(
  context: Ctx,
  heldToken: Token,
  owedToken: Token,
  dolomiteMargin: DolomiteMargin
): Promise<BigDecimal> {
  const heldRiskInfo = await context.MarketRiskInfo.getOrThrow(heldToken.id);
  const owedRiskInfo = await context.MarketRiskInfo.getOrThrow(owedToken.id);

  let liquidationSpread = dolomiteMargin.liquidationReward.minus(ONE_BD);
  liquidationSpread = liquidationSpread.times(ONE_BD.plus(heldRiskInfo.liquidationRewardPremium));
  liquidationSpread = liquidationSpread.times(ONE_BD.plus(owedRiskInfo.liquidationRewardPremium));
  return liquidationSpread;
}

/** Ported from margin-helpers.updateMarginPositionForTransfer. Mutates + persists transfer / position. */
export async function updateMarginPositionForTransfer(
  context: Ctx,
  chainId: number,
  marginAccount1: MarginAccount,
  marginAccount2: MarginAccount,
  balanceUpdate1: BalanceUpdate,
  balanceUpdate2: BalanceUpdate,
  transfer: Transfer,
  meta: EventMeta,
  token: Token,
  priceUSD: BigDecimal
): Promise<void> {
  if (marginAccount1.user_id !== marginAccount2.user_id) {
    return;
  }
  const canBe1 = canBeMarginPosition(marginAccount1);
  const canBe2 = canBeMarginPosition(marginAccount2);
  if (!((!canBe1 && canBe2) || (!canBe2 && canBe1))) {
    return;
  }

  const marginPosition = canBe1
    ? await getOrCreateMarginPosition(context, chainId, meta, marginAccount1)
    : await getOrCreateMarginPosition(context, chainId, meta, marginAccount2);

  if (!marginPosition.isInitialized) {
    return; // GUARD STATEMENT
  }

  // This is a real margin position
  context.Transfer.set({ ...transfer, isTransferForMarginPosition: true });

  if (marginPosition.heldToken_id === token.id) {
    marginPosition.heldAmountPar =
      balanceUpdate1.marginAccount === marginPosition.marginAccount_id
        ? absBD(balanceUpdate1.valuePar)
        : absBD(balanceUpdate2.valuePar);

    if (
      marginPosition.status === MarginPositionStatus.Open &&
      marginPosition.marginAccount_id === transfer.toMarginAccount_id &&
      !marginPosition.heldAmountPar.isEqualTo(ZERO_BD)
    ) {
      // Upsizing margin deposit
      marginPosition.initialHeldAmountPar = marginPosition.heldAmountPar;
      marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.plus(transfer.amountDeltaWei);
      marginPosition.initialHeldAmountUSD = truncate(
        marginPosition.initialHeldAmountUSD.plus(transfer.amountUSDDeltaWei),
        USD_PRECISION
      );
      marginPosition.marginDeposit = marginPosition.marginDeposit.plus(transfer.amountDeltaWei);
      marginPosition.marginDepositUSD = truncate(marginPosition.marginDeposit.times(priceUSD), USD_PRECISION);
    } else if (
      marginPosition.status === MarginPositionStatus.Open &&
      marginPosition.marginAccount_id === transfer.fromMarginAccount_id &&
      !marginPosition.heldAmountPar.isEqualTo(ZERO_BD)
    ) {
      // Downsizing margin deposit
      if (transfer.amountDeltaWei.gte(marginPosition.marginDeposit)) {
        marginPosition.marginDeposit = ZERO_BD;
      } else {
        marginPosition.marginDeposit = marginPosition.marginDeposit.minus(transfer.amountDeltaWei);
        marginPosition.initialHeldAmountPar = marginPosition.heldAmountPar;
        marginPosition.initialHeldAmountWei = marginPosition.initialHeldAmountWei.minus(transfer.amountDeltaWei);
        marginPosition.initialHeldAmountUSD = truncate(
          marginPosition.initialHeldAmountUSD.minus(
            transfer.amountDeltaWei.times(marginPosition.initialHeldPriceUSD)
          ),
          USD_PRECISION
        );
      }
      marginPosition.marginDepositUSD = truncate(marginPosition.marginDeposit.times(priceUSD), USD_PRECISION);
    }
  } else if (token.id === marginPosition.owedToken_id) {
    marginPosition.owedAmountPar =
      balanceUpdate1.marginAccount === marginPosition.marginAccount_id
        ? absBD(balanceUpdate1.valuePar)
        : absBD(balanceUpdate2.valuePar);
  }

  context.MarginPosition.set(marginPosition);
}
