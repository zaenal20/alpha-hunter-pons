import { sellOnCurve, sellOnV4, getTokenBalance, getCurrentPrice } from '../core/trade.js';
import { getWalletClient } from '../core/chain.js';
import { getPrisma } from '../db/index.js';
import { env } from '../config/env.js';
import { formatEther } from 'viem';
import { logInfo, logSell, logError } from '../utils/logger.js';
import { formatSellMsg, htmlEsc } from '../utils/format.js';

let telegramNotify = null;
export function setSellerNotify(fn) { telegramNotify = fn; }

/**
 * Sell a token and close a position
 * Tries curve first, falls back to v4 if graduated
 */
export async function sellToken(positionId, reason) {
  const db = getPrisma();
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position || position.status !== 'open') return;

  const walletClient = getWalletClient();
  const recipient = walletClient.account.address;

  await logInfo(`Selling position #${positionId} (${reason})`);

  try {
    // Get current price (curve first, v4 fallback)
    const sellPrice = await getCurrentPrice(position.curve, position.token);

    const pnl = position.buyPrice > 0 && sellPrice
      ? ((sellPrice - position.buyPrice) / position.buyPrice) * 100
      : 0;

    // Dry run
    if (env.DRY_RUN) {
      const ethReceived = position.buyAmountEth * (1 + pnl / 100);

      const sellData = {
        symbol: position.symbol,
        token: position.token,
        positionId,
        reason,
        buyPrice: position.buyPrice,
        buyAmountEth: position.buyAmountEth,
        sellPrice: sellPrice || 0,
        ethReceived,
        pnl: pnl.toFixed(2),
        tx: 'DRY_RUN',
        dryRun: true,
      };

      await db.position.update({
        where: { id: positionId },
        data: { status: 'closed', sellPrice: sellPrice || 0, sellAmountEth: ethReceived, pnl, closedAt: new Date() },
      });

      await logSell(`Position #${positionId} sold (dry run)`, sellData);
      if (telegramNotify) await telegramNotify(formatSellMsg(sellData));
      return;
    }

    // Live mode
    const balance = await getTokenBalance(position.token, recipient);

    if (balance === 0n) {
      const sellData = {
        symbol: position.symbol,
        positionId,
        reason,
        buyPrice: position.buyPrice,
        buyAmountEth: position.buyAmountEth,
        sellPrice: 0,
        ethReceived: 0,
        pnl: '-100.00',
        tx: 'N/A',
        dryRun: false,
      };

      await logSell(`Position #${positionId} has zero balance`, sellData);
      if (telegramNotify) await telegramNotify(formatSellMsg(sellData));
      await db.position.update({ where: { id: positionId }, data: { status: 'closed', pnl: -100, closedAt: new Date() } });
      return;
    }

    // Try curve sell first, fallback to v4 if it fails (graduated)
    let result;
    let venue = 'curve';

    try {
      result = await sellOnCurve(position.curve, balance, recipient, false);
    } catch (err) {
      if (err.message.includes('CurveGraduated') || err.message.includes('graduated')) {
        await logInfo(`Position #${positionId} graduated, selling via v4 pool`);
        venue = 'v4';
        result = await sellOnV4(position.token, balance, recipient, false);
      } else {
        throw err;
      }
    }

    let ethReceived = 0;
    if (result.quoteOut && result.quoteOut > 0n) {
      ethReceived = Number(formatEther(result.quoteOut));
    }

    await db.position.update({
      where: { id: positionId },
      data: { status: 'closed', sellPrice: sellPrice || 0, sellAmountEth: ethReceived, pnl, closedAt: new Date() },
    });

    const sellData = {
      symbol: position.symbol,
      token: position.token,
      positionId,
      reason,
      buyPrice: position.buyPrice,
      buyAmountEth: position.buyAmountEth,
      sellPrice: sellPrice || 0,
      ethReceived,
      pnl: pnl.toFixed(2),
      tx: result.hash,
      dryRun: false,
      venue,
    };

    await logSell(`Position #${positionId} sold via ${venue}`, sellData);
    if (telegramNotify) await telegramNotify(formatSellMsg(sellData));
  } catch (err) {
    await logError(`Failed to sell position #${positionId}: ${err.message}`, { positionId, reason });

    // Don't close position in DB - it's still open on-chain
    // Just notify so user can handle manually
    if (telegramNotify) {
      await telegramNotify({
        html: `<h3>⚠️ Sell Failed #${positionId}</h3><p>${htmlEsc(err.message)}</p><p>Position still open, try /sell ${positionId} again</p>`,
        fallback: `⚠️ *Sell Failed #${positionId}*\n${err.message}\nPosition still open, try /sell ${positionId} again`,
      });
    }
  }
}
