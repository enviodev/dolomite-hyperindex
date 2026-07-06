import { indexer } from "envio";
import type {
  BigDecimal,
  Deposit,
  IntermediateTrade,
  InterestIndex,
  Liquidation,
  MarginPosition,
  Token,
  Trade,
  Transfer,
  Vaporization,
  Withdrawal,
} from "envio";
import {
  type Ctx,
  type EventMeta,
  type Mutable,
  type BalanceUpdate,
  ProtocolType,
  MarginPositionStatus,
  TradeLiquidationType,
  ValueStruct,
  makeBalanceUpdate,
} from "./helpers/types";
import {
  ZERO_BD,
  ZERO_BI,
  ONE_BI,
  _18_BI,
  USD_PRECISION,
  absBD,
  truncate,
  roundHalfUp,
  convertTokenToDecimal,
  bd,
} from "./helpers/numbers";
import { reverseLookupId, serialEventId, eventId, transactionId } from "./helpers/ids";
import { getConstants } from "../constants";
import { getOrCreateTransaction } from "./helpers/transaction";
import { getOrCreateInterestIndexSnapshotAndReturnId } from "./helpers/interest-index";
import { getEffectiveUserForAddress, getEffectiveUserForUserId } from "./helpers/isolation";
import { getTokenOraclePriceUSD } from "./helpers/pricing";
import { convertStructToDecimalAppliedValue } from "./helpers/amm";
import { updateAndSaveVolumeForTrade } from "./helpers/volume";
import { updateBorrowPositionForLiquidation } from "./helpers/borrow-position";
import {
  type MarginAccountWithValueParChange,
  getOrCreateDolomiteMarginForCall,
  handleDolomiteMarginBalanceUpdateForAccount,
  getOrCreateMarginPosition,
  changeProtocolBalance,
  changeProtocolBalanceApplied,
  getLiquidationSpreadForPair,
  canBeMarginPosition,
  parToWei,
  saveMostRecentTrade,
  updateMarginPositionForTransfer,
} from "./helpers/margin";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildMeta(event: {
  block: { number: number; hash: string; timestamp: number };
  transaction: { hash: string };
  logIndex: number;
}): EventMeta {
  return {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
}

/** Resolve the Token entity backing a market id via the reverse lookup. Returns a mutable copy. */
async function getTokenForMarket(context: Ctx, chainId: number, marketId: bigint): Promise<Mutable<Token>> {
  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, marketId));
  const token = await context.Token.getOrThrow(lookup.token_id);
  return { ...token };
}

// ---------------------------------------------------------------------------
// LogIndexUpdate (Old + New)
// ---------------------------------------------------------------------------

async function handleIndexUpdate(
  context: Ctx,
  chainId: number,
  marketId: bigint,
  borrowIndex: bigint,
  supplyIndex: bigint,
  lastUpdate: bigint
): Promise<void> {
  const lookup = await context.TokenMarketIdReverseLookup.getOrThrow(reverseLookupId(chainId, marketId));
  const tokenAddress = lookup.token_id;

  context.InterestIndex.set({
    id: tokenAddress,
    token_id: tokenAddress,
    borrowIndex: convertTokenToDecimal(borrowIndex, _18_BI),
    supplyIndex: convertTokenToDecimal(supplyIndex, _18_BI),
    lastUpdate,
  });
}

indexer.onEvent({ contract: "DolomiteMargin", event: "LogIndexUpdateOld" }, async ({ event, context }) => {
  await handleIndexUpdate(
    context,
    event.chainId,
    event.params.market,
    event.params.index.borrow,
    event.params.index.supply,
    event.params.index.lastUpdate
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogIndexUpdateNew" }, async ({ event, context }) => {
  await handleIndexUpdate(
    context,
    event.chainId,
    event.params.market,
    event.params.index.borrow,
    event.params.index.supply,
    event.params.index.lastUpdate
  );
});

// ---------------------------------------------------------------------------
// LogOraclePrice
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogOraclePrice" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const token = await getTokenForMarket(context, chainId, event.params.market);

  context.OraclePrice.set({
    id: token.id,
    token_id: token.id,
    price: convertTokenToDecimal(event.params.price.value, 36n - token.decimals),
    blockNumber: meta.blockNumber,
    blockHash: meta.blockHash,
  });

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Core);

  const index = await context.InterestIndex.getOrThrow(token.id);
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    token,
    ValueStruct.fromFields(false, ZERO_BI),
    index,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
});

// ---------------------------------------------------------------------------
// LogDeposit
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogDeposit" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const token = await getTokenForMarket(context, chainId, event.params.market);

  const balanceUpdate = makeBalanceUpdate(
    chainId,
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    event.params.update.deltaWei.value,
    event.params.update.deltaWei.sign,
    token
  );
  const accountUpdateOne = await handleDolomiteMarginBalanceUpdateForAccount(context, chainId, balanceUpdate, meta);

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);

  const depositID = eventId(chainId, meta.txHash, meta.logIndex);
  const existing = await context.Deposit.get(depositID);

  const deltaWeiStruct = ValueStruct.from(event.params.update.deltaWei);
  const marketIndex = await context.InterestIndex.getOrThrow(token.id);

  const effectiveUser = await getEffectiveUserForAddress(context, chainId, event.params.accountOwner);

  const amountDeltaWei = convertStructToDecimalAppliedValue(deltaWeiStruct, token.decimals);
  const amountUSDDeltaWei = truncate(
    amountDeltaWei.times(await getTokenOraclePriceUSD(context, chainId, token, meta, ProtocolType.Core)),
    USD_PRECISION
  );

  const deposit: Mutable<Deposit> = {
    id: depositID,
    serialId: existing?.serialId ?? dolomiteMargin.actionCount,
    transaction_id: transaction.id,
    logIndex: meta.logIndex,
    effectiveUser_id: effectiveUser.id,
    marginAccount_id: accountUpdateOne.marginAccount.id,
    token_id: token.id,
    interestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, marketIndex),
    from: event.params.from,
    amountDeltaWei,
    amountDeltaPar: accountUpdateOne.deltaPar,
    amountUSDDeltaWei,
  };

  dolomiteMargin.totalSupplyVolumeUSD = dolomiteMargin.totalSupplyVolumeUSD.plus(deposit.amountUSDDeltaWei);

  await changeProtocolBalance(
    context,
    chainId,
    meta,
    token,
    deltaWeiStruct,
    marketIndex,
    false,
    ProtocolType.Core,
    dolomiteMargin
  );

  context.Deposit.set(deposit);
});

// ---------------------------------------------------------------------------
// LogWithdraw
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogWithdraw" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const token = await getTokenForMarket(context, chainId, event.params.market);

  const balanceUpdate = makeBalanceUpdate(
    chainId,
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.update.newPar.value,
    event.params.update.newPar.sign,
    event.params.update.deltaWei.value,
    event.params.update.deltaWei.sign,
    token
  );
  const accountUpdateOne = await handleDolomiteMarginBalanceUpdateForAccount(context, chainId, balanceUpdate, meta);

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);

  const withdrawalID = eventId(chainId, meta.txHash, meta.logIndex);
  const existing = await context.Withdrawal.get(withdrawalID);

  const deltaWeiStruct = ValueStruct.from(event.params.update.deltaWei);
  const deltaWeiStructAbs = deltaWeiStruct.abs();
  const marketIndex = await context.InterestIndex.getOrThrow(token.id);

  const effectiveUser = await getEffectiveUserForAddress(context, chainId, event.params.accountOwner);

  const amountDeltaWei = convertStructToDecimalAppliedValue(deltaWeiStructAbs, token.decimals);
  const amountUSDDeltaWei = truncate(
    amountDeltaWei.times(await getTokenOraclePriceUSD(context, chainId, token, meta, ProtocolType.Core)),
    USD_PRECISION
  );

  const withdrawal: Mutable<Withdrawal> = {
    id: withdrawalID,
    serialId: existing?.serialId ?? dolomiteMargin.actionCount,
    transaction_id: transaction.id,
    logIndex: meta.logIndex,
    effectiveUser_id: effectiveUser.id,
    marginAccount_id: accountUpdateOne.marginAccount.id,
    token_id: token.id,
    interestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, marketIndex),
    to: event.params.to,
    amountDeltaWei,
    amountDeltaPar: accountUpdateOne.deltaPar,
    amountUSDDeltaWei,
  };

  context.Withdrawal.set(withdrawal);

  await changeProtocolBalance(
    context,
    chainId,
    meta,
    token,
    deltaWeiStruct,
    marketIndex,
    false,
    ProtocolType.Core,
    dolomiteMargin
  );
});

// ---------------------------------------------------------------------------
// LogTransfer
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogTransfer" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const token = await getTokenForMarket(context, chainId, event.params.market);

  const balanceUpdate1 = makeBalanceUpdate(
    chainId,
    event.params.accountOneOwner,
    event.params.accountOneNumber,
    event.params.updateOne.newPar.value,
    event.params.updateOne.newPar.sign,
    event.params.updateOne.deltaWei.value,
    event.params.updateOne.deltaWei.sign,
    token
  );
  const accountUpdate1 = await handleDolomiteMarginBalanceUpdateForAccount(context, chainId, balanceUpdate1, meta);

  const balanceUpdate2 = makeBalanceUpdate(
    chainId,
    event.params.accountTwoOwner,
    event.params.accountTwoNumber,
    event.params.updateTwo.newPar.value,
    event.params.updateTwo.newPar.sign,
    event.params.updateTwo.deltaWei.value,
    event.params.updateTwo.deltaWei.sign,
    token
  );
  const accountUpdate2 = await handleDolomiteMarginBalanceUpdateForAccount(context, chainId, balanceUpdate2, meta);

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);

  const transferID = eventId(chainId, meta.txHash, meta.logIndex);
  const existing = await context.Transfer.get(transferID);

  const oneSign = event.params.updateOne.deltaWei.sign;
  const fromMarginAccount = oneSign ? accountUpdate2.marginAccount : accountUpdate1.marginAccount;
  const fromDeltaPar = oneSign ? accountUpdate2.deltaPar : accountUpdate1.deltaPar;
  const toMarginAccount = oneSign ? accountUpdate1.marginAccount : accountUpdate2.marginAccount;
  const toDeltaPar = oneSign ? accountUpdate1.deltaPar : accountUpdate2.deltaPar;

  const fromEffectiveUser = (await getEffectiveUserForUserId(context, fromMarginAccount.user_id)).id;
  const toEffectiveUser = (await getEffectiveUserForUserId(context, toMarginAccount.user_id)).id;

  const marketIndex = await context.InterestIndex.getOrThrow(token.id);

  const amountDeltaWeiStruct = ValueStruct.from(event.params.updateOne.deltaWei);
  const priceUSD = await getTokenOraclePriceUSD(context, chainId, token, meta, ProtocolType.Core);
  const amountDeltaWei = convertStructToDecimalAppliedValue(amountDeltaWeiStruct.abs(), token.decimals);

  const transfer: Mutable<Transfer> = {
    id: transferID,
    serialId: existing?.serialId ?? dolomiteMargin.actionCount,
    isTransferForMarginPosition: existing?.isTransferForMarginPosition ?? false,
    transaction_id: transaction.id,
    logIndex: meta.logIndex,
    fromEffectiveUser_id: fromEffectiveUser,
    fromMarginAccount_id: fromMarginAccount.id,
    toEffectiveUser_id: toEffectiveUser,
    toMarginAccount_id: toMarginAccount.id,
    isSelfTransfer: fromMarginAccount.id === toMarginAccount.id,
    walletsConcatenated: `${accountUpdate1.marginAccount.user_id}_${accountUpdate2.marginAccount.user_id}`,
    effectiveWalletsConcatenated: `${fromEffectiveUser}_${toEffectiveUser}`,
    effectiveUsers: [fromEffectiveUser, toEffectiveUser],
    token_id: token.id,
    interestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, marketIndex),
    amountDeltaWei,
    fromAmountDeltaPar: fromDeltaPar,
    toAmountDeltaPar: toDeltaPar,
    amountUSDDeltaWei: truncate(amountDeltaWei.times(priceUSD), USD_PRECISION),
  };

  context.Transfer.set(transfer);

  await changeProtocolBalance(
    context,
    chainId,
    meta,
    token,
    ValueStruct.from(event.params.updateOne.deltaWei),
    marketIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    token,
    ValueStruct.from(event.params.updateTwo.deltaWei),
    marketIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );

  await updateMarginPositionForTransfer(
    context,
    chainId,
    accountUpdate1.marginAccount,
    accountUpdate2.marginAccount,
    balanceUpdate1,
    balanceUpdate2,
    transfer,
    meta,
    token,
    priceUSD
  );
});

// ---------------------------------------------------------------------------
// LogBuy / LogSell / LogTrade (shared _handleTradeInternal)
// ---------------------------------------------------------------------------

async function _handleTradeInternal(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  traderAddress: string,
  inputToken: Mutable<Token>,
  outputToken: Mutable<Token>,
  takerInputBalanceUpdate: BalanceUpdate,
  takerOutputBalanceUpdate: BalanceUpdate,
  makerInputBalanceUpdate: BalanceUpdate | null,
  makerOutputBalanceUpdate: BalanceUpdate | null
): Promise<void> {
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);

  let takerInputAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    takerInputBalanceUpdate,
    meta
  );
  let takerOutputAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    takerOutputBalanceUpdate,
    meta
  );

  let makerInputAccountUpdate: MarginAccountWithValueParChange | null = null;
  let makerOutputAccountUpdate: MarginAccountWithValueParChange | null = null;
  if (makerInputBalanceUpdate !== null && makerOutputBalanceUpdate !== null) {
    makerInputAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
      context,
      chainId,
      makerInputBalanceUpdate,
      meta
    );
    makerOutputAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
      context,
      chainId,
      makerOutputBalanceUpdate,
      meta
    );
  }

  const inputIndex = await context.InterestIndex.getOrThrow(inputToken.id);
  const outputIndex = await context.InterestIndex.getOrThrow(outputToken.id);

  let takerInputDeltaWei = takerInputBalanceUpdate.deltaWei;
  let takerOutputDeltaWei = takerOutputBalanceUpdate.deltaWei;
  let makerInputDeltaWei: BigDecimal | null = makerInputBalanceUpdate ? makerInputBalanceUpdate.deltaWei : null;
  let makerOutputDeltaWei: BigDecimal | null = makerOutputBalanceUpdate ? makerOutputBalanceUpdate.deltaWei : null;
  const isVirtualTransfer =
    makerInputAccountUpdate !== null ||
    inputToken.symbol.startsWith("pol-") ||
    outputToken.symbol.startsWith("pol-");

  await changeProtocolBalanceApplied(
    context,
    chainId,
    meta,
    inputToken,
    takerInputDeltaWei,
    inputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalanceApplied(
    context,
    chainId,
    meta,
    outputToken,
    takerOutputDeltaWei,
    outputIndex,
    isVirtualTransfer,
    ProtocolType.Core,
    dolomiteMargin
  );

  if (makerInputDeltaWei && makerOutputDeltaWei) {
    await changeProtocolBalanceApplied(
      context,
      chainId,
      meta,
      inputToken,
      makerInputDeltaWei,
      inputIndex,
      isVirtualTransfer,
      ProtocolType.Core,
      dolomiteMargin
    );
    await changeProtocolBalanceApplied(
      context,
      chainId,
      meta,
      outputToken,
      makerOutputDeltaWei,
      outputIndex,
      isVirtualTransfer,
      ProtocolType.Core,
      dolomiteMargin
    );
  }

  const serialId = dolomiteMargin.actionCount;
  let intermediateTrade: Mutable<IntermediateTrade> | null = null;
  if (inputToken.symbol.startsWith("pol-") || outputToken.symbol.startsWith("pol-")) {
    const prevId = serialEventId(chainId, meta.txHash, serialId - ONE_BI);
    const loaded = await context.IntermediateTrade.get(prevId);
    intermediateTrade = loaded ? { ...loaded } : null;

    if (intermediateTrade === null && inputToken.symbol.startsWith("pol-")) {
      // When the input token is POL, LogSell comes first, then LogTrade
      const takerEffectiveUser = (
        await getEffectiveUserForUserId(context, takerOutputAccountUpdate.marginAccount.user_id)
      ).id;
      const newIntermediate: Mutable<IntermediateTrade> = {
        id: serialEventId(chainId, meta.txHash, serialId),
        serialId,
        traderAddress,
        takerEffectiveUser_id: takerEffectiveUser,
        takerMarginAccount_id: takerOutputAccountUpdate.marginAccount.id,
        makerEffectiveUser_id: undefined,
        makerMarginAccount_id: undefined,
        walletsConcatenated: takerOutputAccountUpdate.marginAccount.user_id,
        effectiveWalletsConcatenated: takerEffectiveUser,
        effectiveUsers: [takerEffectiveUser],
        takerInputDeltaWei,
        takerOutputDeltaWei,
        takerInputDeltaPar: takerInputAccountUpdate.deltaPar,
        takerOutputDeltaPar: takerOutputAccountUpdate.deltaPar,
        makerInputDeltaPar: undefined,
        makerInputDeltaWei: undefined,
        makerOutputDeltaPar: undefined,
        makerOutputDeltaWei: undefined,
      };
      context.IntermediateTrade.set(newIntermediate);
      return;
    } else if (intermediateTrade !== null && inputToken.symbol.startsWith("pol-")) {
      // When the input token is POL, LogTrade should swap output amounts since the real taker is the maker
      takerInputDeltaWei = intermediateTrade.takerInputDeltaWei;
      takerInputAccountUpdate.deltaPar = intermediateTrade.takerInputDeltaPar;

      const makerOutputDeltaPar = takerOutputAccountUpdate.deltaPar;

      // For LogTrade with POL tokens, the maker is the taker
      const takerMarginAccount = await context.MarginAccount.getOrThrow(makerOutputAccountUpdate!.marginAccount.id);
      takerInputDeltaWei = intermediateTrade.takerInputDeltaWei;
      takerInputAccountUpdate = {
        marginAccount: { ...takerMarginAccount },
        deltaPar: intermediateTrade.takerInputDeltaPar,
      };
      takerOutputDeltaWei = makerOutputBalanceUpdate!.deltaWei;
      takerOutputAccountUpdate = {
        marginAccount: { ...takerMarginAccount },
        deltaPar: makerOutputAccountUpdate!.deltaPar,
      };

      // For LogTrade with POL tokens, the taker is the maker
      const makerMarginAccount = await context.MarginAccount.getOrThrow(intermediateTrade.takerMarginAccount_id);
      makerInputAccountUpdate = { marginAccount: { ...makerMarginAccount }, deltaPar: ZERO_BD };
      makerOutputAccountUpdate = { marginAccount: { ...makerMarginAccount }, deltaPar: makerOutputDeltaPar };
      makerInputDeltaWei = ZERO_BD;
      makerOutputDeltaWei = takerOutputBalanceUpdate.deltaWei;

      const makerEffectiveUser = (
        await getEffectiveUserForUserId(context, makerOutputAccountUpdate.marginAccount.user_id)
      ).id;
      intermediateTrade.makerEffectiveUser_id = makerEffectiveUser;
      intermediateTrade.makerMarginAccount_id = makerOutputAccountUpdate.marginAccount.id;
      intermediateTrade.walletsConcatenated = `${takerOutputAccountUpdate.marginAccount.user_id}_${makerOutputAccountUpdate.marginAccount.user_id}`;
      intermediateTrade.effectiveWalletsConcatenated = `${intermediateTrade.takerEffectiveUser_id}_${makerEffectiveUser}`;
      intermediateTrade.effectiveUsers = [intermediateTrade.takerEffectiveUser_id, makerEffectiveUser];
    }

    if (intermediateTrade === null && outputToken.symbol.startsWith("pol-")) {
      // When the output token is POL, LogTrade comes first, then LogSell
      const takerEffectiveUser = (
        await getEffectiveUserForUserId(context, takerOutputAccountUpdate.marginAccount.user_id)
      ).id;
      const makerEffectiveUser = (
        await getEffectiveUserForUserId(context, makerOutputAccountUpdate!.marginAccount.user_id)
      ).id;
      const newIntermediate: Mutable<IntermediateTrade> = {
        id: serialEventId(chainId, meta.txHash, serialId),
        serialId,
        traderAddress,
        takerEffectiveUser_id: takerEffectiveUser,
        takerMarginAccount_id: takerOutputAccountUpdate.marginAccount.id,
        makerEffectiveUser_id: makerEffectiveUser,
        makerMarginAccount_id: makerOutputAccountUpdate!.marginAccount.id,
        walletsConcatenated: `${takerOutputAccountUpdate.marginAccount.user_id}_${makerOutputAccountUpdate!.marginAccount.user_id}`,
        effectiveWalletsConcatenated: `${takerEffectiveUser}_${makerEffectiveUser}`,
        effectiveUsers: [takerEffectiveUser, makerEffectiveUser],
        takerInputDeltaWei,
        takerOutputDeltaWei,
        makerInputDeltaWei: makerInputDeltaWei ?? undefined,
        makerOutputDeltaWei: makerOutputDeltaWei ?? undefined,
        takerInputDeltaPar: takerInputAccountUpdate.deltaPar,
        takerOutputDeltaPar: takerOutputAccountUpdate.deltaPar,
        makerInputDeltaPar: makerInputAccountUpdate!.deltaPar,
        makerOutputDeltaPar: makerOutputAccountUpdate!.deltaPar,
      };
      context.IntermediateTrade.set(newIntermediate);
      return;
    } else if (intermediateTrade !== null && outputToken.symbol.startsWith("pol-")) {
      // When the output token is POL, LogTrade comes first, then LogSell
      takerInputDeltaWei = intermediateTrade.takerInputDeltaWei;
      takerInputAccountUpdate.deltaPar = intermediateTrade.takerInputDeltaPar;

      const makerMarginAccount = await context.MarginAccount.getOrThrow(intermediateTrade.makerMarginAccount_id!);
      makerInputAccountUpdate = {
        marginAccount: { ...makerMarginAccount },
        deltaPar: intermediateTrade.makerInputDeltaPar!,
      };
      makerOutputAccountUpdate = { marginAccount: { ...makerMarginAccount }, deltaPar: ZERO_BD };
      makerInputDeltaWei = intermediateTrade.makerInputDeltaWei ?? null;
      makerOutputDeltaWei = ZERO_BD;

      intermediateTrade.takerOutputDeltaWei = takerOutputBalanceUpdate.deltaWei;
      intermediateTrade.takerOutputDeltaPar = takerOutputAccountUpdate.deltaPar;
    }
  }

  const tradeID = eventId(chainId, meta.txHash, meta.logIndex);
  const existingTrade = await context.Trade.get(tradeID);

  const takerToken = takerInputDeltaWei.lt(ZERO_BD) ? inputToken : outputToken;
  const makerToken = takerInputDeltaWei.lt(ZERO_BD) ? outputToken : inputToken;

  const takerTokenDeltaWei = takerInputDeltaWei.lt(ZERO_BD)
    ? absBD(takerInputDeltaWei)
    : absBD(takerOutputDeltaWei);
  const makerTokenDeltaWei = takerInputDeltaWei.lt(ZERO_BD)
    ? absBD(takerOutputDeltaWei)
    : absBD(takerInputDeltaWei);

  const amountUSD = truncate(
    takerTokenDeltaWei.times(await getTokenOraclePriceUSD(context, chainId, takerToken, meta, ProtocolType.Core)),
    USD_PRECISION
  );
  const makerAmountUSD = truncate(
    makerTokenDeltaWei.times(await getTokenOraclePriceUSD(context, chainId, makerToken, meta, ProtocolType.Core)),
    USD_PRECISION
  );

  // taker/maker identity fields
  let takerEffectiveUser_id: string;
  let takerMarginAccount_id: string;
  let makerEffectiveUser_id: string | undefined;
  let makerMarginAccount_id: string | undefined;
  let walletsConcatenated: string;
  let effectiveWalletsConcatenated: string;
  let effectiveUsers: string[];

  if (intermediateTrade === null) {
    takerEffectiveUser_id = (
      await getEffectiveUserForUserId(context, takerOutputAccountUpdate.marginAccount.user_id)
    ).id;
    takerMarginAccount_id = takerOutputAccountUpdate.marginAccount.id;
    makerEffectiveUser_id = makerOutputAccountUpdate
      ? (await getEffectiveUserForUserId(context, makerOutputAccountUpdate.marginAccount.user_id)).id
      : undefined;
    makerMarginAccount_id = makerOutputAccountUpdate ? makerOutputAccountUpdate.marginAccount.id : undefined;
    walletsConcatenated = makerOutputAccountUpdate
      ? `${takerOutputAccountUpdate.marginAccount.user_id}_${makerOutputAccountUpdate.marginAccount.user_id}`
      : takerOutputAccountUpdate.marginAccount.user_id;
    effectiveWalletsConcatenated = makerOutputAccountUpdate
      ? `${takerEffectiveUser_id}_${makerEffectiveUser_id!}`
      : takerEffectiveUser_id;
    effectiveUsers = makerOutputAccountUpdate
      ? [takerEffectiveUser_id, makerEffectiveUser_id!]
      : [takerEffectiveUser_id];
  } else {
    takerEffectiveUser_id = intermediateTrade.takerEffectiveUser_id;
    takerMarginAccount_id = intermediateTrade.takerMarginAccount_id;
    makerEffectiveUser_id = intermediateTrade.makerEffectiveUser_id;
    makerMarginAccount_id = intermediateTrade.makerMarginAccount_id;
    walletsConcatenated = intermediateTrade.walletsConcatenated;
    effectiveWalletsConcatenated = intermediateTrade.effectiveWalletsConcatenated;
    effectiveUsers = [...intermediateTrade.effectiveUsers];
  }

  const takerInputTokenDeltaPar = takerInputAccountUpdate.deltaPar.lt(ZERO_BD)
    ? takerInputAccountUpdate.deltaPar
    : takerOutputAccountUpdate.deltaPar;
  const takerOutputTokenDeltaPar = takerOutputAccountUpdate.deltaPar.gt(ZERO_BD)
    ? takerOutputAccountUpdate.deltaPar
    : takerInputAccountUpdate.deltaPar;

  let makerInputTokenDeltaPar: BigDecimal | undefined;
  if (makerInputAccountUpdate !== null && makerInputAccountUpdate.deltaPar.gt(ZERO_BD)) {
    makerInputTokenDeltaPar = makerInputAccountUpdate.deltaPar;
  } else if (makerOutputAccountUpdate !== null && makerOutputAccountUpdate.deltaPar.gt(ZERO_BD)) {
    makerInputTokenDeltaPar = makerOutputAccountUpdate.deltaPar;
  } else if (makerInputAccountUpdate !== null && makerOutputAccountUpdate !== null) {
    makerInputTokenDeltaPar = ZERO_BD;
  } else {
    makerInputTokenDeltaPar = undefined;
  }

  let makerOutputTokenDeltaPar: BigDecimal | undefined;
  if (makerOutputAccountUpdate !== null && makerOutputAccountUpdate.deltaPar.lt(ZERO_BD)) {
    makerOutputTokenDeltaPar = makerOutputAccountUpdate.deltaPar;
  } else if (makerInputAccountUpdate !== null && makerInputAccountUpdate.deltaPar.lt(ZERO_BD)) {
    makerOutputTokenDeltaPar = makerInputAccountUpdate.deltaPar;
  } else if (makerInputAccountUpdate !== null && makerOutputAccountUpdate !== null) {
    makerOutputTokenDeltaPar = ZERO_BD;
  } else {
    makerOutputTokenDeltaPar = undefined;
  }

  const isExpiration = traderAddress === getConstants(chainId).expiry;

  const trade: Mutable<Trade> = {
    id: tradeID,
    serialId: existingTrade?.serialId ?? serialId,
    traderAddress: existingTrade?.traderAddress ?? traderAddress,
    transaction_id: transaction.id,
    timestamp: transaction.timestamp,
    logIndex: meta.logIndex,
    takerEffectiveUser_id,
    takerMarginAccount_id,
    makerEffectiveUser_id,
    makerMarginAccount_id,
    walletsConcatenated,
    effectiveWalletsConcatenated,
    effectiveUsers,
    takerToken_id: inputToken.id,
    makerToken_id: outputToken.id,
    takerInterestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, inputIndex),
    makerInterestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, outputIndex),
    takerTokenDeltaWei,
    makerTokenDeltaWei,
    amountUSD,
    takerAmountUSD: amountUSD,
    makerAmountUSD,
    liquidationType: isExpiration ? TradeLiquidationType.EXPIRATION : undefined,
    takerInputTokenDeltaPar,
    takerOutputTokenDeltaPar,
    makerInputTokenDeltaPar,
    makerOutputTokenDeltaPar,
  };

  updateAndSaveVolumeForTrade(trade, dolomiteMargin, makerToken, takerToken);

  context.Trade.set(trade);
  context.DolomiteMargin.set(dolomiteMargin);
  // persist the tradeVolume mutations applied by updateAndSaveVolumeForTrade (subgraph saved inside the helper)
  context.Token.set(inputToken);
  context.Token.set(outputToken);

  saveMostRecentTrade(context, trade);

  if (makerOutputAccountUpdate !== null) {
    const makerUser = await context.User.getOrThrow(makerOutputAccountUpdate.marginAccount.user_id);
    context.User.set({
      ...makerUser,
      totalTradeVolumeUSD: makerUser.totalTradeVolumeUSD.plus(trade.makerAmountUSD),
      totalTradeCount: makerUser.totalTradeCount + ONE_BI,
    });
    if (makerUser.effectiveUser_id !== makerUser.id) {
      const effectiveMakerUser = await context.User.getOrThrow(makerUser.effectiveUser_id);
      context.User.set({
        ...effectiveMakerUser,
        totalTradeVolumeUSD: effectiveMakerUser.totalTradeVolumeUSD.plus(trade.makerAmountUSD),
        totalTradeCount: effectiveMakerUser.totalTradeCount + ONE_BI,
      });
    }
  }

  const takerUser = await context.User.getOrThrow(takerOutputAccountUpdate.marginAccount.user_id);
  context.User.set({
    ...takerUser,
    totalTradeVolumeUSD: takerUser.totalTradeVolumeUSD.plus(trade.takerAmountUSD),
    totalTradeCount: takerUser.totalTradeCount + ONE_BI,
  });
  if (takerUser.effectiveUser_id !== takerUser.id) {
    const effectiveTakerUser = await context.User.getOrThrow(takerUser.effectiveUser_id);
    context.User.set({
      ...effectiveTakerUser,
      totalTradeVolumeUSD: effectiveTakerUser.totalTradeVolumeUSD.plus(trade.takerAmountUSD),
      totalTradeCount: effectiveTakerUser.totalTradeCount + ONE_BI,
    });
  }

  // if the trade is against the expiry contract, we need to change the margin position
  if (isExpiration) {
    if (makerOutputAccountUpdate === null || makerInputDeltaWei === null || makerOutputDeltaWei === null) {
      context.log.error("makerOutputAccountUpdate cannot be null for expiration trades!");
      return;
    }
    // the maker is the position being expired
    const marginPosition = await getOrCreateMarginPosition(
      context,
      chainId,
      meta,
      makerOutputAccountUpdate.marginAccount
    );

    const heldToken = marginPosition.heldToken_id === outputToken.id ? outputToken : inputToken;
    const owedToken = marginPosition.owedToken_id === outputToken.id ? outputToken : inputToken;

    const heldPrice = await getTokenOraclePriceUSD(context, chainId, heldToken, meta, ProtocolType.Core);
    const owedPrice = await getTokenOraclePriceUSD(context, chainId, owedToken, meta, ProtocolType.Core);

    const expirationTimestamp = marginPosition.expirationTimestamp;
    if (expirationTimestamp === undefined) {
      context.log.error("Attempted to expire a non-expirable position");
      return;
    }

    let liquidationSpread = await getLiquidationSpreadForPair(context, heldToken, owedToken, dolomiteMargin);
    const expiryAge = meta.timestamp - expirationTimestamp;
    const expiryRampTime = dolomiteMargin.expiryRampTime;
    if (expiryAge < expiryRampTime) {
      liquidationSpread = truncate(liquidationSpread.times(bd(expiryAge)).div(bd(expiryRampTime)), 18);
    }

    const owedPriceAdj = truncate(owedPrice.times(liquidationSpread), 36);

    const heldNewPar =
      marginPosition.heldToken_id === outputToken.id && makerOutputBalanceUpdate
        ? makerOutputBalanceUpdate.valuePar
        : makerInputBalanceUpdate!.valuePar;
    const owedNewPar =
      marginPosition.owedToken_id === outputToken.id && makerOutputBalanceUpdate
        ? makerOutputBalanceUpdate.valuePar
        : makerInputBalanceUpdate!.valuePar;

    const borrowedTokenAmountDeltaWei =
      marginPosition.owedToken_id === outputToken.id ? makerOutputDeltaWei : makerInputDeltaWei;

    await handleLiquidateMarginPosition(
      context,
      chainId,
      meta,
      marginPosition,
      heldPrice,
      owedPriceAdj,
      heldToken,
      owedToken,
      marginPosition.heldToken_id === outputToken.id ? outputIndex : inputIndex,
      marginPosition.owedToken_id === outputToken.id ? outputIndex : inputIndex,
      heldNewPar,
      owedNewPar,
      absBD(borrowedTokenAmountDeltaWei),
      MarginPositionStatus.Expired
    );
  }

  if (intermediateTrade !== null) {
    // Delete the intermediateTrade if it was used
    context.IntermediateTrade.deleteUnsafe(intermediateTrade.id);
  }
}

indexer.onEvent({ contract: "DolomiteMargin", event: "LogBuy" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const inputToken = await getTokenForMarket(context, chainId, event.params.takerMarket);
  const outputToken = await getTokenForMarket(context, chainId, event.params.makerMarket);

  const takerInputUpdate = makeBalanceUpdate(
    chainId,
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    event.params.takerUpdate.deltaWei.value,
    event.params.takerUpdate.deltaWei.sign,
    inputToken
  );
  const takerOutputUpdate = makeBalanceUpdate(
    chainId,
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    event.params.makerUpdate.deltaWei.value,
    event.params.makerUpdate.deltaWei.sign,
    outputToken
  );

  await _handleTradeInternal(
    context,
    chainId,
    meta,
    event.params.exchangeWrapper,
    inputToken,
    outputToken,
    takerInputUpdate,
    takerOutputUpdate,
    null,
    null
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSell" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const inputToken = await getTokenForMarket(context, chainId, event.params.takerMarket);
  const outputToken = await getTokenForMarket(context, chainId, event.params.makerMarket);

  const takerInputUpdate = makeBalanceUpdate(
    chainId,
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.takerUpdate.newPar.value,
    event.params.takerUpdate.newPar.sign,
    event.params.takerUpdate.deltaWei.value,
    event.params.takerUpdate.deltaWei.sign,
    inputToken
  );
  const takerOutputUpdate = makeBalanceUpdate(
    chainId,
    event.params.accountOwner,
    event.params.accountNumber,
    event.params.makerUpdate.newPar.value,
    event.params.makerUpdate.newPar.sign,
    event.params.makerUpdate.deltaWei.value,
    event.params.makerUpdate.deltaWei.sign,
    outputToken
  );

  await _handleTradeInternal(
    context,
    chainId,
    meta,
    event.params.exchangeWrapper,
    inputToken,
    outputToken,
    takerInputUpdate,
    takerOutputUpdate,
    null,
    null
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogTrade" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const inputToken = await getTokenForMarket(context, chainId, event.params.inputMarket);
  const outputToken = await getTokenForMarket(context, chainId, event.params.outputMarket);

  const takerInputUpdate = makeBalanceUpdate(
    chainId,
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerInputUpdate.newPar.value,
    event.params.takerInputUpdate.newPar.sign,
    event.params.takerInputUpdate.deltaWei.value,
    event.params.takerInputUpdate.deltaWei.sign,
    inputToken
  );
  const takerOutputUpdate = makeBalanceUpdate(
    chainId,
    event.params.takerAccountOwner,
    event.params.takerAccountNumber,
    event.params.takerOutputUpdate.newPar.value,
    event.params.takerOutputUpdate.newPar.sign,
    event.params.takerOutputUpdate.deltaWei.value,
    event.params.takerOutputUpdate.deltaWei.sign,
    outputToken
  );

  const makerInputUpdate = makeBalanceUpdate(
    chainId,
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerInputUpdate.newPar.value,
    event.params.makerInputUpdate.newPar.sign,
    event.params.makerInputUpdate.deltaWei.value,
    event.params.makerInputUpdate.deltaWei.sign,
    inputToken
  );
  const makerOutputUpdate = makeBalanceUpdate(
    chainId,
    event.params.makerAccountOwner,
    event.params.makerAccountNumber,
    event.params.makerOutputUpdate.newPar.value,
    event.params.makerOutputUpdate.newPar.sign,
    event.params.makerOutputUpdate.deltaWei.value,
    event.params.makerOutputUpdate.deltaWei.sign,
    outputToken
  );

  await _handleTradeInternal(
    context,
    chainId,
    meta,
    event.params.autoTrader,
    inputToken,
    outputToken,
    takerInputUpdate,
    takerOutputUpdate,
    makerInputUpdate,
    makerOutputUpdate
  );
});

// ---------------------------------------------------------------------------
// LogLiquidate
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogLiquidate" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const heldToken = await getTokenForMarket(context, chainId, event.params.heldMarket);
  const owedToken = await getTokenForMarket(context, chainId, event.params.owedMarket);

  const balanceUpdateOne = makeBalanceUpdate(
    chainId,
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.liquidHeldUpdate.newPar.value,
    event.params.liquidHeldUpdate.newPar.sign,
    event.params.liquidHeldUpdate.deltaWei.value,
    event.params.liquidHeldUpdate.deltaWei.sign,
    heldToken
  );
  const liquidHeldAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateOne,
    meta
  );

  const balanceUpdateTwo = makeBalanceUpdate(
    chainId,
    event.params.liquidAccountOwner,
    event.params.liquidAccountNumber,
    event.params.liquidOwedUpdate.newPar.value,
    event.params.liquidOwedUpdate.newPar.sign,
    event.params.liquidOwedUpdate.deltaWei.value,
    event.params.liquidOwedUpdate.deltaWei.sign,
    owedToken
  );
  const liquidOwedAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateTwo,
    meta
  );

  const balanceUpdateThree = makeBalanceUpdate(
    chainId,
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    event.params.solidHeldUpdate.deltaWei.value,
    event.params.solidHeldUpdate.deltaWei.sign,
    heldToken
  );
  const solidHeldAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateThree,
    meta
  );

  const balanceUpdateFour = makeBalanceUpdate(
    chainId,
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    event.params.solidOwedUpdate.deltaWei.value,
    event.params.solidOwedUpdate.deltaWei.sign,
    owedToken
  );
  const solidOwedAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateFour,
    meta
  );

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);

  const liquidationID = eventId(chainId, meta.txHash, meta.logIndex);
  const existing = await context.Liquidation.get(liquidationID);

  const heldIndex = await context.InterestIndex.getOrThrow(heldToken.id);
  const owedIndex = await context.InterestIndex.getOrThrow(owedToken.id);

  const solidHeldDeltaWeiStruct = ValueStruct.from(event.params.solidHeldUpdate.deltaWei);
  const heldTokenAmountDeltaWei = convertStructToDecimalAppliedValue(solidHeldDeltaWeiStruct.abs(), heldToken.decimals);

  const solidOwedDeltaWeiStruct = ValueStruct.from(event.params.solidOwedUpdate.deltaWei);
  const borrowedTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    solidOwedDeltaWeiStruct.abs(),
    owedToken.decimals
  );

  const liquidHeldDeltaWeiStruct = ValueStruct.from(event.params.liquidHeldUpdate.deltaWei);
  const liquidHeldNewParStruct = ValueStruct.from(event.params.liquidHeldUpdate.newPar);

  const liquidOwedDeltaWeiStruct = ValueStruct.from(event.params.liquidOwedUpdate.deltaWei);
  const liquidOwedNewParStruct = ValueStruct.from(event.params.liquidOwedUpdate.newPar);

  const heldPriceUSD = await getTokenOraclePriceUSD(context, chainId, heldToken, meta, ProtocolType.Core);
  const owedPriceUSD = await getTokenOraclePriceUSD(context, chainId, owedToken, meta, ProtocolType.Core);

  const liquidationSpread = await getLiquidationSpreadForPair(context, heldToken, owedToken, dolomiteMargin);
  const owedPriceAdj = truncate(owedPriceUSD.times(liquidationSpread), 36);

  const heldTokenLiquidationRewardWei = roundHalfUp(
    borrowedTokenAmountDeltaWei.times(owedPriceAdj).div(heldPriceUSD),
    heldToken.decimals
  );

  const borrowedTokenAmountUSD = truncate(borrowedTokenAmountDeltaWei.times(owedPriceUSD), USD_PRECISION);
  const heldTokenAmountUSD = truncate(heldTokenAmountDeltaWei.times(heldPriceUSD), USD_PRECISION);
  const heldTokenLiquidationRewardUSD = truncate(heldTokenLiquidationRewardWei.times(heldPriceUSD), USD_PRECISION);

  const liquidEffectiveUser = (await getEffectiveUserForUserId(context, liquidOwedAccountUpdate.marginAccount.user_id))
    .id;
  const solidEffectiveUser = (await getEffectiveUserForUserId(context, solidOwedAccountUpdate.marginAccount.user_id))
    .id;

  const liquidation: Mutable<Liquidation> = {
    id: liquidationID,
    serialId: existing?.serialId ?? dolomiteMargin.actionCount,
    transaction_id: transaction.id,
    logIndex: meta.logIndex,
    liquidEffectiveUser_id: liquidEffectiveUser,
    liquidMarginAccount_id: liquidOwedAccountUpdate.marginAccount.id,
    solidEffectiveUser_id: solidEffectiveUser,
    solidMarginAccount_id: solidOwedAccountUpdate.marginAccount.id,
    effectiveUsers: [liquidEffectiveUser, solidEffectiveUser],
    heldToken_id: heldToken.id,
    borrowedToken_id: owedToken.id,
    heldInterestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, heldIndex),
    borrowedInterestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, owedIndex),
    heldTokenAmountDeltaWei,
    borrowedTokenAmountDeltaWei,
    heldTokenLiquidationRewardWei,
    borrowedTokenAmountUSD,
    heldTokenAmountUSD,
    heldTokenLiquidationRewardUSD,
    liquidBorrowedTokenAmountDeltaPar: liquidOwedAccountUpdate.deltaPar,
    liquidHeldTokenAmountDeltaPar: liquidHeldAccountUpdate.deltaPar,
    solidBorrowedTokenAmountDeltaPar: solidOwedAccountUpdate.deltaPar,
    solidHeldTokenAmountDeltaPar: solidHeldAccountUpdate.deltaPar,
  };

  dolomiteMargin.liquidationCount = dolomiteMargin.liquidationCount + ONE_BI;
  dolomiteMargin.totalLiquidationVolumeUSD = dolomiteMargin.totalLiquidationVolumeUSD.plus(
    liquidation.borrowedTokenAmountUSD
  );
  context.DolomiteMargin.set(dolomiteMargin);

  await changeProtocolBalance(
    context,
    chainId,
    meta,
    heldToken,
    solidHeldDeltaWeiStruct,
    heldIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    owedToken,
    solidOwedDeltaWeiStruct,
    owedIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    heldToken,
    liquidHeldDeltaWeiStruct,
    heldIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    owedToken,
    liquidOwedDeltaWeiStruct,
    owedIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );

  context.Liquidation.set(liquidation);

  if (canBeMarginPosition(liquidOwedAccountUpdate.marginAccount)) {
    const marginPosition = await getOrCreateMarginPosition(
      context,
      chainId,
      meta,
      liquidOwedAccountUpdate.marginAccount
    );
    await handleLiquidateMarginPosition(
      context,
      chainId,
      meta,
      marginPosition,
      heldPriceUSD,
      owedPriceAdj,
      heldToken,
      owedToken,
      heldIndex,
      owedIndex,
      convertStructToDecimalAppliedValue(liquidHeldNewParStruct, heldToken.decimals),
      convertStructToDecimalAppliedValue(liquidOwedNewParStruct, owedToken.decimals),
      liquidation.borrowedTokenAmountDeltaWei,
      MarginPositionStatus.Liquidated
    );
  }

  await updateBorrowPositionForLiquidation(context, liquidOwedAccountUpdate.marginAccount);

  const liquidUser = await context.User.getOrThrow(liquidOwedAccountUpdate.marginAccount.user_id);
  // heldTokenAmountUSD in this case is the amount of held collateral seized + the liquidation reward
  context.User.set({
    ...liquidUser,
    totalCollateralLiquidatedUSD: liquidUser.totalCollateralLiquidatedUSD.plus(liquidation.heldTokenAmountUSD),
    totalLiquidationCount: liquidUser.totalLiquidationCount + ONE_BI,
  });
  if (liquidUser.effectiveUser_id !== liquidUser.id) {
    const effectiveLiquidUser = await context.User.getOrThrow(liquidUser.effectiveUser_id);
    context.User.set({
      ...effectiveLiquidUser,
      totalCollateralLiquidatedUSD: effectiveLiquidUser.totalCollateralLiquidatedUSD.plus(
        liquidation.heldTokenAmountUSD
      ),
      totalLiquidationCount: effectiveLiquidUser.totalLiquidationCount + ONE_BI,
    });
  }
});

// ---------------------------------------------------------------------------
// LogVaporize
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogVaporize" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);

  const heldToken = await getTokenForMarket(context, chainId, event.params.heldMarket);
  const owedToken = await getTokenForMarket(context, chainId, event.params.owedMarket);

  const balanceUpdateOne = makeBalanceUpdate(
    chainId,
    event.params.vaporAccountOwner,
    event.params.vaporAccountNumber,
    event.params.vaporOwedUpdate.newPar.value,
    event.params.vaporOwedUpdate.newPar.sign,
    event.params.vaporOwedUpdate.deltaWei.value,
    event.params.vaporOwedUpdate.deltaWei.sign,
    owedToken
  );
  const vaporOwedAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateOne,
    meta
  );

  const balanceUpdateTwo = makeBalanceUpdate(
    chainId,
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidHeldUpdate.newPar.value,
    event.params.solidHeldUpdate.newPar.sign,
    event.params.solidHeldUpdate.deltaWei.value,
    event.params.solidHeldUpdate.deltaWei.sign,
    heldToken
  );
  const solidHeldAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateTwo,
    meta
  );

  const balanceUpdateThree = makeBalanceUpdate(
    chainId,
    event.params.solidAccountOwner,
    event.params.solidAccountNumber,
    event.params.solidOwedUpdate.newPar.value,
    event.params.solidOwedUpdate.newPar.sign,
    event.params.solidOwedUpdate.deltaWei.value,
    event.params.solidOwedUpdate.deltaWei.sign,
    owedToken
  );
  const solidOwedAccountUpdate = await handleDolomiteMarginBalanceUpdateForAccount(
    context,
    chainId,
    balanceUpdateThree,
    meta
  );

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const vaporOwedNewParStruct = ValueStruct.from(event.params.vaporOwedUpdate.newPar);
  const vaporOwedDeltaWeiStruct = ValueStruct.from(event.params.vaporOwedUpdate.deltaWei);
  const solidHeldDeltaWeiStruct = ValueStruct.from(event.params.solidHeldUpdate.deltaWei);
  const solidOwedDeltaWeiStruct = ValueStruct.from(event.params.solidOwedUpdate.deltaWei);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);

  const vaporizationID = eventId(chainId, meta.txHash, meta.logIndex);
  const existing = await context.Vaporization.get(vaporizationID);

  const heldIndex = await context.InterestIndex.getOrThrow(heldToken.id);
  const owedIndex = await context.InterestIndex.getOrThrow(owedToken.id);

  const borrowedTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    ValueStruct.from(event.params.solidOwedUpdate.deltaWei).abs(),
    owedToken.decimals
  );
  const heldTokenAmountDeltaWei = convertStructToDecimalAppliedValue(
    ValueStruct.from(event.params.solidHeldUpdate.deltaWei).abs(),
    heldToken.decimals
  );

  const owedPriceUSD = await getTokenOraclePriceUSD(context, chainId, owedToken, meta, ProtocolType.Core);
  const vaporOwedDeltaWeiBD = convertStructToDecimalAppliedValue(vaporOwedDeltaWeiStruct, owedToken.decimals);
  const amountUSDVaporized = truncate(vaporOwedDeltaWeiBD.times(owedPriceUSD), USD_PRECISION);

  const vaporEffectiveUser = (await getEffectiveUserForUserId(context, vaporOwedAccountUpdate.marginAccount.user_id))
    .id;
  const solidEffectiveUser = (await getEffectiveUserForUserId(context, solidOwedAccountUpdate.marginAccount.user_id))
    .id;

  const vaporization: Mutable<Vaporization> = {
    id: vaporizationID,
    serialId: existing?.serialId ?? dolomiteMargin.actionCount,
    transaction_id: transaction.id,
    logIndex: meta.logIndex,
    vaporEffectiveUser_id: vaporEffectiveUser,
    vaporMarginAccount_id: vaporOwedAccountUpdate.marginAccount.id,
    solidEffectiveUser_id: solidEffectiveUser,
    solidMarginAccount_id: solidOwedAccountUpdate.marginAccount.id,
    effectiveUsers: [vaporEffectiveUser, solidEffectiveUser],
    heldToken_id: heldToken.id,
    borrowedToken_id: owedToken.id,
    heldInterestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, heldIndex),
    borrowedInterestIndex_id: await getOrCreateInterestIndexSnapshotAndReturnId(context, owedIndex),
    borrowedTokenAmountDeltaWei,
    heldTokenAmountDeltaWei,
    amountUSDVaporized,
    vaporBorrowedTokenAmountDeltaPar: vaporOwedAccountUpdate.deltaPar,
    solidHeldTokenAmountDeltaPar: solidHeldAccountUpdate.deltaPar,
    solidBorrowedTokenAmountDeltaPar: solidOwedAccountUpdate.deltaPar,
  };

  dolomiteMargin.vaporizationCount = dolomiteMargin.vaporizationCount + ONE_BI;
  dolomiteMargin.totalVaporizationVolumeUSD = dolomiteMargin.totalVaporizationVolumeUSD.plus(
    vaporization.amountUSDVaporized
  );
  context.DolomiteMargin.set(dolomiteMargin);

  await changeProtocolBalance(
    context,
    chainId,
    meta,
    heldToken,
    solidHeldDeltaWeiStruct,
    heldIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    owedToken,
    solidOwedDeltaWeiStruct,
    owedIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );
  await changeProtocolBalance(
    context,
    chainId,
    meta,
    owedToken,
    vaporOwedDeltaWeiStruct,
    owedIndex,
    true,
    ProtocolType.Core,
    dolomiteMargin
  );

  if (canBeMarginPosition(vaporOwedAccountUpdate.marginAccount)) {
    const marginPosition = await getOrCreateMarginPosition(
      context,
      chainId,
      meta,
      vaporOwedAccountUpdate.marginAccount
    );
    if (marginPosition.status === MarginPositionStatus.Liquidated) {
      // vaporized accounts must be liquidated before being vaporized
      // when an account is vaporized, the vaporHeldAmount is zero, so it's not updated
      context.MarginPosition.set({
        ...marginPosition,
        owedAmountPar: convertStructToDecimalAppliedValue(vaporOwedNewParStruct, owedToken.decimals),
      });
    }
  }

  context.Vaporization.set(vaporization);
});

// ---------------------------------------------------------------------------
// LogCall
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogCall" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  // This function saves the actionCount, so it's not necessary to use the return value
  await getOrCreateDolomiteMarginForCall(context, chainId, meta, true, ProtocolType.Core);
});

// ---------------------------------------------------------------------------
// handleLiquidateMarginPosition — handles liquidation via the liquidation action
// and liquidation via expiration.
// ---------------------------------------------------------------------------

async function handleLiquidateMarginPosition(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  marginPositionInput: Mutable<MarginPosition>,
  heldPrice: BigDecimal,
  owedPriceAdj: BigDecimal,
  heldToken: Token,
  owedToken: Token,
  heldIndex: InterestIndex,
  owedIndex: InterestIndex,
  heldNewPar: BigDecimal,
  owedNewPar: BigDecimal,
  borrowedTokenAmountDeltaWei: BigDecimal,
  status: string
): Promise<void> {
  const marginPosition = marginPositionInput;
  if (
    marginPosition.isInitialized &&
    (marginPosition.status === MarginPositionStatus.Open ||
      marginPosition.status === MarginPositionStatus.Liquidated ||
      marginPosition.status === MarginPositionStatus.Expired)
  ) {
    marginPosition.status = status;
    if (marginPosition.closeTimestamp === undefined) {
      marginPosition.closeTimestamp = meta.timestamp;
      marginPosition.closeTransaction_id = transactionId(chainId, meta.txHash);
    }

    const heldTokenLiquidationRewardWei = roundHalfUp(
      borrowedTokenAmountDeltaWei.times(owedPriceAdj).div(heldPrice),
      heldToken.decimals
    );
    const heldTokenLiquidationRewardUSD = truncate(heldTokenLiquidationRewardWei.times(heldPrice), USD_PRECISION);

    marginPosition.heldAmountPar = heldNewPar;
    marginPosition.owedAmountPar = owedNewPar;

    if (marginPosition.closeHeldAmountUSD === undefined && marginPosition.closeOwedAmountUSD === undefined) {
      const heldPriceUSD = await getTokenOraclePriceUSD(context, chainId, heldToken, meta, ProtocolType.Core);
      const owedPriceUSD = await getTokenOraclePriceUSD(context, chainId, owedToken, meta, ProtocolType.Core);

      const closeHeldAmountWei = parToWei(marginPosition.initialHeldAmountPar, heldIndex, heldToken.decimals);
      const closeOwedAmountWei = parToWei(
        marginPosition.initialOwedAmountPar.negated(),
        owedIndex,
        owedToken.decimals
      ).negated();

      marginPosition.closeHeldPrice = truncate(heldPriceUSD.div(owedPriceUSD), USD_PRECISION);
      marginPosition.closeHeldPriceUSD = truncate(heldPriceUSD, USD_PRECISION);
      marginPosition.closeHeldAmountWei = closeHeldAmountWei;
      marginPosition.closeHeldAmountUSD = truncate(closeHeldAmountWei.times(heldPriceUSD), USD_PRECISION);

      const closeHeldAmountSeized = marginPosition.closeHeldAmountSeized;
      const closeHeldAmountSeizedUSD = marginPosition.closeHeldAmountSeizedUSD;
      if (closeHeldAmountSeized !== undefined && closeHeldAmountSeizedUSD !== undefined) {
        marginPosition.closeHeldAmountSeized = closeHeldAmountSeized.plus(heldTokenLiquidationRewardWei);
        marginPosition.closeHeldAmountSeizedUSD = closeHeldAmountSeizedUSD.plus(heldTokenLiquidationRewardUSD);
      } else {
        marginPosition.closeHeldAmountSeized = heldTokenLiquidationRewardWei;
        marginPosition.closeHeldAmountSeizedUSD = heldTokenLiquidationRewardUSD;
      }

      marginPosition.closeOwedPrice = truncate(owedPriceUSD.div(heldPriceUSD), USD_PRECISION);
      marginPosition.closeOwedPriceUSD = truncate(owedPriceUSD, USD_PRECISION);
      marginPosition.closeOwedAmountWei = closeOwedAmountWei;
      marginPosition.closeOwedAmountUSD = truncate(closeOwedAmountWei.times(owedPriceUSD), USD_PRECISION);
    }

    context.MarginPosition.set(marginPosition);
  }
}
