import { indexer } from "envio";
import type { LiquidityMiningVestingPosition, LiquidityMiningVestingPositionTransfer } from "envio";
import { ADDRESS_ZERO } from "../constants";
import { ONE_BI, ZERO_BI, ZERO_BD, _18_BI, convertTokenToDecimal } from "./helpers/numbers";
import { userId, liquidityMiningLevelRequestId, liquidityMiningVesterId } from "./helpers/ids";
import type { Ctx, EventMeta, Mutable } from "./helpers/types";
import { ProtocolType } from "./helpers/types";
import { getOrCreateTransaction } from "./helpers/transaction";
import { createUserIfNecessary } from "./helpers/user";
import { getEffectiveUserForAddress } from "./helpers/isolation";
import { getOrCreateInterestIndexSnapshotAndReturnId } from "./helpers/interest-index";
import { getOrCreateDolomiteMarginForCall, getOrCreateEffectiveUserTokenValue, weiToPar } from "./helpers/margin";
import {
  getVestingPosition,
  getVestingPositionId,
  handleClaim,
  handleVestingPositionClose,
  LiquidityMiningVestingPositionStatus,
} from "./helpers/liquidity-mining-helpers";

/**
 * Ported from dolomite-subgraph/src/mappings/liquidity-mining.ts.
 *
 * Two contracts:
 *  - LiquidityMiningVester: the vesting-position lifecycle (create/start/extend/transfer/
 *    close/force-close/emergency-withdraw) plus level requests.
 *  - LiquidityMiningClaimer: the OARB `Claimed` event.
 */

// Shared VestingPositionCreated body (the subgraph's private handleVestingPositionCreated).
async function handleVestingPositionCreated(
  context: Ctx,
  chainId: number,
  meta: EventMeta,
  vesterAddress: string,
  positionId: bigint,
  creator: string,
  startTime: bigint,
  duration: bigint,
  oTokenAmount: bigint,
  pairAmount: bigint
): Promise<void> {
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  await createUserIfNecessary(context, chainId, creator);

  const vester = await context.LiquidityMiningVester.getOrThrow(liquidityMiningVesterId(chainId, vesterAddress));

  const positionEntityId = getVestingPositionId(chainId, vesterAddress, positionId);
  const existing = await context.LiquidityMiningVestingPosition.get(positionEntityId);
  if (existing !== undefined) {
    // Position was already created (which can happen between the duplicate calls to
    // VestingStarted and VestingPositionCreated).
    return;
  }

  const pairToken = await context.Token.getOrThrow(vester.pairToken_id);
  const index = await context.InterestIndex.get(vester.pairToken_id);

  const startTimestamp = startTime;
  const pairAmountPar =
    index === undefined
      ? convertTokenToDecimal(pairAmount, pairToken.decimals)
      : weiToPar(convertTokenToDecimal(pairAmount, pairToken.decimals), index, pairToken.decimals);

  const position: LiquidityMiningVestingPosition = {
    id: positionEntityId,
    vester_id: vester.id,
    positionId,
    status: LiquidityMiningVestingPositionStatus.ACTIVE,
    creator_id: userId(chainId, creator),
    owner_id: userId(chainId, creator),
    openTransaction_id: transaction.id,
    startTimestamp,
    duration,
    endTimestamp: startTimestamp + duration,
    closeTimestamp: undefined,
    oTokenAmount: convertTokenToDecimal(oTokenAmount, _18_BI),
    pairAmountPar,
    paymentAmountWei: ZERO_BD,
    pairTaxesPaid: ZERO_BD,
    closeTransaction_id: undefined,
  };
  context.LiquidityMiningVestingPosition.set(position);

  const effectiveUserTokenValue = await getOrCreateEffectiveUserTokenValue(context, position.owner_id, pairToken);
  effectiveUserTokenValue.totalSupplyPar = effectiveUserTokenValue.totalSupplyPar.plus(position.pairAmountPar);
  context.UserParValue.set(effectiveUserTokenValue);
}

function buildMeta(event: { block: { number: number; hash: string; timestamp: number }; transaction: { hash: string }; logIndex: number }): EventMeta {
  return {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
}

indexer.onEvent({ contract: "LiquidityMiningVester", event: "VestingPositionCreatedOld" }, async ({ event, context }) => {
  const p = event.params.vestingPosition;
  await handleVestingPositionCreated(
    context,
    event.chainId,
    buildMeta(event),
    event.srcAddress,
    p.id,
    p.creator,
    p.startTime,
    p.duration,
    p.amount,
    p.amount
  );
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "VestingPositionCreatedNew" }, async ({ event, context }) => {
  const p = event.params.vestingPosition;
  await handleVestingPositionCreated(
    context,
    event.chainId,
    buildMeta(event),
    event.srcAddress,
    p.id,
    p.creator,
    p.startTime,
    p.duration,
    p.oTokenAmount,
    p.pairAmount
  );
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "VestingStartedOld" }, async ({ event, context }) => {
  await handleVestingPositionCreated(
    context,
    event.chainId,
    buildMeta(event),
    event.srcAddress,
    event.params.vestingId,
    event.params.owner,
    BigInt(event.block.timestamp),
    event.params.duration,
    event.params.amount,
    event.params.amount
  );
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "VestingStartedNew" }, async ({ event, context }) => {
  await handleVestingPositionCreated(
    context,
    event.chainId,
    buildMeta(event),
    event.srcAddress,
    event.params.vestingId,
    event.params.owner,
    BigInt(event.block.timestamp),
    event.params.duration,
    event.params.oTokenAmount,
    event.params.pairAmount
  );
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "PositionDurationExtended" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const loaded = await getVestingPosition(context, chainId, event.srcAddress, event.params.vestingId);
  if (loaded === undefined) {
    context.log.warn(
      `Vesting position is unexpectedly null: ${getVestingPositionId(chainId, event.srcAddress, event.params.vestingId)}`
    );
    return;
  }

  const position: Mutable<LiquidityMiningVestingPosition> = { ...loaded };
  position.duration = event.params.newDuration;
  position.endTimestamp = position.startTimestamp + position.duration;
  context.LiquidityMiningVestingPosition.set(position);
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "Transfer" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  const loaded = await getVestingPosition(context, chainId, event.srcAddress, event.params.tokenId);
  if (loaded === undefined) {
    context.log.warn(
      `Vesting position is unexpectedly null: ${getVestingPositionId(chainId, event.srcAddress, event.params.tokenId)}`
    );
    return;
  }
  const position: Mutable<LiquidityMiningVestingPosition> = { ...loaded };

  if (event.params.to !== ADDRESS_ZERO) {
    await createUserIfNecessary(context, chainId, event.params.to);
  }

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Core);

  let fromEffectiveUserId: string | undefined = undefined;
  let toEffectiveUserId: string | undefined = undefined;
  if (event.params.from !== ADDRESS_ZERO) {
    fromEffectiveUserId = (await getEffectiveUserForAddress(context, chainId, event.params.from)).id;
  }
  if (event.params.to !== ADDRESS_ZERO) {
    toEffectiveUserId = (await getEffectiveUserForAddress(context, chainId, event.params.to)).id;
  }

  const vester = await context.LiquidityMiningVester.getOrThrow(liquidityMiningVesterId(chainId, event.srcAddress));
  const pairToken = await context.Token.getOrThrow(vester.pairToken_id);

  let pairInterestIndexId: string | undefined = undefined;
  const marketInterestIndex = await context.InterestIndex.get(vester.pairToken_id);
  if (marketInterestIndex !== undefined) {
    pairInterestIndexId = await getOrCreateInterestIndexSnapshotAndReturnId(context, marketInterestIndex);
  }

  const transfer: LiquidityMiningVestingPositionTransfer = {
    id: `${chainId}-${dolomiteMargin.vestingPositionTransferCount.toString()}`,
    transaction_id: transaction.id,
    logIndex: meta.logIndex,
    serialId: dolomiteMargin.vestingPositionTransferCount,
    fromEffectiveUser_id: fromEffectiveUserId,
    toEffectiveUser_id: toEffectiveUserId,
    pairInterestIndex_id: pairInterestIndexId,
    vestingPosition_id: position.id,
  };
  context.LiquidityMiningVestingPositionTransfer.set(transfer);

  if (fromEffectiveUserId !== undefined && toEffectiveUserId !== undefined) {
    position.owner_id = userId(chainId, event.params.to);
    context.LiquidityMiningVestingPosition.set(position);

    const fromEffectiveUserTokenValue = await getOrCreateEffectiveUserTokenValue(context, fromEffectiveUserId, pairToken);
    fromEffectiveUserTokenValue.totalSupplyPar = fromEffectiveUserTokenValue.totalSupplyPar.minus(position.pairAmountPar);
    context.UserParValue.set(fromEffectiveUserTokenValue);

    const toEffectiveUserTokenValue = await getOrCreateEffectiveUserTokenValue(context, toEffectiveUserId, pairToken);
    toEffectiveUserTokenValue.totalSupplyPar = toEffectiveUserTokenValue.totalSupplyPar.plus(position.pairAmountPar);
    context.UserParValue.set(toEffectiveUserTokenValue);
  }

  dolomiteMargin.vestingPositionTransferCount = dolomiteMargin.vestingPositionTransferCount + ONE_BI;
  context.DolomiteMargin.set(dolomiteMargin);
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "PositionClosed" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  const loaded = await getVestingPosition(context, chainId, event.srcAddress, event.params.vestingId);
  if (loaded === undefined) {
    context.log.warn(
      `Vesting position is unexpectedly null: ${getVestingPositionId(chainId, event.srcAddress, event.params.vestingId)}`
    );
    return;
  }

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const position: Mutable<LiquidityMiningVestingPosition> = { ...loaded };
  position.closeTransaction_id = transaction.id;
  position.closeTimestamp = meta.timestamp;

  const vester = await context.LiquidityMiningVester.getOrThrow(position.vester_id);
  const paymentToken = await context.Token.getOrThrow(vester.paymentToken_id);
  position.paymentAmountWei = convertTokenToDecimal(event.params.amountPaidWei, paymentToken.decimals);

  position.status = LiquidityMiningVestingPositionStatus.CLOSED;
  context.LiquidityMiningVestingPosition.set(position);

  await handleVestingPositionClose(context, position);
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "PositionForceClosed" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  const loaded = await getVestingPosition(context, chainId, event.srcAddress, event.params.vestingId);
  if (loaded === undefined) {
    context.log.warn(
      `Vesting position is unexpectedly null: ${getVestingPositionId(chainId, event.srcAddress, event.params.vestingId)}`
    );
    return;
  }

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const position: Mutable<LiquidityMiningVestingPosition> = { ...loaded };
  position.closeTransaction_id = transaction.id;
  position.closeTimestamp = meta.timestamp;

  const vester = await context.LiquidityMiningVester.getOrThrow(position.vester_id);
  const pairToken = await context.Token.getOrThrow(vester.pairToken_id);
  position.pairTaxesPaid = convertTokenToDecimal(event.params.pairTax, pairToken.decimals);

  position.status = LiquidityMiningVestingPositionStatus.FORCE_CLOSED;
  context.LiquidityMiningVestingPosition.set(position);

  await handleVestingPositionClose(context, position);
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "EmergencyWithdraw" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  const loaded = await getVestingPosition(context, chainId, event.srcAddress, event.params.vestingId);
  if (loaded === undefined) {
    context.log.warn(
      `Vesting position is unexpectedly null: ${getVestingPositionId(chainId, event.srcAddress, event.params.vestingId)}`
    );
    return;
  }

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const position: Mutable<LiquidityMiningVestingPosition> = { ...loaded };
  position.closeTimestamp = meta.timestamp;
  position.closeTransaction_id = transaction.id;
  position.pairTaxesPaid = convertTokenToDecimal(event.params.pairTax, _18_BI);
  position.status = LiquidityMiningVestingPositionStatus.EMERGENCY_CLOSED;
  context.LiquidityMiningVestingPosition.set(position);

  await handleVestingPositionClose(context, position);
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "LevelRequestInitiated" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  await createUserIfNecessary(context, chainId, event.params.user);

  context.LiquidityMiningLevelUpdateRequest.set({
    id: liquidityMiningLevelRequestId(chainId, event.params.requestId),
    requestId: event.params.requestId,
    user_id: userId(chainId, event.params.user),
    initiateTransaction_id: transaction.id,
    isFulfilled: false,
    level: undefined,
    fulfilmentTransaction_id: undefined,
  });
});

indexer.onEvent({ contract: "LiquidityMiningVester", event: "LevelRequestFinalized" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta = buildMeta(event);
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const request = await context.LiquidityMiningLevelUpdateRequest.getOrThrow(
    liquidityMiningLevelRequestId(chainId, event.params.requestId)
  );
  context.LiquidityMiningLevelUpdateRequest.set({
    ...request,
    fulfilmentTransaction_id: transaction.id,
    isFulfilled: true,
    level: Number(event.params.level),
  });
});

// LiquidityMiningClaimer

const SEASON_NUMBER = ZERO_BI;

indexer.onEvent({ contract: "LiquidityMiningClaimer", event: "Claimed" }, async ({ event, context }) => {
  await handleClaim(
    context,
    event.chainId,
    event.srcAddress,
    event.params.user,
    event.params.epoch,
    SEASON_NUMBER,
    event.params.amount
  );
});
