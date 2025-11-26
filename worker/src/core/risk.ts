/**
 * SAS v1 Risk Management
 * 
 * Implements risk-management.md exactly.
 * 
 * Functions:
 * - Daily loss limits
 * - Kill-switch logic
 * - Cooldown management
 * - Trade authorization gates
 * - Risk state management
 */

import type { Env } from '../env';
import type {
  TradeRow,
  SystemMode,
  RiskStateFlag,
  RiskSnapshot,
} from '../types';
import {
  getTradesToday,
  getOpenTrades,
  getSetting,
  setSetting,
  getRiskState,
  setRiskState,
} from '../db/queries';
import { getETDateString, isTradingDay } from './time';
import { TradierClient } from '../broker/tradierClient';

/**
 * Get current risk snapshot
 * 
 * Per system-interfaces.md:
 * export async function getRiskSnapshot(env: Env, now: Date): Promise<RiskSnapshot>;
 */
export async function getRiskSnapshot(
  env: Env,
  now: Date
): Promise<RiskSnapshot> {
  const systemMode = (await getRiskState(env, 'SYSTEM_MODE')) as SystemMode || 'NORMAL';
  const riskState = (await getRiskState(env, 'RISK_STATE')) as RiskStateFlag || 'NORMAL';
  
  const dailyRealizedPnL = await computeDailyRealizedPnL(env, now);
  const emergencyExitCount = parseInt(
    (await getRiskState(env, 'EMERGENCY_EXIT_COUNT_TODAY')) || '0'
  );
  
  // Include bull exposure in snapshot
  const bullExposure = await computeBullishExposure(env);
  
  return {
    system_mode: systemMode,
    risk_state: riskState,
    daily_realized_pnl: dailyRealizedPnL,
    emergency_exit_count_today: emergencyExitCount,
    // Add bull exposure to snapshot (extend RiskSnapshot type if needed)
  } as RiskSnapshot & {
    bull_exposure?: typeof bullExposure;
  };
}

/**
 * Validate per-trade max loss cap
 * 
 * Reject any new trade where max_loss > MAX_TRADE_LOSS_DOLLARS (credit spreads)
 * or max_loss > MAX_TRADE_DEBIT_DOLLARS (debit spreads)
 */
export async function validatePerTradeMaxLoss(
  env: Env,
  maxLoss: number,
  isDebitSpread?: boolean
): Promise<{ valid: boolean; reason?: string }> {
  if (isDebitSpread) {
    // For debit spreads, use MAX_TRADE_DEBIT_DOLLARS (default 250)
    const maxTradeDebitDollars = parseFloat(
      (await getSetting(env, 'MAX_TRADE_DEBIT_DOLLARS')) || '250'
    );
    
    if (maxLoss > maxTradeDebitDollars) {
      return {
        valid: false,
        reason: `Debit spread max_loss ($${maxLoss.toFixed(2)}) exceeds MAX_TRADE_DEBIT_DOLLARS ($${maxTradeDebitDollars.toFixed(2)})`,
      };
    }
  } else {
    // For credit spreads, use MAX_TRADE_LOSS_DOLLARS
    const maxTradeLossDollars = parseFloat(
      (await getSetting(env, 'MAX_TRADE_LOSS_DOLLARS')) || '0'
    );
    
    // If not set, skip check (default to unlimited)
    if (maxTradeLossDollars <= 0) {
      return { valid: true };
    }
    
    if (maxLoss > maxTradeLossDollars) {
      return {
        valid: false,
        reason: `Trade max_loss ($${maxLoss.toFixed(2)}) exceeds MAX_TRADE_LOSS_DOLLARS ($${maxTradeLossDollars.toFixed(2)})`,
      };
    }
  }
  
  return { valid: true };
}

/**
 * Validate daily new-risk cap
 * 
 * Track sum of max_loss of trades opened today; if it exceeds DAILY_MAX_NEW_RISK, stop opening new trades.
 */
export async function validateDailyNewRiskCap(
  env: Env,
  now: Date,
  newTradeMaxLoss: number
): Promise<{ valid: boolean; reason?: string }> {
  const dailyMaxNewRisk = parseFloat(
    (await getSetting(env, 'DAILY_MAX_NEW_RISK')) || '0'
  );
  
  // If not set, skip check (default to unlimited)
  if (dailyMaxNewRisk <= 0) {
    return { valid: true };
  }
  
  const tradesToday = await getTradesToday(env, now);
  // Count max_loss of trades opened today (that are still open or were closed)
  const openedToday = tradesToday.filter(
    t =>
      t.opened_at !== null &&
      t.broker_order_id_open !== null &&
      t.status !== 'CANCELLED' &&
      t.status !== 'CLOSE_FAILED'
  );
  
  const currentDailyNewRisk = openedToday.reduce((sum, t) => {
    return sum + (t.max_loss != null ? t.max_loss : 0);
  }, 0);
  
  const totalAfterNewTrade = currentDailyNewRisk + newTradeMaxLoss;
  
  if (totalAfterNewTrade > dailyMaxNewRisk) {
    return {
      valid: false,
      reason: `Daily new risk ($${totalAfterNewTrade.toFixed(2)} after new trade) would exceed DAILY_MAX_NEW_RISK ($${dailyMaxNewRisk.toFixed(2)})`,
    };
  }
  
  return { valid: true };
}

/**
 * Compute current bullish exposure across all open bull strategies
 * 
 * Returns:
 * - bull_credit_risk: sum of max_loss for BULL_PUT_CREDIT
 * - bull_debit_risk: sum of max_loss for BULL_CALL_DEBIT
 * - bull_total_risk: weighted total (credit * 1.0 + debit * 1.5)
 * - bull_trade_count: total number of open bull trades
 * - debit_trade_count: number of open BULL_CALL_DEBIT trades
 */
export async function computeBullishExposure(env: Env): Promise<{
  bull_credit_risk: number;
  bull_debit_risk: number;
  bull_total_risk: number;
  bull_trade_count: number;
  debit_trade_count: number;
}> {
  const openTrades = await getOpenTrades(env);
  
  let bull_credit_risk = 0;
  let bull_debit_risk = 0;
  let bull_trade_count = 0;
  let debit_trade_count = 0;
  
  for (const trade of openTrades) {
    const isBullPut = trade.strategy === 'BULL_PUT_CREDIT';
    const isBullCall = trade.strategy === 'BULL_CALL_DEBIT';
    
    if (isBullPut || isBullCall) {
      const maxLoss = trade.max_loss ?? 0;
      const quantity = trade.quantity ?? 1;
      const totalMaxLoss = maxLoss * quantity;
      
      if (isBullPut) {
        bull_credit_risk += totalMaxLoss;
      } else if (isBullCall) {
        bull_debit_risk += totalMaxLoss;
        debit_trade_count += quantity;
      }
      
      bull_trade_count += quantity;
    }
  }
  
  // Weighted risk: debit spreads count as 1.5x (higher directional risk)
  const bull_total_risk = bull_credit_risk * 1.0 + bull_debit_risk * 1.5;
  
  return {
    bull_credit_risk,
    bull_debit_risk,
    bull_total_risk,
    bull_trade_count,
    debit_trade_count,
  };
}

/**
 * Validate global bullish risk cap
 * 
 * Prevents over-allocation of bullish directional risk.
 * Applies weighted risk counting (debit = 1.5x, credit = 1.0x).
 */
export async function validateGlobalBullRiskCap(
  env: Env,
  newTradeMaxLoss: number,
  isDebitSpread: boolean
): Promise<{ valid: boolean; reason?: string }> {
  const globalBullRiskCap = parseFloat(
    (await getSetting(env, 'GLOBAL_BULL_RISK_CAP')) || '2500'
  );
  
  // If not set or 0, skip check (default to unlimited)
  if (globalBullRiskCap <= 0) {
    return { valid: true };
  }
  
  const exposure = await computeBullishExposure(env);
  
  // Weight the new trade's risk
  const weightedNewRisk = isDebitSpread 
    ? newTradeMaxLoss * 1.5 
    : newTradeMaxLoss * 1.0;
  
  const totalAfterNewTrade = exposure.bull_total_risk + weightedNewRisk;
  
  if (totalAfterNewTrade > globalBullRiskCap) {
    return {
      valid: false,
      reason: `Global bull risk ($${totalAfterNewTrade.toFixed(2)} after new trade) would exceed GLOBAL_BULL_RISK_CAP ($${globalBullRiskCap.toFixed(2)}). Current: $${exposure.bull_total_risk.toFixed(2)}`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate bull trade count limits
 * 
 * Enforces:
 * - MAX_BULL_TRADES: total open bull trades (default: 3)
 * - MAX_DEBIT_TRADES: total open debit trades (default: 1)
 */
export async function validateBullTradeCounts(
  env: Env,
  isDebitSpread: boolean
): Promise<{ valid: boolean; reason?: string }> {
  const maxBullTrades = parseInt(
    (await getSetting(env, 'MAX_BULL_TRADES')) || '3'
  );
  const maxDebitTrades = parseInt(
    (await getSetting(env, 'MAX_DEBIT_TRADES')) || '1'
  );
  
  const exposure = await computeBullishExposure(env);
  
  // Check total bull trade count
  if (exposure.bull_trade_count >= maxBullTrades) {
    return {
      valid: false,
      reason: `Bull trade count (${exposure.bull_trade_count}) would exceed MAX_BULL_TRADES (${maxBullTrades})`,
    };
  }
  
  // Check debit trade count (if this is a debit spread)
  if (isDebitSpread && exposure.debit_trade_count >= maxDebitTrades) {
    return {
      valid: false,
      reason: `Debit trade count (${exposure.debit_trade_count}) would exceed MAX_DEBIT_TRADES (${maxDebitTrades})`,
    };
  }
  
  return { valid: true };
}

/**
 * Compute current bearish exposure across all open bear strategies
 * 
 * Returns:
 * - bear_credit_risk: sum of max_loss for BEAR_CALL_CREDIT
 * - bear_debit_risk: sum of max_loss for BEAR_PUT_DEBIT
 * - bear_total_risk: weighted total (credit * 1.0 + debit * 1.5)
 * - bear_trade_count: total number of open bear trades
 * - debit_trade_count: number of open BEAR_PUT_DEBIT trades
 */
export async function computeBearishExposure(env: Env): Promise<{
  bear_credit_risk: number;
  bear_debit_risk: number;
  bear_total_risk: number;
  bear_trade_count: number;
  debit_trade_count: number;
}> {
  const openTrades = await getOpenTrades(env);
  
  let bear_credit_risk = 0;
  let bear_debit_risk = 0;
  let bear_trade_count = 0;
  let debit_trade_count = 0;
  
  for (const trade of openTrades) {
    const isBearCall = trade.strategy === 'BEAR_CALL_CREDIT';
    const isBearPut = trade.strategy === 'BEAR_PUT_DEBIT';
    
    if (isBearCall || isBearPut) {
      const maxLoss = trade.max_loss ?? 0;
      const quantity = trade.quantity ?? 1;
      const totalMaxLoss = maxLoss * quantity;
      
      if (isBearCall) {
        bear_credit_risk += totalMaxLoss;
      } else if (isBearPut) {
        bear_debit_risk += totalMaxLoss;
        debit_trade_count += quantity;
      }
      
      bear_trade_count += quantity;
    }
  }
  
  // Weighted risk: debit spreads count as 1.5x (higher directional risk)
  const bear_total_risk = bear_credit_risk * 1.0 + bear_debit_risk * 1.5;
  
  return {
    bear_credit_risk,
    bear_debit_risk,
    bear_total_risk,
    bear_trade_count,
    debit_trade_count,
  };
}

/**
 * Validate global bearish risk cap
 * 
 * Prevents over-allocation of bearish directional risk.
 * Applies weighted risk counting (debit = 1.5x, credit = 1.0x).
 */
export async function validateGlobalBearRiskCap(
  env: Env,
  newTradeMaxLoss: number,
  isDebitSpread: boolean
): Promise<{ valid: boolean; reason?: string }> {
  const globalBearRiskCap = parseFloat(
    (await getSetting(env, 'GLOBAL_BEAR_RISK_CAP')) || '2500'
  );
  
  // If not set or 0, skip check (default to unlimited)
  if (globalBearRiskCap <= 0) {
    return { valid: true };
  }
  
  const exposure = await computeBearishExposure(env);
  
  // Weight the new trade's risk
  const weightedNewRisk = isDebitSpread 
    ? newTradeMaxLoss * 1.5 
    : newTradeMaxLoss * 1.0;
  
  const totalAfterNewTrade = exposure.bear_total_risk + weightedNewRisk;
  
  if (totalAfterNewTrade > globalBearRiskCap) {
    return {
      valid: false,
      reason: `Global bear risk ($${totalAfterNewTrade.toFixed(2)} after new trade) would exceed GLOBAL_BEAR_RISK_CAP ($${globalBearRiskCap.toFixed(2)}). Current: $${exposure.bear_total_risk.toFixed(2)}`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate bear trade count limits
 * 
 * Enforces:
 * - MAX_BEAR_TRADES: total open bear trades (default: 3)
 * - MAX_DEBIT_BEAR_TRADES: total open bear debit trades (default: 1)
 */
export async function validateBearTradeCounts(
  env: Env,
  isDebitSpread: boolean
): Promise<{ valid: boolean; reason?: string }> {
  const maxBearTrades = parseInt(
    (await getSetting(env, 'MAX_BEAR_TRADES')) || '3'
  );
  const maxDebitBearTrades = parseInt(
    (await getSetting(env, 'MAX_DEBIT_BEAR_TRADES')) || '1'
  );
  
  const exposure = await computeBearishExposure(env);
  
  // Check total bear trade count
  if (exposure.bear_trade_count >= maxBearTrades) {
    return {
      valid: false,
      reason: `Bear trade count (${exposure.bear_trade_count}) would exceed MAX_BEAR_TRADES (${maxBearTrades})`,
    };
  }
  
  // Check debit trade count (if this is a debit spread)
  if (isDebitSpread && exposure.debit_trade_count >= maxDebitBearTrades) {
    return {
      valid: false,
      reason: `Bear debit trade count (${exposure.debit_trade_count}) would exceed MAX_DEBIT_BEAR_TRADES (${maxDebitBearTrades})`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate daily realized loss cap
 * 
 * Track today's realized PnL; if PnL ≤ DAILY_MAX_LOSS (negative), stop auto-entries (only allow exits).
 */
export async function validateDailyRealizedLossCap(
  env: Env,
  now: Date
): Promise<{ valid: boolean; reason?: string }> {
  const dailyMaxLoss = parseFloat(
    (await getSetting(env, 'DAILY_MAX_LOSS')) || '0'
  );
  
  // If not set, skip check (default to unlimited)
  if (dailyMaxLoss <= 0) {
    // Use existing daily loss check as fallback
    const dailyPnL = await computeDailyRealizedPnL(env, now);
    const accountEquity = parseFloat(
      (await getSetting(env, 'ACCOUNT_EQUITY_REFERENCE')) || '100000'
    );
    const maxDailyLossPct = parseFloat(
      (await getSetting(env, 'MAX_DAILY_LOSS_PCT')) || '0.02'
    );
    const maxDailyLoss = accountEquity * maxDailyLossPct;
    
    if (dailyPnL < 0 && Math.abs(dailyPnL) >= maxDailyLoss) {
      return {
        valid: false,
        reason: `Daily realized PnL ($${dailyPnL.toFixed(2)}) hit daily loss limit ($${maxDailyLoss.toFixed(2)})`,
      };
    }
    
    return { valid: true };
  }
  
  const dailyPnL = await computeDailyRealizedPnL(env, now);
  
  // DAILY_MAX_LOSS is negative (e.g., -500 means max $500 loss)
  if (dailyPnL <= dailyMaxLoss) {
    return {
      valid: false,
      reason: `Daily realized PnL ($${dailyPnL.toFixed(2)}) hit DAILY_MAX_LOSS limit ($${dailyMaxLoss.toFixed(2)})`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate concentration cap per underlying
 * 
 * Sum max_loss of all open trades for a symbol; enforce UNDERLYING_MAX_RISK per symbol.
 */
export async function validateUnderlyingConcentrationCap(
  env: Env,
  symbol: string,
  newTradeMaxLoss: number
): Promise<{ valid: boolean; reason?: string }> {
  const underlyingMaxRisk = parseFloat(
    (await getSetting(env, 'UNDERLYING_MAX_RISK')) || '0'
  );
  
  // If not set, skip check (default to unlimited)
  if (underlyingMaxRisk <= 0) {
    return { valid: true };
  }
  
  const openTrades = await getOpenTrades(env);
  const openTradesForSymbol = openTrades.filter(t => t.symbol === symbol);
  
  const currentRisk = openTradesForSymbol.reduce((sum, t) => {
    return sum + (t.max_loss != null ? t.max_loss : 0);
  }, 0);
  
  const totalAfterNewTrade = currentRisk + newTradeMaxLoss;
  
  if (totalAfterNewTrade > underlyingMaxRisk) {
    return {
      valid: false,
      reason: `Underlying ${symbol} risk ($${totalAfterNewTrade.toFixed(2)} after new trade) would exceed UNDERLYING_MAX_RISK ($${underlyingMaxRisk.toFixed(2)})`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate concentration cap per expiry
 * 
 * Sum max_loss for a (symbol, expiry) pair; enforce EXPIRY_MAX_RISK.
 */
export async function validateExpiryConcentrationCap(
  env: Env,
  symbol: string,
  expiration: string,
  newTradeMaxLoss: number
): Promise<{ valid: boolean; reason?: string }> {
  const expiryMaxRisk = parseFloat(
    (await getSetting(env, 'EXPIRY_MAX_RISK')) || '0'
  );
  
  // If not set, skip check (default to unlimited)
  if (expiryMaxRisk <= 0) {
    return { valid: true };
  }
  
  const openTrades = await getOpenTrades(env);
  const openTradesForExpiry = openTrades.filter(
    t => t.symbol === symbol && t.expiration === expiration
  );
  
  const currentRisk = openTradesForExpiry.reduce((sum, t) => {
    return sum + (t.max_loss != null ? t.max_loss : 0);
  }, 0);
  
  const totalAfterNewTrade = currentRisk + newTradeMaxLoss;
  
  if (totalAfterNewTrade > expiryMaxRisk) {
    return {
      valid: false,
      reason: `Expiry ${symbol} ${expiration} risk ($${totalAfterNewTrade.toFixed(2)} after new trade) would exceed EXPIRY_MAX_RISK ($${expiryMaxRisk.toFixed(2)})`,
    };
  }
  
  return { valid: true };
}

/**
 * Check if a new trade can be opened
 * 
 * Per system-interfaces.md:
 * export async function canOpenNewTrade(env: Env, now: Date): Promise<boolean>;
 * 
 * This is the main gate that must be called before any entry attempt.
 */
export async function canOpenNewTrade(env: Env, now: Date): Promise<boolean> {
  // 1. Check system mode
  const systemMode = (await getRiskState(env, 'SYSTEM_MODE')) as SystemMode;
  if (systemMode === 'HARD_STOP') {
    console.log('[risk] canOpenNewTrade=false: systemMode=HARD_STOP');
    return false;
  }
  
  // 2. Check risk state
  const riskState = (await getRiskState(env, 'RISK_STATE')) as RiskStateFlag;
  if (riskState !== 'NORMAL') {
    console.log('[risk] canOpenNewTrade=false: riskState=' + riskState + ' (expected NORMAL)');
    return false;
  }
  
  // 3. Check max open spreads (configurable via MAX_OPEN_SPREADS_GLOBAL, fallback to legacy MAX_OPEN_POSITIONS)
  //    All trades are managed by Gekkoworks - count every OPEN/CLOSING/ENTRY spread
  const maxOpenSpreadsSetting =
    (await getSetting(env, 'MAX_OPEN_SPREADS_GLOBAL')) ||
    (await getSetting(env, 'MAX_OPEN_POSITIONS')) ||
    '10';
  const maxOpenPositions = parseInt(maxOpenSpreadsSetting, 10) || 10;
  const openTrades = await getOpenTrades(env);

  if (openTrades.length >= maxOpenPositions) {
    console.log('[risk] canOpenNewTrade=false: openTrades.length=' + openTrades.length + ' (max ' + maxOpenPositions + ')', JSON.stringify({
      blockingTrades: openTrades.map(t => ({
        id: t.id,
        status: t.status,
        symbol: t.symbol,
        expiration: t.expiration,
        short_strike: t.short_strike,
        long_strike: t.long_strike,
        broker_order_id_open: t.broker_order_id_open,
        broker_order_id_close: t.broker_order_id_close,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
      })),
    }));
    return false;
  }
  
  // 4. Check max trades per day
  // Configurable via MAX_NEW_TRADES_PER_DAY (fallback to legacy MAX_TRADES_PER_DAY); default to 100 if not set.
  const maxTradesPerDaySetting =
    (await getSetting(env, 'MAX_NEW_TRADES_PER_DAY')) ||
    (await getSetting(env, 'MAX_TRADES_PER_DAY')) ||
    '100';
  const maxTradesPerDay = parseInt(maxTradesPerDaySetting, 10) || 100;
  const tradesToday = await getTradesToday(env, now);
  // All trades are managed by Gekkoworks - count all trades opened today
  // Exclude trades that ultimately failed or were rejected (CANCELLED, CLOSE_FAILED).
  const openedToday = tradesToday.filter(
    t =>
      t.opened_at !== null &&
      t.broker_order_id_open !== null &&
      t.status !== 'CANCELLED' &&
      t.status !== 'CLOSE_FAILED'
  );
  if (openedToday.length >= maxTradesPerDay) {
    console.log('[risk] canOpenNewTrade=false: openedToday.length=' + openedToday.length + ' (max ' + maxTradesPerDay + ')');
    return false;
  }
  
  // 5. Check daily loss limit
  const dailyPnL = await computeDailyRealizedPnL(env, now);
  const accountEquity = parseFloat(
    (await getSetting(env, 'ACCOUNT_EQUITY_REFERENCE')) || '100000'
  );
  const maxDailyLossPct = parseFloat(
    (await getSetting(env, 'MAX_DAILY_LOSS_PCT')) || '0.02'
  );
  const maxDailyLoss = accountEquity * maxDailyLossPct;
  
  if (dailyPnL < 0 && Math.abs(dailyPnL) >= maxDailyLoss) {
    // Daily stop hit - update risk state
    console.log('[risk] canOpenNewTrade=false: dailyPnL=' + dailyPnL + ' (limit=' + maxDailyLoss + ')');
    await setRiskState(env, 'RISK_STATE', 'DAILY_STOP_HIT');
    return false;
  }
  
  // 6. Check if we're in a trading day
  if (!isTradingDay(now)) {
    console.log('[risk] canOpenNewTrade=false: not a trading day');
    return false;
  }

  // 7. Check account buying power vs open risk (simple cap)
  try {
    const client = new TradierClient(env);
    const balances = await client.getBalances();

    const maxRiskFraction = parseFloat(
      (await getSetting(env, 'MAX_RISK_FRACTION_OF_BUYING_POWER')) || '0.2'
    );
    const assumedWidth = parseFloat(
      (await getSetting(env, 'DEFAULT_SPREAD_WIDTH')) || '5'
    );

    const existingRisk = openTrades.reduce((sum, t) => {
      return sum + (t.max_loss != null ? t.max_loss : 0);
    }, 0);
    const newTradeRisk = assumedWidth; // width in dollars for 1-lot; we already store per-spread max_loss
    const totalRiskAfter = existingRisk + newTradeRisk;

    const maxAllowedRisk = balances.buying_power * maxRiskFraction;

    if (balances.buying_power > 0 && totalRiskAfter > maxAllowedRisk) {
      console.log(
        '[risk] canOpenNewTrade=false: risk vs buying_power cap',
        JSON.stringify({
          buying_power: balances.buying_power,
          existingRisk,
          newTradeRisk,
          totalRiskAfter,
          maxAllowedRisk,
          maxRiskFraction,
        })
      );
      return false;
    }
  } catch (error) {
    console.log(
      '[risk] balance_check_failed_proceeding',
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
  
  console.log('[risk] canOpenNewTrade=true: all checks passed', JSON.stringify({
    systemMode,
    riskState,
    openTradesCount: openTrades.length,
    openedTodayCount: openedToday.length,
    maxTradesPerDay,
    dailyPnL,
    maxDailyLoss,
    isTradingDay: isTradingDay(now),
  }));
  
  return true;
}

/**
 * Record a trade closure and update risk state
 * 
 * Per system-interfaces.md:
 * export async function recordTradeClosed(env: Env, trade: TradeRow): Promise<void>;
 */
export async function recordTradeClosed(
  env: Env,
  trade: TradeRow
): Promise<void> {
  if (trade.status !== 'CLOSED' || trade.realized_pnl === null) {
    return; // Not a closed trade with realized PnL
  }
  
  // Update daily realized PnL is handled by computeDailyRealizedPnL
  // which queries all closed trades for today
  
  // Check if daily loss limit was hit
  await applyDailyLossCheck(env, new Date());
  
  // If this was an emergency exit, increment counter
  if (trade.exit_reason === 'EMERGENCY') {
    await incrementEmergencyExitCount(env, new Date());
  }
}

/**
 * Increment emergency exit count
 * 
 * Per system-interfaces.md:
 * export async function incrementEmergencyExitCount(env: Env, now: Date): Promise<void>;
 * 
 * If count >= 2, trigger HARD_STOP
 */
export async function incrementEmergencyExitCount(
  env: Env,
  now: Date
): Promise<void> {
  const currentCount = parseInt(
    (await getRiskState(env, 'EMERGENCY_EXIT_COUNT_TODAY')) || '0'
  );
  
  const newCount = currentCount + 1;
  await setRiskState(env, 'EMERGENCY_EXIT_COUNT_TODAY', newCount.toString());
  
  // Set risk state flag
  await setRiskState(env, 'RISK_STATE', 'EMERGENCY_EXIT_OCCURRED_TODAY');
  
  // If 2 or more emergency exits today, trigger HARD_STOP
  if (newCount >= 2) {
    const { setSystemMode } = await import('./systemMode');
    await setSystemMode(env, 'HARD_STOP', 'EMERGENCY_EXIT_THRESHOLD', {
      emergency_exit_count: newCount,
      threshold: 2,
      trade_id: null, // Will be set by caller if available
    });
  }
}

/**
 * Apply daily loss check
 * 
 * Per system-interfaces.md:
 * export async function applyDailyLossCheck(env: Env, now: Date): Promise<void>;
 */
export async function applyDailyLossCheck(env: Env, now: Date): Promise<void> {
  const dailyPnL = await computeDailyRealizedPnL(env, now);
  const accountEquity = parseFloat(
    (await getSetting(env, 'ACCOUNT_EQUITY_REFERENCE')) || '100000'
  );
  const maxDailyLossPct = parseFloat(
    (await getSetting(env, 'MAX_DAILY_LOSS_PCT')) || '0.02'
  );
  const maxDailyLoss = accountEquity * maxDailyLossPct;
  
  const dailyLoss = Math.min(dailyPnL, 0); // negative or zero
  
  if (Math.abs(dailyLoss) >= maxDailyLoss) {
    // Daily stop hit
    await setRiskState(env, 'RISK_STATE', 'DAILY_STOP_HIT');
  }
}

/**
 * Compute daily realized PnL
 * 
 * Sum of realized_pnl for all trades CLOSED today
 */
async function computeDailyRealizedPnL(env: Env, now: Date): Promise<number> {
  const tradesToday = await getTradesToday(env, now);
  const closedToday = tradesToday.filter(
    t => t.status === 'CLOSED' && t.realized_pnl !== null
  );
  
  const totalPnL = closedToday.reduce((sum, trade) => {
    return sum + (trade.realized_pnl || 0);
  }, 0);
  
  return totalPnL;
}

/**
 * Reset risk state for new trading day
 * 
 * Called by premarket cron to reset daily counters
 */
export async function resetDailyRiskState(env: Env, now: Date): Promise<void> {
  const today = getETDateString(now);
  const lastReset = await getRiskState(env, 'LAST_DAILY_RESET');
  
  // Only reset if it's a new trading day
  if (lastReset !== today && isTradingDay(now)) {
    // Reset emergency exit count
    await setRiskState(env, 'EMERGENCY_EXIT_COUNT_TODAY', '0');
    
    // Reset risk state if it was a daily stop (not HARD_STOP)
    const systemMode = (await getRiskState(env, 'SYSTEM_MODE')) as SystemMode;
    const riskState = (await getRiskState(env, 'RISK_STATE')) as RiskStateFlag;
    
    if (systemMode !== 'HARD_STOP') {
      if (riskState === 'DAILY_STOP_HIT' || riskState === 'EMERGENCY_EXIT_OCCURRED_TODAY') {
        await setRiskState(env, 'RISK_STATE', 'NORMAL');
      }
    }
    
    // Update last reset date
    await setRiskState(env, 'LAST_DAILY_RESET', today);
  }
}

/**
 * Check and apply kill-switch if conditions are met
 * 
 * Per risk-management.md Section 7:
 * - Multiple emergency exits (>= 2) → already handled in incrementEmergencyExitCount
 * - Mark-to-market loss > 3% of equity → needs to be called from monitoring
 * - Other conditions → handled elsewhere
 */
export async function checkAndApplyKillSwitch(env: Env): Promise<void> {
  const snapshot = await getRiskSnapshot(env, new Date());
  
  // Already in HARD_STOP
  if (snapshot.system_mode === 'HARD_STOP') {
    return;
  }
  
  // Check emergency exit count (handled in incrementEmergencyExitCount)
  if (snapshot.emergency_exit_count_today >= 2) {
    const { setSystemMode } = await import('./systemMode');
    await setSystemMode(env, 'HARD_STOP', 'EMERGENCY_EXIT_THRESHOLD', {
      emergency_exit_count: snapshot.emergency_exit_count_today,
      threshold: 2,
    });
  }
}

