import type { Env } from '../env';
import { getLatestAccountSnapshot, getOpenTrades } from '../db/queries';
import { isMarketHours, isTradingDay, isPreMarket, isPostMarket } from '../core/time';
import { getTradingMode } from '../core/config';
import { runAccountSync } from '../cron/accountSync';

export interface DashboardSummaryResponse {
  mode: string;
  trading_mode: string;
  market_hours: boolean;
  market_status: 'OPEN' | 'CLOSED_PREMARKET' | 'CLOSED_POSTMARKET' | 'CLOSED_WEEKEND' | 'CLOSED';
  trading_day: boolean;

  cash: number;
  buying_power: number;
  equity: number;

  realized_pnl_today: number;
  unrealized_pnl_open: number;
  open_positions: number;
  open_spreads: number;
  trades_closed_today: number;

  last_updated: string | null;
}

export async function handleDashboardSummary(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const now = new Date();
  const tradingMode = await getTradingMode(env);

  // For now, mode is derived from trading mode
  const mode = tradingMode;

  let snapshot = await getLatestAccountSnapshot(env, mode);

  // If we have no snapshot yet (e.g. before cron window), populate one on-demand
  if (!snapshot) {
    await runAccountSync(env, now);
    snapshot = await getLatestAccountSnapshot(env, mode);
  }

  const {
    cash,
    buying_power,
    equity,
    open_positions,
    trades_closed_today,
    realized_pnl_today,
    unrealized_pnl_open,
    captured_at,
  } = snapshot || {
    cash: 0,
    buying_power: 0,
    equity: 0,
    open_positions: 0,
    trades_closed_today: 0,
    realized_pnl_today: 0,
    unrealized_pnl_open: 0,
    captured_at: null,
  };

  const openTrades = await getOpenTrades(env);
  const tradingDay = isTradingDay(now);
  const marketHours = isMarketHours(now);
  let marketStatus: DashboardSummaryResponse['market_status'] = 'CLOSED';

  if (marketHours) {
    marketStatus = 'OPEN';
  } else if (!tradingDay) {
    marketStatus = 'CLOSED_WEEKEND';
  } else if (isPreMarket(now)) {
    marketStatus = 'CLOSED_PREMARKET';
  } else if (isPostMarket(now)) {
    marketStatus = 'CLOSED_POSTMARKET';
  }

  const body: DashboardSummaryResponse = {
    mode,
    trading_mode: tradingMode,
    market_hours: marketHours,
    market_status: marketStatus,
    trading_day: tradingDay,

    cash: cash ?? 0,
    buying_power: buying_power ?? 0,
    equity: equity ?? 0,

    realized_pnl_today: realized_pnl_today ?? 0,
    unrealized_pnl_open: unrealized_pnl_open ?? 0,
    open_positions: open_positions ?? 0,
    open_spreads: openTrades.length,
    trades_closed_today: trades_closed_today ?? 0,

    last_updated: captured_at ?? null,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}


