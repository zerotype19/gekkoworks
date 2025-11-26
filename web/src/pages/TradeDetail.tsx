import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getTrade } from '../api';
import type { Trade } from '../types';

export default function TradeDetail() {
  const { id } = useParams<{ id: string }>();
  const [trade, setTrade] = useState<Trade | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError('Trade ID is required');
      setLoading(false);
      return;
    }

    const tradeId = id; // TypeScript guard

    async function fetchTrade() {
      try {
        setLoading(true);
        const data = await getTrade(tradeId);
        setTrade(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load trade');
      } finally {
        setLoading(false);
      }
    }

    fetchTrade();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading trade...</div>
      </div>
    );
  }

  if (error || !trade) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-600">Error: {error || 'Trade not found'}</div>
        <Link to="/trades" className="ml-4 text-blue-600 hover:text-blue-800">
          Back to Trades
        </Link>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      OPEN: 'bg-green-100 text-green-800',
      CLOSED: 'bg-gray-100 text-gray-800',
      ENTRY_PENDING: 'bg-yellow-100 text-yellow-800',
      CLOSING_PENDING: 'bg-orange-100 text-orange-800',
      CANCELLED: 'bg-red-100 text-red-800',
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  // Check if trade is fully closed
  const isFullyClosed = trade.status === 'CLOSED' && 
                        trade.exit_price !== null && 
                        trade.closed_at !== null && 
                        trade.realized_pnl !== null;

  // Check if trade is stuck in closing
  const isStuckClosing = trade.status === 'CLOSING_PENDING' && 
                         trade.broker_order_id_close !== null;
  
  // Calculate how long it's been stuck
  const minutesStuck = isStuckClosing ? 
    Math.round((new Date().getTime() - new Date(trade.updated_at).getTime()) / (1000 * 60)) : 
    null;

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Link
            to="/trades"
            className="text-blue-600 hover:text-blue-800 text-sm font-medium"
          >
            ← Back to Trades
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-6 md:p-8">
          <div className="flex justify-between items-start mb-6">
            <h1 className="text-3xl font-bold text-gray-900">Trade Details</h1>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 inline-flex text-sm leading-5 font-semibold rounded-full ${getStatusColor(trade.status)}`}>
                {trade.status}
              </span>
              {isFullyClosed && (
                <span className="px-3 py-1 inline-flex text-sm leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                  ✓ Fully Closed
                </span>
              )}
            </div>
          </div>

          {/* Closure Status Banner */}
          {(isStuckClosing || (trade.status === 'CLOSED' && !isFullyClosed)) && (
            <div className={`mb-6 p-4 rounded-lg ${isStuckClosing ? 'bg-orange-50 border border-orange-200' : 'bg-yellow-50 border border-yellow-200'}`}>
              <div className="flex items-start gap-2">
                <span className="text-xl">⚠️</span>
                <div>
                  <h3 className={`font-semibold ${isStuckClosing ? 'text-orange-800' : 'text-yellow-800'}`}>
                    {isStuckClosing ? 'Close Order Stuck' : 'Closure Data Incomplete'}
                  </h3>
                  <p className={`text-sm mt-1 ${isStuckClosing ? 'text-orange-700' : 'text-yellow-700'}`}>
                    {isStuckClosing && minutesStuck !== null && (
                      <>Close order has been pending for {minutesStuck} minutes. The system should reconcile this automatically.</>
                    )}
                    {!isStuckClosing && !isFullyClosed && (
                      <>Trade is marked as CLOSED but is missing some closure data (exit_price, closed_at, or realized_pnl). This may indicate a sync issue.</>
                    )}
                  </p>
                  {trade.broker_order_id_close && (
                    <p className="text-xs mt-2 text-gray-600 font-mono">
                      Exit Order ID: {trade.broker_order_id_close}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Successful Closure Banner */}
          {isFullyClosed && (
            <div className="mb-6 p-4 rounded-lg bg-green-50 border border-green-200">
              <div className="flex items-start gap-2">
                <span className="text-xl">✓</span>
                <div>
                  <h3 className="font-semibold text-green-800">Trade Successfully Closed</h3>
                  <p className="text-sm mt-1 text-green-700">
                    All closure data is present: exit price ${trade.exit_price?.toFixed(2)}, closed at {trade.closed_at ? new Date(trade.closed_at).toLocaleString() : 'N/A'}, realized PnL ${trade.realized_pnl?.toFixed(2)}.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Basic Info */}
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Trade ID</h2>
                <p className="text-sm font-mono text-gray-900">{trade.id}</p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Symbol</h2>
                <p className="text-lg font-semibold text-gray-900">{trade.symbol}</p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Expiration</h2>
                <p className="text-gray-900">{new Date(trade.expiration).toLocaleDateString()}</p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Proposal ID</h2>
                <p className="text-sm font-mono text-gray-600">{trade.proposal_id || 'N/A'}</p>
              </div>
            </div>

            {/* Spread Details */}
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Strikes</h2>
                <div className="flex items-center gap-2">
                  <div>
                    <span className="text-xs text-gray-500">Short:</span>
                    <span className="ml-2 text-lg font-semibold text-gray-900">${trade.short_strike}</span>
                  </div>
                  <span className="text-gray-400">/</span>
                  <div>
                    <span className="text-xs text-gray-500">Long:</span>
                    <span className="ml-2 text-lg font-semibold text-gray-900">${trade.long_strike}</span>
                  </div>
                </div>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Width</h2>
                <p className="text-lg font-semibold text-gray-900">${trade.width}</p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Exit Reason</h2>
                <p className="text-gray-900">{trade.exit_reason || 'N/A'}</p>
              </div>
            </div>

            {/* Pricing */}
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Entry Price</h2>
                <p className="text-lg font-semibold text-gray-900">
                  {trade.entry_price ? `$${trade.entry_price.toFixed(2)}` : 'N/A'}
                </p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Exit Price</h2>
                <p className={`text-lg font-semibold ${trade.exit_price !== null ? 'text-gray-900' : 'text-gray-400'}`}>
                  {trade.exit_price !== null ? `$${trade.exit_price.toFixed(2)}` : 'Not set'}
                  {trade.exit_price === null && trade.status === 'CLOSED' && (
                    <span className="ml-2 text-xs text-yellow-600">⚠️ Missing</span>
                  )}
                </p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Realized PnL</h2>
                <p className={`text-2xl font-bold ${trade.realized_pnl !== null ? (trade.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600') : 'text-gray-400'}`}>
                  {trade.realized_pnl !== null ? `$${trade.realized_pnl.toFixed(2)}` : 'Not calculated'}
                  {trade.realized_pnl === null && trade.status === 'CLOSED' && (
                    <span className="ml-2 text-xs text-yellow-600">⚠️ Missing</span>
                  )}
                </p>
              </div>
            </div>

            {/* Risk Metrics */}
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Max Profit</h2>
                <p className="text-lg font-semibold text-green-600">
                  {trade.max_profit !== null ? `$${trade.max_profit.toFixed(2)}` : 'N/A'}
                </p>
              </div>
              <div>
                <h2 className="text-sm font-medium text-gray-500 mb-2">Max Loss</h2>
                <p className="text-lg font-semibold text-red-600">
                  {trade.max_loss !== null ? `$${trade.max_loss.toFixed(2)}` : 'N/A'}
                </p>
              </div>
            </div>

            {/* Timestamps */}
            <div className="space-y-4 md:col-span-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-gray-200">
                <div>
                  <h2 className="text-sm font-medium text-gray-500 mb-2">Created</h2>
                  <p className="text-sm text-gray-900">
                    {new Date(trade.created_at).toLocaleString()}
                  </p>
                </div>
                <div>
                  <h2 className="text-sm font-medium text-gray-500 mb-2">Updated</h2>
                  <p className="text-sm text-gray-900">
                    {new Date(trade.updated_at).toLocaleString()}
                  </p>
                </div>
                {trade.opened_at && (
                  <div>
                    <h2 className="text-sm font-medium text-gray-500 mb-2">Opened</h2>
                    <p className="text-sm text-gray-900">
                      {new Date(trade.opened_at).toLocaleString()}
                    </p>
                  </div>
                )}
                <div>
                  <h2 className="text-sm font-medium text-gray-500 mb-2">Closed</h2>
                  {trade.closed_at ? (
                    <p className="text-sm text-gray-900">
                      {new Date(trade.closed_at).toLocaleString()}
                    </p>
                  ) : trade.status === 'CLOSING_PENDING' ? (
                    <p className="text-sm text-orange-600">Pending closure...</p>
                  ) : trade.status === 'CLOSED' ? (
                    <p className="text-sm text-yellow-600">Not set ⚠️</p>
                  ) : (
                    <p className="text-sm text-gray-400">-</p>
                  )}
                </div>
              </div>
            </div>

            {/* Broker Order IDs */}
            {(trade.broker_order_id_open || trade.broker_order_id_close) && (
              <div className="space-y-4 md:col-span-2 pt-4 border-t border-gray-200">
                <h2 className="text-sm font-medium text-gray-500 mb-2">Broker Order IDs</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {trade.broker_order_id_open && (
                    <div>
                      <span className="text-xs text-gray-500">Entry Order:</span>
                      <p className="text-sm font-mono text-gray-900">{trade.broker_order_id_open}</p>
                    </div>
                  )}
                  {trade.broker_order_id_close && (
                    <div>
                      <span className="text-xs text-gray-500">Exit Order:</span>
                      <p className="text-sm font-mono text-gray-900">{trade.broker_order_id_close}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

