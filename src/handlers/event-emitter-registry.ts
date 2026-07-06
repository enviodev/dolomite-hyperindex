import { indexer } from "envio";
import type { AsyncDeposit, AsyncWithdrawal } from "envio";
import type { EventMeta, Mutable } from "./helpers/types";
import { AsyncDepositStatus, AsyncWithdrawalStatus, TradeLiquidationType } from "./helpers/types";
import { getAsyncDepositOrWithdrawalKey, getEventEmitterRegistryAddresses } from "./helpers/event-emitter-helpers";
import { getEffectiveUserForAddress } from "./helpers/isolation";
import { handleClaim } from "./helpers/liquidity-mining-helpers";
import { getOrCreateMarginAccount } from "./helpers/margin";
import { getOrCreateTransaction } from "./helpers/transaction";
import { createUserIfNecessary } from "./helpers/user";
import { convertTokenToDecimal, ZERO_BI } from "./helpers/numbers";
import {
  dolomiteMarginId,
  liquidityMiningVesterId,
  settingId,
  tokenId,
  userId,
} from "./helpers/ids";

/**
 * Ported from event-emitter-registry.requireIsValidEventEmitter. The subgraph guarded every
 * handler by asserting the emitting contract was one of the known proxy addresses.
 */
function requireIsValidEventEmitter(chainId: number, srcAddress: string): boolean {
  const valid = getEventEmitterRegistryAddresses(chainId).map((a) => a.toLowerCase());
  return valid.includes(srcAddress.toLowerCase());
}

function metaOf(event: { block: { number: number; hash: string; timestamp: number }; transaction: { hash: string }; logIndex: number }): EventMeta {
  return {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
}

// ---------------------------------------------------------------------------------------------
// Async deposits
// ---------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncDepositCreated" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const inputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.deposit.inputToken));
  const outputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.token));

  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    event.params.deposit.vault,
    event.params.deposit.accountNumber,
    meta
  );
  context.MarginAccount.set(marginAccount);
  const effectiveUser = await getEffectiveUserForAddress(context, chainId, event.params.deposit.vault);

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  context.AsyncDeposit.set({
    id: getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key),
    key: event.params.key,
    creationTransaction_id: transaction.id,
    executionTransaction_id: undefined,
    marginAccount_id: marginAccount.id,
    effectiveUser_id: effectiveUser.id,
    status: AsyncDepositStatus.CREATED,
    inputToken_id: inputToken.id,
    inputAmount: convertTokenToDecimal(event.params.deposit.inputAmount, inputToken.decimals),
    outputToken_id: outputToken.id,
    minOutputAmount: convertTokenToDecimal(event.params.deposit.outputAmount, outputToken.decimals),
    outputAmount: convertTokenToDecimal(event.params.deposit.outputAmount, outputToken.decimals),
    isRetryable: event.params.deposit.isRetryable,
  });
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncDepositOutputAmountUpdated" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  const deposit = await context.AsyncDeposit.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const outputToken = await context.Token.getOrThrow(deposit.outputToken_id);
  const updated: Mutable<AsyncDeposit> = { ...deposit };
  updated.outputAmount = convertTokenToDecimal(event.params.outputAmount, outputToken.decimals);
  context.AsyncDeposit.set(updated);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncDepositExecuted" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const deposit = await context.AsyncDeposit.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const updated: Mutable<AsyncDeposit> = { ...deposit };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncDepositStatus.DEPOSIT_EXECUTED;
  context.AsyncDeposit.set(updated);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncDepositFailed" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const deposit = await context.AsyncDeposit.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const updated: Mutable<AsyncDeposit> = { ...deposit };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncDepositStatus.DEPOSIT_FAILED;
  context.AsyncDeposit.set(updated);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncDepositCancelled" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const deposit = await context.AsyncDeposit.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const updated: Mutable<AsyncDeposit> = { ...deposit };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncDepositStatus.DEPOSIT_CANCELLED;
  updated.isRetryable = false;
  context.AsyncDeposit.set(updated);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncDepositCancelledFailed" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const deposit = await context.AsyncDeposit.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const updated: Mutable<AsyncDeposit> = { ...deposit };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncDepositStatus.DEPOSIT_CANCELLED_FAILED;
  updated.isRetryable = true;
  context.AsyncDeposit.set(updated);
});

// ---------------------------------------------------------------------------------------------
// Async withdrawals
// ---------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncWithdrawalCreated" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const inputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.token));
  const outputToken = await context.Token.getOrThrow(tokenId(chainId, event.params.withdrawal.outputToken));

  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    event.params.withdrawal.vault,
    event.params.withdrawal.accountNumber,
    meta
  );
  context.MarginAccount.set(marginAccount);
  const effectiveUser = await getEffectiveUserForAddress(context, chainId, event.params.withdrawal.vault);

  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  context.AsyncWithdrawal.set({
    id: getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key),
    key: event.params.key,
    creationTransaction_id: transaction.id,
    executionTransaction_id: undefined,
    marginAccount_id: marginAccount.id,
    effectiveUser_id: effectiveUser.id,
    status: AsyncWithdrawalStatus.CREATED,
    inputToken_id: inputToken.id,
    inputAmount: convertTokenToDecimal(event.params.withdrawal.inputAmount, inputToken.decimals),
    outputToken_id: outputToken.id,
    minOutputAmount: convertTokenToDecimal(event.params.withdrawal.outputAmount, outputToken.decimals),
    outputAmount: convertTokenToDecimal(event.params.withdrawal.outputAmount, outputToken.decimals),
    isRetryable: event.params.withdrawal.isRetryable,
    isLiquidation: event.params.withdrawal.isLiquidation,
    extraData: event.params.withdrawal.extraData,
  });
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncWithdrawalOutputAmountUpdated" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  const withdrawal = await context.AsyncWithdrawal.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const outputToken = await context.Token.getOrThrow(withdrawal.outputToken_id);
  const updated: Mutable<AsyncWithdrawal> = { ...withdrawal };
  updated.outputAmount = convertTokenToDecimal(event.params.outputAmount, outputToken.decimals);
  context.AsyncWithdrawal.set(updated);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncWithdrawalExecuted" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const withdrawal = await context.AsyncWithdrawal.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);

  const updated: Mutable<AsyncWithdrawal> = { ...withdrawal };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncWithdrawalStatus.WITHDRAWAL_EXECUTED;
  updated.isRetryable = false;
  context.AsyncWithdrawal.set(updated);

  if (updated.isLiquidation) {
    const trades = await context.Trade.getWhere({ transaction_id: { _eq: transaction.id } });
    for (const trade of trades) {
      if (
        (trade.takerToken_id === updated.inputToken_id && trade.makerToken_id === updated.outputToken_id) ||
        (trade.makerToken_id === updated.inputToken_id && trade.takerToken_id === updated.outputToken_id)
      ) {
        context.Trade.set({ ...trade, liquidationType: TradeLiquidationType.LIQUIDATION });
      }
    }
  }
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncWithdrawalFailed" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const withdrawal = await context.AsyncWithdrawal.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const updated: Mutable<AsyncWithdrawal> = { ...withdrawal };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncWithdrawalStatus.WITHDRAWAL_EXECUTION_FAILED;
  updated.isRetryable = true;
  context.AsyncWithdrawal.set(updated);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "AsyncWithdrawalCancelled" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }
  const meta = metaOf(event);

  const withdrawal = await context.AsyncWithdrawal.getOrThrow(
    getAsyncDepositOrWithdrawalKey(chainId, event.params.token, event.params.key)
  );
  const transaction = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
  const updated: Mutable<AsyncWithdrawal> = { ...withdrawal };
  updated.executionTransaction_id = transaction.id;
  updated.status = AsyncWithdrawalStatus.WITHDRAWAL_CANCELLED;
  updated.isRetryable = false;
  context.AsyncWithdrawal.set(updated);
});

// ---------------------------------------------------------------------------------------------
// Liquidity mining rewards
// ---------------------------------------------------------------------------------------------

const seasonNumber = ZERO_BI;

indexer.onEvent({ contract: "EventEmitterRegistry", event: "RewardClaimed" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  await handleClaim(
    context,
    chainId,
    event.params.distributor,
    event.params.user,
    event.params.epoch,
    seasonNumber,
    event.params.amount
  );
});

// ---------------------------------------------------------------------------------------------
// Distributor registration (dynamically registers the LiquidityMiningVester contract)
// ---------------------------------------------------------------------------------------------

indexer.contractRegister({ contract: "EventEmitterRegistry", event: "DistributorRegistered" }, async ({ event, context }) => {
  context.chain.LiquidityMiningVester.add(event.params.vesterContract);
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "DistributorRegistered" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  // Ported faithfully from handleDistributorRegistered: the vester fields come straight from the
  // event params (createLiquidityMiningVester only knows the hard-coded OARB/GOARB vesters and
  // would drop any other distributor, so we construct inline to preserve fidelity).
  context.LiquidityMiningVester.set({
    id: liquidityMiningVesterId(chainId, event.params.vesterContract),
    oTokenAddress: event.params.oTokenAddress,
    pairToken_id: tokenId(chainId, event.params.pairToken),
    paymentToken_id: tokenId(chainId, event.params.paymentToken),
  });
});

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "EventEmitterRegistry", event: "DolomiteSettingChanged" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  const id = settingId(chainId, event.srcAddress, event.params.settingId);
  const existing = await context.DolomiteSetting.get(id);
  context.DolomiteSetting.set({
    id,
    dolomite_id: existing?.dolomite_id ?? dolomiteMarginId(chainId, event.srcAddress),
    key: existing?.key ?? event.params.settingId,
    value: event.params.value,
  });
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "UserSettingChanged" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  await createUserIfNecessary(context, chainId, event.params.user);

  const id = settingId(chainId, event.params.user, event.params.settingId);
  const existing = await context.UserSetting.get(id);
  context.UserSetting.set({
    id,
    effectiveUser_id: existing?.effectiveUser_id ?? userId(chainId, event.params.user),
    key: existing?.key ?? event.params.settingId,
    value: event.params.value,
  });
});

indexer.onEvent({ contract: "EventEmitterRegistry", event: "TokenSettingChanged" }, async ({ event, context }) => {
  const chainId = event.chainId;
  if (!requireIsValidEventEmitter(chainId, event.srcAddress)) {
    return;
  }

  const id = settingId(chainId, event.params.token, event.params.settingId);
  const existing = await context.TokenSetting.get(id);
  context.TokenSetting.set({
    id,
    token_id: existing?.token_id ?? tokenId(chainId, event.params.token),
    key: existing?.key ?? event.params.settingId,
    value: event.params.value,
  });
});
