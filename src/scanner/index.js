import { checkFilters } from './filter.js';
import { buyToken } from '../trader/buy.js';
import { getClient, FACTORY_V2, FACTORY_V2_ABI } from '../core/chain.js';
import { parseAbi } from 'viem';
import { logInfo, logWarn, logError } from '../utils/logger.js';

let running = false;
let pollTimer = null;
const seenTokens = new Set();

const PONS_API = 'https://www.ponsfamily.com/api/pons-launches';

/**
 * Fetch active launches from Pons API
 */
async function fetchActiveLaunches() {
  const params = new URLSearchParams({
    explore: '1',
    sort: 'recentBuys',
    age: 'all',
    page: '1',
    pageSize: '50',
    graduatedPage: '1',
    graduatedPageSize: '10',
    includeGraduated: '0',
    version: 'all',
    v: '22',
    fresh: '1',
  });

  const res = await fetch(`${PONS_API}?${params}`);
  const data = await res.json();
  return data.active?.items || [];
}

/**
 * Start scanner - poll Pons API for launches with bonding progress
 */
export async function startScanner(notifyFn, config) {
  if (running) return;
  running = true;

  const pollMs = parseInt(config.scanner_poll_ms || '10000');
  const thresholdPct = parseFloat(config.bonding_curve_pct || '80');

  await logInfo(`Scanner started (threshold: ${thresholdPct}%)`);

  const poll = async () => {
    if (!running) return;

    try {
      const launches = await fetchActiveLaunches();

      for (const launch of launches) {
        const token = launch.token.toLowerCase();
        const progress = launch.graduationProgressPct;

        // Skip if already seen or below threshold
        if (seenTokens.has(token)) continue;
        if (progress < thresholdPct) continue;

        // ETH pair filter
        const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
        if (config.only_eth_paired === 'true' && launch.pairToken?.toLowerCase() !== ZERO_ADDR) {
          continue;
        }

        // Mark as seen
        seenTokens.add(token);

        await logInfo(`${launch.symbol} hit ${progress.toFixed(1)}% bonding, running filters...`);

        // Run filters
        const filters = {
          require_social: config.require_social,
          min_holders: config.min_holders,
        };

        const result = await checkFilters(token, filters);
        if (!result.pass) {
          await logWarn(`${launch.symbol} filtered out: ${result.reason}`);
          continue;
        }

        // Passed filters - need curve address
        const client = getClient();
        const launchData = await client.readContract({
          address: FACTORY_V2,
          abi: parseAbi(FACTORY_V2_ABI),
          functionName: 'getLaunchedToken',
          args: [token],
        });
        const curve = launchData.curve;

        const meta = result.meta;
        await logInfo(`${meta.symbol} passed filters, buying...`);

        await buyToken(token, curve, meta, config);
      }
    } catch (err) {
      await logError(`Scanner error: ${err.message}`);
    }

    if (running) {
      pollTimer = setTimeout(poll, pollMs);
    }
  };

  poll();
}

export function stopScanner() {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logInfo('Scanner stopped');
}

export function getWatchlistSize() {
  return seenTokens.size;
}
