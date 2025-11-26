import type { Env } from '../env';
import { getAllTrades, getOpenTrades } from '../db/queries';
import { evaluateOpenTrade } from '../engine/monitoring';

export async function handleDebugPnl(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const now = new Date();
    const trades = await getAllTrades(env, 1000);

    const todayStr = now.toISOString().split('T')[0];
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    let realizedToday = 0;
    let realizedWeek = 0;
    let realizedTotal = 0;

    for (const t of trades) {
      if (t.status === 'CLOSED' && t.realized_pnl != null) {
        realizedTotal += t.realized_pnl;
        const closedDate = t.closed_at?.split('T')[0];
        if (closedDate === todayStr) {
          realizedToday += t.realized_pnl;
        }
        if (t.closed_at && t.closed_at >= weekAgo.toISOString()) {
          realizedWeek += t.realized_pnl;
        }
      }
    }

    const openTrades = await getOpenTrades(env);
    const unrealized: Array<{
      trade_id: string;
      symbol: string;
      expiration: string;
      short_strike: number;
      long_strike: number;
      unrealized_pnl: number;
      pnl_fraction: number;
    }> = [];
    let unrealizedTotal = 0;

    for (const trade of openTrades) {
      if (trade.status !== 'OPEN') continue;
      try {
        const decision = await evaluateOpenTrade(env, trade, now);
        const m = decision.metrics;
        unrealized.push({
          trade_id: trade.id,
          symbol: trade.symbol,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          unrealized_pnl: m.unrealized_pnl,
          pnl_fraction: m.pnl_fraction,
        });
        unrealizedTotal += m.unrealized_pnl;
      } catch {
        // Ignore evaluation errors in debug endpoint
      }
    }

    const body = {
      realized: {
        today: realizedToday,
        last_7d: realizedWeek,
        total: realizedTotal,
      },
      unrealized: {
        total: unrealizedTotal,
        by_trade: unrealized,
      },
      meta: {
        trades_considered: trades.length,
        open_trades: openTrades.length,
        now: now.toISOString(),
      },
    };

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify(
        {
          error: error?.message ?? String(error),
        },
        null,
        2
      ),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}


