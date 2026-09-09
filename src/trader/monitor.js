import { getPrisma, getConfig } from '../db/index.js';
import { getCurrentPrice } from '../core/trade.js';
import { sellToken } from './sell.js';
import { logInfo, logError } from '../utils/logger.js';

const activeMonitors = new Map(); // positionId -> timer

/**
 * Start monitoring price for a position
 */
export async function startPriceMonitor(positionId, token, curve) {
  if (activeMonitors.has(positionId)) return;

  const db = getPrisma();
  const trailingPct = parseFloat((await getConfig('trailing_stoploss_pct')) || '15');
  const pollMs = parseInt((await getConfig('monitor_poll_ms')) || '3000');
  const maxMinutes = parseFloat((await getConfig('max_position_minutes')) || '30');

  await logInfo(`Starting price monitor for position #${positionId} (max ${maxMinutes}m)`);

  const poll = async () => {
    try {
      const position = await db.position.findUnique({ where: { id: positionId } });
      if (!position || position.status !== 'open') {
        stopPriceMonitor(positionId);
        return;
      }

      const currentPrice = await getCurrentPrice(curve, token);
      if (!currentPrice || currentPrice <= 0) return;

      // --- Max Position Time ---
      const ageMinutes = (Date.now() - new Date(position.createdAt).getTime()) / 60000;
      if (ageMinutes >= maxMinutes) {
        await sellToken(positionId, `Max position time reached (${maxMinutes}m)`);
        return;
      }

      // --- Main Stoploss ---
      if (position.mainStoploss && currentPrice <= position.mainStoploss) {
        await sellToken(positionId, `Main stoploss hit (${position.mainStoploss.toFixed(12)})`);
        return;
      }

      // --- Trailing Stop ---
      if (currentPrice > (position.trailingHigh || 0)) {
        const newTrailingStop = currentPrice * (1 - trailingPct / 100);

        await db.position.update({
          where: { id: positionId },
          data: { trailingHigh: currentPrice, trailingStop: newTrailingStop },
        });

        const gainPct = position.buyPrice > 0
          ? ((currentPrice - position.buyPrice) / position.buyPrice) * 100
          : 0;

        if (gainPct > 5) {
          await logInfo(`New high for #${positionId}: ${currentPrice.toFixed(12)} ETH (+${gainPct.toFixed(2)}%)`);
        }
      }

      if (position.trailingStop && currentPrice <= position.trailingStop) {
        await sellToken(positionId, `Trailing stoploss hit (${position.trailingStop.toFixed(12)})`);
        return;
      }
    } catch (err) {
      await logError(`Monitor error for #${positionId}: ${err.message}`);
    }

    if (activeMonitors.has(positionId)) {
      activeMonitors.set(positionId, setTimeout(poll, pollMs));
    }
  };

  activeMonitors.set(positionId, setTimeout(poll, pollMs));
}

/**
 * Stop monitoring a position
 */
export function stopPriceMonitor(positionId) {
  const timer = activeMonitors.get(positionId);
  if (timer) {
    clearTimeout(timer);
    activeMonitors.delete(positionId);
    console.log(`[Monitor] Stopped for position #${positionId}`);
  }
}

/**
 * Resume monitoring for all open positions (on startup)
 */
export async function resumeAllMonitors() {
  const db = getPrisma();
  const openPositions = await db.position.findMany({ where: { status: 'open' } });

  for (const pos of openPositions) {
    await startPriceMonitor(pos.id, pos.token, pos.curve);
  }

  await logInfo(`Resumed ${openPositions.length} position monitors`);
}
