import { getClient, TOKEN_ABI, TOKEN_INFO_ABI, FACTORY_V2, FACTORY_V2_ABI, CURVE_ABI } from '../core/chain.js';
import { parseAbi } from 'viem';

/**
 * Check if socials object has any non-empty links
 */
function hasSocials(socials) {
  if (!socials) return false;
  return !!(socials.twitter || socials.telegram || socials.discord || socials.website || socials.farcaster);
}

/**
 * Get token metadata (name, symbol, socials, etc.)
 * Tries socials() first, falls back to getTokenInfo() if empty
 */
export async function getTokenMeta(token) {
  const client = getClient();

  const [name, symbol, socials] = await Promise.all([
    client.readContract({ address: token, abi: parseAbi(TOKEN_ABI), functionName: 'name' }),
    client.readContract({ address: token, abi: parseAbi(TOKEN_ABI), functionName: 'symbol' }),
    client.readContract({ address: token, abi: parseAbi(TOKEN_ABI), functionName: 'socials' }),
  ]);

  let description = '';
  let deployer = '';
  let finalSocials = socials;

  // Try getTokenInfo() for additional data and fallback socials
  try {
    const info = await client.readContract({
      address: token,
      abi: parseAbi(TOKEN_INFO_ABI),
      functionName: 'getTokenInfo',
    });
    deployer = info[0];
    description = info[2];

    // info[3] is the Socials struct - use as fallback if socials() returned empty
    if (!hasSocials(socials) && hasSocials(info[3])) {
      finalSocials = info[3];
      console.log(`[Filter] Using socials from getTokenInfo() for ${token}`);
    }
  } catch {}

  return { name, symbol, socials: finalSocials, description, deployer };
}

/**
 * Get holder count from Pons API
 */
export async function getHolderCount(token) {
  const res = await fetch(`https://www.ponsfamily.com/api/pons-v2-market/${token}/holders`);
  const data = await res.json();
  return data.holdersCount || 0;
}

/**
 * Check if token passes filters
 */
export async function checkFilters(token, filters) {
  const meta = await getTokenMeta(token);

  // Social check
  if (filters.require_social === 'true') {
    const { twitter, telegram, discord, website } = meta.socials;
    if (!twitter && !telegram && !discord && !website) {
      return { pass: false, reason: 'No social links', meta };
    }
  }

  // Holder count
  const minHolders = parseInt(filters.min_holders || '0');
  if (minHolders > 0) {
    try {
      const holderCount = await getHolderCount(token);
      if (holderCount < minHolders) {
        return { pass: false, reason: `Only ${holderCount} holders (min: ${minHolders})`, meta };
      }
    } catch (err) {
      console.log(`[Filter] Could not count holders for ${token}: ${err.message}`);
    }
  }

  return { pass: true, reason: 'All filters passed', meta };
}

/**
 * Get bonding curve progress (0..1)
 */
export async function getBondingProgress(curve) {
  const client = getClient();
  const [raised, threshold] = await Promise.all([
    client.readContract({ address: curve, abi: parseAbi(CURVE_ABI), functionName: 'realQuoteReserve' }),
    client.readContract({ address: curve, abi: parseAbi(CURVE_ABI), functionName: 'graduationThreshold' }),
  ]);
  return Number(raised) / Number(threshold);
}

