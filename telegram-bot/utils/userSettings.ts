import { runQuery, getQuery, allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';

/**
 * User-specific settings management for telegram bot users
 * Each user can configure their own mining, automation, and safety parameters
 */

/**
 * Initialize user_settings table
 */
export async function initializeUserSettingsTable(): Promise<void> {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS user_settings (
      telegram_id TEXT PRIMARY KEY,
      motherload_threshold REAL DEFAULT 5000,
      sol_per_block REAL DEFAULT 0.001,
      num_blocks INTEGER DEFAULT 10,
      automation_budget_percent REAL DEFAULT 50,
      auto_claim_sol_threshold REAL DEFAULT 0.01,
      auto_claim_orb_threshold REAL DEFAULT 10000,
      auto_claim_staking_threshold REAL DEFAULT 1,
      auto_swap_enabled INTEGER DEFAULT 0,
      swap_threshold REAL DEFAULT 100,
      min_orb_price REAL DEFAULT 0,
      min_orb_to_keep REAL DEFAULT 10,
      min_swap_amount REAL DEFAULT 1,
      slippage_bps INTEGER DEFAULT 300,
      auto_stake_enabled INTEGER DEFAULT 0,
      stake_threshold REAL DEFAULT 50,
      auto_transfer_enabled INTEGER DEFAULT 0,
      orb_transfer_threshold REAL DEFAULT 100,
      transfer_recipient_address TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  // Migration: Update min_swap_amount from old default (10) to new default (1)
  await runQuery(`
    UPDATE user_settings
    SET min_swap_amount = 1
    WHERE min_swap_amount > 1
  `);

  logger.info('[Telegram DB] User settings table initialized');
}

export interface UserSettings {
  telegram_id: string;
  motherload_threshold: number;
  sol_per_block: number;
  num_blocks: number;
  automation_budget_percent: number;
  auto_claim_sol_threshold: number;
  auto_claim_orb_threshold: number;
  auto_claim_staking_threshold: number;
  auto_swap_enabled: boolean;
  swap_threshold: number;
  min_orb_price: number;
  min_orb_to_keep: number;
  min_swap_amount: number;
  slippage_bps: number;
  auto_stake_enabled: boolean;
  stake_threshold: number;
  auto_transfer_enabled: boolean;
  orb_transfer_threshold: number;
  transfer_recipient_address: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Get user settings (creates default if not exists)
 */
export async function getUserSettings(telegramId: string): Promise<UserSettings> {
  let settings = await getQuery<any>(`
    SELECT * FROM user_settings WHERE telegram_id = ?
  `, [telegramId]);

  // Create default settings if none exist
  if (!settings) {
    await createDefaultUserSettings(telegramId);
    settings = await getQuery<any>(`
      SELECT * FROM user_settings WHERE telegram_id = ?
    `, [telegramId]);
  }

  return convertSettingsFromDb(settings!);
}

/**
 * Create default settings for a new user
 */
async function createDefaultUserSettings(telegramId: string): Promise<void> {
  await runQuery(`
    INSERT INTO user_settings (telegram_id)
    VALUES (?)
  `, [telegramId]);

  logger.info(`[User Settings] Created default settings for ${telegramId}`);
}

/**
 * Update user setting
 */
export async function updateUserSetting(
  telegramId: string,
  key: keyof UserSettings,
  value: any
): Promise<void> {
  // Ensure settings exist first
  await getUserSettings(telegramId);

  // Convert boolean to integer for storage
  const dbValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;

  await runQuery(`
    UPDATE user_settings
    SET ${key} = ?, updated_at = ?
    WHERE telegram_id = ?
  `, [dbValue, Date.now(), telegramId]);

  logger.info(`[User Settings] Updated ${key} = ${value} for ${telegramId}`);
}

/**
 * Update multiple user settings at once
 */
export async function updateUserSettings(
  telegramId: string,
  updates: Partial<UserSettings>
): Promise<void> {
  // Ensure settings exist first
  await getUserSettings(telegramId);

  const keys = Object.keys(updates).filter(k => k !== 'telegram_id' && k !== 'created_at' && k !== 'updated_at');
  if (keys.length === 0) return;

  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => {
    const val = updates[k as keyof UserSettings];
    return typeof val === 'boolean' ? (val ? 1 : 0) : val;
  });

  await runQuery(`
    UPDATE user_settings
    SET ${setClauses}, updated_at = ?
    WHERE telegram_id = ?
  `, [...values, Date.now(), telegramId]);

  logger.info(`[User Settings] Updated ${keys.length} settings for ${telegramId}`);
}

/**
 * Reset user settings to defaults
 */
export async function resetUserSettings(telegramId: string): Promise<void> {
  await runQuery(`
    DELETE FROM user_settings WHERE telegram_id = ?
  `, [telegramId]);

  await createDefaultUserSettings(telegramId);
  logger.info(`[User Settings] Reset settings for ${telegramId}`);
}

/**
 * Convert database row to UserSettings object
 */
function convertSettingsFromDb(row: any): UserSettings {
  return {
    telegram_id: row.telegram_id,
    motherload_threshold: row.motherload_threshold,
    sol_per_block: row.sol_per_block,
    num_blocks: row.num_blocks,
    automation_budget_percent: row.automation_budget_percent,
    auto_claim_sol_threshold: row.auto_claim_sol_threshold,
    auto_claim_orb_threshold: row.auto_claim_orb_threshold,
    auto_claim_staking_threshold: row.auto_claim_staking_threshold,
    auto_swap_enabled: row.auto_swap_enabled === 1,
    swap_threshold: row.swap_threshold,
    min_orb_price: row.min_orb_price,
    min_orb_to_keep: row.min_orb_to_keep,
    min_swap_amount: row.min_swap_amount,
    slippage_bps: row.slippage_bps,
    auto_stake_enabled: row.auto_stake_enabled === 1,
    stake_threshold: row.stake_threshold,
    auto_transfer_enabled: row.auto_transfer_enabled === 1,
    orb_transfer_threshold: row.orb_transfer_threshold,
    transfer_recipient_address: row.transfer_recipient_address,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get all users with specific setting enabled
 */
export async function getUsersWithSetting(
  setting: keyof UserSettings,
  value: any
): Promise<string[]> {
  const dbValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;

  const rows = await allQuery<{ telegram_id: string }>(`
    SELECT telegram_id FROM user_settings WHERE ${setting} = ?
  `, [dbValue]);

  return rows.map(r => r.telegram_id);
}

/**
 * Get formatted settings display for user
 */
export function formatSettingsDisplay(settings: UserSettings): string {
  return `
⚙️ *Your Mining Settings*

*Mining Configuration:*
• Motherload Threshold: ${settings.motherload_threshold} LODE
• SOL Per Block: ${settings.sol_per_block} SOL
• Number of Blocks: ${settings.num_blocks} blocks

*Automation:*
• Budget Allocation: ${settings.automation_budget_percent}%
• Auto-claim SOL: ≥${settings.auto_claim_sol_threshold} SOL
• Auto-claim LODE: ≥${settings.auto_claim_orb_threshold} LODE
• Auto-claim Staking: ≥${settings.auto_claim_staking_threshold} LODE

*Swap Settings:*
• Auto-swap: ${settings.auto_swap_enabled ? '✅ Enabled' : '❌ Disabled'}
• Swap Threshold: ${settings.swap_threshold} LODE
• Min LODE Price: $${settings.min_orb_price}
• Min LODE to Keep: ${settings.min_orb_to_keep} LODE
• Min Swap Amount: ${settings.min_swap_amount} LODE
• Slippage: ${(settings.slippage_bps / 100).toFixed(2)}%

*Staking:*
• Auto-stake: ${settings.auto_stake_enabled ? '✅ Enabled' : '❌ Disabled'}
• Stake Threshold: ${settings.stake_threshold} LODE

*Auto-Transfer:*
• Auto-transfer: ${settings.auto_transfer_enabled ? '✅ Enabled' : '❌ Disabled'}
• Transfer Threshold: ${settings.orb_transfer_threshold} LODE
• Recipient: ${settings.transfer_recipient_address ? `\`${settings.transfer_recipient_address.slice(0, 8)}...${settings.transfer_recipient_address.slice(-8)}\`` : 'Not set'}
`.trim();
}
