import { indexer } from "envio";
import type { Mutable } from "./helpers/types";
import type { Zap, ZapTraderParam } from "envio";
import { getConstants } from "../constants";
import {
  dolomiteMarginId,
  eventId,
  marginAccountId,
  transactionId,
  userId,
  zapTraderParamId,
} from "./helpers/ids";
import { getEffectiveUserForAddress } from "./helpers/isolation";
import { getTokenPathForZap, getZapAccountNumber } from "./helpers/zap-helpers";
import { absBD, ONE_BI, ZERO_BD } from "./helpers/numbers";

function isContractUnknown(chainId: number, srcAddress: string): boolean {
  const constants = getConstants(chainId);
  const src = srcAddress.toLowerCase();
  return (
    !constants.genericTraders.includes(src) &&
    src !== constants.eventEmitter &&
    src !== constants.eventEmitterFromCore
  );
}

indexer.onEvent(
  { contract: "GenericTraderProxy", event: "ZapExecuted" },
  async ({ event, context }) => {
    const chainId = event.chainId;

    if (isContractUnknown(chainId, event.srcAddress)) {
      context.log.warn(
        "handleZapExecuted: event address does not match GenericTraderProxyV1 or EventEmitterRegistry address"
      );
      return;
    }

    const accountOwner = event.params.accountOwner;
    const accountNumber = event.params.accountNumber;

    const zapId = eventId(chainId, event.transaction.hash, BigInt(event.logIndex));

    const effectiveUser = await getEffectiveUserForAddress(context, chainId, accountOwner);

    const tokenPath = await getTokenPathForZap(context, chainId, event.params.marketIdsPath);

    // Ported from `transaction.transfers.load()` (derived reverse lookup).
    const txId = transactionId(chainId, event.transaction.hash);
    const transfers = await context.Transfer.getWhere({ transaction_id: { _eq: txId } });

    const zapAccountNumber = getZapAccountNumber(
      accountOwner,
      accountNumber,
      BigInt(event.block.timestamp)
    );

    let amountInToken = ZERO_BD;
    let amountInUSD = ZERO_BD;
    let amountOutToken = ZERO_BD;
    let amountOutUSD = ZERO_BD;
    for (let i = 0; i < transfers.length; i++) {
      const transfer = transfers[i]!;
      const toMarginAccount = await context.MarginAccount.getOrThrow(transfer.toMarginAccount_id);
      const fromMarginAccount = await context.MarginAccount.getOrThrow(transfer.fromMarginAccount_id);
      if (toMarginAccount.accountNumber === zapAccountNumber) {
        // Transfers into the zap account are the amount in
        amountInToken = absBD(transfer.amountDeltaWei);
        amountInUSD = absBD(transfer.amountUSDDeltaWei);
      } else if (fromMarginAccount.accountNumber === zapAccountNumber) {
        // Transfers out of the zap account are the amount out
        amountOutToken = absBD(transfer.amountDeltaWei);
        amountOutUSD = absBD(transfer.amountUSDDeltaWei);
      }

      if (!amountInToken.isEqualTo(ZERO_BD) && !amountOutToken.isEqualTo(ZERO_BD)) {
        break;
      }
    }

    if (amountInToken.isEqualTo(ZERO_BD) || amountOutToken.isEqualTo(ZERO_BD)) {
      context.log.error(
        `Could not create zap! ${transfers.length.toString()} ${zapAccountNumber.toString()}`
      );
      throw new Error("Invalid state!");
    }

    const zap: Mutable<Zap> = {
      id: zapId,
      marginAccount_id: marginAccountId(chainId, accountOwner, accountNumber),
      effectiveUser_id: effectiveUser.id,
      transaction_id: txId,
      tokenPath,
      amountInToken,
      amountInUSD,
      amountOutToken,
      amountOutUSD,
    };
    context.Zap.set(zap);

    const constants = getConstants(chainId);
    const dolomiteMargin = await context.DolomiteMargin.getOrThrow(
      dolomiteMarginId(chainId, constants.dolomiteMargin)
    );

    for (let i = 0; i < event.params.tradersPath.length; i++) {
      const traderParamEvent = event.params.tradersPath[i]!;

      let traderType: string;
      if (traderParamEvent.traderType === 0n) {
        traderType = "EXTERNAL_LIQUIDITY";
      } else if (traderParamEvent.traderType === 1n) {
        traderType = "INTERNAL_LIQUIDITY";
      } else if (traderParamEvent.traderType === 2n) {
        traderType = "ISOLATION_MODE_UNWRAPPER";
      } else if (traderParamEvent.traderType === 3n) {
        traderType = "ISOLATION_MODE_WRAPPER";
      } else {
        throw new Error(`Invalid trader type, found: ${traderParamEvent.traderType.toString()}`);
      }

      const tradeDataEmpty =
        traderParamEvent.tradeData === "0x" || traderParamEvent.tradeData.length === 0;

      const traderParam: Mutable<ZapTraderParam> = {
        id: zapTraderParamId(zapId, i),
        zap_id: zapId,
        traderType,
        traderAddress: traderParamEvent.trader,
        tradeData: tradeDataEmpty ? undefined : traderParamEvent.tradeData,
      };
      context.ZapTraderParam.set(traderParam);
    }

    const dolomiteMarginMutable: Mutable<typeof dolomiteMargin> = { ...dolomiteMargin };
    dolomiteMarginMutable.zapCount = dolomiteMargin.zapCount + ONE_BI;
    dolomiteMarginMutable.totalZapVolumeUSD = dolomiteMargin.totalZapVolumeUSD.plus(amountInUSD);
    context.DolomiteMargin.set(dolomiteMarginMutable);

    const user = await context.User.getOrThrow(userId(chainId, accountOwner));
    const userMutable: Mutable<typeof user> = { ...user };
    userMutable.totalZapCount = user.totalZapCount + ONE_BI;
    userMutable.totalZapVolumeUSD = user.totalZapVolumeUSD.plus(amountInUSD);
    context.User.set(userMutable);

    if (user.effectiveUser_id !== user.id) {
      const effectiveUserEntity = await context.User.getOrThrow(user.effectiveUser_id);
      const effectiveUserMutable: Mutable<typeof effectiveUserEntity> = { ...effectiveUserEntity };
      effectiveUserMutable.totalZapCount = effectiveUserEntity.totalZapCount + ONE_BI;
      effectiveUserMutable.totalZapVolumeUSD =
        effectiveUserEntity.totalZapVolumeUSD.plus(amountInUSD);
      context.User.set(effectiveUserMutable);
    }
  }
);
