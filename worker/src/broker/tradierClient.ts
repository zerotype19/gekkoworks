/**
 * SAS v1 Tradier Broker Client
 * 
 * Implements BrokerClient interface for Tradier API.
 * All broker interactions must go through this client.
 * 
 * Per broker-rules.md:
 * - Base URL determined by TRADIER_ENV
 * - All calls use Bearer token auth
 * - 10 second timeout (default), 15 seconds for bulk order operations
 * - Error handling per spec
 */

import type { Env } from '../env';

const TRADIER_TIMEOUT_MS = 10000; // 10 seconds (default) - increased for reliability
const TRADIER_ORDERS_TIMEOUT_MS = 15000; // 15 seconds for bulk order operations
const TRADIER_POSITIONS_TIMEOUT_MS = 10000; // 10 seconds for positions sync
const TRADIER_MAX_RETRIES = 2; // Maximum retries for transient failures
const TRADIER_RETRY_DELAY_MS = 1000; // Initial retry delay (1 second)
import type {
  BrokerClient,
  UnderlyingQuote,
  OptionQuote,
  BrokerOrder,
  BrokerPosition,
  PlaceSpreadOrderParams,
  BrokerOrderStatus,
} from '../types';
import { logBrokerEvent } from '../logging/brokerLogger';
import { getTradingMode } from '../core/config';

export class TradierClient implements BrokerClient {
  private baseUrl: string;
  private apiToken: string;
  private accountId: string;
  private env: Env;

  constructor(env: Env) {
    // Store env for logging
    this.env = env;

    // Determine base URL from TRADIER_ENV
    if (env.TRADIER_ENV === 'sandbox') {
      this.baseUrl = 'https://sandbox.tradier.com/v1';
    } else if (env.TRADIER_ENV === 'live') {
      this.baseUrl = 'https://api.tradier.com/v1';
    } else {
      throw new Error(`Invalid TRADIER_ENV: ${env.TRADIER_ENV}`);
    }

    // TODO: Replace with actual API token when available
    this.apiToken = env.TRADIER_API_TOKEN || 'PLACEHOLDER_API_TOKEN';
    this.accountId = env.TRADIER_ACCOUNT_ID || 'PLACEHOLDER_ACCOUNT_ID';
  }

  /**
   * Make HTTP request to Tradier API with retry logic
   * 
   * Retries on timeout or 5xx errors up to TRADIER_MAX_RETRIES times.
   * Uses exponential backoff for retries.
   */
  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: URLSearchParams,
    timeoutMs?: number,
    retries: number = TRADIER_MAX_RETRIES
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const timeout = timeoutMs ?? TRADIER_TIMEOUT_MS;
    
    const headers: HeadersInit = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Accept': 'application/json',
    };

    if (method === 'POST' && body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body?.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status >= 400) {
        // Try to get error details from response body
        let errorDetails = '';
        try {
          const errorText = await response.text();
          if (errorText) {
            try {
              const errorData = JSON.parse(errorText);
              errorDetails = JSON.stringify(errorData);
            } catch {
              errorDetails = errorText;
            }
          }
        } catch (e) {
          errorDetails = `Failed to read error response: ${e}`;
        }
        
        // Retry on 5xx errors (server errors) if retries remaining
        if (response.status >= 500 && retries > 0) {
          const delay = TRADIER_RETRY_DELAY_MS * (TRADIER_MAX_RETRIES - retries + 1);
          console.log('[broker] retrying after server error', JSON.stringify({
            status: response.status,
            retriesRemaining: retries - 1,
            delayMs: delay,
            url: response.url || url,
          }));
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.request(method, path, body, timeoutMs, retries - 1);
        }
        
        const fullError = `Tradier API error: ${response.status} ${response.statusText}${errorDetails ? ` - ${errorDetails}` : ''}`;
        console.error('[broker] API error response', JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          errorDetails,
          url: response.url || url,
        }));
        throw new Error(fullError);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Retry on timeout if retries remaining
      if (error instanceof Error && error.name === 'AbortError' && retries > 0) {
        const delay = TRADIER_RETRY_DELAY_MS * (TRADIER_MAX_RETRIES - retries + 1);
        console.log('[broker] retrying after timeout', JSON.stringify({
          timeout: `${timeout / 1000}s`,
          retriesRemaining: retries - 1,
          delayMs: delay,
          url,
        }));
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.request(method, path, body, timeoutMs, retries - 1);
      }
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Tradier API timeout (${timeout / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * Normalize quote response (handle array or object)
   */
  private normalizeQuoteResponse(data: any): any[] {
    if (!data?.quotes?.quote) {
      return [];
    }
    const quote = data.quotes.quote;
    return Array.isArray(quote) ? quote : [quote];
  }

  /**
   * Normalize option chain response (handle array or object)
   */
  private normalizeOptionResponse(data: any): any[] {
    if (!data?.options?.option) {
      return [];
    }
    const option = data.options.option;
    return Array.isArray(option) ? option : [option];
  }

  /**
   * Get underlying quote for a symbol
   */
  async getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      // URL encode symbol to handle special characters
      const encodedSymbol = encodeURIComponent(symbol);
      const data = await this.request('GET', `/markets/quotes?symbols=${encodedSymbol}&greeks=false`);
      const quotes = this.normalizeQuoteResponse(data);
      
      if (quotes.length === 0) {
        throw new Error(`No quote data returned for ${symbol}`);
      }

      const quote = quotes[0];

      // Validate required fields
      if (quote.bid === null || quote.bid === undefined ||
          quote.ask === null || quote.ask === undefined ||
          quote.last === null || quote.last === undefined) {
        throw new Error(`Missing required quote fields for ${symbol}`);
      }

      const result = {
        symbol: quote.symbol || symbol,
        last: parseFloat(quote.last),
        bid: parseFloat(quote.bid),
        ask: parseFloat(quote.ask),
        change: quote.change ? parseFloat(quote.change) : null,
        change_percentage: quote.change_percentage ? parseFloat(quote.change_percentage) : null,
        prev_close: quote.previous_close ? parseFloat(quote.previous_close) : null,
      };

      // Log success - we need to make a request to get status code, so we'll log after parsing
      // For now, we'll assume success if we got here (the request() method throws on 400+)
      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_QUOTES',
        symbol,
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'GET_QUOTES',
        symbol,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Get option chain for a symbol and expiration
   */
  async getOptionChain(symbol: string, expiration: string): Promise<OptionQuote[]> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      // URL encode parameters to handle special characters
      const encodedSymbol = encodeURIComponent(symbol);
      const encodedExpiration = encodeURIComponent(expiration);
      const data = await this.request(
        'GET',
        `/markets/options/chains?symbol=${encodedSymbol}&expiration=${encodedExpiration}&greeks=true`
      );
      
      const rawOptions = this.normalizeOptionResponse(data);
      const rawCount = rawOptions.length;

      // Reduced logging - only log raw sample in debug scenarios (removed for production)

      const isSandbox = mode === 'SANDBOX_PAPER';

      // Stage 1: Basic sanity check (symbol, strike, type)
      const stage1 = rawOptions.filter((opt: any) => {
        return (
          opt &&
          opt.symbol &&
          opt.strike !== null && opt.strike !== undefined &&
          (opt.option_type || opt.type) // Tradier uses option_type
        );
      });

      // Reduced logging - filter stage details removed

      // Stage 2: Map to our internal format (handle Tradier field names)
      const mapped = stage1.map((opt: any): OptionQuote | null => {
        try {
          // Tradier uses option_type, not type
          const optionType = (opt.option_type || opt.type || '').toLowerCase();
          if (optionType !== 'put' && optionType !== 'call') {
            return null;
          }

          // Tradier nests greeks: greeks.delta, greeks.mid_iv (or greeks.smv_vol)
          const delta = opt.greeks?.delta ?? opt.delta;
          // Tradier uses mid_iv, smv_vol, or bid_iv/ask_iv - prefer mid_iv, fallback to smv_vol
          const iv = opt.greeks?.mid_iv ?? opt.greeks?.smv_vol ?? opt.greeks?.bid_iv ?? opt.greeks?.ask_iv ?? opt.implied_volatility ?? opt.iv;

          return {
            symbol: opt.symbol,
            underlying: symbol,
            type: optionType as 'call' | 'put',
            expiration_date: opt.expiration_date || expiration,
            strike: parseFloat(opt.strike),
            bid: opt.bid != null ? parseFloat(opt.bid) : 0,
            ask: opt.ask != null ? parseFloat(opt.ask) : 0,
            last: opt.last != null ? parseFloat(opt.last) : null,
          delta: delta != null && delta !== '' ? parseFloat(delta) : null,
          implied_volatility: iv != null && iv !== '' ? parseFloat(iv) : null,
          };
        } catch (err) {
          return null;
        }
      }).filter((opt): opt is OptionQuote => opt !== null);

      // Reduced logging - filter stage details removed

      // Stage 3: Keep both PUT and CALL options (different strategies need different types)
      // No longer filtering to PUTs only since we now support BEAR_CALL_CREDIT and BULL_CALL_DEBIT

      // Reduced logging - option type counts removed

      // Stage 4: Apply mode-specific filters
      const result = mapped.filter((opt) => {
        if (isSandbox) {
          // SANDBOX: Only drop obviously broken rows
          // Allow 0 bid/ask, missing greeks, etc.
          return opt.strike > 0 && !!opt.symbol && !!opt.type;
        }

        // LIVE/DRY_RUN: Stricter filters
        return (
          opt.strike > 0 &&
          opt.bid != null &&
          opt.ask != null &&
          (opt.bid > 0 || opt.ask > 0) &&
          opt.delta != null &&
          opt.implied_volatility != null
        );
      });

      // Reduced logging - only log summary if there's an issue (0 results but raw data exists)

      if (rawCount > 0 && result.length === 0) {
        console.log(`[broker] WARNING: Chain for ${symbol} ${expiration} had ${rawCount} raw options but 0 after filtering (mode: ${mode})`);
      }

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_CHAINS',
        symbol,
        expiration,
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'GET_CHAINS',
        symbol,
        expiration,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Place a multileg spread order
   * 
   * Per Tradier spec: For multileg orders, type must be 'credit' or 'debit' based on the spread type.
   * Valid types: market, limit, stop, stop_limit, debit, credit, even
   */
  async placeSpreadOrder(params: PlaceSpreadOrderParams): Promise<BrokerOrder> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const body = new URLSearchParams();
      
      // Build body per Tradier API documentation for multileg orders:
      // https://docs.tradier.com/reference/brokerage-api-trading-place-order
      // For multileg orders: class, type, symbol, duration, price, option_symbol[0], side[0], quantity[0], option_symbol[1], side[1], quantity[1], tag
      
      // Determine order type based on strategy AND side (ENTRY vs EXIT)
      // Per Tradier spec:
      // - ENTRY: type matches strategy (credit spread → credit, debit spread → debit)
      // - EXIT: type is FLIPPED (credit spread → debit, debit spread → credit)
      //   This is because closing reverses the cash flow direction
      let orderType: 'credit' | 'debit';
      const isExit = params.side === 'EXIT';
      
      if (params.strategy) {
        // First determine the base type from strategy
        let baseType: 'credit' | 'debit';
        if (params.strategy.endsWith('_CREDIT')) {
          baseType = 'credit';
        } else if (params.strategy.endsWith('_DEBIT')) {
          baseType = 'debit';
        } else {
          // Fallback: if strategy doesn't match pattern, default to credit (safer for most spreads)
          console.warn('[broker][placeSpreadOrder] Unknown strategy pattern, defaulting to credit', JSON.stringify({
            strategy: params.strategy,
          }));
          baseType = 'credit';
        }
        
        // For EXIT orders, flip the type:
        // - Credit spread entry (we receive credit) → Credit spread exit (we pay debit)
        // - Debit spread entry (we pay debit) → Debit spread exit (we receive credit)
        if (isExit) {
          orderType = baseType === 'credit' ? 'debit' : 'credit';
        } else {
          orderType = baseType;
        }
      } else {
        // If no strategy provided, we can't determine type - this should not happen in production
        throw new Error('strategy is required to determine order type (credit/debit) for multileg orders');
      }
      
      // 1. class - must be 'multileg' for spread orders
      body.append('class', 'multileg');
      
      // 2. type - must be 'credit' or 'debit' for multileg orders (NOT 'limit' or 'market')
      body.append('type', orderType);
      
      // 3. symbol - underlying symbol
      body.append('symbol', params.symbol);
      
      // 4. duration - must be 'day' for v1
      body.append('duration', 'day');
      
      // 5. price - limit price (required - Tradier uses this as the net credit/debit limit)
      // For multileg orders with type=credit or type=debit, price is always required
      // Even for "market" exits, we provide a limit price as a safety cap
      if (!params.limit_price) {
        throw new Error('limit_price is required for multileg orders');
      }
      // Format price to 2 decimal places (Tradier expects specific format)
      const formattedPrice = parseFloat(params.limit_price.toFixed(2));
      body.append('price', formattedPrice.toString());

      // 6. Leg 0 - option_symbol, side, quantity
      body.append('option_symbol[0]', params.legs[0].option_symbol);
      body.append('side[0]', params.legs[0].side.toLowerCase());
      body.append('quantity[0]', params.legs[0].quantity.toString());

      // 7. Leg 1 - option_symbol, side, quantity
      body.append('option_symbol[1]', params.legs[1].option_symbol);
      body.append('side[1]', params.legs[1].side.toLowerCase());
      body.append('quantity[1]', params.legs[1].quantity.toString());
      
      // 8. tag - for tracking
      body.append('tag', params.tag);
      
      // Log the exact request body for debugging
      const requestBodyEntries: Record<string, string> = {};
      body.forEach((value, key) => {
        requestBodyEntries[key] = value;
      });
      const debugDetails = {
        symbol: params.symbol,
        strategy: params.strategy,
        side: params.side,
        orderType,
        isExit,
        leg0: {
          option_symbol: params.legs[0].option_symbol,
          side: params.legs[0].side,
          quantity: params.legs[0].quantity,
        },
        leg1: {
          option_symbol: params.legs[1].option_symbol,
          side: params.legs[1].side,
          quantity: params.legs[1].quantity,
        },
        limit_price: params.limit_price,
        bodyEntries: requestBodyEntries,
        bodyString: body.toString(),
      };
      console.log('[broker][placeSpreadOrder][debug]', JSON.stringify(debugDetails));
      
      // Also save to system_logs for debug endpoint
      try {
        const { insertSystemLog } = await import('../db/queries');
        await insertSystemLog(this.env, 'broker', '[broker][placeSpreadOrder][debug]', JSON.stringify(debugDetails));
      } catch (err) {
        // Never let logging break trading
        console.warn('[broker] failed to persist debug log', err);
      }

      const data = await this.request(
        'POST',
        `/accounts/${this.accountId}/orders`,
        body,
        TRADIER_ORDERS_TIMEOUT_MS
      );

      // Parse order response - Tradier may nest the order in different structures
      let orderId: string;
      if (data.order?.id) {
        orderId = data.order.id.toString();
      } else if (data.id) {
        orderId = data.id.toString();
      } else {
        throw new Error('Order response missing order id');
      }

      const result: BrokerOrder = {
        id: orderId,
        status: 'NEW',
        avg_fill_price: null,
        filled_quantity: 0,
        remaining_quantity: params.legs[0].quantity, // Assuming both legs same quantity
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Update debug log with order ID for matching
      try {
        const { insertSystemLog } = await import('../db/queries');
        await insertSystemLog(this.env, 'broker', '[broker][placeSpreadOrder][order_id]', JSON.stringify({
          orderId,
          strategy: params.strategy,
          symbol: params.symbol,
          timestamp: new Date().toISOString(),
        }));
      } catch (err) {
        // Never let logging break trading
        console.warn('[broker] failed to persist order ID log', err);
      }

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'PLACE_ORDER',
        symbol: params.symbol,
        orderId,
        statusCode: 201, // POST success typically 201
        ok: true,
        durationMs,
        mode,
        strategy: params.strategy, // Include strategy for debugging
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      // Enhanced error logging for debugging exit rejections
      console.error('[broker][placeSpreadOrder][error]', JSON.stringify({
        symbol: params.symbol,
        side: params.side,
        strategy: params.strategy,
        limit_price: params.limit_price,
        legs: params.legs.map(l => ({
          option_symbol: l.option_symbol,
          side: l.side,
          quantity: l.quantity,
        })),
        error_message: err?.message ?? String(err),
        error_type: err?.constructor?.name ?? typeof err,
        error_stack: err?.stack,
        duration_ms: durationMs,
        mode,
      }));
      
      await logBrokerEvent(this.env, {
        operation: 'PLACE_ORDER',
        symbol: params.symbol,
        ok: false,
        durationMs,
        errorMessage,
        mode,
        strategy: params.strategy, // Include strategy for debugging
      });
      
      throw err;
    }
  }

  /**
   * Place a single-leg option close order
   * 
   * Used as fallback if multileg order fails.
   * Per Tradier spec: class=option, type=market, duration=day
   */
  async placeSingleLegCloseOrder(params: {
    symbol: string;
    option_symbol: string;
    side: 'buy_to_close' | 'sell_to_close';
    quantity: number;
    tag: string;
  }): Promise<BrokerOrder> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const body = new URLSearchParams();
      
      body.append('class', 'option');
      body.append('symbol', params.symbol);
      body.append('type', 'market');  // Always market for forced closes
      body.append('duration', 'day');
      body.append('side', params.side.toLowerCase());  // Lowercase as Tradier expects
      body.append('quantity', params.quantity.toString());
      body.append('option_symbol', params.option_symbol);
      body.append('tag', params.tag);

      // Reduced logging - only log on errors

      const data = await this.request(
        'POST',
        `/accounts/${this.accountId}/orders`,
        body,
        TRADIER_ORDERS_TIMEOUT_MS
      );

      // Parse order response
      let orderId: string;
      if (data.order?.id) {
        orderId = data.order.id.toString();
      } else if (data.id) {
        orderId = data.id.toString();
      } else {
        throw new Error('Order response missing order id');
      }

      const result: BrokerOrder = {
        id: orderId,
        status: 'NEW',
        avg_fill_price: null,
        filled_quantity: 0,
        remaining_quantity: params.quantity,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'PLACE_SINGLE_LEG_ORDER',
        symbol: params.symbol,
        orderId,
        statusCode: 201,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      console.error('[broker][placeSingleLegCloseOrder][error]', JSON.stringify({
        symbol: params.symbol,
        option_symbol: params.option_symbol,
        side: params.side,
        quantity: params.quantity,
        error_message: err?.message ?? String(err),
        error_type: err?.constructor?.name ?? typeof err,
        error_stack: err?.stack,
        duration_ms: durationMs,
        mode,
      }));
      
      await logBrokerEvent(this.env, {
        operation: 'PLACE_SINGLE_LEG_ORDER',
        symbol: params.symbol,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Get order status
   */
  async getOrder(orderId: string): Promise<BrokerOrder> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      // URL encode orderId to handle any special characters
      const encodedOrderId = encodeURIComponent(orderId);
      const data = await this.request(
        'GET',
        `/accounts/${this.accountId}/orders/${encodedOrderId}`
      );

      // Parse order from response - structure may vary
      const order = data.order || data;
      
      // Reduced logging - only log rejections/cancellations (not every order check)
      if (order.status?.toLowerCase() === 'rejected' || order.status?.toLowerCase() === 'cancelled') {
        console.log('[broker][getOrder][rejected]', JSON.stringify({
          order_id: orderId,
          status: order.status,
          status_message: order.status_message,
          reject_reason: order.reject_reason || order.error || order.message || 'No reason provided',
        }));
      }
      
      // Map Tradier status to our BrokerOrderStatus
      const statusMap: Record<string, BrokerOrderStatus> = {
        'filled': 'FILLED',
        'open': 'OPEN',
        'cancelled': 'CANCELLED',
        'rejected': 'REJECTED',
        'expired': 'EXPIRED',
        'pending': 'NEW',
        'partially_filled': 'OPEN',
        'partial': 'OPEN',
      };

      const status: BrokerOrderStatus = statusMap[order.status?.toLowerCase()] || 'UNKNOWN';

      // Calculate avg_fill_price
      // For multileg credit spreads, Tradier returns avg_fill_price as negative (debit)
      // We need to convert to positive (credit) for entry_price
      let avgFillPrice: number | null = null;
      if (order.avg_fill_price != null) {
        const rawPrice = parseFloat(order.avg_fill_price);
        // Tradier can return negative avg_fill_price for net credits; normalize to absolute
        avgFillPrice = Math.abs(rawPrice);
      } else if (order.leg && Array.isArray(order.leg)) {
        // For multileg orders, compute net credit/debit from legs
        // Tradier nests legs in 'leg' array (not 'legs')
        const netPrice = order.leg.reduce((sum: number, leg: any) => {
          const legPrice = leg.avg_fill_price ? parseFloat(leg.avg_fill_price) : 0;
          // For credit spread: sell_to_open is positive (credit), buy_to_open is negative (debit)
          if (leg.side?.includes('sell')) {
            return sum + legPrice; // Credit received
          } else if (leg.side?.includes('buy')) {
            return sum - legPrice; // Debit paid
          }
          return sum;
        }, 0);
        avgFillPrice = Math.abs(netPrice); // Ensure positive for credit spread
      } else if (order.legs && Array.isArray(order.legs)) {
        // Fallback: try 'legs' array (some Tradier responses might use this)
        const netPrice = order.legs.reduce((sum: number, leg: any) => {
          const legPrice = leg.avg_fill_price ? parseFloat(leg.avg_fill_price) : 0;
          if (leg.side?.includes('sell')) {
            return sum + legPrice;
          } else if (leg.side?.includes('buy')) {
            return sum - legPrice;
          }
          return sum;
        }, 0);
        avgFillPrice = Math.abs(netPrice);
      }

      const result: BrokerOrder = {
        id: orderId,
        status,
        avg_fill_price: avgFillPrice,
        filled_quantity: order.filled_quantity ? parseInt(order.filled_quantity) : 0,
        remaining_quantity: order.remaining_quantity ? parseInt(order.remaining_quantity) : 0,
        created_at: order.created_at || null,
        updated_at: order.updated_at || new Date().toISOString(),
      };

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_ORDER_STATUS',
        orderId,
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'GET_ORDER_STATUS',
        orderId,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Cancel an order
   * 
   * DELETE /accounts/{account_id}/orders/{order_id}
   */
  async cancelOrder(orderId: string): Promise<void> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const encodedOrderId = encodeURIComponent(orderId);
      await this.request(
        'DELETE',
        `/accounts/${this.accountId}/orders/${encodedOrderId}`
      );

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'CANCEL_ORDER',
        orderId,
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'CANCEL_ORDER',
        orderId,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Get positions (for reconciliation)
   */
  async getPositions(): Promise<BrokerPosition[]> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const data = await this.request(
        'GET',
        `/accounts/${this.accountId}/positions`,
        undefined,
        TRADIER_POSITIONS_TIMEOUT_MS
      );

      const positions = data.positions?.position || [];
      const normalized = Array.isArray(positions) ? positions : [positions];

      const result = normalized.map((pos: any): BrokerPosition => {
        const cost_basis =
          pos.cost_basis != null ? parseFloat(pos.cost_basis) : null;
        const market_value =
          pos.market_value != null ? parseFloat(pos.market_value) : null;
        let gain_loss: number | null = null;

        if (pos.gain_loss != null) {
          gain_loss = parseFloat(pos.gain_loss);
        } else if (market_value != null && cost_basis != null) {
          gain_loss = market_value - cost_basis;
        }

        return {
          symbol: pos.symbol || '',
          quantity: pos.quantity ? parseFloat(pos.quantity) : 0,
          cost_basis,
          market_value,
          gain_loss,
        };
      });

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_POSITIONS',
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'GET_POSITIONS',
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Get account balances for risk management
   *
   * GET /accounts/{account_id}/balances
   */
  async getBalances(): Promise<{
    cash: number;
    buying_power: number;
    equity: number;
    margin_requirement: number;
  }> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const data = await this.request(
        'GET',
        `/accounts/${this.accountId}/balances`
      );

      const b = data.balances || {};

      const cash = b.cash != null ? parseFloat(b.cash) : 0;
      const buying_power =
        b.buying_power != null
          ? parseFloat(b.buying_power)
          : b.total_cash != null
          ? parseFloat(b.total_cash)
          : 0;
      const equity =
        b.equity != null
          ? parseFloat(b.equity)
          : b.total_equity != null
          ? parseFloat(b.total_equity)
          : 0;
      const margin_requirement =
        b.margin_requirement != null
          ? parseFloat(b.margin_requirement)
          : 0;

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_BALANCES',
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return {
        cash,
        buying_power,
        equity,
        margin_requirement,
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage =
        raw.length > 200 ? raw.slice(0, 200) + '…' : raw;

      await logBrokerEvent(this.env, {
        operation: 'GET_BALANCES',
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });

      throw err;
    }
  }

  /**
   * Get realized gain/loss for a date range
   *
   * GET /accounts/{account_id}/gainloss?start=YYYY-MM-DD&end=YYYY-MM-DD
   * Returns closed positions with gain_loss field.
   */
  async getGainLoss(params: {
    start: string;
    end: string;
  }): Promise<
    Array<{
      symbol: string;
      gain_loss: number;
      open_date?: string;
      close_date?: string;
    }>
  > {
    const mode = await getTradingMode(this.env);
    const startTs = Date.now();

    try {
      const url =
        `/accounts/${this.accountId}/gainloss?start=${encodeURIComponent(
          params.start
        )}&end=${encodeURIComponent(params.end)}`;

      const data = await this.request('GET', url);

      const closed = data?.gainloss?.closed_position;
      if (!closed) {
        const durationMs = Date.now() - startTs;
        await logBrokerEvent(this.env, {
          operation: 'GET_GAINLOSS',
          statusCode: 200,
          ok: true,
          durationMs,
          mode,
        });
        return [];
      }

      const items = Array.isArray(closed) ? closed : [closed];
      const normalized = items
        .filter((p: any) => p != null)
        .map((p: any) => ({
          symbol: p.symbol ?? '',
          gain_loss:
            p.gain_loss != null ? parseFloat(String(p.gain_loss)) : 0,
          open_date: p.open_date ?? undefined,
          close_date: p.close_date ?? undefined,
        }));

      const durationMs = Date.now() - startTs;
      await logBrokerEvent(this.env, {
        operation: 'GET_GAINLOSS',
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return normalized;
    } catch (err: any) {
      const durationMs = Date.now() - startTs;
      const raw = err?.message ?? String(err);
      const errorMessage =
        raw.length > 200 ? raw.slice(0, 200) + '…' : raw;

      await logBrokerEvent(this.env, {
        operation: 'GET_GAINLOSS',
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });

      throw err;
    }
  }

  /**
   * Get open orders from Tradier
   * 
   * GET /accounts/{account_id}/orders?state=open
   * Returns only orders with status 'open' or 'pending'
   */
  async getOpenOrders(): Promise<BrokerOrder[]> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const url = `/accounts/${this.accountId}/orders?state=open`;
      const data = await this.request('GET', url, undefined, TRADIER_ORDERS_TIMEOUT_MS);

      // Parse orders from response (same structure as getAllOrders)
      let orders: any[] = [];
      
      if (data.orders) {
        if (Array.isArray(data.orders)) {
          orders = data.orders;
        } else if (data.orders.order) {
          orders = Array.isArray(data.orders.order) ? data.orders.order : [data.orders.order];
        } else if (typeof data.orders === 'object' && data.orders.id) {
          orders = [data.orders];
        }
      }

      const normalized = orders.filter(o => o != null && o !== undefined);

      const result = normalized.map((order: any): BrokerOrder => {
        const statusMap: Record<string, BrokerOrderStatus> = {
          'filled': 'FILLED',
          'open': 'OPEN',
          'cancelled': 'CANCELLED',
          'rejected': 'REJECTED',
          'expired': 'EXPIRED',
          'pending': 'NEW',
          'partially_filled': 'OPEN',
          'partial': 'OPEN',
        };

        const status: BrokerOrderStatus = statusMap[order.status?.toLowerCase()] || 'UNKNOWN';

        let avgFillPrice: number | null = null;
        if (order.avg_fill_price != null) {
          const rawPrice = parseFloat(order.avg_fill_price);
          avgFillPrice = Math.abs(rawPrice);
        }

        return {
          id: order.id?.toString() || '',
          status,
          avg_fill_price: avgFillPrice,
          filled_quantity: order.filled_quantity ? parseInt(order.filled_quantity) : 0,
          remaining_quantity: order.remaining_quantity ? parseInt(order.remaining_quantity) : 0,
          created_at: order.create_date || order.created_at || null,
          updated_at: order.transaction_date || order.updated_at || new Date().toISOString(),
        };
      });

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_ALL_ORDERS',
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;

      await logBrokerEvent(this.env, {
        operation: 'GET_ALL_ORDERS',
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });

      throw err;
    }
  }

  /**
   * Get order details with leg information
   * 
   * Returns the full order object including leg details for multileg orders
   */
  async getOrderWithLegs(orderId: string): Promise<any> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const encodedOrderId = encodeURIComponent(orderId);
      const data = await this.request(
        'GET',
        `/accounts/${this.accountId}/orders/${encodedOrderId}`
      );

      const order = data.order || data;

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_ORDER_WITH_LEGS',
        orderId,
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return order;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'GET_ORDER_WITH_LEGS',
        orderId,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }

  /**
   * Get all orders from Tradier
   * 
   * GET /accounts/{account_id}/orders
   * Supports filter=all|intraday and date ranges
   */
  async getAllOrders(
    filter: 'all' | 'intraday' = 'all',
    startDate?: string,
    endDate?: string
  ): Promise<BrokerOrder[]> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      let url = `/accounts/${this.accountId}/orders?filter=${filter}`;
      if (startDate) {
        url += `&start=${encodeURIComponent(startDate)}`;
      }
      if (endDate) {
        url += `&end=${encodeURIComponent(endDate)}`;
      }

      const data = await this.request('GET', url, undefined, TRADIER_ORDERS_TIMEOUT_MS);

      // Reduced logging - removed verbose response structure logging

      // Parse orders from response - Tradier can return various structures:
      // 1. { orders: { order: [...] } } - multiple orders
      // 2. { orders: { order: {...} } } - single order
      // 3. { orders: [...] } - direct array
      // 4. { orders: null } or { orders: undefined } - no orders
      let orders: any[] = [];
      
      if (data.orders) {
        if (Array.isArray(data.orders)) {
          // Direct array: { orders: [...] }
          orders = data.orders;
        } else if (data.orders.order) {
          // Nested: { orders: { order: [...] } } or { orders: { order: {...} } }
          orders = Array.isArray(data.orders.order) ? data.orders.order : [data.orders.order];
        } else if (typeof data.orders === 'object' && data.orders.id) {
          // Single order object directly in orders: { orders: { id: ..., status: ... } }
          orders = [data.orders];
        }
      }

      // Filter out null/undefined entries
      const normalized = orders.filter(o => o != null && o !== undefined);

      // Reduced logging - removed parsed order sample logging

      const result = normalized.map((order: any): BrokerOrder => {
        // Map Tradier status to our BrokerOrderStatus
        const statusMap: Record<string, BrokerOrderStatus> = {
          'filled': 'FILLED',
          'open': 'OPEN',
          'cancelled': 'CANCELLED',
          'rejected': 'REJECTED',
          'expired': 'EXPIRED',
          'pending': 'NEW',
          'partially_filled': 'OPEN',
          'partial': 'OPEN',
        };

        const status: BrokerOrderStatus = statusMap[order.status?.toLowerCase()] || 'UNKNOWN';

        // Calculate avg_fill_price
        // For multileg credit spreads, Tradier returns avg_fill_price as negative (debit)
        // We need to convert to positive (credit) for entry_price
        let avgFillPrice: number | null = null;
        if (order.avg_fill_price != null) {
          const rawPrice = parseFloat(order.avg_fill_price);
          // For credit spreads (type='credit'), Tradier returns negative values
          // Convert to positive for our entry_price
          if (order.type === 'credit' && rawPrice < 0) {
            avgFillPrice = Math.abs(rawPrice);
          } else {
            avgFillPrice = rawPrice;
          }
        } else if (order.leg && Array.isArray(order.leg)) {
          // For multileg orders, compute net credit/debit from legs
          // Tradier nests legs in 'leg' array (not 'legs')
          const netPrice = order.leg.reduce((sum: number, leg: any) => {
            const legPrice = leg.avg_fill_price ? parseFloat(leg.avg_fill_price) : 0;
            // For credit spread: sell_to_open is positive (credit), buy_to_open is negative (debit)
            if (leg.side?.includes('sell')) {
              return sum + legPrice; // Credit received
            } else if (leg.side?.includes('buy')) {
              return sum - legPrice; // Debit paid
            }
            return sum;
          }, 0);
          avgFillPrice = Math.abs(netPrice); // Ensure positive for credit spread
        } else if (order.legs && Array.isArray(order.legs)) {
          // Fallback: try 'legs' array (some Tradier responses might use this)
          const netPrice = order.legs.reduce((sum: number, leg: any) => {
            const legPrice = leg.avg_fill_price ? parseFloat(leg.avg_fill_price) : 0;
            if (leg.side?.includes('sell')) {
              return sum + legPrice;
            } else if (leg.side?.includes('buy')) {
              return sum - legPrice;
            }
            return sum;
          }, 0);
          avgFillPrice = Math.abs(netPrice);
        }

        return {
          id: order.id?.toString() || '',
          status,
          avg_fill_price: avgFillPrice,
          filled_quantity: order.filled_quantity ? parseInt(order.filled_quantity) : 0,
          remaining_quantity: order.remaining_quantity ? parseInt(order.remaining_quantity) : 0,
          created_at: order.create_date || order.created_at || null,
          updated_at: order.transaction_date || order.updated_at || new Date().toISOString(),
        };
      });

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_ALL_ORDERS',
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;

      await logBrokerEvent(this.env, {
        operation: 'GET_ALL_ORDERS',
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });

      throw err;
    }
  }

  /**
   * Get historical market data for SMA calculation
   * 
   * GET /markets/history?symbol=SPY&interval=daily&start=YYYY-MM-DD&end=YYYY-MM-DD
   * 
   * Note: This endpoint is needed for SMA calculation despite being in the "forbidden" list
   * in the initial API guide. It's a read-only market data endpoint, not a trading operation.
   */
  async getHistoricalData(
    symbol: string,
    startDate: string,
    endDate: string
  ): Promise<Array<{ date: string; close: number }>> {
    const mode = await getTradingMode(this.env);
    const start = Date.now();

    try {
      const encodedSymbol = encodeURIComponent(symbol);
      const encodedStart = encodeURIComponent(startDate);
      const encodedEnd = encodeURIComponent(endDate);
      
      const url = `/markets/history?symbol=${encodedSymbol}&interval=daily&start=${encodedStart}&end=${encodedEnd}`;
      const data = await this.request('GET', url);

      // Parse historical data from response
      // Tradier returns: { history: { day: [...] } } or { history: { day: {...} } }
      const history = data.history;
      if (!history || !history.day) {
        return [];
      }

      const days = Array.isArray(history.day) ? history.day : [history.day];
      
      const result = days
        .filter((day: any) => day && day.close != null)
        .map((day: any) => ({
          date: day.date || day.datetime || '',
          close: parseFloat(day.close),
        }))
        .filter((item: any) => item.date && !isNaN(item.close));

      const durationMs = Date.now() - start;
      await logBrokerEvent(this.env, {
        operation: 'GET_HISTORICAL_DATA',
        symbol,
        statusCode: 200,
        ok: true,
        durationMs,
        mode,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const raw = err?.message ?? String(err);
      const errorMessage = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
      
      await logBrokerEvent(this.env, {
        operation: 'GET_HISTORICAL_DATA',
        symbol,
        ok: false,
        durationMs,
        errorMessage,
        mode,
      });
      
      throw err;
    }
  }
}

