import type { User } from "envio";
import type { Ctx } from "./types";
import { userId } from "./ids";

/**
 * Ported from isolation-mode-helpers. Given a vault/user address, resolve the
 * effective User (following the `effectiveUser` pointer set by IsolationMode events).
 */
export async function getEffectiveUserForAddress(context: Ctx, chainId: number, address: string): Promise<User> {
  const user = await context.User.getOrThrow(userId(chainId, address));
  return context.User.getOrThrow(user.effectiveUser_id);
}

/**
 * Ported from isolation-mode-helpers.getEffectiveUserForAddressString. In the subgraph
 * the "string" here was a raw address; in this port callers frequently already hold a
 * namespaced User id (`${chainId}-${address}`). Resolve the effective User from a User id.
 */
export async function getEffectiveUserForUserId(context: Ctx, userEntityId: string): Promise<User> {
  const user = await context.User.getOrThrow(userEntityId);
  return context.User.getOrThrow(user.effectiveUser_id);
}
