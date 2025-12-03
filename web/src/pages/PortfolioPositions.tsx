import { useEffect, useState } from 'react';
import { getPortfolioPositions } from '../api';
import type { PortfolioPositionsResponse } from '../api';

export default function PortfolioPositions() {
  const [data, setData] = useState<PortfolioPositionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchPositions() {
      try {
        setLoading(true);
        const positions = await getPortfolioPositions();
        setData(positions);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load portfolio positions');
      } finally {
        setLoading(false);
      }
    }

    fetchPositions();
    // Refresh every 30 seconds
    const interval = setInterval(fetchPositions, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading portfolio positions...</div>
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

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">No data available</div>
      </div>
    );
  }

  const symbols = Object.keys(data.bySymbol).sort();

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Portfolio Positions</h1>
          <p className="text-sm text-gray-600">
            Raw broker leg positions from Tradier (mirrored in portfolio_positions table)
          </p>
        </div>

        {/* Summary */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <h2 className="text-xs font-medium text-gray-500 mb-1">Total Positions</h2>
              <div className="text-2xl font-bold text-gray-900">{data.total}</div>
            </div>
            <div>
              <h2 className="text-xs font-medium text-gray-500 mb-1">Symbols</h2>
              <div className="text-2xl font-bold text-gray-900">{symbols.length}</div>
            </div>
            <div>
              <h2 className="text-xs font-medium text-gray-500 mb-1">Last Updated</h2>
              <div className="text-sm text-gray-900">
                {data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A'}
              </div>
            </div>
            <div>
              <h2 className="text-xs font-medium text-gray-500 mb-1">Source</h2>
              <div className="text-sm text-gray-900">portfolio_positions</div>
            </div>
          </div>
        </div>

        {/* Positions by Symbol */}
        {symbols.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-center text-gray-500">No positions found</div>
          </div>
        ) : (
          <div className="space-y-6">
            {symbols.map((symbol) => {
              const positions = data.bySymbol[symbol];
              const longPositions = positions.filter(p => p.side === 'long');
              const shortPositions = positions.filter(p => p.side === 'short');
              const totalLongQty = longPositions.reduce((sum, p) => sum + p.quantity, 0);
              const totalShortQty = shortPositions.reduce((sum, p) => sum + p.quantity, 0);

              return (
                <div key={symbol} className="bg-white rounded-lg shadow">
                  <div className="px-6 py-4 border-b border-gray-200">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xl font-bold text-gray-900">{symbol}</h2>
                      <div className="flex gap-4 text-sm">
                        <div>
                          <span className="text-gray-500">Long: </span>
                          <span className="font-semibold text-green-600">{totalLongQty}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Short: </span>
                          <span className="font-semibold text-red-600">{totalShortQty}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Net: </span>
                          <span className={`font-semibold ${totalLongQty - totalShortQty >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {totalLongQty - totalShortQty}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Expiration
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Type
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Strike
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Side
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Quantity
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Cost Basis
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Bid
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Ask
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Mark
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Last Price
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {positions.map((position) => (
                          <tr key={position.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {new Date(position.expiration).toLocaleDateString()}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 uppercase">
                              {position.option_type}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">
                              ${position.strike.toFixed(2)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span
                                className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                  position.side === 'long'
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-red-100 text-red-800'
                                }`}
                              >
                                {position.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                              {position.quantity}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                              {position.cost_basis_per_contract !== null
                                ? `$${position.cost_basis_per_contract.toFixed(2)}`
                                : 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-blue-600">
                              {position.bid !== null
                                ? `$${position.bid.toFixed(2)}`
                                : 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-orange-600">
                              {position.ask !== null
                                ? `$${position.ask.toFixed(2)}`
                                : 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-gray-900">
                              {position.bid !== null && position.ask !== null
                                ? `$${((position.bid + position.ask) / 2).toFixed(2)}`
                                : 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                              {position.last_price !== null
                                ? `$${position.last_price.toFixed(2)}`
                                : 'N/A'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

