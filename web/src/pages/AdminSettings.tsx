import { useEffect, useState } from 'react';
import { getSystemSettings, updateSystemSetting } from '../api';
import type { SystemSettings } from '../api';

interface SettingField {
  key: string;
  label: string;
  description: string;
  type: 'text' | 'number' | 'select';
  options?: string[];
  category: 'trading' | 'scoring' | 'risk' | 'exitRules' | 'other';
}

const SETTING_FIELDS: SettingField[] = [
  // Trading
  {
    key: 'TRADING_MODE',
    label: 'Trading Mode',
    description: 'Current trading mode (DRY_RUN, SANDBOX_PAPER, LIVE)',
    type: 'select',
    options: ['DRY_RUN', 'SANDBOX_PAPER', 'LIVE'],
    category: 'trading',
  },
  {
    key: 'AUTO_MODE_ENABLED_PAPER',
    label: 'Auto Mode (Paper)',
    description: 'Enable auto-execution in SANDBOX_PAPER mode',
    type: 'select',
    options: ['true', 'false'],
    category: 'trading',
  },
  {
    key: 'AUTO_MODE_ENABLED_LIVE',
    label: 'Auto Mode (Live)',
    description: 'Enable auto-execution in LIVE mode',
    type: 'select',
    options: ['true', 'false'],
    category: 'trading',
  },
  // Scoring
  {
    key: 'MIN_SCORE_PAPER',
    label: 'Min Score (Paper)',
    description: 'Minimum score threshold for PAPER mode (0-1 scale)',
    type: 'number',
    category: 'scoring',
  },
  {
    key: 'MIN_SCORE_LIVE',
    label: 'Min Score (Live)',
    description: 'Minimum score threshold for LIVE mode (0-100 scale)',
    type: 'number',
    category: 'scoring',
  },
  // Risk
  {
    key: 'MAX_NEW_TRADES_PER_DAY',
    label: 'Max New Trades Per Day',
    description: 'Maximum number of new trades allowed per day',
    type: 'number',
    category: 'risk',
  },
  {
    key: 'MAX_OPEN_SPREADS_GLOBAL',
    label: 'Max Open Spreads',
    description: 'Maximum number of open spreads allowed simultaneously',
    type: 'number',
    category: 'risk',
  },
  {
    key: 'MAX_DAILY_LOSS_PCT',
    label: 'Max Daily Loss %',
    description: 'Maximum daily loss as percentage of account equity (e.g., 0.02 = 2%)',
    type: 'number',
    category: 'risk',
  },
  {
    key: 'ACCOUNT_EQUITY_REFERENCE',
    label: 'Account Equity Reference',
    description: 'Reference account equity for risk calculations',
    type: 'number',
    category: 'risk',
  },
  // Exit Rules
  {
    key: 'CLOSE_RULE_PROFIT_TARGET_FRACTION',
    label: 'Profit Target Fraction',
    description: 'Profit target as fraction of max gain (e.g., 0.35 = 35%)',
    type: 'number',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_STOP_LOSS_FRACTION',
    label: 'Stop Loss Fraction',
    description: 'Stop loss as fraction of max loss (e.g., -0.30 = -30%)',
    type: 'number',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_TIME_EXIT_DTE',
    label: 'Time Exit DTE',
    description: 'Days to expiration threshold for time-based exit',
    type: 'number',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_TIME_EXIT_CUTOFF',
    label: 'Time Exit Cutoff',
    description: 'Time cutoff for time-based exit (HH:MM format, ET)',
    type: 'text',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_IV_CRUSH_THRESHOLD',
    label: 'IV Crush Threshold',
    description: 'IV crush threshold (e.g., 0.85 = 85% of entry IV)',
    type: 'number',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_IV_CRUSH_MIN_PNL',
    label: 'IV Crush Min PnL',
    description: 'Minimum PnL required to trigger IV crush exit (e.g., 0.15 = 15%)',
    type: 'number',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_TRAIL_ARM_PROFIT_FRACTION',
    label: 'Trail Arm Profit Fraction',
    description: 'Profit fraction to start trailing (e.g., 0.25 = 25%)',
    type: 'number',
    category: 'exitRules',
  },
  {
    key: 'CLOSE_RULE_TRAIL_GIVEBACK_FRACTION',
    label: 'Trail Giveback Fraction',
    description: 'Giveback fraction to trigger exit (e.g., 0.10 = 10%)',
    type: 'number',
    category: 'exitRules',
  },
  // Other
  {
    key: 'DEFAULT_TRADE_QUANTITY',
    label: 'Default Trade Quantity',
    description: 'Default number of contracts per trade',
    type: 'number',
    category: 'other',
  },
];

export default function AdminSettings() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [updateError, setUpdateError] = useState<Record<string, string>>({});

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      setLoading(true);
      setError(null);
      const data = await getSystemSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdate(key: string, value: string) {
    try {
      setUpdating(prev => ({ ...prev, [key]: true }));
      setUpdateError(prev => ({ ...prev, [key]: '' }));
      await updateSystemSetting(key, value);
      await loadSettings(); // Reload to get updated values
    } catch (err) {
      setUpdateError(prev => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Failed to update',
      }));
    } finally {
      setUpdating(prev => ({ ...prev, [key]: false }));
    }
  }

  function getValue(key: string): string {
    return settings?.all[key] || '';
  }

  function renderField(field: SettingField) {
    const currentValue = getValue(field.key);
    const isUpdating = updating[field.key];
    const fieldError = updateError[field.key];

    return (
      <div key={field.key} className="mb-6 p-4 bg-white rounded-lg shadow">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {field.label}
        </label>
        <p className="text-xs text-gray-500 mb-2">{field.description}</p>
        <div className="flex gap-2">
          {field.type === 'select' ? (
            <select
              value={currentValue}
              onChange={(e) => handleUpdate(field.key, e.target.value)}
              disabled={isUpdating}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            >
              {field.options?.map(opt => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                type={field.type}
                value={currentValue}
                onChange={() => {
                  // Don't update on every keystroke, wait for blur or Enter
                }}
                onBlur={(e) => {
                  if (e.target.value !== currentValue) {
                    handleUpdate(field.key, e.target.value);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value !== currentValue) {
                    handleUpdate(field.key, e.currentTarget.value);
                  }
                }}
                disabled={isUpdating}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                placeholder="Not set"
              />
              {currentValue && (
                <button
                  onClick={() => handleUpdate(field.key, currentValue)}
                  disabled={isUpdating}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
                >
                  {isUpdating ? 'Saving...' : 'Save'}
                </button>
              )}
            </>
          )}
        </div>
        {fieldError && (
          <p className="mt-1 text-sm text-red-600">{fieldError}</p>
        )}
        {isUpdating && !fieldError && (
          <p className="mt-1 text-sm text-gray-500">Updating...</p>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="text-center">Loading settings...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="text-center text-red-600">Error: {error}</div>
        <button
          onClick={loadSettings}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  const categories = ['trading', 'scoring', 'risk', 'exitRules', 'other'] as const;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">System Settings</h1>
        <p className="text-gray-600">
          Configure system parameters. Changes take effect immediately.
        </p>
        <button
          onClick={loadSettings}
          className="mt-4 px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
        >
          Refresh
        </button>
      </div>

      {categories.map(category => {
        const categoryFields = SETTING_FIELDS.filter(f => f.category === category);
        if (categoryFields.length === 0) return null;

        const categoryLabels: Record<string, string> = {
          trading: 'Trading Mode & Auto-Execution',
          scoring: 'Scoring Thresholds',
          risk: 'Risk Management',
          exitRules: 'Exit Rules',
          other: 'Other Settings',
        };

        return (
          <div key={category} className="mb-8">
            <h2 className="text-xl font-semibold text-gray-800 mb-4 border-b pb-2">
              {categoryLabels[category]}
            </h2>
            {categoryFields.map(field => renderField(field))}
          </div>
        );
      })}

      {/* Show any settings not in our predefined list */}
      {settings && Object.keys(settings.all).length > SETTING_FIELDS.length && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-800 mb-4 border-b pb-2">
            Additional Settings
          </h2>
          {Object.entries(settings.all)
            .filter(([key]) => !SETTING_FIELDS.find(f => f.key === key))
            .map(([key, value]) => (
              <div key={key} className="mb-4 p-4 bg-gray-50 rounded-lg">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {key}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={value}
                    onChange={() => {
                      // Don't update on every keystroke
                    }}
                    onBlur={(e) => {
                      if (e.target.value !== value) {
                        handleUpdate(key, e.target.value);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.currentTarget.value !== value) {
                        handleUpdate(key, e.currentTarget.value);
                      }
                    }}
                    disabled={updating[key]}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                  {value && (
                    <button
                      onClick={() => handleUpdate(key, value)}
                      disabled={updating[key]}
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
                    >
                      {updating[key] ? 'Saving...' : 'Save'}
                    </button>
                  )}
                </div>
                {updateError[key] && (
                  <p className="mt-1 text-sm text-red-600">{updateError[key]}</p>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

