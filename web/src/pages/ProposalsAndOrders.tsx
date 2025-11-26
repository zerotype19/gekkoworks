import React, { useEffect, useState } from 'react';
import { getProposalsAndOrders, type ProposalsAndOrdersResponse } from '../api';

export default function ProposalsAndOrders() {
  const [data, setData] = useState<ProposalsAndOrdersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const response = await getProposalsAndOrders(50);
        if (!cancelled) {
          setData(response);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'Failed to load proposals and orders');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    // Refresh every 30 seconds
    const interval = setInterval(load, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const toggleRow = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getOutcomeColor = (outcome: string) => {
    switch (outcome) {
      case 'FILLED':
        return 'bg-green-100 text-green-800';
      case 'REJECTED':
        return 'bg-red-100 text-red-800';
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-800';
      case 'INVALIDATED':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // Format score as percentage
  const formatScore = (score: number) => {
    // If score is already a percentage (0-1), convert to percentage string
    if (score <= 1) {
      return `${(score * 100).toFixed(1)}%`;
    }
    // If score is already 0-100, just add %
    return `${score.toFixed(1)}%`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading proposals and orders...</div>
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
        <div className="text-gray-500">No data available</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">Proposals & Orders</h1>

      {/* Summary */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 text-gray-900">Summary</h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">{data.summary.total}</div>
            <div className="text-sm text-gray-500">Total</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{data.summary.filled}</div>
            <div className="text-sm text-gray-500">Filled</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-600">{data.summary.rejected}</div>
            <div className="text-sm text-gray-500">Rejected</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-yellow-600">{data.summary.pending}</div>
            <div className="text-sm text-gray-500">Pending</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-600">{data.summary.invalidated}</div>
            <div className="text-sm text-gray-500">Invalidated</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-600">{data.summary.not_attempted}</div>
            <div className="text-sm text-gray-500">Not Attempted</div>
          </div>
        </div>
      </div>

      {/* Proposals Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Time
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Symbol
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Strategy
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Spread
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Credit
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Score
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Outcome
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Order Status
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.proposals.map((item) => {
                const isExpanded = expandedRows.has(item.proposal.id);
                const entryOrderOk = item.entryOrder?.ok ?? false;
                const entryOrderError = item.entryOrder?.error_message;

                return (
                  <React.Fragment key={item.proposal.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(item.proposal.created_at).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {item.proposal.symbol}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {item.proposal.strategy}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {item.proposal.short_strike}/{item.proposal.long_strike} ({item.proposal.width}pt)
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        ${item.proposal.credit_target.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatScore(item.proposal.score)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${getOutcomeColor(item.outcome)}`}>
                          {item.outcome}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        {item.entryOrder ? (
                          <div>
                            {entryOrderOk ? (
                              <span className="text-green-600">✓ OK</span>
                            ) : (
                              <span className="text-red-600">✗ Error</span>
                            )}
                            {item.entryOrderStatus && (
                              <div className="text-xs text-gray-500">
                                Status: {item.entryOrderStatus.status_code}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-500">No order</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => toggleRow(item.proposal.id)}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          {isExpanded ? '▼' : '▶'}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={9} className="px-6 py-4 bg-gray-50">
                          <div className="space-y-4">
                            {/* Proposal Details */}
                            <div>
                              <h3 className="text-lg font-semibold text-gray-900 mb-2">Proposal Details</h3>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div>
                                  <span className="text-gray-500">Expiration:</span>
                                  <div className="text-gray-900 font-medium">{item.proposal.expiration}</div>
                                </div>
                                <div>
                                  <span className="text-gray-500">Quantity:</span>
                                  <div className="text-gray-900 font-medium">{item.proposal.quantity}</div>
                                </div>
                                <div>
                                  <span className="text-gray-500">Min Score Required:</span>
                                  <div className="text-gray-900 font-medium">{formatScore(item.proposal.min_score_required)}</div>
                                </div>
                                <div>
                                  <span className="text-gray-500">Min Credit Required:</span>
                                  <div className="text-gray-900 font-medium">${item.proposal.min_credit_required.toFixed(2)}</div>
                                </div>
                              </div>
                              <div className="mt-4">
                                <h4 className="text-md font-semibold text-gray-900 mb-2">Component Scores</h4>
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                                  <div>
                                    <span className="text-gray-500">IVR:</span>
                                    <div className="text-gray-900 font-medium">{formatScore(item.proposal.ivr_score)}</div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">Vertical Skew:</span>
                                    <div className="text-gray-900 font-medium">{formatScore(item.proposal.vertical_skew_score)}</div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">Term Structure:</span>
                                    <div className="text-gray-900 font-medium">{formatScore(item.proposal.term_structure_score)}</div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">Delta Fitness:</span>
                                    <div className="text-gray-900 font-medium">{formatScore(item.proposal.delta_fitness_score)}</div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">EV:</span>
                                    <div className="text-gray-900 font-medium">{formatScore(item.proposal.ev_score)}</div>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Outcome & Rationale */}
                            <div>
                              <h3 className="text-lg font-semibold text-gray-900 mb-2">Outcome & Rationale</h3>
                              <div className="bg-white border border-gray-200 rounded p-4">
                                <div className="mb-2">
                                  <span className="text-gray-500">Outcome:</span>
                                  <span className={`ml-2 px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${getOutcomeColor(item.outcome)}`}>
                                    {item.outcome}
                                  </span>
                                </div>
                                <div className="mb-2">
                                  <span className="text-gray-500">Reason:</span>
                                  <div className="text-gray-900 mt-1">{item.outcomeReason}</div>
                                </div>
                                {item.rejectionReasons.length > 0 && (
                                  <div>
                                    <span className="text-gray-500">Rejection Reasons:</span>
                                    <ul className="list-disc list-inside text-red-600 mt-1">
                                      {item.rejectionReasons.map((reason, idx) => (
                                        <li key={idx}>{reason}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Trade Info */}
                            {item.trade && (
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900 mb-2">Trade</h3>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                  <div>
                                    <span className="text-gray-500">Trade ID:</span>
                                    <div className="text-gray-900 font-mono text-xs">{item.trade.id}</div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">Status:</span>
                                    <div className="text-gray-900 font-medium">{item.trade.status}</div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">Entry Price:</span>
                                    <div className="text-gray-900 font-medium">
                                      {item.trade.entry_price ? `$${item.trade.entry_price.toFixed(2)}` : 'N/A'}
                                    </div>
                                  </div>
                                  <div>
                                    <span className="text-gray-500">Exit Price:</span>
                                    <div className="text-gray-900 font-medium">
                                      {item.trade.exit_price ? `$${item.trade.exit_price.toFixed(2)}` : 'N/A'}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Entry Order */}
                            {item.entryOrder && (
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900 mb-2">Entry Order</h3>
                                <div className="bg-white border border-gray-200 rounded p-4">
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                    <div>
                                      <span className="text-gray-500">Order ID:</span>
                                      <div className="text-gray-900 font-mono text-xs">{item.entryOrder.order_id || 'N/A'}</div>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Status:</span>
                                      <div className={entryOrderOk ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                                        {entryOrderOk ? 'OK' : 'Error'}
                                      </div>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">HTTP Status:</span>
                                      <div className="text-gray-900">{item.entryOrder.status_code || 'N/A'}</div>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Duration:</span>
                                      <div className="text-gray-900">{item.entryOrder.duration_ms ? `${item.entryOrder.duration_ms}ms` : 'N/A'}</div>
                                    </div>
                                  </div>
                                  {entryOrderError && (
                                    <div className="mt-2">
                                      <span className="text-gray-500">Error:</span>
                                      <div className="text-red-600 text-sm mt-1">{entryOrderError}</div>
                                    </div>
                                  )}
                                  {item.entryOrderStatus && (
                                    <div className="mt-2 pt-2 border-t border-gray-200">
                                      <span className="text-gray-500">Order Status Check:</span>
                                      <div className="text-gray-900 text-sm mt-1">
                                        Status Code: {item.entryOrderStatus.status_code || 'N/A'}
                                        {item.entryOrderStatus.error_message && (
                                          <div className="text-red-600 mt-1">{item.entryOrderStatus.error_message}</div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Exit Order */}
                            {item.exitOrder && (
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900 mb-2">Exit Order</h3>
                                <div className="bg-white border border-gray-200 rounded p-4">
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                    <div>
                                      <span className="text-gray-500">Order ID:</span>
                                      <div className="text-gray-900 font-mono text-xs">{item.exitOrder.order_id || 'N/A'}</div>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Status:</span>
                                      <div className={item.exitOrder.ok ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                                        {item.exitOrder.ok ? 'OK' : 'Error'}
                                      </div>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">HTTP Status:</span>
                                      <div className="text-gray-900">{item.exitOrder.status_code || 'N/A'}</div>
                                    </div>
                                    <div>
                                      <span className="text-gray-500">Created:</span>
                                      <div className="text-gray-900 text-xs">
                                        {new Date(item.exitOrder.created_at).toLocaleString()}
                                      </div>
                                    </div>
                                  </div>
                                  {item.exitOrder.error_message && (
                                    <div className="mt-2">
                                      <span className="text-gray-500">Error:</span>
                                      <div className="text-red-600 text-sm mt-1">{item.exitOrder.error_message}</div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Entry Logs */}
                            {item.entryLogs.length > 0 && (
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900 mb-2">Entry Logs</h3>
                                <div className="bg-white border border-gray-200 rounded p-4 max-h-64 overflow-y-auto">
                                  {item.entryLogs.map((log, idx) => (
                                    <div key={idx} className="mb-2 text-xs font-mono border-b border-gray-200 pb-2">
                                      <div className="text-gray-500">
                                        {new Date(log.created_at).toLocaleString()}
                                      </div>
                                      <div className="text-gray-900 mt-1">{log.message}</div>
                                      {log.details && (
                                        <div className="text-gray-500 mt-1 whitespace-pre-wrap">
                                          {log.details}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Exit Logs */}
                            {item.exitLogs.length > 0 && (
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900 mb-2">Exit Logs</h3>
                                <div className="bg-white border border-gray-200 rounded p-4 max-h-64 overflow-y-auto">
                                  {item.exitLogs.map((log, idx) => (
                                    <div key={idx} className="mb-2 text-xs font-mono border-b border-gray-200 pb-2">
                                      <div className="text-gray-500">
                                        {new Date(log.created_at).toLocaleString()}
                                      </div>
                                      <div className="text-gray-900 mt-1">{log.message}</div>
                                      {log.details && (
                                        <div className="text-gray-500 mt-1 whitespace-pre-wrap">
                                          {log.details}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </div>
  );
}

