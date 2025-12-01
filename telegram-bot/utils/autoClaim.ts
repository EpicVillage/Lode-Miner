import { allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { getUserSettings } from './userSettings';
import { getUserClaimableRewards, claimUserSol, claimUserOrb } from './userOperations';
import { claimUserStakingRewards } from './userStaking';
import { formatSOL, formatLODE } from './formatters';
import { Telegraf } from 'telegraf';
import { checkAndExecuteLodeTransfer } from './lodeAutoTransfer';

/**
 * Auto-Claim & Auto-Transfer Background Service
 *
 * Periodically checks all users' claimable rewards and automatically
 * claims them when thresholds are met. After claiming, also checks
 * and executes auto-transfer if LODE balance exceeds threshold.
 */

const AUTO_CLAIM_CHECK_INTERVAL = 1 * 60 * 1000; // 1 minute
let autoClaimInterval: NodeJS.Timeout | null = null;
let bot: Telegraf | null = null;

interface TelegramUser {
  telegram_id: string;
}

interface ClaimRecord {
  reward: string;
  timestamp: number;
}

interface UserClaimHistory {
  messageId: number;
  chatId: string;
  claims: ClaimRecord[];
}

// Track auto-claim message history per user
const userClaimHistory: Map<string, UserClaimHistory> = new Map();

/**
 * Format relative time (e.g., "5 mins ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins === 1) return '1 min ago';
  if (diffMins < 60) return `${diffMins} mins ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours === 1) return '1 hour ago';
  return `${diffHours} hours ago`;
}

/**
 * Build the auto-claim message from history
 */
function buildClaimMessage(claims: ClaimRecord[]): string {
  const lines = claims.map((claim, index) => {
    if (index === 0) {
      // Most recent claim - no time suffix
      return `• ${claim.reward}`;
    } else {
      // Older claims - show relative time
      return `• ${claim.reward} - ${formatRelativeTime(claim.timestamp)}`;
    }
  });

  return `✅ *Auto-Claim Successful*\n\nClaimed:\n${lines.join('\n')}`;
}

/**
 * Reset claim history for a user (call when user sends any command)
 */
export function resetUserClaimHistory(telegramId: string): void {
  userClaimHistory.delete(telegramId);
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
    logger.error('[Auto-Claim] Failed to get users:', error);
    return [];
  }
}

/**
 * Check and process auto-claims for a single user
 */
async function processUserAutoClaims(telegramId: string): Promise<void> {
  try {
    // Get user settings
    const settings = await getUserSettings(telegramId);

    // Get claimable rewards
    const rewards = await getUserClaimableRewards(telegramId);

    const claimedRewards: string[] = [];

    // Check mining SOL threshold
    if (settings.auto_claim_sol_threshold > 0 && rewards.miningSol >= settings.auto_claim_sol_threshold) {
      logger.info(`[Auto-Claim] ${telegramId}: Mining SOL ${rewards.miningSol.toFixed(4)} >= threshold ${settings.auto_claim_sol_threshold}`);

      const result = await claimUserSol(telegramId);

      if (result.success && result.solAmount) {
        claimedRewards.push(`${formatSOL(result.solAmount)} from mining`);
        logger.info(`[Auto-Claim] ${telegramId}: Claimed ${result.solAmount.toFixed(4)} SOL | ${result.signature}`);
      } else {
        logger.warn(`[Auto-Claim] ${telegramId}: Failed to claim SOL - ${result.error}`);
      }
    }

    // Check mining LODE threshold
    if (settings.auto_claim_orb_threshold > 0 && rewards.miningOrb >= settings.auto_claim_orb_threshold) {
      logger.info(`[Auto-Claim] ${telegramId}: Mining LODE ${rewards.miningOrb.toFixed(2)} >= threshold ${settings.auto_claim_orb_threshold}`);

      const result = await claimUserOrb(telegramId);

      if (result.success && result.orbAmount) {
        claimedRewards.push(`${formatLODE(result.orbAmount)} from mining`);
        logger.info(`[Auto-Claim] ${telegramId}: Claimed ${result.orbAmount.toFixed(2)} LODE | ${result.signature}`);
      } else {
        logger.warn(`[Auto-Claim] ${telegramId}: Failed to claim LODE - ${result.error}`);
      }
    }

    // Check staking rewards threshold
    if (settings.auto_claim_staking_threshold > 0 && rewards.stakingOrb >= settings.auto_claim_staking_threshold) {
      logger.info(`[Auto-Claim] ${telegramId}: Staking rewards ${rewards.stakingOrb.toFixed(2)} >= threshold ${settings.auto_claim_staking_threshold}`);

      const result = await claimUserStakingRewards(telegramId);

      if (result.success && result.amount) {
        claimedRewards.push(`${formatLODE(result.amount)} from staking`);
        logger.info(`[Auto-Claim] ${telegramId}: Claimed ${result.amount.toFixed(2)} LODE staking rewards | ${result.signature}`);
      } else {
        logger.warn(`[Auto-Claim] ${telegramId}: Failed to claim staking rewards - ${result.error}`);
      }
    }

    // Send/update notification if any claims were made
    if (claimedRewards.length > 0 && bot) {
      const now = Date.now();
      const existingHistory = userClaimHistory.get(telegramId);

      // Add new claims to history
      const newClaims: ClaimRecord[] = claimedRewards.map(reward => ({
        reward,
        timestamp: now,
      }));

      try {
        if (existingHistory) {
          // Update existing message - add new claims at the top
          const updatedClaims = [...newClaims, ...existingHistory.claims];
          const message = buildClaimMessage(updatedClaims);

          try {
            await bot.telegram.editMessageText(
              existingHistory.chatId,
              existingHistory.messageId,
              undefined,
              message,
              { parse_mode: 'Markdown' }
            );

            // Update history
            userClaimHistory.set(telegramId, {
              ...existingHistory,
              claims: updatedClaims,
            });
          } catch (editError: any) {
            // If edit fails (message too old, deleted, etc.), send new message
            if (editError.description?.includes('message to edit not found') ||
                editError.description?.includes('message can\'t be edited')) {
              logger.debug(`[Auto-Claim] ${telegramId}: Edit failed, sending new message`);
              const sentMessage = await bot.telegram.sendMessage(telegramId, buildClaimMessage(newClaims), { parse_mode: 'Markdown' });
              userClaimHistory.set(telegramId, {
                messageId: sentMessage.message_id,
                chatId: telegramId,
                claims: newClaims,
              });
            } else {
              throw editError;
            }
          }
        } else {
          // No existing message - send new one
          const message = buildClaimMessage(newClaims);
          const sentMessage = await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });

          // Store message info for future edits
          userClaimHistory.set(telegramId, {
            messageId: sentMessage.message_id,
            chatId: telegramId,
            claims: newClaims,
          });
        }
      } catch (error) {
        logger.warn(`[Auto-Claim] Failed to send notification to ${telegramId}:`, error);
      }
    }

    // Check and execute auto-transfer after claims (if enabled)
    try {
      const transferResult = await checkAndExecuteLodeTransfer(telegramId);
      if (transferResult.transferred) {
        logger.info(`[Auto-Transfer] ${telegramId}: Transferred ${transferResult.amount?.toFixed(2)} LODE | ${transferResult.signature}`);
      } else if (transferResult.error) {
        logger.warn(`[Auto-Transfer] ${telegramId}: ${transferResult.error}`);
      }
    } catch (error) {
      logger.error(`[Auto-Transfer] Error for ${telegramId}:`, error);
    }

  } catch (error) {
    logger.error(`[Auto-Claim] Error processing user ${telegramId}:`, error);
  }
}

/**
 * Run auto-claim check for all users
 */
async function runAutoClaimCheck(): Promise<void> {
  try {
    logger.debug('[Auto-Claim] Running periodic check...');

    const users = await getAllUsers();

    if (users.length === 0) {
      logger.debug('[Auto-Claim] No users found');
      return;
    }

    logger.info(`[Auto-Claim] Checking ${users.length} users for auto-claims`);

    // Process users sequentially to avoid rate limits
    for (const telegramId of users) {
      await processUserAutoClaims(telegramId);

      // Small delay between users to avoid overwhelming the blockchain/bot
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.debug('[Auto-Claim] Check complete');

  } catch (error) {
    logger.error('[Auto-Claim] Error during check:', error);
  }
}

/**
 * Initialize auto-claim service
 */
export function initializeAutoClaim(telegrafBot: Telegraf): void {
  bot = telegrafBot;

  if (autoClaimInterval) {
    logger.warn('[Auto-Claim] Already initialized, skipping');
    return;
  }

  logger.info(`[Auto-Claim] Initializing with ${AUTO_CLAIM_CHECK_INTERVAL / 1000}s interval`);

  // Run initial check after 1 minute (give bot time to fully start)
  setTimeout(() => {
    runAutoClaimCheck();
  }, 60 * 1000);

  // Set up periodic checks
  autoClaimInterval = setInterval(() => {
    runAutoClaimCheck();
  }, AUTO_CLAIM_CHECK_INTERVAL);

  logger.info('[Auto-Claim] Service started');
}

/**
 * Stop auto-claim service
 */
export function stopAutoClaim(): void {
  if (autoClaimInterval) {
    clearInterval(autoClaimInterval);
    autoClaimInterval = null;
    logger.info('[Auto-Claim] Service stopped');
  }
}

/**
 * Manually trigger auto-claim check for a specific user
 */
export async function manualTriggerAutoClaim(telegramId: string): Promise<void> {
  logger.info(`[Auto-Claim] Manual trigger for ${telegramId}`);
  await processUserAutoClaims(telegramId);
}

/**
 * Get auto-claim status
 */
export function getAutoClaimStatus(): {
  running: boolean;
  interval: number;
  nextCheckIn?: number;
} {
  return {
    running: autoClaimInterval !== null,
    interval: AUTO_CLAIM_CHECK_INTERVAL,
  };
}
