import type { BigDecimal, EvmOnEventContext, Token } from "envio";
import { convertTokenToDecimal } from "./numbers";
import { marginAccountId } from "./ids";

/** Shared handler context alias. */
export type Ctx = EvmOnEventContext;

/** Make a loaded (read-only) entity's fields writable so we can mutate a copy before .set(). */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Minimal replacement for the subgraph's ambient `event` object. Handlers build this
 * from `event.block` / `event.transaction` and pass it into helpers explicitly.
 */
export type EventMeta = {
  blockNumber: bigint;
  blockHash: string;
  timestamp: bigint;
  txHash: string;
  logIndex: bigint;
};

// ---------------------------------------------------------------------------
// String enums (subgraph used `class X { static Foo: string = 'FOO' }`).
// ---------------------------------------------------------------------------

export const ProtocolType = {
  Core: "CORE",
  Admin: "ADMIN",
  Expiry: "EXPIRY",
  Amm: "AMM",
  Position: "POSITION",
  Zap: "ZAP",
} as const;
export type ProtocolTypeValue = (typeof ProtocolType)[keyof typeof ProtocolType];

export const MarginPositionStatus = {
  Open: "OPEN",
  Closed: "CLOSED",
  Expired: "EXPIRED",
  Liquidated: "LIQUIDATED",
  Unknown: "UNKNOWN",
} as const;
export type MarginPositionStatusValue = (typeof MarginPositionStatus)[keyof typeof MarginPositionStatus];

/** subgraph MarginPositionStatus.isClosed */
export function isMarginPositionClosed(status: string): boolean {
  return status !== MarginPositionStatus.Open;
}

export const BorrowPositionStatus = {
  Open: "OPEN",
  Closed: "CLOSED",
} as const;

export const TradeLiquidationType = {
  LIQUIDATION: "LIQUIDATION",
  EXPIRATION: "EXPIRATION",
} as const;

export const AsyncDepositStatus = {
  CREATED: "CREATED",
  DEPOSIT_EXECUTED: "DEPOSIT_EXECUTED",
  DEPOSIT_FAILED: "DEPOSIT_FAILED",
  DEPOSIT_CANCELLED: "DEPOSIT_CANCELLED",
  DEPOSIT_CANCELLED_FAILED: "DEPOSIT_CANCELLED_FAILED",
} as const;

export const AsyncWithdrawalStatus = {
  CREATED: "CREATED",
  WITHDRAWAL_EXECUTED: "WITHDRAWAL_EXECUTED",
  WITHDRAWAL_EXECUTION_FAILED: "WITHDRAWAL_EXECUTION_FAILED",
  WITHDRAWAL_CANCELLED: "WITHDRAWAL_CANCELLED",
} as const;

export const LiquidityMiningVestingPositionStatus = {
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED",
  FORCE_CLOSED: "FORCE_CLOSED",
  EMERGENCY_CLOSED: "EMERGENCY_CLOSED",
} as const;

// ---------------------------------------------------------------------------
// BalanceUpdate — ported from margin-types.ts. Holds decimal-converted par/wei
// (with sign already applied) plus the margin-account id it targets.
// ---------------------------------------------------------------------------

export type BalanceUpdate = {
  accountOwner: string;
  accountNumber: bigint;
  token: Token;
  /** Can be negative. */
  valuePar: BigDecimal;
  /** Can be negative. */
  deltaWei: BigDecimal;
  /** `${chainId}-${owner}-${accountNumber}` (the MarginAccount id). */
  marginAccount: string;
};

export function makeBalanceUpdate(
  chainId: number,
  accountOwner: string,
  accountNumber: bigint,
  valuePar: bigint,
  valueParSign: boolean,
  deltaWei: bigint,
  deltaWeiSign: boolean,
  token: Token
): BalanceUpdate {
  return {
    accountOwner,
    accountNumber,
    token,
    valuePar: convertTokenToDecimal(valueParSign ? valuePar : -valuePar, token.decimals),
    deltaWei: convertTokenToDecimal(deltaWeiSign ? deltaWei : -deltaWei, token.decimals),
    marginAccount: marginAccountId(chainId, accountOwner, accountNumber),
  };
}

// ---------------------------------------------------------------------------
// ValueStruct — ported from margin-types.ts. The subgraph decoded an on-chain
// `(bool sign, uint256 value)` tuple; here handlers already have {sign, value}.
// ---------------------------------------------------------------------------

export type ValueStructLike = { sign: boolean; value: bigint };

export class ValueStruct {
  readonly sign: boolean;
  readonly value: bigint;

  constructor(sign: boolean, value: bigint) {
    this.sign = sign;
    this.value = value;
  }

  static fromFields(sign: boolean, value: bigint): ValueStruct {
    return new ValueStruct(sign, value);
  }

  static from(v: ValueStructLike): ValueStruct {
    return new ValueStruct(v.sign, v.value);
  }

  neg(): ValueStruct {
    return new ValueStruct(!this.sign, this.value);
  }

  abs(): ValueStruct {
    return new ValueStruct(true, this.value < 0n ? -this.value : this.value);
  }

  /** Signed raw integer value. */
  applied(): bigint {
    return this.sign ? this.value : -this.value;
  }
}
