import { buyOnCurve, getCurrentPrice } from '../core/trade.js';
import { getWalletClient } from '../core/chain.js';
import { getPrisma } from '../db/index.js';
import { formatEther } from 'viem';
import { env } from '../config/env.js';
import { startPriceMonitor } from './monitor.js';
import { logInfo, logBuy, logError } from '../utils/logger.js';
import { formatBuyMsg } from '../utils/format.js';

// Telegram notify function - set by bot
let telegramNotify = null;
export function setTraderNotify(fn) { telegramNotify = fn; }

/**
 * Buy a token and open a position
 */
export async function buyToken(token, curve, meta, config) {
  const db = getPrisma();
  const walletClient = getWalletClient();
  const recipient = walletClient.account.address;

  const buyAmountEth = parseFloat(config.buy_amount_eth || '0.01');
  const mainStoplossPct = parseFloat(config.main_stoploss_pct || '30');
  const trailingStoplossPct = parseFloat(config.trailing_stoploss_pct || '15');

  // Check max open positions
  const openPositions = await db.position.count({ where: { status: 'open' } });
  const maxPositions = parseInt(config.max_open_positions || '5');
  if (openPositions >= maxPositions) {
    await logInfo(`Max open positions (${maxPositions}) reached, skipping buy for ${meta.symbol}`);
    return;
  }

  await logInfo(`Buying ${meta.symbol} for ${buyAmountEth} ETH (${env.DRY_RUN ? 'DRY RUN' : 'LIVE'})`);

  try {
    // Get price before buy
    const buyPrice = await getCurrentPrice(curve);

    // Execute buy
    const result = await buyOnCurve(curve, buyAmountEth, recipient, env.DRY_RUN);

    // Get actual tokens received
    let tokensReceived = 0;
    if (result.tokensOut && result.tokensOut > 0n) {
      tokensReceived = Number(formatEther(result.tokensOut));
    } else if (env.DRY_RUN && buyPrice > 0) {
      // Estimate tokens for dry run
      tokensReceived = buyAmountEth / buyPrice;
    }

    // Calculate stoploss levels
    const mainStoplossPrice = buyPrice * (1 - mainStoplossPct / 100);
    const trailingHigh = buyPrice;

    // Save position to DB
    const position = await db.position.create({
      data: {
        token: token.toLowerCase(),
        symbol: meta.symbol,
        curve: curve.toLowerCase(),
        status: 'open',
        buyPrice,
        buyAmountEth,
        tokensReceived,
        mainStoploss: mainStoplossPrice,
        trailingStop: null,
        trailingHigh,
      },
    });

    const txHash = env.DRY_RUN ? 'DRY_RUN' : result.hash;

    const buyData = {
      symbol: meta.symbol,
      token: token,
      amount: buyAmountEth,
      tokens: tokensReceived,
      price: buyPrice,
      mainSL: mainStoplossPrice,
      trailingPct: trailingStoplossPct,
      positionId: position.id,
      tx: txHash,
      dryRun: env.DRY_RUN,
    };

    await logBuy(`${meta.symbol} bought`, buyData);

    // Send formatted Telegram notification
    if (telegramNotify) {
      await telegramNotify(formatBuyMsg(buyData));
    }

    // Start price monitoring
    startPriceMonitor(position.id, token, curve);

    return position;
  } catch (err) {
    await logError(`Failed to buy ${meta.symbol}: ${err.message}`, { token, curve });
    throw err;
  }
}
