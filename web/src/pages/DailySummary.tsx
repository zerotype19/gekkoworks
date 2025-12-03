import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getDailySummaryList, getDailySummary, generateDailySummary, type DailySummary } from '../api';

export default function DailySummaryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [summaryList, setSummaryList] = useState<Array<{ date: string; generated_at: string }>>([]);
  const [selectedSummary, setSelectedSummary] = useState<DailySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  
  const selectedDate = searchParams.get('date');

  useEffect(() => {
    async function fetchSummaryList() {
      try {
        setLoading(true);
        const data = await getDailySummaryList(30);
        setSummaryList(data.summaries);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load summary list');
      } finally {
        setLoading(false);
      }
    }

    fetchSummaryList();
  }, []);

  useEffect(() => {
    async function fetchSummary() {
      if (!selectedDate) {
        setSelectedSummary(null);
        return;
      }

      try {
        setLoadingDetail(true);
        const summary = await getDailySummary(selectedDate);
        // Ensure summary structure is correct
        if (summary && !summary.summary) {
          // If response doesn't have nested summary, it might be the raw data
          console.warn('Unexpected summary structure', summary);
        }
        setSelectedSummary(summary);
        setError(null);
      } catch (err) {
        if (err instanceof Error && (err.message.includes('404') || err.message.includes('not found'))) {
          setSelectedSummary(null);
          setError(null);
        } else {
          console.error('Error fetching summary', err);
          setError(err instanceof Error ? err.message : 'Failed to load summary');
        }
      } finally {
        setLoadingDetail(false);
      }
    }

    fetchSummary();
  }, [selectedDate]);

  const handleDateClick = (date: string) => {
    setSearchParams({ date });
  };

  const handleGenerateSummary = async (date: string) => {
    try {
      setGenerating(true);
      const summary = await generateDailySummary(date);
      setSelectedSummary(summary);
      setError(null);
      // Refresh the list
      const data = await getDailySummaryList(30);
      setSummaryList(data.summaries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate summary');
    } finally {
      setGenerating(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      weekday: 'long',
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  };

  const formatDateTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading daily summaries...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Daily Activity Summary</h1>
        <p className="mt-2 text-sm text-gray-600">
          View comprehensive summaries of daily trading activity. Summaries are automatically generated at 4:15 PM ET.
        </p>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Summary List */}
        <div className="lg:col-span-1">
          <div className="bg-white shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">Available Summaries</h2>
            </div>
            <div className="divide-y divide-gray-200 max-h-[600px] overflow-y-auto">
              {summaryList.length === 0 ? (
                <div className="px-4 py-5 text-sm text-gray-500">
                  No summaries available yet. The first summary will be generated at 4:15 PM ET.
                </div>
              ) : (
                summaryList.map((summary) => (
                  <button
                    key={summary.date}
                    onClick={() => handleDateClick(summary.date)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${
                      selectedDate === summary.date ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                    }`}
                  >
                    <div className="font-medium text-gray-900">
                      {formatDate(summary.date)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Generated: {formatDateTime(summary.generated_at)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Summary Detail */}
        <div className="lg:col-span-2">
          {loadingDetail ? (
            <div className="bg-white shadow rounded-lg p-8 text-center">
              <div className="text-gray-600">Loading summary...</div>
            </div>
          ) : selectedDate && !selectedSummary ? (
            <div className="bg-white shadow rounded-lg p-8">
              <div className="text-center">
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Summary not found for {formatDate(selectedDate)}
                </h3>
                <p className="text-sm text-gray-600 mb-4">
                  This summary hasn't been generated yet. You can generate it now.
                </p>
                <button
                  onClick={() => handleGenerateSummary(selectedDate)}
                  disabled={generating}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {generating ? 'Generating...' : 'Generate Summary'}
                </button>
              </div>
            </div>
          ) : selectedSummary ? (
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <div>
                    <h2 className="text-xl font-medium text-gray-900">
                      {formatDate(selectedSummary.date)}
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">
                      Generated: {formatDateTime(selectedSummary.generated_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleGenerateSummary(selectedSummary.date)}
                    disabled={generating}
                    className="text-sm px-3 py-1 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {generating ? 'Regenerating...' : 'Regenerate'}
                  </button>
                </div>
              </div>

              <div className="px-4 py-5 sm:p-6 space-y-6">
                {/* Summary Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-sm text-gray-600">Trades Opened</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {selectedSummary.summary?.trades?.opened ?? 0}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-sm text-gray-600">Trades Closed</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {selectedSummary.summary?.trades?.closed ?? 0}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-sm text-gray-600">Open Trades</div>
                    <div className="text-2xl font-bold text-gray-900">
                      {selectedSummary.summary?.trades?.open ?? 0}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-sm text-gray-600">Realized P&L</div>
                    <div className={`text-2xl font-bold ${
                      (selectedSummary.summary?.pnl?.realized_today ?? 0) >= 0 
                        ? 'text-green-600' 
                        : 'text-red-600'
                    }`}>
                      ${(selectedSummary.summary?.pnl?.realized_today ?? 0).toFixed(2)}
                    </div>
                  </div>
                </div>

                {/* Proposals */}
                {selectedSummary.summary?.proposals && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-3">Proposals</h3>
                    <div className="grid grid-cols-4 gap-4">
                      <div className="bg-blue-50 rounded-lg p-3">
                        <div className="text-xs text-gray-600">Total</div>
                        <div className="text-xl font-bold text-gray-900">
                          {selectedSummary.summary.proposals.total ?? 0}
                        </div>
                      </div>
                      <div className="bg-green-50 rounded-lg p-3">
                        <div className="text-xs text-gray-600">Ready</div>
                        <div className="text-xl font-bold text-gray-900">
                          {selectedSummary.summary.proposals.ready ?? 0}
                        </div>
                      </div>
                      <div className="bg-purple-50 rounded-lg p-3">
                        <div className="text-xs text-gray-600">Consumed</div>
                        <div className="text-xl font-bold text-gray-900">
                          {selectedSummary.summary.proposals.consumed ?? 0}
                        </div>
                      </div>
                      <div className="bg-red-50 rounded-lg p-3">
                        <div className="text-xs text-gray-600">Invalidated</div>
                        <div className="text-xl font-bold text-gray-900">
                          {selectedSummary.summary.proposals.invalidated ?? 0}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Account Balance */}
                {selectedSummary.summary?.account && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-3">Account Balance</h3>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600">Cash</div>
                        <div className="text-xl font-bold text-gray-900">
                          ${(selectedSummary.summary.account.cash ?? 0).toFixed(2)}
                        </div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600">Buying Power</div>
                        <div className="text-xl font-bold text-gray-900">
                          ${(selectedSummary.summary.account.buying_power ?? 0).toFixed(2)}
                        </div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4">
                        <div className="text-sm text-gray-600">Equity</div>
                        <div className="text-xl font-bold text-gray-900">
                          ${(selectedSummary.summary.account.equity ?? 0).toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Trades Opened */}
                {selectedSummary.details?.trades_opened && selectedSummary.details.trades_opened.length > 0 && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-3">
                      Trades Opened ({selectedSummary.details.trades_opened.length})
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Symbol
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Strategy
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Entry Price
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Quantity
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Time
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {selectedSummary.details.trades_opened.map((trade) => (
                            <tr key={trade.id}>
                              <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                                {trade.symbol}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                                {trade.strategy}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                                ${trade.entry_price?.toFixed(2) || 'N/A'}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                                {trade.quantity}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                                {trade.opened_at ? formatDateTime(trade.opened_at) : 'N/A'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Trades Closed */}
                {selectedSummary.details?.trades_closed && selectedSummary.details.trades_closed.length > 0 && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-3">
                      Trades Closed ({selectedSummary.details.trades_closed.length})
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Symbol
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Strategy
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Entry
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Exit
                            </th>
                            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                              P&L
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Reason
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {selectedSummary.details.trades_closed.map((trade) => (
                            <tr key={trade.id}>
                              <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                                {trade.symbol}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                                {trade.strategy}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                                ${trade.entry_price?.toFixed(2) || 'N/A'}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                                ${trade.exit_price?.toFixed(2) || 'N/A'}
                              </td>
                              <td className={`px-4 py-3 whitespace-nowrap text-sm text-right font-bold ${
                                (trade.realized_pnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'
                              }`}>
                                ${trade.realized_pnl?.toFixed(2) || 'N/A'}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                                {trade.exit_reason || 'N/A'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Exit Reasons Breakdown */}
                {selectedSummary.details?.exit_reasons && Object.keys(selectedSummary.details.exit_reasons).length > 0 && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-3">Exit Reasons</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {Object.entries(selectedSummary.details.exit_reasons).map(([reason, count]) => (
                        <div key={reason} className="bg-gray-50 rounded-lg p-3">
                          <div className="text-xs text-gray-600">{reason}</div>
                          <div className="text-xl font-bold text-gray-900">{count}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Strategy Breakdown */}
                {selectedSummary.details?.trades_by_strategy && Object.keys(selectedSummary.details.trades_by_strategy).length > 0 && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-3">Trades by Strategy</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {Object.entries(selectedSummary.details.trades_by_strategy).map(([strategy, count]) => (
                        <div key={strategy} className="bg-gray-50 rounded-lg p-3">
                          <div className="text-xs text-gray-600">{strategy}</div>
                          <div className="text-xl font-bold text-gray-900">{count}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white shadow rounded-lg p-8 text-center">
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                Select a date to view summary
              </h3>
              <p className="text-sm text-gray-600">
                Click on a date from the list to view its detailed summary
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

