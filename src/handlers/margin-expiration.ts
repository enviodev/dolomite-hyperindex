import { indexer } from "envio";
import type { EventMeta } from "./helpers/types";
import { ProtocolType, MarginPositionStatus } from "./helpers/types";
import { ZERO_BD, ZERO_BI } from "./helpers/numbers";
import { reverseLookupId, borrowPositionAmountId } from "./helpers/ids";
import {
  getOrCreateMarginAccount,
  getOrCreateMarginPosition,
  getOrCreateTokenValue,
  getOrCreateDolomiteMarginForCall,
  deleteTokenValueIfNecessary,
} from "./helpers/margin";

indexer.onEvent({ contract: "DolomiteMarginExpiry", event: "ExpirySet" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };

  context.log.info(`Handling expiration set for hash and index: ${meta.txHash}-${event.logIndex}`);

  const reverseLookup = await context.TokenMarketIdReverseLookup.getOrThrow(
    reverseLookupId(chainId, event.params.marketId)
  );
  const token = await context.Token.getOrThrow(reverseLookup.token_id);

  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    event.params.owner,
    event.params.number,
    meta
  );

  if (event.params.time === ZERO_BI) {
    // remove the market ID
    const index = marginAccount.expirationTokens.indexOf(token.id);
    if (index !== -1) {
      const copy = [...marginAccount.expirationTokens];
      copy.splice(index, 1);
      marginAccount.expirationTokens = copy;
    }
    marginAccount.hasExpiration = marginAccount.expirationTokens.length > 0;
  } else {
    // add the market ID, if necessary
    const index = marginAccount.expirationTokens.indexOf(token.id);
    if (index === -1) {
      marginAccount.expirationTokens = [...marginAccount.expirationTokens, token.id];
    }
    marginAccount.hasExpiration = true;
  }
  context.MarginAccount.set(marginAccount);

  const marginPosition = await getOrCreateMarginPosition(context, chainId, meta, marginAccount);
  if (!marginPosition.marginDeposit.isEqualTo(ZERO_BD) && marginPosition.status === MarginPositionStatus.Open) {
    if (event.params.time === ZERO_BI) {
      const expirationTimestamp = marginPosition.expirationTimestamp;
      if (expirationTimestamp === undefined || expirationTimestamp >= meta.timestamp) {
        // if the position is not expired, follow through with changing the expiration. Why? Because this event is
        // emitted *before* LogTrade if the account is expired in its entirety. So, the expiration needs to stay intact
        // for the data's sake
        marginPosition.expirationTimestamp = undefined;
      }
    } else {
      marginPosition.expirationTimestamp = event.params.time;
    }
    context.MarginPosition.set(marginPosition);
  }

  const tokenValue = await getOrCreateTokenValue(context, marginAccount, token);
  tokenValue.expirationTimestamp = event.params.time > ZERO_BI ? event.params.time : undefined;
  tokenValue.expiryAddress = event.params.time > ZERO_BI ? event.srcAddress : undefined;
  if (!deleteTokenValueIfNecessary(context, tokenValue)) {
    context.MarginAccountTokenValue.set(tokenValue);
  }

  // token.id is namespaced (`${chainId}-${addr}`); the id builder needs the raw address so the
  // result matches getOrCreateBorrowPositionAmount's `${marginAccount.id}-${rawTokenAddr}` scheme.
  const rawTokenAddress = token.id.substring(token.id.indexOf("-") + 1);
  const id = borrowPositionAmountId(chainId, event.params.owner, event.params.number, rawTokenAddress);
  const borrowPositionAmount = await context.BorrowPositionAmount.get(id);
  if (borrowPositionAmount !== undefined) {
    const next = { ...borrowPositionAmount };
    if (event.params.time === ZERO_BI) {
      // NOTE: subgraph reads marginPosition.expirationTimestamp here (not borrowPositionAmount's) — preserved.
      const expirationTimestamp = marginPosition.expirationTimestamp;
      if (expirationTimestamp === undefined || expirationTimestamp >= meta.timestamp) {
        // if the position is not expired, follow through with changing the expiration. Why? Because this event is
        // emitted *before* LogTrade if the account is expired in its entirety. So, the expiration needs to stay intact
        // for the data's sake
        next.expirationTimestamp = undefined;
      }
    } else {
      next.expirationTimestamp = event.params.time;
    }
    context.BorrowPositionAmount.set(next);
  }
});

indexer.onEvent(
  { contract: "DolomiteMarginExpiry", event: "LogExpiryRampTimeSet" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const meta: EventMeta = {
      blockNumber: BigInt(event.block.number),
      blockHash: event.block.hash,
      timestamp: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
      logIndex: BigInt(event.logIndex),
    };

    context.log.info(
      `Handling expiration ramp time set for hash and index: ${meta.txHash}-${event.logIndex}`
    );

    const dolomiteMargin = await getOrCreateDolomiteMarginForCall(context, chainId, meta, false, ProtocolType.Expiry);
    dolomiteMargin.expiryRampTime = event.params.expiryRampTime;
    context.DolomiteMargin.set(dolomiteMargin);
  }
);
