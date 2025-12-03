/**
 * Place market exit orders
 * 
 * This module handles placing market orders for closing positions.
 * It uses portfolio_positions as the source of truth and builds market orders.
 */

import type { Env } from '../env';
import type { TradeRow, BrokerOrder } from '../types';
import { TradierClient } from '../broker/tradierClient';
import { getOpenPositionsForTrade } from '../portfolio/getOpenPositionsForTrade';
import { buildExitOrderPayload, type ExitOrderPayload } from '../tradier/buildExitOrderPayload';
import { generateClientOrderId, createOrderRecord, updateOrderWithTradierResponse, linkOrderToTrade } from './orderHelpers';
import { insertProposal } from '../db/queries';

/**
 * Place market exit order(s) for a trade
 * 
 * This function:
 * 1. Gets positions from portfolio_positions
 * 2. Builds exit order payload (single-leg, multileg, or per-leg)
 * 3. Places market orders
 * 4. Falls back to per-leg market orders if multileg fails
 * 
 * @returns The broker order ID(s) and success status
 */
export async function placeMarketExitOrder(
  env: Env,
  trade: TradeRow,
  now: Date
): Promise<{
  success: boolean;
  orderIds: string[];
  reason?: string;
}> {
  const broker = new TradierClient(env);
  
  // Step 1: Get positions from portfolio_positions (source of truth)
  const positions = await getOpenPositionsForTrade(env, trade);
  
  if (positions.length === 0) {
    return {
      success: false,
      orderIds: [],
      reason: 'No positions found in portfolio_positions - nothing to close',
    };
  }
  
  // Step 2: Build exit order payload
  const payload = await buildExitOrderPayload(trade, positions);
  
  // Step 3: Log the payload
  console.log('[exit][market-order][payload]', JSON.stringify({
    trade_id: trade.id,
    symbol: trade.symbol,
    strategy: trade.strategy,
    payload_kind: payload.kind,
    positions_count: positions.length,
    positions: positions.map(p => ({
      strike: p.strike,
      side: p.side,
      quantity: p.quantity,
      option_type: p.option_type,
    })),
    payload: payload,
    timestamp: now.toISOString(),
  }));
  
  // Step 4: Create exit proposal and order record
  const exitProposal = await insertProposal(env, {
    id: crypto.randomUUID(),
    symbol: trade.symbol,
    expiration: trade.expiration,
    short_strike: trade.short_strike,
    long_strike: trade.long_strike,
    width: trade.width,
    quantity: trade.quantity,
    strategy: trade.strategy || 'BULL_PUT_CREDIT',
    credit_target: 0, // Market orders don't have a target price
    score: 0,
    ivr_score: 0,
    vertical_skew_score: 0,
    term_structure_score: 0,
    delta_fitness_score: 0,
    ev_score: 0,
    status: 'READY',
    kind: 'EXIT',
    linked_trade_id: trade.id,
  });
  
  const clientOrderId = generateClientOrderId(exitProposal.id, 'EXIT');
  await createOrderRecord(env, exitProposal, 'EXIT', clientOrderId);
  
  // Step 5: Place orders based on payload kind
  const orderIds: string[] = [];
  
  try {
    switch (payload.kind) {
      case 'single': {
        // Single-leg market order
        const order = await broker.placeSingleLegCloseOrder({
          symbol: payload.request.symbol,
          option_symbol: payload.request.option_symbol,
          side: payload.request.side,
          quantity: payload.request.quantity,
          tag: payload.request.tag,
        });
        
        orderIds.push(order.id);
        await updateOrderWithTradierResponse(env, clientOrderId, order.id, 'PLACED');
        await linkOrderToTrade(env, clientOrderId, trade.id);
        
        console.log('[exit][market-order][single-leg][placed]', JSON.stringify({
          trade_id: trade.id,
          order_id: order.id,
          option_symbol: payload.request.option_symbol,
          side: payload.request.side,
          quantity: payload.request.quantity,
          timestamp: now.toISOString(),
        }));
        break;
      }
      
      case 'multileg': {
        // Multileg order with market-like limit price
        // Try multileg first, fall back to per-leg if it fails
        try {
          const order = await broker.placeSpreadOrder({
            symbol: payload.request.symbol,
            side: 'EXIT',
            legs: payload.request.legs.map(leg => ({
              option_symbol: leg.option_symbol,
              side: leg.side,
              quantity: leg.quantity,
            })),
            tag: payload.request.tag,
            strategy: payload.request.strategy,
            limit_price: payload.request.marketLikeLimitPrice, // Market-like limit
            client_order_id: clientOrderId,
          });
          
          orderIds.push(order.id);
          await updateOrderWithTradierResponse(env, clientOrderId, order.id, 'PLACED');
          await linkOrderToTrade(env, clientOrderId, trade.id);
          
          console.log('[exit][market-order][multileg][placed]', JSON.stringify({
            trade_id: trade.id,
            order_id: order.id,
            legs: payload.request.legs,
            market_like_limit_price: payload.request.marketLikeLimitPrice,
            timestamp: now.toISOString(),
          }));
        } catch (multilegError) {
          // Multileg failed - fall back to per-leg market orders
          console.warn('[exit][market-order][multileg][failed][falling-back]', JSON.stringify({
            trade_id: trade.id,
            error: multilegError instanceof Error ? multilegError.message : String(multilegError),
            note: 'Falling back to per-leg market orders',
            timestamp: now.toISOString(),
          }));
          
          // Build per-leg requests from multileg request
          const perLegRequests = payload.request.legs.map(leg => ({
            symbol: payload.request.symbol,
            option_symbol: leg.option_symbol,
            side: leg.side,
            quantity: leg.quantity,
            tag: 'GEKKOWORKS-EXIT-MARKET',
          }));
          
          // Place each leg as a separate market order
          for (const req of perLegRequests) {
            const order = await broker.placeSingleLegCloseOrder(req);
            orderIds.push(order.id);
            
            // Create separate order records for each leg
            const legClientOrderId = generateClientOrderId(exitProposal.id, 'EXIT');
            await updateOrderWithTradierResponse(env, legClientOrderId, order.id, 'PLACED');
            await linkOrderToTrade(env, legClientOrderId, trade.id);
            
            console.log('[exit][market-order][per-leg][placed]', JSON.stringify({
              trade_id: trade.id,
              order_id: order.id,
              option_symbol: req.option_symbol,
              side: req.side,
              quantity: req.quantity,
              timestamp: now.toISOString(),
            }));
          }
        }
        break;
      }
      
      case 'perLeg': {
        // Per-leg market orders (already split)
        for (const req of payload.requests) {
          const order = await broker.placeSingleLegCloseOrder(req);
          orderIds.push(order.id);
          
          // Create separate order records for each leg
          const legClientOrderId = generateClientOrderId(exitProposal.id, 'EXIT');
          await updateOrderWithTradierResponse(env, legClientOrderId, order.id, 'PLACED');
          await linkOrderToTrade(env, legClientOrderId, trade.id);
          
          console.log('[exit][market-order][per-leg][placed]', JSON.stringify({
            trade_id: trade.id,
            order_id: order.id,
            option_symbol: req.option_symbol,
            side: req.side,
            quantity: req.quantity,
            timestamp: now.toISOString(),
          }));
        }
        break;
      }
    }
    
    // Step 6: Log Tradier response
    console.log('[exit][market-order][tradier-response]', JSON.stringify({
      trade_id: trade.id,
      payload_kind: payload.kind,
      order_ids: orderIds,
      success: true,
      timestamp: now.toISOString(),
    }));
    
    return {
      success: true,
      orderIds,
    };
  } catch (error) {
    console.error('[exit][market-order][error]', JSON.stringify({
      trade_id: trade.id,
      payload_kind: payload.kind,
      error: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : undefined,
      timestamp: now.toISOString(),
    }));
    
    return {
      success: false,
      orderIds: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

