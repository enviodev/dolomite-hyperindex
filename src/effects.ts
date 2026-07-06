import { S, createEffect } from "envio";
import { createPublicClient, http, type PublicClient } from "viem";

/**
 * All on-chain reads the subgraph did via contract binds, reimplemented as Envio
 * Effects (deduped + cached, run only in the preload pass). One viem client per chain.
 */

const RPC_URLS: Record<number, string | undefined> = {
  1: process.env.ENVIO_RPC_URL_1,
  42161: process.env.ENVIO_RPC_URL_42161,
  8453: process.env.ENVIO_RPC_URL_8453,
  80094: process.env.ENVIO_RPC_URL_80094,
  56: process.env.ENVIO_RPC_URL_56,
  5000: process.env.ENVIO_RPC_URL_5000,
  1101: process.env.ENVIO_RPC_URL_1101,
  196: process.env.ENVIO_RPC_URL_196,
};

const clients: Record<number, PublicClient> = {};

function getClient(chainId: number): PublicClient {
  const cached = clients[chainId];
  if (cached) return cached;
  const url = RPC_URLS[chainId];
  if (!url) throw new Error(`No RPC url configured for chain ${chainId} (set ENVIO_RPC_URL_${chainId}).`);
  const client = createPublicClient({ transport: http(url) });
  clients[chainId] = client;
  return client;
}

const addr = (a: string) => a.toLowerCase() as `0x${string}`;
const decimalTuple = { type: "tuple", components: [{ name: "value", type: "uint256" }] } as const;

const erc20Abi = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const marginAbi = [
  { name: "getNumMarkets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getMarginRatio", type: "function", stateMutability: "view", inputs: [], outputs: [decimalTuple] },
  { name: "getLiquidationSpread", type: "function", stateMutability: "view", inputs: [], outputs: [decimalTuple] },
  { name: "getEarningsRate", type: "function", stateMutability: "view", inputs: [], outputs: [decimalTuple] },
  { name: "getMinBorrowedValue", type: "function", stateMutability: "view", inputs: [], outputs: [decimalTuple] },
  {
    name: "getAccountMaxNumberOfMarketsWithBalances",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "getMarketPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [decimalTuple],
  },
] as const;

const expiryAbi = [
  { name: "g_expiryRampTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const modularInterestAbi = [
  { name: "getOptimalUtilizationByToken", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getLowerOptimalPercentByToken", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getUpperOptimalPercentByToken", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const linearInterestAbi = [
  { name: "OPTIMAL_UTILIZATION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "LOWER_OPTIMAL_PERCENT", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "UPPER_OPTIMAL_PERCENT", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// ---- Token metadata (symbol/name/decimals) with DGD/AAVE overrides ----
export const getTokenMetadata = createEffect(
  {
    name: "getTokenMetadata",
    input: { chainId: S.number, address: S.string },
    output: { name: S.string, symbol: S.string, decimals: S.number },
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const a = addr(input.address);
    const DGD = "0xe0b7927c4af23765cb51314a0e0521a9645f0e2a";
    const AAVE = "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9";
    if (a === DGD) return { name: "DGD", symbol: "DGD", decimals: await readDecimals(input.chainId, a) };
    if (a === AAVE) return { name: "Aave Token", symbol: "AAVE", decimals: 18 };
    const client = getClient(input.chainId);
    const args = { address: a, abi: erc20Abi } as const;
    let symbol = "unknown";
    let name = "unknown";
    try { symbol = (await client.readContract({ ...args, functionName: "symbol" })) as string; } catch { /* keep */ }
    try { name = (await client.readContract({ ...args, functionName: "name" })) as string; } catch { /* keep */ }
    return { name, symbol, decimals: await readDecimals(input.chainId, a) };
  }
);

/**
 * Direct (non-Effect) token name read for use inside `contractRegister` handlers,
 * whose context has no `context.effect`. Async RPC is allowed there.
 */
export async function fetchTokenNameForRegistration(chainId: number, address: string): Promise<string> {
  try {
    return (await getClient(chainId).readContract({ address: addr(address), abi: erc20Abi, functionName: "name" })) as string;
  } catch {
    return "";
  }
}

async function readDecimals(chainId: number, a: `0x${string}`): Promise<number> {
  try {
    const d = (await getClient(chainId).readContract({ address: a, abi: erc20Abi, functionName: "decimals" })) as number;
    return Number(d);
  } catch {
    return 0;
  }
}

// ---- DolomiteMargin.getMarketPrice(marketId) -> raw price (string) ----
export const getMarketPrice = createEffect(
  {
    name: "getMarketPrice",
    input: { chainId: S.number, marginAddress: S.string, marketId: S.bigint },
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const res = (await getClient(input.chainId).readContract({
      address: addr(input.marginAddress),
      abi: marginAbi,
      functionName: "getMarketPrice",
      args: [input.marketId],
    })) as { value: bigint };
    return res.value.toString();
  }
);

// ---- DolomiteMargin.getNumMarkets() ----
export const getNumMarkets = createEffect(
  {
    name: "getNumMarkets",
    input: { chainId: S.number, marginAddress: S.string },
    output: S.number,
    cache: false,
    rateLimit: false,
  },
  async ({ input }) => {
    const n = (await getClient(input.chainId).readContract({
      address: addr(input.marginAddress),
      abi: marginAbi,
      functionName: "getNumMarkets",
    })) as bigint;
    return Number(n);
  }
);

// ---- Risk params (read once when the DolomiteMargin singleton is created) ----
export const getRiskParams = createEffect(
  {
    name: "getRiskParams",
    input: { chainId: S.number, marginAddress: S.string },
    output: {
      marginRatio: S.string,
      liquidationSpread: S.string,
      earningsRate: S.string,
      minBorrowedValue: S.string,
      accountMaxNumberOfMarketsWithBalances: S.string,
    },
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const a = addr(input.marginAddress);
    const readValue = async (functionName: "getMarginRatio" | "getLiquidationSpread" | "getEarningsRate" | "getMinBorrowedValue") => {
      const res = (await client.readContract({ address: a, abi: marginAbi, functionName })) as { value: bigint };
      return res.value.toString();
    };
    let accountMax = "0";
    try {
      const m = (await client.readContract({ address: a, abi: marginAbi, functionName: "getAccountMaxNumberOfMarketsWithBalances" })) as bigint;
      accountMax = m.toString();
    } catch { /* not present on some chains */ }
    const [marginRatio, liquidationSpread, earningsRate, minBorrowedValue] = await Promise.all([
      readValue("getMarginRatio"),
      readValue("getLiquidationSpread"),
      readValue("getEarningsRate"),
      readValue("getMinBorrowedValue"),
    ]);
    return { marginRatio, liquidationSpread, earningsRate, minBorrowedValue, accountMaxNumberOfMarketsWithBalances: accountMax };
  }
);

// ---- Expiry ramp time ----
export const getExpiryRampTime = createEffect(
  {
    name: "getExpiryRampTime",
    input: { chainId: S.number, expiryAddress: S.string },
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    try {
      const t = (await getClient(input.chainId).readContract({
        address: addr(input.expiryAddress),
        abi: expiryAbi,
        functionName: "g_expiryRampTime",
      })) as bigint;
      return t.toString();
    } catch {
      return "0";
    }
  }
);

// ---- Modular interest setter (per-token optimal/lower/upper) ----
export const getModularInterestRates = createEffect(
  {
    name: "getModularInterestRates",
    input: { chainId: S.number, setter: S.string, token: S.string },
    output: { optimal: S.string, lower: S.string, upper: S.string },
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const a = addr(input.setter);
    const t = addr(input.token);
    const read = async (functionName: "getOptimalUtilizationByToken" | "getLowerOptimalPercentByToken" | "getUpperOptimalPercentByToken") =>
      ((await client.readContract({ address: a, abi: modularInterestAbi, functionName, args: [t] })) as bigint).toString();
    const [optimal, lower, upper] = await Promise.all([
      read("getOptimalUtilizationByToken"),
      read("getLowerOptimalPercentByToken"),
      read("getUpperOptimalPercentByToken"),
    ]);
    return { optimal, lower, upper };
  }
);

// ---- Linear-step interest setter constants (with subgraph fallbacks) ----
export const getLinearInterestConstants = createEffect(
  {
    name: "getLinearInterestConstants",
    input: { chainId: S.number, setter: S.string },
    output: { optimal: S.string, lower: S.string, upper: S.string },
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const a = addr(input.setter);
    const read = async (functionName: "OPTIMAL_UTILIZATION" | "LOWER_OPTIMAL_PERCENT" | "UPPER_OPTIMAL_PERCENT", fallback: string) => {
      try {
        return ((await client.readContract({ address: a, abi: linearInterestAbi, functionName })) as bigint).toString();
      } catch {
        return fallback;
      }
    };
    const [optimal, lower, upper] = await Promise.all([
      read("OPTIMAL_UTILIZATION", "900000000000000000"),
      read("LOWER_OPTIMAL_PERCENT", "40000000000000000"),
      read("UPPER_OPTIMAL_PERCENT", "960000000000000000"),
    ]);
    return { optimal, lower, upper };
  }
);

// ---- AMM pair LP balanceOf ----
export const getAmmPairBalanceOf = createEffect(
  {
    name: "getAmmPairBalanceOf",
    input: { chainId: S.number, pair: S.string, account: S.string },
    output: S.string,
    cache: false,
    rateLimit: false,
  },
  async ({ input }) => {
    const b = (await getClient(input.chainId).readContract({
      address: addr(input.pair),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr(input.account)],
    })) as bigint;
    return b.toString();
  }
);
