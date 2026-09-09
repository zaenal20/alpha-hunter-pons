import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env } from '../config/env.js';

export const ROBINHOOD_CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
};

// V2 Contract addresses
export const FACTORY_V2 = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const MEME_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

// V4 PoolManager ABI (no getPool - pools are storage in PoolManager)
export const POOL_MANAGER_ABI = [
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks),(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96),bytes) returns (int256, int256)',
];

// V2 events
export const CURVE_BUY = parseAbiItem(
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)'
);

export const CURVE_SELL = parseAbiItem(
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)'
);

// Token ABI
export const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)',
  'function balanceOf(address) view returns (uint256)',
];

// V2 Token info
export const TOKEN_INFO_ABI = [
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)',
];

// V2 Factory ABI
export const FACTORY_V2_ABI = [
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
];

// V2 Curve ABI
export const CURVE_ABI = [
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
];

// ERC20
export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

// HTTP client for reads
let httpClient;

export function getClient() {
  if (!httpClient) {
    httpClient = createPublicClient({
      chain: ROBINHOOD_CHAIN,
      transport: http(env.RPC_URL),
    });
  }
  return httpClient;
}

// Wallet client for writes
let walletClient;

export function getWalletClient() {
  if (!walletClient) {
    const account = privateKeyToAccount(
      env.PRIVATE_KEY.startsWith('0x') ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`
    );
    walletClient = createWalletClient({
      account,
      chain: ROBINHOOD_CHAIN,
      transport: http(env.RPC_URL),
    });
  }
  return walletClient;
}
