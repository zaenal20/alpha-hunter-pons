import { setupBot } from './bot/index.js';
import { initDefaults } from './db/index.js';
import { env } from './config/env.js';

async function main() {
  console.log('🤖 Alpha Hunter - Pons Sniper');
  console.log(`   Dry Run: ${env.DRY_RUN ? 'ON' : 'OFF'}`);
  console.log(`   RPC: ${env.RPC_URL}`);

  // Initialize DB defaults
  await initDefaults();
  console.log('[DB] Initialized');

  // Start Telegram bot
  await setupBot();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
