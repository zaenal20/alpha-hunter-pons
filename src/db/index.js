import { PrismaClient } from '@prisma/client';

let prisma;

export function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// Default config values
const DEFAULTS = {
  bonding_curve_pct: '80',
  min_holders: '10',
  require_social: 'true',
  buy_amount_eth: '0.01',
  main_stoploss_pct: '30',
  trailing_activation_pct: '10',
  trailing_stoploss_pct: '5',
  scanner_poll_ms: '10000',
  monitor_poll_ms: '3000',
  max_open_positions: '5',
  max_position_minutes: '30',
  only_eth_paired: 'true',
  no_rebuy: 'true',
  max_dev_hold_pct: '5',
};

export async function initDefaults() {
  const db = getPrisma();
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await db.config.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
  }
}

export async function getConfig(key) {
  const row = await getPrisma().config.findUnique({ where: { key } });
  return row?.value;
}

export async function setConfig(key, value) {
  await getPrisma().config.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function getAllConfig() {
  const rows = await getPrisma().config.findMany();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
