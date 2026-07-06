import { indexer } from "envio";
import type { BorrowPosition, DolomiteMargin, StrategyPosition, User } from "envio";

import { getConstants } from "../constants";
import { borrowPositionId, dolomiteMarginId, userId } from "./helpers/ids";
import { getOrCreateMarginAccount } from "./helpers/margin";
import { getEffectiveUserForUserId } from "./helpers/isolation";
import { getOrCreateTransaction } from "./helpers/transaction";
import { isStrategy, parseStrategy } from "./helpers/borrow-position";
import { BorrowPositionStatus, type Mutable } from "./helpers/types";
import { ONE_BI } from "./helpers/numbers";

// subgraph _100_BI: borrow positions live in accountNumbers >= 100.
const _100_BI = 100n;

indexer.onEvent(
  { contract: "BorrowPositionProxy", event: "BorrowPositionOpen" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const meta = {
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      timestamp: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
    };

    const constants = getConstants(chainId);
    const srcAddress = event.srcAddress.toLowerCase();
    const isContractUnknown =
      !constants.borrowProxies.includes(srcAddress) && srcAddress !== constants.eventEmitter;
    if (isContractUnknown) {
      context.log.warn(
        "handleOpenBorrowPosition: event address does not match BorrowPositionProxy or EventEmitterRegistry address",
      );
      return;
    }

    const accountOwner = event.params.accountOwner;
    const accountIndex = event.params.accountIndex;

    if (accountIndex < _100_BI) {
      context.log.warn(
        "handleOpenBorrowPosition: attempted to open a borrow position within a Dolomite Balance",
      );
      return;
    }

    const id = borrowPositionId(chainId, accountOwner, accountIndex);
    const existing = await context.BorrowPosition.get(id);
    if (existing !== undefined) {
      return;
    }

    const marginAccount = await getOrCreateMarginAccount(
      context,
      chainId,
      accountOwner,
      accountIndex,
      meta,
    );
    context.MarginAccount.set(marginAccount);

    const uid = userId(chainId, accountOwner);
    const user: Mutable<User> = { ...(await context.User.getOrThrow(uid)) };
    user.totalBorrowPositionCount = user.totalBorrowPositionCount + ONE_BI;
    context.User.set(user);
    if (user.effectiveUser_id !== user.id) {
      const effectiveUserMut = { ...(await context.User.getOrThrow(user.effectiveUser_id)) };
      effectiveUserMut.totalBorrowPositionCount = effectiveUserMut.totalBorrowPositionCount + ONE_BI;
      context.User.set(effectiveUserMut);
    }

    const effectiveUser = await getEffectiveUserForUserId(context, marginAccount.user_id);
    const openTransaction = await getOrCreateTransaction(
      context,
      chainId,
      meta.txHash,
      meta.blockNumber,
      meta.timestamp,
    );

    const borrowPosition: Mutable<BorrowPosition> = {
      id,
      effectiveUser_id: effectiveUser.id,
      marginAccount_id: marginAccount.id,
      openTimestamp: meta.timestamp,
      closeTimestamp: undefined,
      status: BorrowPositionStatus.Open,
      openTransaction_id: openTransaction.id,
      closeTransaction_id: undefined,
      strategy_id: undefined,
      amounts: [],
      allTokens: [],
      supplyTokens: [],
      borrowTokens: [],
      effectiveSupplyTokens: [],
      effectiveBorrowTokens: [],
    };

    if (isStrategy(marginAccount)) {
      const strategyObject = parseStrategy(marginAccount);

      const strategy: StrategyPosition = {
        id: borrowPosition.id,
        effectiveUser_id: borrowPosition.effectiveUser_id,
        marginAccount_id: marginAccount.id,
        strategyId: strategyObject.strategyId,
        positionId: strategyObject.positionId,
      };
      context.StrategyPosition.set(strategy);

      borrowPosition.strategy_id = strategy.id;
    }
    // Save once we set the strategy
    context.BorrowPosition.set(borrowPosition);

    const dolomiteMargin: Mutable<DolomiteMargin> = {
      ...(await context.DolomiteMargin.getOrThrow(dolomiteMarginId(chainId, constants.dolomiteMargin))),
    };
    dolomiteMargin.borrowPositionCount = dolomiteMargin.borrowPositionCount + ONE_BI;
    context.DolomiteMargin.set(dolomiteMargin);
  },
);
