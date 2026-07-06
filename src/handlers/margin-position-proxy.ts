import { indexer } from "envio";
import type { BigDecimal, InterestIndex, MarginAccount, MarginPosition } from "envio";
import {
  type Ctx,
  type EventMeta,
  type Mutable,
  ProtocolType,
  MarginPositionStatus,
  ValueStruct,
} from "./helpers/types";
import { absBD, truncate, convertTokenToDecimal, ZERO_BD, ONE_BI, USD_PRECISION } from "./helpers/numbers";
import { tokenId, userId, transactionId, dolomiteMarginId, borrowPositionId } from "./helpers/ids";
import { getConstants } from "../constants";
import { getOrCreateMarginAccount, getOrCreateMarginPosition, getOrCreateTokenValue } from "./helpers/margin";
import { convertStructToDecimalAppliedValue } from "./helpers/amm";
import { getTokenOraclePriceUSD } from "./helpers/pricing";

/** Ported from margin-position-proxy.isContractUnknown. */
function isContractUnknown(chainId: number, srcAddress: string): boolean {
  const c = getConstants(chainId);
  const addr = srcAddress.toLowerCase();
  return !c.ammRouters.includes(addr) && addr !== c.eventEmitter;
}

/**
 * Ported from margin-position-proxy.updateMarginPositionForTrade. Mutates + persists the
 * margin position. `inputWei`/`outputWei`/`depositWei` are decimal-converted magnitudes
 * (mirroring PositionChangeEvent's convertTokenToDecimal of the deltaWei magnitudes).
 */
async function updateMarginPositionForTrade(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  marginAccount: MarginAccount,
  marginPosition: Mutable<MarginPosition>,
  inputTokenId: string,
  outputTokenId: string,
  depositTokenId: string,
  inputWei: BigDecimal,
  outputWei: BigDecimal,
  depositWei: BigDecimal,
  isOpen: boolean,
  inputTokenNewPar: ValueStruct,
  outputTokenNewPar: ValueStruct,
  inputTokenIndex: InterestIndex,
  outputTokenIndex: InterestIndex
): Promise<void> {
  let isPositionBeingOpened = false;
  if (marginPosition.owedToken_id === undefined || marginPosition.heldToken_id === undefined) {
    // the position is being opened
    isPositionBeingOpened = true;
    marginPosition.owedToken_id = inputTokenId;
    marginPosition.heldToken_id = outputTokenId;
  }

  if (!isPositionBeingOpened) {
    const tokens = [marginPosition.heldToken_id, marginPosition.owedToken_id];
    if (
      marginPosition.status === MarginPositionStatus.Unknown ||
      !tokens.includes(inputTokenId) ||
      !tokens.includes(outputTokenId) ||
      !tokens.includes(depositTokenId)
    ) {
      // the position is invalidated
      marginPosition.status = MarginPositionStatus.Unknown;
      context.MarginPosition.set(marginPosition);
      return;
    }
  }

  const heldToken = await context.Token.getOrThrow(marginPosition.heldToken_id!);
  const owedToken = await context.Token.getOrThrow(marginPosition.owedToken_id!);

  const heldTokenNewPar =
    marginPosition.heldToken_id === inputTokenId
      ? absBD(convertStructToDecimalAppliedValue(inputTokenNewPar, heldToken.decimals))
      : absBD(convertStructToDecimalAppliedValue(outputTokenNewPar, heldToken.decimals));

  const owedTokenNewPar =
    marginPosition.owedToken_id === inputTokenId
      ? absBD(convertStructToDecimalAppliedValue(inputTokenNewPar, owedToken.decimals))
      : absBD(convertStructToDecimalAppliedValue(outputTokenNewPar, owedToken.decimals));

  const heldTokenIndex = marginPosition.heldToken_id === inputTokenId ? inputTokenIndex : outputTokenIndex;
  const owedTokenIndex = marginPosition.owedToken_id === inputTokenId ? inputTokenIndex : outputTokenIndex;

  // if the trader is closing the position, they are sizing down the collateral and debt
  const inputAmountWei = !isOpen ? inputWei.negated() : inputWei;
  const outputAmountWei = !isOpen ? outputWei.negated() : outputWei;

  const heldAmountWei = marginPosition.heldToken_id === inputTokenId ? inputAmountWei : outputAmountWei;
  const owedAmountWei = marginPosition.owedToken_id === inputTokenId ? inputAmountWei : outputAmountWei;

  marginPosition.owedAmountPar = owedTokenNewPar;
  marginPosition.heldAmountPar = heldTokenNewPar;

  if (isPositionBeingOpened) {
    const owedPriceUSD = await getTokenOraclePriceUSD(context, chainId, owedToken, meta, ProtocolType.Position);
    const heldPriceUSD = await getTokenOraclePriceUSD(context, chainId, heldToken, meta, ProtocolType.Position);

    marginPosition.initialOwedAmountPar = owedTokenNewPar;
    marginPosition.initialOwedAmountWei = owedAmountWei;

    if (owedAmountWei.isEqualTo(ZERO_BD)) {
      marginPosition.initialOwedPrice = ZERO_BD;
    } else {
      marginPosition.initialOwedPrice = truncate(absBD(heldAmountWei).div(absBD(owedAmountWei)), 18);
    }
    marginPosition.initialOwedPriceUSD = truncate(marginPosition.initialOwedPrice.times(heldPriceUSD), 36);
    marginPosition.initialOwedAmountUSD = truncate(owedAmountWei.times(marginPosition.initialOwedPriceUSD), 36);

    marginPosition.initialHeldAmountPar = heldTokenNewPar;
    marginPosition.initialHeldAmountWei = heldAmountWei.plus(depositWei);
    if (heldAmountWei.isEqualTo(ZERO_BD)) {
      marginPosition.initialHeldPrice = ZERO_BD;
    } else {
      marginPosition.initialHeldPrice = truncate(absBD(owedAmountWei).div(absBD(heldAmountWei)), 18);
    }
    marginPosition.initialHeldPriceUSD = truncate(marginPosition.initialHeldPrice.times(owedPriceUSD), USD_PRECISION);
    marginPosition.initialHeldAmountUSD = truncate(
      marginPosition.initialHeldAmountWei.times(marginPosition.initialHeldPriceUSD),
      USD_PRECISION
    );

    // set the margin deposit here and the initial held amount. We do it here, because the `isInitialized` GUARD
    // STATEMENT executes, disallowing the initial values to be set when the position is opened
    marginPosition.marginDeposit = depositWei;
    marginPosition.marginDepositUSD = truncate(depositWei.times(marginPosition.initialHeldPriceUSD), USD_PRECISION);

    // Needs to be initialized
    marginPosition.initialMarginDeposit = depositWei;
    marginPosition.initialMarginDepositUSD = truncate(
      depositWei.times(marginPosition.initialHeldPriceUSD),
      USD_PRECISION
    );

    marginPosition.isInitialized = true;
  }

  if (marginPosition.owedAmountPar.isEqualTo(ZERO_BD)) {
    marginPosition.status = MarginPositionStatus.Closed;
    marginPosition.closeTimestamp = meta.timestamp;
    marginPosition.closeTransaction_id = transactionId(chainId, meta.txHash);

    const heldPriceUSD = await getTokenOraclePriceUSD(context, chainId, heldToken, meta, ProtocolType.Position);
    const owedPriceUSD = await getTokenOraclePriceUSD(context, chainId, owedToken, meta, ProtocolType.Position);

    if (heldAmountWei.isEqualTo(ZERO_BD)) {
      marginPosition.closeHeldPrice = ZERO_BD;
    } else {
      marginPosition.closeHeldPrice = truncate(owedAmountWei.div(heldAmountWei), 18);
    }
    marginPosition.closeHeldPriceUSD = truncate(marginPosition.closeHeldPrice.times(owedPriceUSD), USD_PRECISION);
    marginPosition.closeHeldAmountWei = marginPosition.initialHeldAmountPar.times(heldTokenIndex.supplyIndex);
    marginPosition.closeHeldAmountUSD = truncate(marginPosition.closeHeldAmountWei.times(heldPriceUSD), USD_PRECISION);
    marginPosition.closeHeldAmountSeized = ZERO_BD;
    marginPosition.closeHeldAmountSeizedUSD = ZERO_BD;

    if (owedAmountWei.isEqualTo(ZERO_BD)) {
      marginPosition.closeOwedPrice = ZERO_BD;
    } else {
      marginPosition.closeOwedPrice = truncate(heldAmountWei.div(owedAmountWei), 18);
    }
    marginPosition.closeOwedPriceUSD = truncate(marginPosition.closeOwedPrice.times(heldPriceUSD), 36);
    marginPosition.closeOwedAmountWei = marginPosition.initialOwedAmountPar.times(owedTokenIndex.borrowIndex);
    marginPosition.closeOwedAmountUSD = truncate(marginPosition.closeOwedAmountWei.times(owedPriceUSD), 36);
  }

  const tokenValue = await getOrCreateTokenValue(context, marginAccount, owedToken);
  if (tokenValue.expirationTimestamp !== undefined) {
    marginPosition.expirationTimestamp = tokenValue.expirationTimestamp;
  }

  context.MarginPosition.set(marginPosition);
}

indexer.onEvent({ contract: "DolomiteAmmRouter", event: "MarginPositionOpen" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };

  if (isContractUnknown(chainId, event.srcAddress)) {
    context.log.warn(`Ignoring event from unknown contract: ${event.srcAddress}`);
    return;
  }

  const borrowPosition = await context.BorrowPosition.get(
    borrowPositionId(chainId, event.params.user, event.params.accountIndex)
  );
  if (borrowPosition !== undefined) {
    // Ignoring event because it is a borrow position
    return;
  }

  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    event.params.user,
    event.params.accountIndex,
    meta
  );

  const user = await context.User.getOrThrow(userId(chainId, event.params.user));
  context.User.set({ ...user, totalMarginPositionCount: user.totalMarginPositionCount + ONE_BI });
  if (user.effectiveUser_id !== user.id) {
    const effectiveUser = await context.User.getOrThrow(user.effectiveUser_id);
    context.User.set({
      ...effectiveUser,
      totalMarginPositionCount: effectiveUser.totalMarginPositionCount + ONE_BI,
    });
  }

  const marginPosition = await getOrCreateMarginPosition(context, chainId, meta, marginAccount);

  const inputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.inputToken));
  const outputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.outputToken));
  const depositToken = await context.Token.getOrThrow(tokenId(chainId, event.params.depositToken));

  const inputBalanceUpdate = ValueStruct.from(event.params.inputBalanceUpdate.newPar);
  const outputBalanceUpdate = ValueStruct.from(event.params.outputBalanceUpdate.newPar);
  const inputIndex = await context.InterestIndex.getOrThrow(inputToken.id);
  const outputIndex = await context.InterestIndex.getOrThrow(outputToken.id);

  const inputWei = convertTokenToDecimal(event.params.inputBalanceUpdate.deltaWei.value, inputToken.decimals);
  const outputWei = convertTokenToDecimal(event.params.outputBalanceUpdate.deltaWei.value, outputToken.decimals);
  const depositWei = convertTokenToDecimal(event.params.marginDepositUpdate.deltaWei.value, depositToken.decimals);

  await updateMarginPositionForTrade(
    context,
    chainId,
    meta,
    marginAccount,
    marginPosition,
    inputToken.id,
    outputToken.id,
    depositToken.id,
    inputWei,
    outputWei,
    depositWei,
    true,
    inputBalanceUpdate,
    outputBalanceUpdate,
    inputIndex,
    outputIndex
  );
  context.MarginPosition.set(marginPosition);

  const dolomiteMargin = await context.DolomiteMargin.getOrThrow(
    dolomiteMarginId(chainId, getConstants(chainId).dolomiteMargin)
  );
  context.DolomiteMargin.set({
    ...dolomiteMargin,
    marginPositionCount: dolomiteMargin.marginPositionCount + ONE_BI,
  });
});

indexer.onEvent({ contract: "DolomiteAmmRouter", event: "MarginPositionClose" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };

  if (isContractUnknown(chainId, event.srcAddress)) {
    context.log.warn(`Ignoring event from unknown contract: ${event.srcAddress}`);
    return;
  }

  const borrowPosition = await context.BorrowPosition.get(
    borrowPositionId(chainId, event.params.user, event.params.accountIndex)
  );
  if (borrowPosition !== undefined) {
    // Ignoring event because it is a borrow position
    return;
  }

  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    event.params.user,
    event.params.accountIndex,
    meta
  );
  const marginPosition = await getOrCreateMarginPosition(context, chainId, meta, marginAccount);

  const inputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.inputToken));
  const outputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.outputToken));
  const withdrawalToken = await context.Token.getOrThrow(tokenId(chainId, event.params.withdrawalToken));

  const inputBalanceUpdate = ValueStruct.from(event.params.inputBalanceUpdate.newPar);
  const outputBalanceUpdate = ValueStruct.from(event.params.outputBalanceUpdate.newPar);
  const inputIndex = await context.InterestIndex.getOrThrow(inputToken.id);
  const outputIndex = await context.InterestIndex.getOrThrow(outputToken.id);

  const inputWei = convertTokenToDecimal(event.params.inputBalanceUpdate.deltaWei.value, inputToken.decimals);
  const outputWei = convertTokenToDecimal(event.params.outputBalanceUpdate.deltaWei.value, outputToken.decimals);
  const withdrawalWei = convertTokenToDecimal(
    event.params.marginWithdrawalUpdate.deltaWei.value,
    withdrawalToken.decimals
  );

  await updateMarginPositionForTrade(
    context,
    chainId,
    meta,
    marginAccount,
    marginPosition,
    inputToken.id,
    outputToken.id,
    withdrawalToken.id,
    inputWei,
    outputWei,
    withdrawalWei,
    false,
    inputBalanceUpdate,
    outputBalanceUpdate,
    inputIndex,
    outputIndex
  );
  context.MarginPosition.set(marginPosition);
});
