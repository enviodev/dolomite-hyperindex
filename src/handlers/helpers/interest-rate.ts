import type { BigDecimal, DolomiteMargin, InterestIndex, InterestRate, Token, TotalPar } from "envio";
import type { Ctx } from "./types";
import {
  ZERO_BI,
  ONE_ETH_BI,
  ONE_ETH_BD,
  SECONDS_IN_YEAR,
  INTEREST_PRECISION,
  TEN_BI,
  bd,
  absBD,
  truncate,
  bdToBigInt,
} from "./numbers";
import { parToWei } from "./margin";
import { getConstants } from "../../constants";

const SECONDS_IN_YEAR_BI = SECONDS_IN_YEAR;
const PERCENT = 100n;

/** Ported from interest-setter.getLinearStepFunctionInterestRatePerSecond. */
export function getLinearStepFunctionInterestRatePerSecond(
  optimalUtilization: bigint,
  lowerOptimalRate: bigint,
  upperOptimalRate: bigint,
  borrowWei: bigint,
  supplyWei: bigint
): bigint {
  const maxGoal = lowerOptimalRate + upperOptimalRate;
  const BASE = ONE_ETH_BI; // 100%
  if (borrowWei === ZERO_BI) {
    return ZERO_BI;
  }
  if (supplyWei === ZERO_BI) {
    // totalBorrowed > 0 but no supply.
    return maxGoal / SECONDS_IN_YEAR_BI;
  }

  const utilization = (BASE * borrowWei) / supplyWei;
  const optimalUtilizationDeltaToMax = BASE - optimalUtilization;
  const initialGoal = lowerOptimalRate;

  let aprBI: bigint; // expressed as 1.0 == 1e18 or 0.1 == 1e17
  if (utilization >= BASE) {
    aprBI = maxGoal;
  } else if (utilization > optimalUtilization) {
    const deltaToGoal = maxGoal - initialGoal;
    const interestToAdd = (deltaToGoal * (utilization - optimalUtilization)) / optimalUtilizationDeltaToMax;
    aprBI = interestToAdd + initialGoal;
  } else {
    aprBI = (initialGoal * utilization) / optimalUtilization;
  }

  return aprBI / SECONDS_IN_YEAR_BI;
}

/** Ported from interest-setter.getDoubleExponentInterestRatePerSecond. */
function getDoubleExponentInterestRatePerSecond(borrowWei: bigint, supplyWei: bigint): bigint {
  if (borrowWei === ZERO_BI) {
    return ZERO_BI;
  }

  const maxAPR = ONE_ETH_BI; // 1.00 -> 100%
  if (borrowWei >= supplyWei) {
    return maxAPR / SECONDS_IN_YEAR_BI;
  }

  const coefficients: bigint[] = [0n, 20n, 0n, 0n, 0n, 0n, 20n, 60n];
  let result = coefficients[0]! * ONE_ETH_BI;
  let polynomial = (ONE_ETH_BI * borrowWei) / supplyWei;
  for (let i = 1; i < coefficients.length; i++) {
    const coefficient = coefficients[i]!;
    if (coefficient !== 0n) {
      result = result + coefficient * polynomial;
    }
    polynomial = (polynomial * polynomial) / ONE_ETH_BI;
  }

  return (result * maxAPR) / (SECONDS_IN_YEAR_BI * ONE_ETH_BI * PERCENT);
}

function getInterestRatePerSecond(
  chainId: number,
  borrowWeiBI: bigint,
  supplyWeiBI: bigint,
  interestRateObject: InterestRate
): bigint {
  const c = getConstants(chainId);
  const interestSetter = interestRateObject.interestSetter.toLowerCase();
  if (interestSetter === c.doubleExponentInterestSetter) {
    return getDoubleExponentInterestRatePerSecond(borrowWeiBI, supplyWeiBI);
  } else if (
    interestSetter === c.aaveAltInterestSetter ||
    interestSetter === c.aaveStableInterestSetter
  ) {
    return getLinearStepFunctionInterestRatePerSecond(
      interestRateObject.optimalUtilizationRate,
      interestRateObject.lowerOptimalRate,
      interestRateObject.upperOptimalRate,
      borrowWeiBI,
      supplyWeiBI
    );
  } else if (interestSetter === c.alwaysZeroInterestSetter) {
    return ZERO_BI;
  } else {
    return getLinearStepFunctionInterestRatePerSecond(
      interestRateObject.optimalUtilizationRate,
      interestRateObject.lowerOptimalRate,
      interestRateObject.upperOptimalRate,
      borrowWeiBI,
      supplyWeiBI
    );
  }
}

/**
 * Ported from interest-setter.updateInterestRate. Recomputes the per-token borrow/supply
 * interest rates from current TotalPar + index and persists the InterestRate entity.
 * InterestRate / MarketRiskInfo are keyed by the token id (`${chainId}-${address}`).
 */
export async function updateInterestRate(
  context: Ctx,
  chainId: number,
  token: Token,
  totalPar: TotalPar,
  index: InterestIndex,
  dolomiteMargin: DolomiteMargin
): Promise<void> {
  let borrowWei = absBD(parToWei(totalPar.borrowPar.negated(), index, token.decimals));
  let supplyWei = parToWei(totalPar.supplyPar, index, token.decimals);

  const scale = bd(TEN_BI ** token.decimals);
  borrowWei = borrowWei.times(scale);
  supplyWei = supplyWei.times(scale);

  const borrowWeiBI = bdToBigInt(borrowWei);
  const supplyWeiBI = bdToBigInt(supplyWei);

  const interestRate = await context.InterestRate.getOrThrow(index.token_id);
  const interestRatePerSecond = getInterestRatePerSecond(chainId, borrowWeiBI, supplyWeiBI, interestRate);
  const marketInfo = await context.MarketRiskInfo.getOrThrow(token.id);

  const interestPerYearBD = bd(interestRatePerSecond * SECONDS_IN_YEAR);
  const borrowInterestRate = interestPerYearBD.div(ONE_ETH_BD);

  let earningsRate: BigDecimal;
  if (marketInfo.earningsRateOverride !== undefined) {
    earningsRate = marketInfo.earningsRateOverride;
  } else {
    earningsRate = dolomiteMargin.earningsRate;
  }

  let supplyInterestRate: BigDecimal;
  if (borrowWei.lt(supplyWei)) {
    // Supply interest is spread across the supplied balance but paid on the borrowed
    // amount, so scale down by borrowWei / supplyWei.
    supplyInterestRate = truncate(
      truncate(borrowInterestRate.times(earningsRate), INTEREST_PRECISION).times(borrowWei).div(supplyWei),
      INTEREST_PRECISION
    );
  } else {
    supplyInterestRate = truncate(borrowInterestRate.times(earningsRate), INTEREST_PRECISION);
  }

  context.InterestRate.set({ ...interestRate, borrowInterestRate, supplyInterestRate });
}
