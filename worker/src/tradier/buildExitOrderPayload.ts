/**
 * Build exit order payloads from portfolio positions
 * 
 * This module builds market orders for closing positions.
 * It uses portfolio_positions as the source of truth for what we actually hold.
 * 
 * NOTE: Tradier multileg orders require type='credit' or 'debit' with a limit price.
 * For "market" exits, we use a very aggressive limit price (market-like).
 * If multileg fails, we fall back to per-leg market orders.
 */

import type { TradeRow, PortfolioPositionRow } from '../types';

export type ExitOrderPayload =
  | { kind: 'single'; request: SingleLegMarketOrderRequest }
  | { kind: 'multileg'; request: MultiLegMarketOrderRequest }
  | { kind: 'perLeg'; requests: SingleLegMarketOrderRequest[] };

export interface SingleLegMarketOrderRequest {
  symbol: string;
  option_symbol: string;
  side: 'buy_to_close' | 'sell_to_close';
  quantity: number;
  tag: string;
}

export interface MultiLegMarketOrderRequest {
  symbol: string;
  legs: Array<{
    option_symbol: string;
    side: 'buy_to_close' | 'sell_to_close';
    quantity: number;
  }>;
  strategy: string;
  tag: string;
  // Market-like limit price (very aggressive to ensure fill)
  // For credit spreads: use a very high debit limit (willing to pay up to width)
  // For debit spreads: use a very low credit limit (willing to accept minimal credit)
  marketLikeLimitPrice: number;
}

/**
 * Map position side to closing action
 * 
 * - long position → sell_to_close (we sell what we own)
 * - short position → buy_to_close (we buy back what we shorted)
 */
function getClosingSide(position: PortfolioPositionRow): 'buy_to_close' | 'sell_to_close' {
  if (position.side === 'long') {
    return 'sell_to_close';
  } else if (position.side === 'short') {
    return 'buy_to_close';
  } else {
    throw new Error(`Invalid position side: ${position.side}`);
  }
}

/**
 * Format option symbol from position data
 * 
 * Tradier format: SYMBOL + YYMMDD + C/P + STRIKE
 * Example: AAPL260102C00290000
 */
function formatOptionSymbol(
  symbol: string,
  expiration: string,
  strike: number,
  optionType: 'call' | 'put'
): string {
  const expDate = new Date(expiration);
  const yy = expDate.getFullYear().toString().slice(-2);
  const mm = String(expDate.getMonth() + 1).padStart(2, '0');
  const dd = String(expDate.getDate()).padStart(2, '0');
  const expStr = `${yy}${mm}${dd}`;
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  const optionTypeChar = optionType === 'call' ? 'C' : 'P';
  return `${symbol}${expStr}${optionTypeChar}${strikeStr}`;
}

/**
 * Calculate market-like limit price for multileg exit
 * 
 * For market exits, we need to provide a limit price that's aggressive enough to fill.
 * - Credit spread exit: we pay debit, so use width (max we could pay)
 * - Debit spread exit: we receive credit, so use 0.01 (min we'd accept)
 */
function calculateMarketLikeLimitPrice(trade: TradeRow): number {
  const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
  
  if (isDebitSpread) {
    // Debit spread exit: we receive credit, use very low limit (willing to accept minimal credit)
    return 0.01;
  } else {
    // Credit spread exit: we pay debit, use width (max we could pay)
    return trade.width;
  }
}

/**
 * Build exit order payload from trade and positions
 * 
 * Rules:
 * 1. If only one position: build single-leg MARKET order
 * 2. If multiple legs with same symbol/expiration: treat as spread
 * 3. For spreads, use multileg with market-like limit price
 *    If multileg fails, fall back to per-leg MARKET orders
 * 
 * @param trade The trade to close
 * @param positions Positions from portfolio_positions that match this trade
 */
export async function buildExitOrderPayload(
  trade: TradeRow,
  positions: PortfolioPositionRow[]
): Promise<ExitOrderPayload> {
  if (positions.length === 0) {
    throw new Error(`No positions found for trade ${trade.id} - nothing to close`);
  }
  
  // Determine option type from strategy
  if (!trade.strategy) {
    throw new Error(`Trade ${trade.id} missing strategy - cannot determine option type`);
  }
  const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') 
    ? 'call' 
    : 'put';
  
  // Single-leg position: build single-leg market order
  if (positions.length === 1) {
    const position = positions[0];
    const optionSymbol = formatOptionSymbol(
      position.symbol,
      position.expiration,
      position.strike,
      position.option_type
    );
    
    return {
      kind: 'single',
      request: {
        symbol: position.symbol,
        option_symbol: optionSymbol,
        side: getClosingSide(position),
        quantity: position.quantity,
        tag: 'GEKKOWORKS-EXIT-MARKET',
      },
    };
  }
  
  // Multiple legs: try multileg market first, fallback to per-leg
  // NOTE: Tradier may not support multileg market orders directly
  // If multileg market fails, we'll fall back to per-leg market orders
  // For now, we'll build both and let the caller decide
  
  // Check if all positions have same symbol/expiration (required for multileg)
  const symbols = new Set(positions.map(p => p.symbol));
  const expirations = new Set(positions.map(p => p.expiration));
  
  if (symbols.size === 1 && expirations.size === 1) {
    // All positions are for same underlying and expiration - can use multileg
    const symbol = Array.from(symbols)[0];
    const expiration = Array.from(expirations)[0];
    
    const legs = positions.map(position => {
      const optionSymbol = formatOptionSymbol(
        symbol,
        expiration,
        position.strike,
        position.option_type
      );
      
      return {
        option_symbol: optionSymbol,
        side: getClosingSide(position),
        quantity: position.quantity,
      };
    });
    
    // Build multileg request with market-like limit price
    // Tradier requires a limit price for multileg orders, so we use an aggressive one
    const marketLikeLimitPrice = calculateMarketLikeLimitPrice(trade);
    
    const multilegRequest: MultiLegMarketOrderRequest = {
      symbol,
      legs,
      strategy: trade.strategy,
      tag: 'GEKKOWORKS-EXIT-MARKET-MULTILEG',
      marketLikeLimitPrice,
    };
    
    return {
      kind: 'multileg',
      request: multilegRequest,
    };
  } else {
    // Positions have different symbols/expirations - must use per-leg orders
    const perLegRequests: SingleLegMarketOrderRequest[] = positions.map(position => {
      const optionSymbol = formatOptionSymbol(
        position.symbol,
        position.expiration,
        position.strike,
        position.option_type
      );
      
      return {
        symbol: position.symbol,
        option_symbol: optionSymbol,
        side: getClosingSide(position),
        quantity: position.quantity,
        tag: 'GEKKOWORKS-EXIT-MARKET',
      };
    });
    
    return {
      kind: 'perLeg',
      requests: perLegRequests,
    };
  }
}

