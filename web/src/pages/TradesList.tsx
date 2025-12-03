import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTrades } from '../api';
import type { Trade } from '../types';

export default function TradesList() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTrades() {
      try {
        setLoading(true);
        const data = await getTrades();
        setTrades(data.trades);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load trades');
      } finally {
        setLoading(false);
      }
    }

    fetchTrades();
    // Refresh every 30 seconds
    const interval = setInterval(fetchTrades, 30000);
    return () => clearInterval(interval);
  }, []);

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

  // Helper to check if a trade is fully closed
  const isFullyClosed = (trade: Trade) => {
    return trade.status === 'CLOSED' && 
           trade.exit_price !== null && 
           trade.closed_at !== null && 
           trade.realized_pnl !== null;
  };

  // Helper to check if a trade should be closed but isn't
  const isStuckClosing = (trade: Trade) => {
    if (trade.status !== 'CLOSING_PENDING') return false;
    if (!trade.broker_order_id_close) return false;
    
    // Check if it's been pending for more than 5 minutes
    const now = new Date();
    const updated = new Date(trade.updated_at);
    const minutesPending = (now.getTime() - updated.getTime()) / (1000 * 60);
    
    return minutesPending > 5;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading trades...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-600">Error: {error}</div>
      </div>
    );
  }

  // Calculate closure statistics
  const fullyClosed = trades.filter(isFullyClosed).length;
  const stuckClosing = trades.filter(isStuckClosing).length;
  const closedButIncomplete = trades.filter(t => t.status === 'CLOSED' && !isFullyClosed(t)).length;
  const closingPending = trades.filter(t => t.status === 'CLOSING_PENDING').length;

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Trades</h1>
        
        {/* Closure Status Summary */}
        {trades.length > 0 && (
          <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-gray-500 mb-1">Fully Closed</div>
              <div className="text-2xl font-bold text-green-600">{fullyClosed}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-gray-500 mb-1">Pending Close</div>
              <div className="text-2xl font-bold text-orange-600">{closingPending}</div>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-gray-500 mb-1">Stuck Closing</div>
              <div className="text-2xl font-bold text-red-600">{stuckClosing}</div>
              {stuckClosing > 0 && (
                <div className="text-xs text-red-600 mt-1">⚠️ Needs attention</div>
              )}
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-sm text-gray-500 mb-1">Incomplete Data</div>
              <div className="text-2xl font-bold text-yellow-600">{closedButIncomplete}</div>
              {closedButIncomplete > 0 && (
                <div className="text-xs text-yellow-600 mt-1">⚠️ Missing fields</div>
              )}
            </div>
          </div>
        )}
        
        {trades.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <p className="text-gray-500">No trades yet.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      ID
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Symbol
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Strategy
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Proposal ID
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Expiration
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Strikes
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Entry Price
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Exit Price
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      PnL
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Closed
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {trades.map((trade) => (
                    <tr key={trade.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 whitespace-nowrap">
                        <Link
                          to={`/trades/${trade.id}`}
                          className="text-blue-600 hover:text-blue-800 text-xs font-mono"
                        >
                          {trade.id.slice(0, 8)}...
                        </Link>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs font-medium text-gray-900">
                        {trade.symbol}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-500">
                        {trade.strategy || '-'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <span className={`px-1.5 py-0.5 inline-flex text-xs leading-4 font-semibold rounded-full ${getStatusColor(trade.status)}`}>
                            {trade.status}
                          </span>
                          {isStuckClosing(trade) && (
                            <span className="px-1.5 py-0.5 inline-flex text-xs leading-4 font-semibold rounded-full bg-red-100 text-red-800" title="Close order pending for > 5 minutes">
                              ⚠️
                            </span>
                          )}
                          {isFullyClosed(trade) && (
                            <span className="text-green-600 text-xs" title="Trade fully closed with all data">
                              ✓
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs">
                        {trade.proposal_id ? (
                          <span className="text-gray-500 font-mono text-xs" title={trade.proposal_id}>
                            {trade.proposal_id.slice(0, 8)}...
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-500">
                        {new Date(trade.expiration).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-500">
                        {trade.short_strike} / {trade.long_strike}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-900">
                        {trade.entry_price ? `$${trade.entry_price.toFixed(2)}` : '-'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-900">
                        {trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '-'}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs">
                        {trade.realized_pnl !== null ? (
                          <span className={trade.realized_pnl >= 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                            ${trade.realized_pnl.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-500">
                        {trade.closed_at ? (
                          <div>
                            <div>{new Date(trade.closed_at).toLocaleDateString()}</div>
                            <div className="text-xs text-gray-400">{new Date(trade.closed_at).toLocaleTimeString()}</div>
                          </div>
                        ) : trade.status === 'CLOSING_PENDING' ? (
                          <span className="text-orange-600 text-xs">Pending...</span>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-gray-200">
              {trades.map((trade) => (
                <Link
                  key={trade.id}
                  to={`/trades/${trade.id}`}
                  className="block p-4 hover:bg-gray-50"
                >
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="text-sm font-mono text-blue-600">
                        {trade.id.slice(0, 8)}...
                      </div>
                      <div className="text-lg font-semibold text-gray-900 mt-1">
                        {trade.symbol}
                      </div>
                    </div>
                    <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusColor(trade.status)}`}>
                      {trade.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm text-gray-600 mt-2">
                    <div>
                      <span className="font-medium">Strategy:</span> {trade.strategy || '-'}
                    </div>
                    <div>
                      <span className="font-medium">Strikes:</span> {trade.short_strike} / {trade.long_strike}
                    </div>
                    <div>
                      <span className="font-medium">Entry:</span> {trade.entry_price ? `$${trade.entry_price.toFixed(2)}` : '-'}
                    </div>
                    <div>
                      <span className="font-medium">Exp:</span> {new Date(trade.expiration).toLocaleDateString()}
                    </div>
                    <div>
                      <span className="font-medium">Proposal ID:</span>{' '}
                      {trade.proposal_id ? (
                        <span className="text-gray-500 font-mono text-xs">{trade.proposal_id.slice(0, 8)}...</span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </div>
                    <div>
                      <span className="font-medium">Exit:</span> {trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '-'}
                    </div>
                    <div>
                      <span className="font-medium">PnL:</span>{' '}
                      {trade.realized_pnl !== null ? (
                        <span className={trade.realized_pnl >= 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                          ${trade.realized_pnl.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </div>
                    <div>
                      <span className="font-medium">Closed:</span>{' '}
                      {trade.closed_at ? (
                        <span className="text-green-600">
                          {new Date(trade.closed_at).toLocaleString()}
                        </span>
                      ) : trade.status === 'CLOSING_PENDING' ? (
                        <span className="text-orange-600 text-xs">Pending...</span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </div>
                    {(isStuckClosing(trade) || (!isFullyClosed(trade) && trade.status === 'CLOSED')) && (
                      <div className="col-span-2">
                        {isStuckClosing(trade) && (
                          <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
                            ⚠️ Close pending for {Math.round((new Date().getTime() - new Date(trade.updated_at).getTime()) / (1000 * 60))} min
                          </span>
                        )}
                        {!isFullyClosed(trade) && trade.status === 'CLOSED' && (
                          <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800">
                            ⚠️ Missing closure data
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

