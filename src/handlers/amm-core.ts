import { indexer } from "envio";
import type { BigDecimal, AmmFactory, AmmPair, AmmMint, AmmBurn, AmmTrade, Transaction, Token } from "envio";
import type { Ctx, EventMeta, Mutable } from "./helpers/types";
import { ProtocolType } from "./helpers/types";
import { ZERO_BD, ONE_BI, _18_BI, convertTokenToDecimal } from "./helpers/numbers";
import { ADDRESS_ZERO, getConstants } from "../constants";
import { ammFactoryId, ammPairId, bundleId, transactionId } from "./helpers/ids";
import { getOrCreateTransaction } from "./helpers/transaction";
import { createUserIfNecessary } from "./helpers/user";
import { createLiquidityPosition, createLiquiditySnapshot } from "./helpers/amm";
import { findEthPerToken, getEthPriceInUSD, getTokenOraclePriceUSD, getTrackedLiquidityUSD } from "./helpers/pricing";
import { getAmmPairBalanceOf } from "../effects";

/** subgraph amm-core.isCompleteMint: a mint is complete once its `sender` field is populated. */
async function isCompleteMint(context: Ctx, mintId: string): Promise<boolean> {
  const mint = await context.AmmMint.getOrThrow(mintId);
  return mint.sender !== undefined;
}

/** subgraph amm-core.getAmmEventID: `${txHash}-${allEvents.length}` (chain-prefixed here). */
function getAmmEventID(chainId: number, hash: string, length: number): string {
  return `${transactionId(chainId, hash)}-${length}`;
}

// ---------------------------------------------------------------------------
// Transfer (LP token transfers) — handleERC20Transfer
// ---------------------------------------------------------------------------
indexer.onEvent({ contract: "AmmPair", event: "Transfer" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };

  const from = event.params.from;
  const to = event.params.to;
  const value = convertTokenToDecimal(event.params.value, _18_BI);
  const pairAddress = event.srcAddress;

  // ignore initial transfers for first adds
  if (to === ADDRESS_ZERO && event.params.value === 1000n) {
    return;
  }

  const factoryEntityId = ammFactoryId(chainId, getConstants(chainId).factory);
  const ammFactory: Mutable<AmmFactory> = { ...(await context.AmmFactory.getOrThrow(factoryEntityId)) };

  // user stats
  await createUserIfNecessary(context, chainId, from);
  await createUserIfNecessary(context, chainId, to);

  // get pair
  const pair: Mutable<AmmPair> = { ...(await context.AmmPair.getOrThrow(ammPairId(chainId, pairAddress))) };

  // get or create transaction
  const transaction: Mutable<Transaction> = {
    ...(await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp)),
  };

  // snapshot of mints at the start of the handler (mirrors subgraph local var)
  const mints = transaction.intermittentAmmMints;

  // mints
  if (from === ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    context.AmmPair.set(pair);

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || (await isCompleteMint(context, mints[mints.length - 1]!))) {
      // update factory
      ammFactory.ammMintCount = ammFactory.ammMintCount + ONE_BI;

      const mint: AmmMint = {
        id: getAmmEventID(chainId, meta.txHash, mints.length),
        transaction_id: transaction.id,
        pair_id: pair.id,
        to,
        liquidity: value,
        timestamp: transaction.timestamp,
        serialId: ammFactory.ammMintCount,
        sender: undefined,
        amount0: undefined,
        amount1: undefined,
        logIndex: undefined,
        amountUSD: undefined,
        feeTo: undefined,
        feeLiquidity: undefined,
      };
      context.AmmMint.set(mint);

      // update mints in transaction
      transaction.intermittentAmmMints = mints.concat([mint.id]);

      // save entities
      context.Transaction.set(transaction);
      context.AmmFactory.set(ammFactory);
    }
  }

  // case where direct send first on ETH withdrawals
  if (to === pairAddress) {
    ammFactory.ammBurnCount = ammFactory.ammBurnCount + ONE_BI;
    context.AmmFactory.set(ammFactory);

    const burns = transaction.intermittentAmmBurns;
    const burn: AmmBurn = {
      id: getAmmEventID(chainId, meta.txHash, burns.length),
      transaction_id: transaction.id,
      pair_id: pair.id,
      liquidity: value,
      timestamp: transaction.timestamp,
      to,
      sender: from,
      needsComplete: true,
      serialId: ammFactory.ammBurnCount,
      amount0: undefined,
      amount1: undefined,
      logIndex: undefined,
      amountUSD: undefined,
      feeTo: undefined,
      feeLiquidity: undefined,
    };
    context.AmmBurn.set(burn);

    transaction.intermittentAmmBurns = burns.concat([burn.id]);
    context.Transaction.set(transaction);
  }

  // burn
  if (to === ADDRESS_ZERO && from === pairAddress) {
    pair.totalSupply = pair.totalSupply.minus(value);
    context.AmmPair.set(pair);

    // this is a new instance of a logical burn
    const burns = transaction.intermittentAmmBurns;
    let burn: Mutable<AmmBurn>;
    if (burns.length > 0) {
      const currentBurn = await context.AmmBurn.getOrThrow(burns[burns.length - 1]!);
      if (currentBurn.needsComplete) {
        burn = { ...currentBurn };
      } else {
        ammFactory.ammBurnCount = ammFactory.ammBurnCount + ONE_BI;

        burn = {
          id: getAmmEventID(chainId, meta.txHash, burns.length),
          transaction_id: transaction.id,
          needsComplete: false,
          pair_id: pair.id,
          liquidity: value,
          timestamp: transaction.timestamp,
          serialId: ammFactory.ammBurnCount,
          to: undefined,
          sender: undefined,
          amount0: undefined,
          amount1: undefined,
          logIndex: undefined,
          amountUSD: undefined,
          feeTo: undefined,
          feeLiquidity: undefined,
        };

        // faithfully preserve the subgraph's double-increment quirk here
        ammFactory.ammBurnCount = ammFactory.ammBurnCount + ONE_BI;
        context.AmmFactory.set(ammFactory);
      }
    } else {
      burn = {
        id: getAmmEventID(chainId, meta.txHash, burns.length),
        transaction_id: transaction.id,
        needsComplete: false,
        pair_id: pair.id,
        liquidity: value,
        timestamp: transaction.timestamp,
        serialId: ammFactory.ammBurnCount,
        to: undefined,
        sender: undefined,
        amount0: undefined,
        amount1: undefined,
        logIndex: undefined,
        amountUSD: undefined,
        feeTo: undefined,
        feeLiquidity: undefined,
      };

      ammFactory.ammBurnCount = ammFactory.ammBurnCount + ONE_BI;
      context.AmmFactory.set(ammFactory);
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !(await isCompleteMint(context, mints[mints.length - 1]!))) {
      const mint = await context.AmmMint.getOrThrow(mints[mints.length - 1]!);
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      context.AmmMint.deleteUnsafe(mints[mints.length - 1]!);

      // update the transaction
      transaction.intermittentAmmMints = mints.slice(0, mints.length - 1);
      context.Transaction.set(transaction);
    }
    context.AmmBurn.set(burn);

    if (burn.needsComplete) {
      // if accessing last one, replace it
      transaction.intermittentAmmBurns = burns.slice(0, burns.length - 1).concat([burn.id]);
    } else {
      // else add new one
      transaction.intermittentAmmBurns = burns.concat([burn.id]);
    }
    context.Transaction.set(transaction);
  }

  if (from !== ADDRESS_ZERO && from !== pairAddress) {
    const fromUserLiquidityPosition = await createLiquidityPosition(context, chainId, pairAddress, from);
    const balance = await context.effect(getAmmPairBalanceOf, { chainId, pair: pairAddress, account: from });
    fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(BigInt(balance), _18_BI);
    context.AmmLiquidityPosition.set(fromUserLiquidityPosition);
    await createLiquiditySnapshot(context, chainId, fromUserLiquidityPosition, meta);
  }

  if (to !== ADDRESS_ZERO && to !== pairAddress) {
    const toUserLiquidityPosition = await createLiquidityPosition(context, chainId, pairAddress, to);
    const balance = await context.effect(getAmmPairBalanceOf, { chainId, pair: pairAddress, account: to });
    toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(BigInt(balance), _18_BI);
    context.AmmLiquidityPosition.set(toUserLiquidityPosition);
    await createLiquiditySnapshot(context, chainId, toUserLiquidityPosition, meta);
  }
});

// ---------------------------------------------------------------------------
// Sync (reserves + pricing) — handleSync
// ---------------------------------------------------------------------------
indexer.onEvent({ contract: "AmmPair", event: "Sync" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const pairAddress = event.srcAddress;

  const ammPair: Mutable<AmmPair> = { ...(await context.AmmPair.getOrThrow(ammPairId(chainId, pairAddress))) };
  const token0: Mutable<Token> = { ...(await context.Token.getOrThrow(ammPair.token0_id)) };
  const token1: Mutable<Token> = { ...(await context.Token.getOrThrow(ammPair.token1_id)) };
  const ammFactory: Mutable<AmmFactory> = {
    ...(await context.AmmFactory.getOrThrow(ammFactoryId(chainId, getConstants(chainId).factory))),
  };

  // reset factory liquidity by subtracting only tracked liquidity
  ammFactory.ammLiquidityUSD = ammFactory.ammLiquidityUSD.minus(ammPair.reserveUSD);

  // reset token total liquidity amounts
  token0.ammTradeLiquidity = token0.ammTradeLiquidity.minus(ammPair.reserve0);
  token1.ammTradeLiquidity = token1.ammTradeLiquidity.minus(ammPair.reserve1);

  ammPair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  ammPair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (!ammPair.reserve1.isEqualTo(ZERO_BD)) {
    ammPair.token0Price = ammPair.reserve0.div(ammPair.reserve1);
  } else {
    ammPair.token0Price = ZERO_BD;
  }

  if (!ammPair.reserve0.isEqualTo(ZERO_BD)) {
    ammPair.token1Price = ammPair.reserve1.div(ammPair.reserve0);
  } else {
    ammPair.token1Price = ZERO_BD;
  }

  context.AmmPair.set(ammPair);

  // update ETH price, since reserves could have changed
  const bundle = { ...(await context.Bundle.getOrThrow(bundleId(chainId))) };
  bundle.ethPrice = await getEthPriceInUSD(context, chainId);
  context.Bundle.set(bundle);

  token0.derivedETH = await findEthPerToken(context, chainId, token0);
  context.Token.set(token0);
  token1.derivedETH = await findEthPerToken(context, chainId, token1);
  context.Token.set(token1);

  // get tracked liquidity - if neither token is in whitelist, this will be 0
  let trackedLiquidityETH: BigDecimal;
  if (!bundle.ethPrice.isEqualTo(ZERO_BD)) {
    trackedLiquidityETH = (
      await getTrackedLiquidityUSD(context, chainId, ammPair.reserve0, token0, ammPair.reserve1, token1)
    ).div(bundle.ethPrice);
  } else {
    trackedLiquidityETH = ZERO_BD;
  }

  // use derived amounts within pair
  ammPair.trackedReserveETH = trackedLiquidityETH;
  ammPair.reserveETH = ammPair.reserve0
    .times(token0.derivedETH ?? ZERO_BD)
    .plus(ammPair.reserve1.times(token1.derivedETH ?? ZERO_BD));
  ammPair.reserveUSD = ammPair.reserveETH.times(bundle.ethPrice);

  // use tracked amounts globally
  ammFactory.ammLiquidityUSD = ammFactory.ammLiquidityUSD.plus(ammPair.reserveUSD);

  // now correctly set liquidity amounts for each token
  token0.ammTradeLiquidity = token0.ammTradeLiquidity.plus(ammPair.reserve0);
  token1.ammTradeLiquidity = token1.ammTradeLiquidity.plus(ammPair.reserve1);

  // save entities
  context.AmmPair.set(ammPair);
  context.AmmFactory.set(ammFactory);
  context.Token.set(token0);
  context.Token.set(token1);
});

// ---------------------------------------------------------------------------
// Mint — handleMint
// ---------------------------------------------------------------------------
indexer.onEvent({ contract: "AmmPair", event: "Mint" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
  const pairAddress = event.srcAddress;

  const transaction = await context.Transaction.getOrThrow(transactionId(chainId, meta.txHash));
  const mints = transaction.intermittentAmmMints;
  const mint: Mutable<AmmMint> = { ...(await context.AmmMint.getOrThrow(mints[mints.length - 1]!)) };

  const pair: Mutable<AmmPair> = { ...(await context.AmmPair.getOrThrow(ammPairId(chainId, pairAddress))) };
  const ammFactory: Mutable<AmmFactory> = {
    ...(await context.AmmFactory.getOrThrow(ammFactoryId(chainId, getConstants(chainId).factory))),
  };

  const token0: Mutable<Token> = { ...(await context.Token.getOrThrow(pair.token0_id)) };
  const token1: Mutable<Token> = { ...(await context.Token.getOrThrow(pair.token1_id)) };

  // update exchange info (except balances, sync will cover that)
  const token0Amount = convertTokenToDecimal(event.params.amount0Wei, token0.decimals);
  const token1Amount = convertTokenToDecimal(event.params.amount1Wei, token1.decimals);

  // update txn counts
  token0.transactionCount = token0.transactionCount + ONE_BI;
  token1.transactionCount = token1.transactionCount + ONE_BI;

  // get new amounts of USD and ETH for tracking
  const amountTotalUSD = (await getTokenOraclePriceUSD(context, chainId, token0, meta, ProtocolType.Amm))
    .times(token0Amount)
    .plus((await getTokenOraclePriceUSD(context, chainId, token1, meta, ProtocolType.Amm)).times(token1Amount));

  // update txn counts
  pair.transactionCount = pair.transactionCount + ONE_BI;
  ammFactory.transactionCount = ammFactory.transactionCount + ONE_BI;

  // save entities
  context.Token.set(token0);
  context.Token.set(token1);
  context.AmmPair.set(pair);
  context.AmmFactory.set(ammFactory);

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount;
  mint.amount1 = token1Amount;
  mint.logIndex = meta.logIndex;
  mint.amountUSD = amountTotalUSD;
  context.AmmMint.set(mint);

  // update the LP position
  const liquidityPosition = await createLiquidityPosition(context, chainId, pairAddress, mint.to);
  await createLiquiditySnapshot(context, chainId, liquidityPosition, meta);
});

// ---------------------------------------------------------------------------
// Burn — handleBurn
// ---------------------------------------------------------------------------
indexer.onEvent({ contract: "AmmPair", event: "Burn" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
  const pairAddress = event.srcAddress;

  const transaction = await context.Transaction.get(transactionId(chainId, meta.txHash));

  // safety check
  if (transaction === undefined) {
    return;
  }

  const burns = transaction.intermittentAmmBurns;
  const burn: Mutable<AmmBurn> = { ...(await context.AmmBurn.getOrThrow(burns[burns.length - 1]!)) };

  const ammPair: Mutable<AmmPair> = { ...(await context.AmmPair.getOrThrow(ammPairId(chainId, pairAddress))) };
  const ammFactory: Mutable<AmmFactory> = {
    ...(await context.AmmFactory.getOrThrow(ammFactoryId(chainId, getConstants(chainId).factory))),
  };

  // update token info
  const token0: Mutable<Token> = { ...(await context.Token.getOrThrow(ammPair.token0_id)) };
  const token1: Mutable<Token> = { ...(await context.Token.getOrThrow(ammPair.token1_id)) };
  const token0Amount = convertTokenToDecimal(event.params.amount0Wei, token0.decimals);
  const token1Amount = convertTokenToDecimal(event.params.amount1Wei, token1.decimals);

  // update txn counts
  token0.transactionCount = token0.transactionCount + ONE_BI;
  token1.transactionCount = token1.transactionCount + ONE_BI;

  // get new amounts of USD and ETH for tracking
  const amountTotalUSD = (await getTokenOraclePriceUSD(context, chainId, token0, meta, ProtocolType.Amm))
    .times(token0Amount)
    .plus((await getTokenOraclePriceUSD(context, chainId, token1, meta, ProtocolType.Amm)).times(token1Amount));

  // update txn counts
  ammFactory.transactionCount = ammFactory.transactionCount + ONE_BI;
  ammPair.transactionCount = ammPair.transactionCount + ONE_BI;

  // update global counter and save
  context.Token.set(token0);
  context.Token.set(token1);
  context.AmmPair.set(ammPair);
  context.AmmFactory.set(ammFactory);

  // update burn
  burn.amount0 = token0Amount;
  burn.amount1 = token1Amount;
  burn.logIndex = meta.logIndex;
  burn.amountUSD = amountTotalUSD;
  context.AmmBurn.set(burn);

  // update the LP position
  const liquidityPosition = await createLiquidityPosition(context, chainId, pairAddress, burn.sender!);
  await createLiquiditySnapshot(context, chainId, liquidityPosition, meta);
});

// ---------------------------------------------------------------------------
// Swap — handleSwap
// ---------------------------------------------------------------------------
indexer.onEvent({ contract: "AmmPair", event: "Swap" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const meta: EventMeta = {
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: BigInt(event.logIndex),
  };
  const pairAddress = event.srcAddress;

  const pair: Mutable<AmmPair> = { ...(await context.AmmPair.getOrThrow(ammPairId(chainId, pairAddress))) };
  const token0: Mutable<Token> = { ...(await context.Token.getOrThrow(pair.token0_id)) };
  const token1: Mutable<Token> = { ...(await context.Token.getOrThrow(pair.token1_id)) };
  const amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals);
  const amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals);
  const amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals);
  const amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals);

  // totals for volume updates
  const amount0Total = amount0Out.plus(amount0In);
  const amount1Total = amount1Out.plus(amount1In);

  const token0PriceUSD = await getTokenOraclePriceUSD(context, chainId, token0, meta, ProtocolType.Amm);
  const token1PriceUSD = await getTokenOraclePriceUSD(context, chainId, token1, meta, ProtocolType.Amm);

  // update txn counts
  token0.transactionCount = token0.transactionCount + ONE_BI;
  token1.transactionCount = token1.transactionCount + ONE_BI;

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  const volumeUSD = amount0In.times(token0PriceUSD).plus(amount1In.times(token1PriceUSD));
  pair.volumeUSD = pair.volumeUSD.plus(volumeUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.transactionCount = pair.transactionCount + ONE_BI;
  context.AmmPair.set(pair);

  // update global values, only used tracked amounts for volume
  const ammFactory: Mutable<AmmFactory> = {
    ...(await context.AmmFactory.getOrThrow(ammFactoryId(chainId, getConstants(chainId).factory))),
  };
  ammFactory.totalAmmVolumeUSD = ammFactory.totalAmmVolumeUSD.plus(volumeUSD);
  ammFactory.transactionCount = ammFactory.transactionCount + ONE_BI;
  ammFactory.ammTradeCount = ammFactory.ammTradeCount + ONE_BI;

  // save entities
  context.AmmPair.set(pair);
  context.Token.set(token0);
  context.Token.set(token1);
  context.AmmFactory.set(ammFactory);

  const transaction: Mutable<Transaction> = {
    ...(await getOrCreateTransaction(context, chainId, meta.txHash, meta.blockNumber, meta.timestamp)),
  };
  const ammTrade: AmmTrade = {
    id: getAmmEventID(chainId, meta.txHash, transaction.intermittentAmmTrades.length),
    transaction_id: transaction.id,
    pair_id: pair.id,
    timestamp: transaction.timestamp,
    sender: event.params.sender,
    amount0In,
    amount1In,
    amount0Out,
    amount1Out,
    to: event.params.to,
    from: event.transaction.from ?? "0x0000000000000000000000000000000000000000",
    logIndex: meta.logIndex,
    serialId: ammFactory.ammTradeCount,
    // use the tracked amount if we have it
    amountUSD: volumeUSD,
  };
  context.AmmTrade.set(ammTrade);

  // update the transaction
  transaction.intermittentAmmTrades = transaction.intermittentAmmTrades.concat([ammTrade.id]);
  context.Transaction.set(transaction);
});
