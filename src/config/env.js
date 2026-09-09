import 'dotenv/config';

function requireEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

export const env = {
  TELEGRAM_BOT_TOKEN: requireEnv('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_ADMIN_ID: requireEnv('TELEGRAM_ADMIN_ID'),
  PRIVATE_KEY: requireEnv('PRIVATE_KEY'),
  RPC_URL: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  DRY_RUN: process.env.DRY_RUN !== 'false',
};
