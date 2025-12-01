import { allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { getUserSettings } from './userSettings';
import { getUserBalances } from './userWallet';
import { stakeUserOrb } from './userStaking';
import { formatLODE } from './formatters';
import { Telegraf } from 'telegraf';

/**
 * Auto-Stake Background Service
 *
 * Periodically checks all users with auto-stake enabled and automatically
 * stakes ORB when thresholds are met.
 */

const AUTO_STAKE_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
let autoStakeInterval: NodeJS.Timeout | null = null;
let bot: Telegraf | null = null;

interface TelegramUser {
  telegram_id: string;
}

/**
 * Get all telegram users from database
 */
async function getAllUsers(): Promise<string[]> {
  try {
    const users = await allQuery<TelegramUser>(`
      SELECT telegram_id FROM telegram_users
    `);

    return users.map(u => u.telegram_id);
  } catch (error) {
    logger.error('[Auto-Stake] Failed to get users:', error);
    return [];
  }
}

/**
 * Check and process auto-stake for a single user
 */
async function processUserAutoStake(telegramId: string): Promise<void> {
  try {
    // Get user settings
    const settings = await getUserSettings(telegramId);

    // Skip if auto-stake not enabled
    if (!settings.auto_stake_enabled) {
      return;
    }

    // Get user balances
    const balances = await getUserBalances(telegramId);
    if (!balances) {
      logger.debug(`[Auto-Stake] ${telegramId}: Could not fetch balances`);
      return;
    }

    // Check if ORB balance exceeds stake threshold
    if (balances.orb < settings.stake_threshold) {
      logger.debug(`[Auto-Stake] ${telegramId}: ORB ${balances.orb.toFixed(2)} below threshold ${settings.stake_threshold}`);
      return;
    }

    // Calculate stake amount (we'll stake everything above threshold to maximize rewards)
    const stakeAmount = balances.orb - settings.min_orb_to_keep;

    if (stakeAmount <= 0) {
      logger.debug(`[Auto-Stake] ${telegramId}: Stake amount ${stakeAmount.toFixed(2)} <= 0 (keeping ${settings.min_orb_to_keep} ORB)`);
      return;
    }

    // Minimum stake amount (similar to min swap amount logic)
    const MIN_STAKE_AMOUNT = 1; // At least 1 ORB
    if (stakeAmount < MIN_STAKE_AMOUNT) {
      logger.debug(`[Auto-Stake] ${telegramId}: Stake amount ${stakeAmount.toFixed(2)} below minimum ${MIN_STAKE_AMOUNT}`);
      return;
    }

    logger.info(`[Auto-Stake] ${telegramId}: Staking ${stakeAmount.toFixed(2)} LODE (balance: ${balances.orb.toFixed(2)}, keeping: ${settings.min_orb_to_keep})`);

    // Execute stake
    const result = await stakeUserOrb(telegramId, stakeAmount);

    if (result.success) {
      const message = `✅ *Auto-Stake Successful*\n\nStaked: ${formatLODE(stakeAmount)} LODE\n\nYour LODE is now earning staking rewards!\n\nTransaction: \`${result.signature}\``;

      // Send notification
      if (bot) {
        try {
          await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
        } catch (error) {
          logger.warn(`[Auto-Stake] Failed to send notification to ${telegramId}:`, error);
        }
      }

      logger.info(`[Auto-Stake] ${telegramId}: Staked ${stakeAmount.toFixed(2)} LODE | ${result.signature}`);
    } else {
      logger.warn(`[Auto-Stake] ${telegramId}: Stake failed - ${result.error}`);

      // Send error notification
      if (bot) {
        try {
          const errorMessage = `⚠️ *Auto-Stake Failed*\n\nFailed to stake ${formatLODE(stakeAmount)} LODE\n\nError: ${result.error}\n\nPlease check your balance or try manual staking.`;
          await bot.telegram.sendMessage(telegramId, errorMessage, { parse_mode: 'Markdown' });
        } catch (error) {
          logger.warn(`[Auto-Stake] Failed to send error notification to ${telegramId}:`, error);
        }
      }
    }

  } catch (error) {
    logger.error(`[Auto-Stake] Error processing user ${telegramId}:`, error);
  }
}

/**
 * Run auto-stake check for all users
 */
async function runAutoStakeCheck(): Promise<void> {
  try {
    logger.debug('[Auto-Stake] Running periodic check...');

    const users = await getAllUsers();

    if (users.length === 0) {
      logger.debug('[Auto-Stake] No users found');
      return;
    }

    logger.info(`[Auto-Stake] Checking ${users.length} users for auto-stakes`);

    // Process users sequentially to avoid rate limits
    for (const telegramId of users) {
      await processUserAutoStake(telegramId);

      // Small delay between users to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    logger.debug('[Auto-Stake] Check complete');

  } catch (error) {
    logger.error('[Auto-Stake] Error during check:', error);
  }
}

/**
 * Initialize auto-stake service
 */
export function initializeAutoStake(telegrafBot: Telegraf): void {
  bot = telegrafBot;

  if (autoStakeInterval) {
    logger.warn('[Auto-Stake] Already initialized, skipping');
    return;
  }

  logger.info(`[Auto-Stake] Initializing with ${AUTO_STAKE_CHECK_INTERVAL / 1000}s interval`);

  // Run initial check after 3 minutes (give bot time to fully start)
  setTimeout(() => {
    runAutoStakeCheck();
  }, 3 * 60 * 1000);

  // Set up periodic checks
  autoStakeInterval = setInterval(() => {
    runAutoStakeCheck();
  }, AUTO_STAKE_CHECK_INTERVAL);

  logger.info('[Auto-Stake] Service started');
}

/**
 * Stop auto-stake service
 */
export function stopAutoStake(): void {
  if (autoStakeInterval) {
    clearInterval(autoStakeInterval);
    autoStakeInterval = null;
    logger.info('[Auto-Stake] Service stopped');
  }
}
