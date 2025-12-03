import { useEffect, useState } from 'react';
import React from 'react';
import { getBrokerEvents, type BrokerEvent, type SystemLog, type BrokerEventsResponse } from '../api';

export default function BrokerActivityPage() {
  const [data, setData] = useState<BrokerEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const response = await getBrokerEvents(100);
        if (!cancelled) {
          setData(response);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'Failed to load broker events');
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

  const parseProposalDetails = (details: string | null): any => {
    if (!details) return null;
    try {
      return JSON.parse(details);
    } catch {
      return null;
    }
  };

  const allEvents = [
    ...(data?.events.map(e => ({ ...e, type: 'broker' as const, sortKey: e.created_at })) || []),
    ...(data?.systemLogs.map(l => ({ ...l, type: 'system' as const, sortKey: l.created_at })) || []),
  ].sort((a, b) => new Date(b.sortKey).getTime() - new Date(a.sortKey).getTime());

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Broker Activity & System Logs</h1>

      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {error && <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>}

      {!loading && !error && allEvents.length === 0 && (
        <div className="text-sm text-gray-500 bg-gray-50 p-4 rounded">
          No broker events or system logs recorded yet.
        </div>
      )}

      {allEvents.length > 0 && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-8">
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">
                    Time
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">
                    Type
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider min-w-[200px]">
                    Operation / Message
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">
                    Symbol
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-20">
                    Status
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">
                    Duration (ms)
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {allEvents.map((item) => {
                  const isExpanded = expandedRows.has(`${item.type}-${item.id}`);
                  const rowId = `${item.type}-${item.id}`;

                  if (item.type === 'broker') {
                    const ev = item as BrokerEvent & { type: 'broker' };
                    return (
                      <React.Fragment key={rowId}>
                        <tr
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => toggleRow(rowId)}
                        >
                          <td className="px-2 py-2 whitespace-nowrap">
                            <span className="text-gray-400 text-xs">
                              {isExpanded ? '▼' : '▶'}
                            </span>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-gray-500">
                            {new Date(ev.created_at).toLocaleTimeString()}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                              Broker
                            </span>
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-900">
                            <span className="font-mono truncate block max-w-[200px]">{ev.operation}</span>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-gray-900">
                            {ev.symbol ?? '-'}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs">
                            {ev.status_code ? (
                              <span className={ev.ok ? 'text-green-600' : 'text-red-600'}>
                                {ev.status_code} {ev.ok ? '✅' : '⚠️'}
                              </span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-gray-500">
                            {ev.duration_ms ?? '-'}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-gray-50">
                            <td colSpan={7} className="px-2 py-2">
                              <div className="text-xs space-y-1">
                                <div><strong>Expiration:</strong> {ev.expiration ?? '-'}</div>
                                <div><strong>Order ID:</strong> {ev.order_id ?? '-'}</div>
                                <div><strong>Mode:</strong> {ev.mode}</div>
                                {ev.error_message && (
                                  <div className="text-red-600"><strong>Error:</strong> {ev.error_message}</div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  } else {
                    const log = item as SystemLog & { type: 'system' };
                    const details = parseProposalDetails(log.details);
                    const isProposalSummary = log.message.includes('[proposals] summary');
                    const isTradeCycle = log.message.includes('[tradeCycle]');

                    return (
                      <React.Fragment key={rowId}>
                        <tr
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => toggleRow(rowId)}
                        >
                          <td className="px-2 py-2 whitespace-nowrap">
                            <span className="text-gray-400 text-xs">
                              {isExpanded ? '▼' : '▶'}
                            </span>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-gray-500">
                            {new Date(log.created_at).toLocaleTimeString()}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                              isTradeCycle ? 'bg-yellow-100 text-yellow-800' :
                              isProposalSummary ? 'bg-purple-100 text-purple-800' :
                              'bg-gray-100 text-gray-800'
                            }`}>
                              {log.log_type}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-900">
                            <div className="truncate max-w-[200px]">{log.message}</div>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-gray-900">
                            {details?.symbol ?? '-'}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs">
                            {details?.reason ? (
                              <span className={`truncate block max-w-[80px] ${details.reason.includes('ERROR') || details.reason.includes('FAILED') ? 'text-red-600' : 'text-yellow-600'}`}>
                                {details.reason}
                              </span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-gray-500">
                            -
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-gray-50">
                            <td colSpan={7} className="px-2 py-2">
                              <div className="text-xs space-y-2">
                                <div><strong>Message:</strong> {log.message}</div>
                                {details && (
                                  <div className="mt-2">
                                    <strong>Details:</strong>
                                    <pre className="mt-1 p-2 bg-gray-100 rounded text-xs overflow-x-auto">
                                      {JSON.stringify(details, null, 2)}
                                    </pre>
                                  </div>
                                )}
                                {!details && log.details && (
                                  <div className="mt-2">
                                    <strong>Details:</strong>
                                    <pre className="mt-1 p-2 bg-gray-100 rounded text-xs overflow-x-auto">
                                      {log.details}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  }
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
