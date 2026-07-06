import type { BorrowPosition, BorrowPositionAmount, MarginAccount, Token } from "envio";
import { type Ctx, type EventMeta, type Mutable, type BalanceUpdate, BorrowPositionStatus } from "./types";
import { ZERO_BD } from "./numbers";
import { getOrCreateTokenValue } from "./margin";
import { getOrCreateTransaction } from "./transaction";

// Strategy thresholds (ported from constants.template.ts).
const STRATEGY_LOWER_ACCOUNT_ID = 1_000_000_000n;
const STRATEGY_UPPER_ACCOUNT_ID = 10_000_000_000n;
const STRATEGY_POSITION_ID_THRESHOLD = 1_000_000n;
const STRATEGY_ID_THRESHOLD = 1_000n;

function rawAddress(entityId: string): string {
  const idx = entityId.indexOf("-");
  return idx === -1 ? entityId : entityId.substring(idx + 1);
}

/** subgraph BorrowPositionStatus.isClosed */
export function isBorrowPositionClosed(position: BorrowPosition): boolean {
  return position.status !== BorrowPositionStatus.Open;
}

async function getOrCreateBorrowPositionAmount(
  context: Ctx,
  marginAccount: MarginAccount,
  token: Token
): Promise<Mutable<BorrowPositionAmount>> {
  // subgraph id: `${owner}-${accountNumber}-${token.id}` → `${marginAccount.id}-${rawTokenAddr}`
  const id = `${marginAccount.id}-${rawAddress(token.id)}`;
  const existing = await context.BorrowPositionAmount.get(id);
  if (existing !== undefined) {
    return { ...existing };
  }
  return {
    id,
    token_id: token.id,
    amountWei: ZERO_BD,
    amountPar: ZERO_BD,
    expirationTimestamp: undefined,
  };
}

/** Returns whether the position's token lists changed. Persists the BorrowPositionAmount. */
async function updateBorrowAndSupplyTokens(
  context: Ctx,
  borrowPosition: Mutable<BorrowPosition>,
  marginAccount: MarginAccount,
  balanceUpdate: BalanceUpdate
): Promise<boolean> {
  const tokenValue = await getOrCreateTokenValue(context, marginAccount, balanceUpdate.token);
  let updated = false;
  const borrowPositionAmount = await getOrCreateBorrowPositionAmount(context, marginAccount, balanceUpdate.token);
  const tokenIdStr = borrowPositionAmount.token_id;

  const removeFrom = (arr: readonly string[], value: string): readonly string[] => {
    const index = arr.indexOf(value);
    if (index !== -1) {
      const copy = [...arr];
      copy.splice(index, 1);
      updated = true;
      return copy;
    }
    return arr;
  };

  if (!borrowPositionAmount.amountPar.isEqualTo(ZERO_BD) && balanceUpdate.valuePar.isEqualTo(ZERO_BD)) {
    // going from having a balance to not having one — remove from lists
    borrowPosition.amounts = removeFrom(borrowPosition.amounts, borrowPositionAmount.id);
    borrowPosition.allTokens = removeFrom(borrowPosition.allTokens, tokenIdStr);
    if (borrowPositionAmount.amountPar.gt(ZERO_BD)) {
      borrowPosition.supplyTokens = removeFrom(borrowPosition.supplyTokens, tokenIdStr);
    } else {
      borrowPosition.borrowTokens = removeFrom(borrowPosition.borrowTokens, tokenIdStr);
    }
  } else if (borrowPositionAmount.amountPar.isEqualTo(ZERO_BD) && !balanceUpdate.valuePar.isEqualTo(ZERO_BD)) {
    // going from not having a balance to having one — add to lists
    borrowPosition.amounts = [...borrowPosition.amounts, borrowPositionAmount.id];
    borrowPosition.allTokens = [...borrowPosition.allTokens, tokenIdStr];
    if (balanceUpdate.valuePar.gt(ZERO_BD)) {
      borrowPosition.supplyTokens = [...borrowPosition.supplyTokens, tokenIdStr];
      if (borrowPosition.effectiveSupplyTokens.indexOf(tokenIdStr) === -1) {
        borrowPosition.effectiveSupplyTokens = [...borrowPosition.effectiveSupplyTokens, tokenIdStr];
      }
    } else {
      borrowPosition.borrowTokens = [...borrowPosition.borrowTokens, tokenIdStr];
      if (borrowPosition.effectiveBorrowTokens.indexOf(tokenIdStr) === -1) {
        borrowPosition.effectiveBorrowTokens = [...borrowPosition.effectiveBorrowTokens, tokenIdStr];
      }
    }
    updated = true;
  }

  borrowPositionAmount.amountPar = tokenValue.valuePar;
  borrowPositionAmount.amountWei = borrowPositionAmount.amountWei.plus(balanceUpdate.deltaWei);
  context.BorrowPositionAmount.set(borrowPositionAmount);

  return updated;
}

function isAmountsEmpty(borrowPosition: BorrowPosition): boolean {
  return borrowPosition.amounts.length === 0;
}

/** Ported from borrow-position-helpers.updateBorrowPositionForBalanceUpdate. */
export async function updateBorrowPositionForBalanceUpdate(
  context: Ctx,
  chainId: number,
  marginAccount: MarginAccount,
  balanceUpdate: BalanceUpdate,
  meta: EventMeta
): Promise<void> {
  const existing = await context.BorrowPosition.get(marginAccount.id);
  if (existing === undefined) {
    return;
  }
  const position: Mutable<BorrowPosition> = { ...existing };
  const isPositionEmptyBefore = isAmountsEmpty(position);
  await updateBorrowAndSupplyTokens(context, position, marginAccount, balanceUpdate);

  if (isAmountsEmpty(position) && position.status !== BorrowPositionStatus.Closed) {
    position.status = BorrowPositionStatus.Closed;
    position.closeTimestamp = meta.timestamp;
    const tx = await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp);
    position.closeTransaction_id = tx.id;
  } else if (isPositionEmptyBefore && !isAmountsEmpty(position)) {
    // the user reopened the position
    position.status = BorrowPositionStatus.Open;
    position.closeTimestamp = undefined;
    position.closeTransaction_id = undefined;
  }
  context.BorrowPosition.set(position);
}

/** Ported from borrow-position-helpers.updateBorrowPositionForLiquidation (no-op, kept for parity). */
export async function updateBorrowPositionForLiquidation(
  context: Ctx,
  marginAccount: MarginAccount
): Promise<void> {
  await context.BorrowPosition.get(marginAccount.id);
  // The borrow/supply tokens are updated in updateBorrowPositionForBalanceUpdate. Do nothing.
}

export function isStrategy(marginAccount: MarginAccount): boolean {
  return (
    marginAccount.accountNumber >= STRATEGY_LOWER_ACCOUNT_ID &&
    marginAccount.accountNumber <= STRATEGY_UPPER_ACCOUNT_ID
  );
}

export type ParsedStrategy = { strategyId: bigint; positionId: bigint };

export function parseStrategy(marginAccount: MarginAccount): ParsedStrategy {
  const fullPositionId = marginAccount.accountNumber;
  const positionId = fullPositionId % STRATEGY_POSITION_ID_THRESHOLD;
  const remainingValue = (fullPositionId - positionId) / STRATEGY_POSITION_ID_THRESHOLD;
  const strategyId = remainingValue - STRATEGY_ID_THRESHOLD;
  return { strategyId, positionId };
}
