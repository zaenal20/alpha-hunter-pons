import { parseEther, formatEther, parseAbi, encodeAbiParameters, keccak256 } from 'viem';
import { getClient, getWalletClient, CURVE_ABI, ERC20_ABI, POOL_MANAGER_ABI, POOL_MANAGER, MEME_HOOK, FACTORY_V2, FACTORY_V2_ABI } from './chain.js';
import { logError } from '../utils/logger.js';

const DEFAULT_SLIPPAGE_BPS = 500n; // 5%

function applySlippage(amount, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  return (amount * (10000n - slippageBps)) / 10000n;
}

function parseCurveBuyReceipt(receipt) {
  for (const log of receipt.logs) {
    if (log.data && log.data.length >= 194) {
      try {
        const data = log.data.slice(2);
        const tokensOut = BigInt('0x' + data.slice(64, 128));
        if (tokensOut > 0n) return tokensOut;
      } catch {}
    }
  }
  return 0n;
}

export async function getV2Price(curve) {
  const client = getClient();
  const [quoteReserve, tokenReserve] = await client.readContract({
    address: curve,
    abi: parseAbi(CURVE_ABI),
    functionName: 'getReserves',
  });
  return Number(quoteReserve) / Number(tokenReserve);
}

export async function getV2GraduationProgress(curve) {
  const client = getClient();
  const [raised, threshold] = await Promise.all([
    client.readContract({ address: curve, abi: parseAbi(CURVE_ABI), functionName: 'realQuoteReserve' }),
    client.readContract({ address: curve, abi: parseAbi(CURVE_ABI), functionName: 'graduationThreshold' }),
  ]);
  return Number(raised) / Number(threshold);
}

export async function buyOnCurve(curve, quoteIn, recipient, dryRun) {
  const quoteInWei = parseEther(quoteIn.toString());

  if (dryRun) {
    return { hash: 'DRY_RUN', tokensOut: 0n };
  }

  const walletClient = getWalletClient();
  const hash = await walletClient.writeContract({
    address: curve,
    abi: parseAbi(CURVE_ABI),
    functionName: 'buy',
    args: [quoteInWei, 0n, recipient],
    value: quoteInWei,
  });

  const client = getClient();
  const receipt = await client.waitForTransactionReceipt({ hash });
  const tokensOut = parseCurveBuyReceipt(receipt);

  return { hash, tokensOut, receipt };
}

export async function sellOnCurve(curve, tokensIn, recipient, dryRun) {
  if (dryRun) {
    return { hash: 'DRY_RUN', quoteOut: 0n };
  }

  const walletClient = getWalletClient();
  const hash = await walletClient.writeContract({
    address: curve,
    abi: parseAbi(CURVE_ABI),
    functionName: 'sell',
    args: [tokensIn, 0n, recipient],
  });

  const client = getClient();
  const receipt = await client.waitForTransactionReceipt({ hash });

  let quoteOut = 0n;
  for (const log of receipt.logs) {
    if (log.data && log.data.length >= 194) {
      try {
        const data = log.data.slice(2);
        const out = BigInt('0x' + data.slice(64, 128));
        if (out > 0n) { quoteOut = out; break; }
      } catch {}
    }
  }

  return { hash, quoteOut, receipt };
}

export async function getTokenBalance(token, address) {
  const client = getClient();
  return client.readContract({
    address: token,
    abi: parseAbi(ERC20_ABI),
    functionName: 'balanceOf',
    args: [address],
  });
}

/**
 * Build v4 pool key from launch record
 */
function buildPoolKey(launch) {
  const [currency0, currency1] =
    launch.pairToken.toLowerCase() < launch.token.toLowerCase()
      ? [launch.pairToken, launch.token]
      : [launch.token, launch.pairToken];

  return {
    currency0,
    currency1,
    fee: launch.poolFee || 0,
    tickSpacing: launch.tickSpacing || 60,
    hooks: MEME_HOOK,
  };
}

/**
 * Get price from v4 pool (for graduated tokens)
 */
export async function getV4Price(token) {
  const client = getClient();

  // Step 1: Get launch record from factory
  let launch;
  try {
    launch = await client.readContract({
      address: FACTORY_V2,
      abi: parseAbi(FACTORY_V2_ABI),
      functionName: 'getLaunchedToken',
      args: [token],
    });
  } catch (err) {
    await logError(`[V4Price] factory getLaunchedToken failed for ${token}: ${err.message}`);
    return null;
  }

  if (!launch || !launch.exists) {
    await logError(`[V4Price] token ${token} not found in factory`);
    return null;
  }

  // Step 2: Build pool key and compute poolId
  const poolKey = buildPoolKey(launch);
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' }, { type: 'address' },
        { type: 'uint24' }, { type: 'int24' }, { type: 'address' },
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    )
  );

  // Step 3: Compute storage slot (Pool.STATE_SLOT = 6)
  const STATE_SLOT = 6n;
  const storageSlot = keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [BigInt(poolId), STATE_SLOT]
    )
  );

  // Step 4: Read slot0 from PoolManager
  let data;
  try {
    data = await client.readContract({
      address: POOL_MANAGER,
      abi: parseAbi(POOL_MANAGER_ABI),
      functionName: 'extsload',
      args: [storageSlot],
    });
  } catch (err) {
    await logError(`[V4Price] extsload failed for ${token}: ${err.message}`, {
      poolId, storageSlot, pairToken: launch.pairToken, poolFee: poolKey.fee, tickSpacing: poolKey.tickSpacing,
    });
    return null;
  }

  // Step 5: Decode sqrtPriceX96
  const sqrtPriceX96 = BigInt(data) & ((1n << 160n) - 1n);
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n) {
    await logError(`[V4Price] sqrtPriceX96 is zero for ${token}`, {
      rawData: data, poolId, storageSlot,
    });
    return null;
  }

  // Step 6: Calculate price
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = ratio * ratio;
  const isToken0 = launch.pairToken.toLowerCase() > launch.token.toLowerCase();
  return isToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

/**
 * Sell on v4 pool via PoolManager
 */
export async function sellOnV4(token, tokensIn, recipient, dryRun) {
  if (dryRun) return { hash: 'DRY_RUN_V4', quoteOut: 0n };

  const client = getClient();
  const walletClient = getWalletClient();

  const launch = await client.readContract({
    address: FACTORY_V2,
    abi: parseAbi(FACTORY_V2_ABI),
    functionName: 'getLaunchedToken',
    args: [token],
  });

  const poolKey = buildPoolKey(launch);

  await walletClient.writeContract({
    address: token,
    abi: parseAbi(ERC20_ABI),
    functionName: 'approve',
    args: [POOL_MANAGER, tokensIn],
  });

  const isToken0 = launch.pairToken.toLowerCase() > launch.token.toLowerCase();
  const zeroForOne = isToken0;

  const hash = await walletClient.writeContract({
    address: POOL_MANAGER,
    abi: parseAbi(POOL_MANAGER_ABI),
    functionName: 'swap',
    args: [
      poolKey,
      {
        zeroForOne,
        amountSpecified: tokensIn,
        sqrtPriceLimitX96: zeroForOne
          ? 4295128740n
          : 1461446703485210103287273052203988822378723970341n,
      },
      '0x',
    ],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });

  let quoteOut = 0n;
  for (const log of receipt.logs) {
    if (log.data && log.data.length >= 258) {
      try {
        const data = log.data.slice(2);
        const amount0 = BigInt('0x' + data.slice(0, 64));
        const amount1 = BigInt('0x' + data.slice(64, 128));
        quoteOut = isToken0 ? (amount1 > 0n ? amount1 : -amount1) : (amount0 > 0n ? amount0 : -amount0);
        if (quoteOut > 0n) break;
      } catch {}
    }
  }

  return { hash, quoteOut, receipt };
}

/**
 * Get current price - curve first, v4 fallback for graduated tokens
 */
export async function getCurrentPrice(curve, token) {
  const client = getClient();

  // Step 1: Try curve
  try {
    const [quoteReserve, tokenReserve] = await client.readContract({
      address: curve,
      abi: parseAbi(CURVE_ABI),
      functionName: 'getReserves',
    });

    const price = Number(quoteReserve) / Number(tokenReserve);
    if (price > 0 && isFinite(price)) return price;

    // Price invalid (Infinity/NaN) — token likely graduated
    console.log(`[Price] curve invalid for ${token}, falling back to v4 (reserves: ${quoteReserve}/${tokenReserve})`);
  } catch (err) {
    await logError(`[Price] curve error for ${token} (curve: ${curve}): ${err.message}`);
  }

  // Step 2: Fallback v4
  if (token) {
    try {
      const v4Price = await getV4Price(token);
      if (v4Price && v4Price > 0 && isFinite(v4Price)) return v4Price;
      await logError(`[Price] v4 returned invalid for ${token}: ${v4Price}`);
    } catch (err) {
      await logError(`[Price] v4 error for ${token}: ${err.message}`);
    }
  } else {
    await logError(`[Price] no token address for curve ${curve}, cannot fallback`);
  }

  return null;
}
