import { allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { getUserSettings } from './userSettings';
import { getUserBalances } from './userWallet';
import { swapUserOrbToSol } from './userOperations';
import { getOrbPrice } from '../../src/utils/jupiter';
import { formatSOL, formatLODE } from './formatters';
import { Telegraf } from 'telegraf';

/**
 * Auto-Swap Background Service
 *
 * Periodically checks all users with auto-swap enabled and automatically
 * swaps LODE to SOL when thresholds are met.
 */

const AUTO_SWAP_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
let autoSwapInterval: NodeJS.Timeout | null = null;
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
    logger.error('[Auto-Swap] Failed to get users:', error);
    return [];
  }
}

/**
 * Check and process auto-swap for a single user
 */
async function processUserAutoSwap(telegramId: string): Promise<void> {
  try {
    // Get user settings
    const settings = await getUserSettings(telegramId);

    // Skip if auto-swap not enabled
    if (!settings.auto_swap_enabled) {
      return;
    }

    // Get user balances
    const balances = await getUserBalances(telegramId);
    if (!balances) {
      logger.debug(`[Auto-Swap] ${telegramId}: Could not fetch balances`);
      return;
    }

    // Check if LODE balance exceeds swap threshold
    if (balances.orb < settings.swap_threshold) {
      logger.debug(`[Auto-Swap] ${telegramId}: LODE ${balances.orb.toFixed(2)} below threshold ${settings.swap_threshold}`);
      return;
    }

    // Check price protection (min_orb_price)
    if (settings.min_orb_price > 0) {
      try {
        const lodePrice = await getOrbPrice();
        if (lodePrice.priceInUsd < settings.min_orb_price) {
          logger.info(`[Auto-Swap] ${telegramId}: LODE price $${lodePrice.priceInUsd.toFixed(2)} below minimum $${settings.min_orb_price} - skipping swap`);
          return;
        }
      } catch (error) {
        logger.warn(`[Auto-Swap] ${telegramId}: Failed to check LODE price:`, error);
        // Continue with swap if price check fails (safer to proceed)
      }
    }

    // Calculate swap amount (balance - min_orb_to_keep)
    const swapAmount = balances.orb - settings.min_orb_to_keep;

    if (swapAmount < settings.min_swap_amount) {
      logger.debug(`[Auto-Swap] ${telegramId}: Swap amount ${swapAmount.toFixed(2)} below minimum ${settings.min_swap_amount}`);
      return;
    }

    logger.info(`[Auto-Swap] ${telegramId}: Swapping ${swapAmount.toFixed(2)} LODE (balance: ${balances.orb.toFixed(2)}, keeping: ${settings.min_orb_to_keep})`);

    // Execute swap
    const result = await swapUserOrbToSol(telegramId, swapAmount);

    if (result.success && result.solReceived) {
      const message = `✅ *Auto-Swap Successful*\n\nSwapped: ${formatLODE(swapAmount)} LODE\nReceived: ${formatSOL(result.solReceived)} SOL\n\n[View on Solscan](https://solscan.io/tx/${result.signature})`;

      // Send notification
      if (bot) {
        try {
          await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
        } catch (error) {
          logger.warn(`[Auto-Swap] Failed to send notification to ${telegramId}:`, error);
        }
      }

      logger.info(`[Auto-Swap] ${telegramId}: Swapped ${swapAmount.toFixed(2)} LODE → ${result.solReceived.toFixed(4)} SOL | ${result.signature}`);
    } else {
      logger.warn(`[Auto-Swap] ${telegramId}: Swap failed - ${result.error}`);

      // Send error notification
      if (bot) {
        try {
          const errorMessage = `⚠️ *Auto-Swap Failed*\n\nFailed to swap ${formatLODE(swapAmount)} LODE\n\nError: ${result.error}\n\nPlease check your settings or try manual swap.`;
          await bot.telegram.sendMessage(telegramId, errorMessage, { parse_mode: 'Markdown' });
        } catch (error) {
          logger.warn(`[Auto-Swap] Failed to send error notification to ${telegramId}:`, error);
        }
      }
    }

  } catch (error) {
    logger.error(`[Auto-Swap] Error processing user ${telegramId}:`, error);
  }
}

/**
 * Run auto-swap check for all users
 */
async function runAutoSwapCheck(): Promise<void> {
  try {
    logger.debug('[Auto-Swap] Running periodic check...');

    const users = await getAllUsers();

    if (users.length === 0) {
      logger.debug('[Auto-Swap] No users found');
      return;
    }

    logger.info(`[Auto-Swap] Checking ${users.length} users for auto-swaps`);

    // Process users sequentially to avoid rate limits
    for (const telegramId of users) {
      await processUserAutoSwap(telegramId);

      // Small delay between users to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    logger.debug('[Auto-Swap] Check complete');

  } catch (error) {
    logger.error('[Auto-Swap] Error during check:', error);
  }
}

/**
 * Initialize auto-swap service
 */
export function initializeAutoSwap(telegrafBot: Telegraf): void {
  bot = telegrafBot;

  if (autoSwapInterval) {
    logger.warn('[Auto-Swap] Already initialized, skipping');
    return;
  }

  logger.info(`[Auto-Swap] Initializing with ${AUTO_SWAP_CHECK_INTERVAL / 1000}s interval`);

  // Run initial check after 2 minutes (give bot time to fully start)
  setTimeout(() => {
    runAutoSwapCheck();
  }, 2 * 60 * 1000);

  // Set up periodic checks
  autoSwapInterval = setInterval(() => {
    runAutoSwapCheck();
  }, AUTO_SWAP_CHECK_INTERVAL);

  logger.info('[Auto-Swap] Service started');
}

/**
 * Stop auto-swap service
 */
export function stopAutoSwap(): void {
  if (autoSwapInterval) {
    clearInterval(autoSwapInterval);
    autoSwapInterval = null;
    logger.info('[Auto-Swap] Service stopped');
  }
}
