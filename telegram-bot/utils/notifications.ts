import { Telegraf } from 'telegraf';
import { runQuery, getQuery, allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { formatSOL, formatLODE, formatUSD } from './formatters';

/**
 * Notification system for telegram bot users
 * Sends real-time alerts for various events
 */

export enum NotificationType {
  MINING_STARTED = 'mining_started',
  MINING_COMPLETED = 'mining_completed',
  REWARDS_AVAILABLE = 'rewards_available',
  MOTHERLOAD_THRESHOLD = 'motherload_threshold',
  PRICE_ALERT = 'price_alert',
  LOW_BALANCE = 'low_balance',
  TRANSACTION_SUCCESS = 'transaction_success',
  TRANSACTION_FAILED = 'transaction_failed',
  ROUND_COMPLETED = 'round_completed',
  AUTOMATION_ERROR = 'automation_error',
}

export interface Notification {
  telegram_id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
}

let botInstance: Telegraf | null = null;

/**
 * Initialize notification system with bot instance
 */
export function initializeNotifications(bot: Telegraf): void {
  botInstance = bot;
  logger.info('[Notifications] Notification system initialized');
}

/**
 * Send notification to a user
 */
export async function sendNotification(
  telegramId: string,
  type: NotificationType,
  title: string,
  message: string
): Promise<boolean> {
  try {
    if (!botInstance) {
      logger.warn('[Notifications] Bot instance not initialized');
      return false;
    }

    const formattedMessage = `
🔔 *${title}*

${message}

_${new Date().toLocaleTimeString()}_
`.trim();

    await botInstance.telegram.sendMessage(telegramId, formattedMessage, {
      parse_mode: 'Markdown',
    });

    logger.info(`[Notifications] Sent ${type} notification to ${telegramId}`);
    return true;
  } catch (error) {
    logger.error(`[Notifications] Failed to send notification to ${telegramId}:`, error);
    return false;
  }
}

/**
 * Notify user about mining started
 */
export async function notifyMiningStarted(
  telegramId: string,
  roundId: number,
  solDeployed: number
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.MINING_STARTED,
    '⛏️ Mining Started',
    `Deployed ${formatSOL(solDeployed)} to Round #${roundId}\n\nGood luck! 🍀`
  );
}

/**
 * Notify user about mining completed
 */
export async function notifyMiningCompleted(
  telegramId: string,
  roundId: number,
  won: boolean,
  solRewards: number,
  orbRewards: number
): Promise<void> {
  const title = won ? '🎉 Mining Win!' : '💰 Mining Complete';
  const message = won
    ? `You won Round #${roundId}!\n\nRewards:\n• ${formatSOL(solRewards)}\n• ${formatLODE(orbRewards)}\n\nCongratulations! 🎊`
    : `Round #${roundId} complete.\n\nRewards:\n• ${formatSOL(solRewards)}\n• ${formatLODE(orbRewards)}`;

  await sendNotification(telegramId, NotificationType.MINING_COMPLETED, title, message);
}

/**
 * Notify user about claimable rewards
 */
export async function notifyRewardsAvailable(
  telegramId: string,
  solRewards: number,
  orbRewards: number
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.REWARDS_AVAILABLE,
    '💎 Rewards Ready to Claim',
    `You have unclaimed rewards:\n• ${formatSOL(solRewards)}\n• ${formatLODE(orbRewards)}\n\nUse /rewards to claim them!`
  );
}

/**
 * Notify user about motherload threshold reached
 */
export async function notifyMotherloadThreshold(
  telegramId: string,
  motherload: number,
  threshold: number
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.MOTHERLOAD_THRESHOLD,
    '🚀 High Motherload Alert',
    `Current motherload: ${formatLODE(motherload)}\n\nThis exceeds your threshold of ${formatLODE(threshold)}!\n\nAutomation will deploy if enabled.`
  );
}

/**
 * Notify user about price alert
 */
export async function notifyPriceAlert(
  telegramId: string,
  currentPrice: number,
  alertType: 'low' | 'high'
): Promise<void> {
  const title = alertType === 'low' ? '📉 Low Price Alert' : '📈 High Price Alert';
  const message = `LODE price: ${formatUSD(currentPrice)}\n\n${
    alertType === 'low' ? '⚠️ Price is below your minimum threshold!' : '✨ Price is high - good time to swap!'
  }`;

  await sendNotification(telegramId, NotificationType.PRICE_ALERT, title, message);
}

/**
 * Notify user about low balance
 */
export async function notifyLowBalance(
  telegramId: string,
  currentBalance: number,
  minBalance: number
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.LOW_BALANCE,
    '⚠️ Low SOL Balance',
    `Your balance is ${formatSOL(currentBalance)}\n\nThis is below your minimum buffer of ${formatSOL(minBalance)}.\n\nPlease add more SOL to continue mining.`
  );
}

/**
 * Notify user about transaction success
 */
export async function notifyTransactionSuccess(
  telegramId: string,
  type: string,
  signature: string,
  details?: string
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.TRANSACTION_SUCCESS,
    `✅ ${type} Successful`,
    `${details || 'Transaction completed successfully'}\n\nSignature: \`${signature.slice(0, 8)}...${signature.slice(-8)}\``
  );
}

/**
 * Notify user about transaction failure
 */
export async function notifyTransactionFailed(
  telegramId: string,
  type: string,
  error: string
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.TRANSACTION_FAILED,
    `❌ ${type} Failed`,
    `Transaction failed:\n\n${error}\n\nPlease try again or check your balance.`
  );
}

/**
 * Notify user about round completion
 */
export async function notifyRoundCompleted(
  telegramId: string,
  roundId: number,
  totalRewards: number
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.ROUND_COMPLETED,
    '🏁 Round Complete',
    `Round #${roundId} has ended.\n\nTotal rewards distributed: ${formatLODE(totalRewards)}`
  );
}

/**
 * Notify user about automation error
 */
export async function notifyAutomationError(
  telegramId: string,
  error: string
): Promise<void> {
  await sendNotification(
    telegramId,
    NotificationType.AUTOMATION_ERROR,
    '⚠️ Automation Error',
    `Automation encountered an error:\n\n${error}\n\nPlease check your settings and balance.`
  );
}

/**
 * Get notification preferences for a user
 * TODO: Implement user-specific notification settings
 */
export async function getUserNotificationPreferences(telegramId: string): Promise<{
  enabled: boolean;
  types: NotificationType[];
}> {
  // For now, all notifications are enabled
  return {
    enabled: true,
    types: Object.values(NotificationType),
  };
}

/**
 * Check if user has notifications enabled for a specific type
 */
export async function isNotificationEnabled(
  telegramId: string,
  type: NotificationType
): Promise<boolean> {
  const prefs = await getUserNotificationPreferences(telegramId);
  return prefs.enabled && prefs.types.includes(type);
}
