import { getConstants } from "../../constants";
import { asyncKeyId, liquidityMiningClaimId } from "./ids";

export { AsyncDepositStatus, AsyncWithdrawalStatus } from "./types";

/**
 * Ported from event-emitter-registry-helpers.getAsyncDepositOrWithdrawalKey. Returns the
 * AsyncDeposit/AsyncWithdrawal entity id (`${chainId}-${token}-${key}`).
 */
export function getAsyncDepositOrWithdrawalKey(chainId: number, token: string, key: string): string {
  return asyncKeyId(chainId, token, key);
}

/**
 * Ported from event-emitter-registry-helpers.getRewardClaimerKey. Returns the
 * LiquidityMiningClaim entity id (`${chainId}-${distributor}-${user}-${epoch}`).
 */
export function getRewardClaimerKey(chainId: number, distributor: string, user: string, epoch: bigint): string {
  return liquidityMiningClaimId(chainId, distributor, user, epoch);
}

/**
 * Ported from event-emitter-registry-helpers.createEventEmitterRegistries. The subgraph
 * called EventEmitterRegistryTemplate.create(...) for both proxies; in Envio the CALLING
 * HANDLER must do the dynamic `contractRegister` for EventEmitterRegistry. This helper only
 * returns the two proxy addresses to register (non-zero ones).
 */
export function getEventEmitterRegistryAddresses(chainId: number): string[] {
  const c = getConstants(chainId);
  return [c.eventEmitter, c.eventEmitterFromCore].filter((a) => a !== "0x0000000000000000000000000000000000000000");
}
