import { indexer } from "envio";
import type { AmmFactory, AmmPair } from "envio";
import type { Mutable } from "./helpers/types";
import { ZERO_BD, ZERO_BI } from "./helpers/numbers";
import { ammFactoryId, ammPairId, bundleId, tokenId, ammPairLookupId } from "./helpers/ids";
import { getConstants } from "../constants";

/**
 * Ported from amm-factory.handleNewPair. Creates the AmmPair + its two AmmPairReverseLookup
 * entries and bumps AmmFactory.pairCount (creating AmmFactory + Bundle on first pair).
 */
indexer.onEvent({ contract: "DolomiteAmmFactory", event: "PairCreated" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const factoryAddress = getConstants(chainId).factory;

  if (event.srcAddress.toLowerCase() !== factoryAddress.toLowerCase()) {
    context.log.error(`Invalid Factory address, found ${event.srcAddress} and ${factoryAddress}`);
    return;
  }

  const factoryEntityId = ammFactoryId(chainId, factoryAddress);

  // load factory (create if first exchange)
  const existingFactory = await context.AmmFactory.get(factoryEntityId);
  let factory: Mutable<AmmFactory>;
  if (existingFactory === undefined) {
    factory = {
      id: factoryEntityId,
      pairCount: 0,
      totalAmmVolumeUSD: ZERO_BD,
      ammLiquidityUSD: ZERO_BD,
      transactionCount: ZERO_BI,
      ammTradeCount: ZERO_BI,
      ammMintCount: ZERO_BI,
      ammBurnCount: ZERO_BI,
    };

    // create new bundle
    context.Bundle.set({ id: bundleId(chainId), ethPrice: ZERO_BD });
  } else {
    factory = { ...existingFactory };
  }
  factory.pairCount += 1;
  context.AmmFactory.set(factory);

  const token0Address = event.params.token0;
  const token1Address = event.params.token1;
  const pairAddress = event.params.pair;

  // load the tokens (assumed to exist; subgraph cast with `as Token`)
  const token0 = await context.Token.getOrThrow(tokenId(chainId, token0Address));
  const token1 = await context.Token.getOrThrow(tokenId(chainId, token1Address));

  const pairEntityId = ammPairId(chainId, pairAddress);
  const pair: Mutable<AmmPair> = {
    id: pairEntityId,
    token0_id: token0.id,
    token1_id: token1.id,
    liquidityProviderCount: ZERO_BI,
    createdAtTimestamp: BigInt(event.block.timestamp),
    createdAtBlockNumber: BigInt(event.block.number),
    transactionCount: ZERO_BI,
    reserve0: ZERO_BD,
    reserve1: ZERO_BD,
    trackedReserveETH: ZERO_BD,
    reserveETH: ZERO_BD,
    reserveUSD: ZERO_BD,
    totalSupply: ZERO_BD,
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    token0Price: ZERO_BD,
    token1Price: ZERO_BD,
  };

  // NOTE: reverse-lookup ids use ammPairLookupId (`${chainId}-${addr0}-${addr1}`) so the
  // pricing helper's findEthPerToken lookups resolve. (Subgraph used `${token0.id}-${token1.id}`.)
  context.AmmPairReverseLookup.set({
    id: ammPairLookupId(chainId, token0Address, token1Address),
    pair_id: pair.id,
  });
  context.AmmPairReverseLookup.set({
    id: ammPairLookupId(chainId, token1Address, token0Address),
    pair_id: pair.id,
  });

  context.AmmPair.set(pair);
});

// Register the newly-created pair as a dynamic AmmPair contract.
indexer.contractRegister({ contract: "DolomiteAmmFactory", event: "PairCreated" }, async ({ event, context }) => {
  context.chain.AmmPair.add(event.params.pair);
});
