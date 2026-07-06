// Entity id builders. Every id is namespaced with `${chainId}-` (single multichain
// indexer; addresses repeat across chains). Addresses arrive lowercased.
// These mirror the subgraph's id-generation patterns, prefixed with the chain id.

const lc = (s: string) => s.toLowerCase();

export const tokenId = (chainId: number, address: string) => `${chainId}-${lc(address)}`;
export const userId = (chainId: number, address: string) => `${chainId}-${lc(address)}`;
export const dolomiteMarginId = (chainId: number, address: string) => `${chainId}-${lc(address)}`;
export const ammFactoryId = (chainId: number, address: string) => `${chainId}-${lc(address)}`;
export const ammPairId = (chainId: number, address: string) => `${chainId}-${lc(address)}`;
export const bundleId = (chainId: number) => `${chainId}-1`;

export const reverseLookupId = (chainId: number, marketId: bigint) => `${chainId}-${marketId.toString()}`;
export const isolationVaultLookupId = (chainId: number, vault: string) => `${chainId}-${lc(vault)}`;
export const ammPairLookupId = (chainId: number, token0: string, token1: string) =>
  `${chainId}-${lc(token0)}-${lc(token1)}`;

export const oraclePriceId = (chainId: number, tokenAddress: string) => `${chainId}-${lc(tokenAddress)}`;
export const interestIndexId = (chainId: number, tokenAddress: string) => `${chainId}-${lc(tokenAddress)}`;
export const interestRateId = (chainId: number, tokenAddress: string) => `${chainId}-${lc(tokenAddress)}`;
export const marketRiskInfoId = (chainId: number, tokenAddress: string) => `${chainId}-${lc(tokenAddress)}`;
export const totalParId = (chainId: number, tokenAddress: string) => `${chainId}-${lc(tokenAddress)}`;
// InterestIndexSnapshot: subgraph uses `${tokenId}-${lastUpdate}` where tokenId already
// carries the chain prefix here.
export const interestIndexSnapshotId = (tokenEntityId: string, lastUpdate: bigint) =>
  `${tokenEntityId}-${lastUpdate.toString()}`;

export const marginAccountId = (chainId: number, owner: string, accountNumber: bigint) =>
  `${chainId}-${lc(owner)}-${accountNumber.toString()}`;
// subgraph: `${marginAccount.user}-${accountNumber}-${marketId}` — user id already carries chain prefix.
export const marginAccountTokenValueId = (userEntityId: string, accountNumber: bigint, marketId: bigint) =>
  `${userEntityId}-${accountNumber.toString()}-${marketId.toString()}`;
export const userParValueId = (userEntityId: string, tokenEntityId: string) =>
  `${userEntityId}-${tokenEntityId}`;

export const transactionId = (chainId: number, hash: string) => `${chainId}-${lc(hash)}`;
// Deposits/Withdrawals/Trades/etc: `${transactionHash}-${logIndex}` (chain-prefixed).
export const eventId = (chainId: number, hash: string, logIndex: bigint | number) =>
  `${chainId}-${lc(hash)}-${logIndex.toString()}`;
export const serialEventId = (chainId: number, hash: string, serialId: bigint) =>
  `${chainId}-${lc(hash)}-${serialId.toString()}`;

export const ammLiquidityPositionId = (chainId: number, pair: string, user: string) =>
  `${chainId}-${lc(pair)}-${lc(user)}`;

export const marginPositionId = marginAccountId;
export const borrowPositionId = marginAccountId;
export const strategyPositionId = marginAccountId;
export const borrowPositionAmountId = (chainId: number, owner: string, accountNumber: bigint, token: string) =>
  `${chainId}-${lc(owner)}-${accountNumber.toString()}-${lc(token)}`;

export const liquidityMiningVesterId = (chainId: number, vester: string) => `${chainId}-${lc(vester)}`;
export const liquidityMiningVestingPositionId = (chainId: number, vester: string, nftId: bigint) =>
  `${chainId}-${lc(vester)}-${nftId.toString()}`;
export const liquidityMiningClaimId = (chainId: number, distributor: string, user: string, epoch: number | bigint) =>
  `${chainId}-${lc(distributor)}-${lc(user)}-${epoch.toString()}`;
export const liquidityMiningSeasonId = (chainId: number, distributor: string, user: string, season: number | bigint) =>
  `${chainId}-${lc(distributor)}-${lc(user)}-${season.toString()}`;
export const liquidityMiningLevelRequestId = (chainId: number, requestId: bigint) =>
  `${chainId}-${requestId.toString()}`;

// AsyncDeposit / AsyncWithdrawal: `${tokenAddress}-${key}` (chain-prefixed).
export const asyncKeyId = (chainId: number, token: string, key: string) =>
  `${chainId}-${lc(token)}-${lc(key)}`;

export const settingId = (chainId: number, scope: string, settingsHash: string) =>
  `${chainId}-${lc(scope)}-${lc(settingsHash)}`;
export const mostRecentTradeId = (chainId: number, tokenAddress: string) => `${chainId}-${lc(tokenAddress)}`;
export const zapTraderParamId = (zapEntityId: string, index: number | bigint) => `${zapEntityId}-${index.toString()}`;
