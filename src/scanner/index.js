import { checkFilters, getHoldersData } from './filter.js';
import { buyToken } from '../trader/buy.js';
import { getClient, FACTORY_V2, FACTORY_V2_ABI } from '../core/chain.js';
import { parseAbi } from 'viem';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { getAllConfig, getPrisma } from '../db/index.js';

let running = false;
let pollTimer = null;
const seenTokens = new Set();

const PONS_API = 'https://www.ponsfamily.com/api/pons-launches';

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

export async function startScanner(notifyFn) {
  if (running) return;
  running = true;

  await logInfo('Scanner started');

  const poll = async () => {
    if (!running) return;

    try {
      const config = await getAllConfig();
      const pollMs = parseInt(config.scanner_poll_ms || '10000');

      // Check max positions BEFORE API call
      const db = getPrisma();
      const openCount = await db.position.count({ where: { status: 'open' } });
      const maxPositions = parseInt(config.max_open_positions || '5');
      if (openCount >= maxPositions) {
        // Skip API call, schedule next poll
        if (running) pollTimer = setTimeout(poll, pollMs);
        return;
      }

      const thresholdPct = parseFloat(config.bonding_curve_pct || '80');
      const launches = await fetchActiveLaunches();

      for (const launch of launches) {
        const token = launch.token.toLowerCase();
        const progress = launch.graduationProgressPct;

        if (seenTokens.has(token)) continue;
        if (progress < thresholdPct) continue;

        // ETH pair filter
        const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
        if (config.only_eth_paired === 'true' && launch.pairToken?.toLowerCase() !== ZERO_ADDR) {
          continue;
        }

        seenTokens.add(token);

        // No rebuy filter
        if (config.no_rebuy === 'true') {
          const existing = await db.position.findFirst({
            where: { token },
          });
          if (existing) {
            await logWarn(`${launch.symbol} already traded (pos #${existing.id}), skipping`);
            continue;
          }
        }

        await logInfo(`${launch.symbol} hit ${progress.toFixed(1)}% bonding, running filters...`);

        // Check dev hold + holder count in one API call
        const maxDevHoldPct = parseFloat(config.max_dev_hold_pct || '5');
        const { holdersCount, devHoldPct } = await getHoldersData(token, launch.deployer);

        if (devHoldPct > maxDevHoldPct) {
          await logWarn(`${launch.symbol} dev holds ${devHoldPct.toFixed(1)}% (max: ${maxDevHoldPct}%), skipping`);
          continue;
        }

        const filters = {
          require_social: config.require_social,
          min_holders: config.min_holders,
          _holdersCount: holdersCount, // reuse fetched data
        };

        const result = await checkFilters(token, filters);
        if (!result.pass) {
          await logWarn(`${launch.symbol} filtered out: ${result.reason}`);
          continue;
        }

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
      const config = await getAllConfig();
      const pollMs = parseInt(config.scanner_poll_ms || '10000');
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
