/**
 * Telegram notification helpers
 *
 * Sends lifecycle alerts without impacting core trading flow.
 */

import type { Env } from '../env';
import type { ProposalRow, TradeRow } from '../types';
import type { TradingMode } from '../core/config';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[telegram] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, skipping message');
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn('[telegram] sendMessage failed', res.status, await res.text());
    }
  } catch (err) {
    console.warn('[telegram] sendMessage error', err);
  }
}

export async function notifyProposalCreated(env: Env, mode: TradingMode, proposal: ProposalRow): Promise<void> {
  // Determine option type and strike labels based on strategy
  const isCall = proposal.strategy === 'BEAR_CALL_CREDIT' || proposal.strategy === 'BULL_CALL_DEBIT';
  const optionType = isCall ? 'call' : 'put';
  const shortLabel = `Short ${optionType}`;
  const longLabel = `Long ${optionType}`;
  
  // Format strategy name for display
  const strategyName = proposal.strategy?.replace(/_/g, ' ') || 'UNKNOWN';
  
  const lines = [
    '*Gekkoworks – Proposal Created*',
    `Mode: \`${mode}\``,
    `Strategy: \`${strategyName}\``,
    `Symbol: ${proposal.symbol}`,
    `Expiration: ${proposal.expiration}`,
    `${shortLabel}: ${proposal.short_strike}`,
    `${longLabel}: ${proposal.long_strike}`,
    `Width: ${proposal.width}`,
    `Credit target: $${proposal.credit_target.toFixed(2)}`,
    `Score: ${(proposal.score * 100).toFixed(1)}%`,
  ];

  await sendTelegramMessage(env, lines.join('\n'));
}

export async function notifyEntrySubmitted(env: Env, mode: TradingMode, trade: TradeRow, limitPrice: number): Promise<void> {
  // Determine option type and strike labels based on strategy
  const isCall = trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT';
  const optionType = isCall ? 'call' : 'put';
  const shortLabel = `Short ${optionType}`;
  const longLabel = `Long ${optionType}`;
  
  // Format strategy name for display
  const strategyName = trade.strategy?.replace(/_/g, ' ') || 'UNKNOWN';
  
  const lines = [
    '*Gekkoworks – Entry Submitted*',
    `Mode: \`${mode}\``,
    `Strategy: \`${strategyName}\``,
    `Trade ID: \`${trade.id}\``,
    `Symbol: ${trade.symbol}`,
    `Expiration: ${trade.expiration}`,
    `${shortLabel}: ${trade.short_strike}`,
    `${longLabel}: ${trade.long_strike}`,
    `Width: ${trade.width}`,
    `Quantity: ${trade.quantity ?? 1}`,
    `Entry limit: $${limitPrice.toFixed(2)}`,
    trade.broker_order_id_open ? `Order ID: \`${trade.broker_order_id_open}\`` : '',
  ].filter(Boolean);

  await sendTelegramMessage(env, lines.join('\n'));
}

export async function notifyEntryFilled(env: Env, mode: TradingMode, trade: TradeRow): Promise<void> {
  // Determine option type and strike labels based on strategy
  const isCall = trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT';
  const optionType = isCall ? 'call' : 'put';
  const shortLabel = `Short ${optionType}`;
  const longLabel = `Long ${optionType}`;
  
  // Format strategy name for display
  const strategyName = trade.strategy?.replace(/_/g, ' ') || 'UNKNOWN';
  
  const lines = [
    '*Gekkoworks – Trade Opened*',
    `Mode: \`${mode}\``,
    `Strategy: \`${strategyName}\``,
    `Trade ID: \`${trade.id}\``,
    `Symbol: ${trade.symbol}`,
    `Expiration: ${trade.expiration}`,
    `${shortLabel}: ${trade.short_strike}`,
    `${longLabel}: ${trade.long_strike}`,
    `Width: ${trade.width}`,
    `Quantity: ${trade.quantity ?? 1}`,
    `Entry fill: $${(trade.entry_price ?? 0).toFixed(2)}`,
    trade.max_profit !== null ? `Max profit: $${trade.max_profit.toFixed(2)}` : '',
    trade.max_loss !== null ? `Max loss: $${trade.max_loss.toFixed(2)}` : '',
    trade.broker_order_id_open ? `Order ID: \`${trade.broker_order_id_open}\`` : '',
  ].filter(Boolean);

  await sendTelegramMessage(env, lines.join('\n'));
}

export async function notifyExitSubmitted(env: Env, mode: TradingMode, trade: TradeRow, exitPrice: number): Promise<void> {
  // Determine option type and strike labels based on strategy
  const isCall = trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT';
  const optionType = isCall ? 'call' : 'put';
  const shortLabel = `Short ${optionType}`;
  const longLabel = `Long ${optionType}`;
  
  // Format strategy name for display
  const strategyName = trade.strategy?.replace(/_/g, ' ') || 'UNKNOWN';
  
  const lines = [
    '*Gekkoworks – Exit Submitted*',
    `Mode: \`${mode}\``,
    `Strategy: \`${strategyName}\``,
    `Trade ID: \`${trade.id}\``,
    `Symbol: ${trade.symbol}`,
    `Expiration: ${trade.expiration}`,
    `${shortLabel}: ${trade.short_strike}`,
    `${longLabel}: ${trade.long_strike}`,
    `Quantity: ${trade.quantity ?? 1}`,
    `Exit limit: $${exitPrice.toFixed(2)}`,
    trade.exit_reason ? `Exit reason: \`${trade.exit_reason}\`` : '',
    trade.broker_order_id_close ? `Order ID: \`${trade.broker_order_id_close}\`` : '',
  ].filter(Boolean);

  await sendTelegramMessage(env, lines.join('\n'));
}

export async function notifyExitFilled(env: Env, mode: TradingMode, trade: TradeRow): Promise<void> {
  // Determine option type and strike labels based on strategy
  const isCall = trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT';
  const optionType = isCall ? 'call' : 'put';
  const shortLabel = `Short ${optionType}`;
  const longLabel = `Long ${optionType}`;
  
  // Format strategy name for display
  const strategyName = trade.strategy?.replace(/_/g, ' ') || 'UNKNOWN';
  
  // Format PnL with color indicator
  const pnl = trade.realized_pnl ?? 0;
  const pnlFormatted = pnl >= 0 
    ? `+$${pnl.toFixed(2)} ✅` 
    : `-$${Math.abs(pnl).toFixed(2)} ❌`;
  
  const lines = [
    '*Gekkoworks – Trade Closed*',
    `Mode: \`${mode}\``,
    `Strategy: \`${strategyName}\``,
    `Trade ID: \`${trade.id}\``,
    `Symbol: ${trade.symbol}`,
    `Expiration: ${trade.expiration}`,
    `${shortLabel}: ${trade.short_strike}`,
    `${longLabel}: ${trade.long_strike}`,
    `Quantity: ${trade.quantity ?? 1}`,
    `Entry: $${(trade.entry_price ?? 0).toFixed(2)}`,
    `Exit fill: $${(trade.exit_price ?? 0).toFixed(2)}`,
    `Realized PnL: ${pnlFormatted}`,
    trade.exit_reason ? `Exit reason: \`${trade.exit_reason}\`` : 'Exit reason: `UNKNOWN`',
    trade.broker_order_id_close ? `Order ID: \`${trade.broker_order_id_close}\`` : '',
    trade.opened_at && trade.closed_at ? `Duration: ${Math.round((new Date(trade.closed_at).getTime() - new Date(trade.opened_at).getTime()) / (1000 * 60 * 60 * 24))} days` : '',
  ].filter(Boolean);

  await sendTelegramMessage(env, lines.join('\n'));
}


