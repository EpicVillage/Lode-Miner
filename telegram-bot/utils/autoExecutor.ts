import { PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from '../../src/utils/solana';
import {
  fetchBoard,
  fetchMiner,
  fetchTreasury,
  getAutomationPDA,
  getMinerPDA,
  isReferralInitialized
} from '../../src/utils/accounts';
import { buildExecuteAutomationInstruction, buildCheckpointInstruction, buildRegisterReferralInstruction } from '../../src/utils/program';
import { recordTransaction, allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { getOrbPrice } from '../../src/utils/jupiter';
import { getUserSettings } from './userSettings';
import { getUserWallet } from './userWallet';
import { getUserDeployedSquares, getRoundWinningSquare } from './userRounds';
import { recordUserRound, updateRoundResult, Platform } from '../../shared/database';
import { LODE_MULTIPLIER, SOL_MULTIPLIER } from '../../src/utils/config';

// Default referrer address (dev wallet for referral rewards)
const DEFAULT_REFERRER = new PublicKey('9LGAtUrQx8u3YXF5traoUtFBN3w62bgqohLc1Npkh3Yq');

const PLATFORM: Platform = 'telegram';

/**
 * Automation Executor Service for Telegram Bot Users
 *
 * This service runs in the background and monitors all telegram users
 * with active automation accounts. When a new round starts, it executes
 * the automation instruction for each eligible user.
 */

interface AutomationInfo {
  pda: PublicKey;
  amountPerSquare: number;
  balance: number;
  mask: number;
  costPerRound: number;
}

let isRunning = false;
let executorInterval: NodeJS.Timeout | null = null;
let lastRoundId: string | null = null;
let lastMotherloadNotification: Map<string, number> = new Map(); // Track last notification time per user

/**
 * Get automation account info for a user
 */
async function getAutomationInfo(userPublicKey: PublicKey): Promise<AutomationInfo | null> {
  try {
    const connection = getConnection();
    const [automationPDA] = getAutomationPDA(userPublicKey);
    const accountInfo = await connection.getAccountInfo(automationPDA);

    if (!accountInfo || accountInfo.data.length < 112) {
      return null;
    }

    const data = accountInfo.data;
    const amountPerSquare = data.readBigUInt64LE(8);
    const balance = data.readBigUInt64LE(48);
    const mask = data.readBigUInt64LE(104);

    return {
      pda: automationPDA,
      amountPerSquare: Number(amountPerSquare),
      balance: Number(balance),
      mask: Number(mask),
      costPerRound: Number(amountPerSquare) * Number(mask),
    };
  } catch (error) {
    logger.error('[Auto-Executor] Failed to get automation info:', error);
    return null;
  }
}

/**
 * Get all telegram users with active automation accounts
 */
async function getUsersWithActiveAutomation(): Promise<Array<{ telegram_id: string; public_key: string }>> {
  try {
    const users = await allQuery<{ telegram_id: string; public_key: string }>(
      'SELECT telegram_id, public_key FROM telegram_users WHERE public_key IS NOT NULL'
    );

    // Filter to only users with active automation accounts
    const usersWithAutomation: Array<{ telegram_id: string; public_key: string }> = [];

    for (const user of users) {
      try {
        const userPublicKey = new PublicKey(user.public_key);
        const automationInfo = await getAutomationInfo(userPublicKey);

        if (automationInfo && automationInfo.balance > 0) {
          usersWithAutomation.push(user);
        }
      } catch (error) {
        logger.debug(`[Auto-Executor] Skipping user ${user.telegram_id}: ${error}`);
      }
    }

    return usersWithAutomation;
  } catch (error) {
    logger.error('[Auto-Executor] Failed to get users with automation:', error);
    return [];
  }
}

/**
 * Execute automation for a single user
 */
async function executeUserAutomation(
  telegramId: string,
  userWallet: any,
  board: any,
  treasury: any
): Promise<boolean> {
  try {
    const userPublicKey = userWallet.publicKey;
    const settings = await getUserSettings(telegramId);

    // Check motherload threshold
    const currentMotherload = Number(treasury.motherlodeBl) / SOL_MULTIPLIER;
    if (currentMotherload < settings.motherload_threshold) {
      logger.info(`[Auto-Executor] User ${telegramId}: ⏸️ Skipped - Motherload ${currentMotherload.toFixed(2)} SOL below threshold ${settings.motherload_threshold} SOL`);

      // Notify user once every 6 hours (not every round to avoid spam)
      const now = Date.now();
      const lastNotified = lastMotherloadNotification.get(telegramId) || 0;
      const sixHours = 6 * 60 * 60 * 1000;

      if (now - lastNotified > sixHours) {
        try {
          const { Telegraf } = await import('telegraf');
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          if (botToken) {
            const bot = new Telegraf(botToken);
            const message = `⏸️ *Automation Paused*\n\nYour automation is active but not executing because the current motherload (${currentMotherload.toFixed(2)} SOL) is below your threshold setting (${settings.motherload_threshold} SOL).\n\n💡 *To resume automation:*\nAdjust your motherload threshold in /settings → Mining Configuration → Motherload Threshold\n\nRecommended: 100-300 SOL for active mining`;
            await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
            lastMotherloadNotification.set(telegramId, now);
            logger.info(`[Auto-Executor] Sent motherload threshold notification to user ${telegramId}`);
          }
        } catch (notifyError) {
          logger.error(`[Auto-Executor] Failed to send motherload notification to ${telegramId}:`, notifyError);
        }
      }

      return false;
    }

    // Get automation info
    let automationInfo = await getAutomationInfo(userPublicKey);
    if (!automationInfo) {
      logger.warn(`[Auto-Executor] User ${telegramId}: ⚠️ No automation account found`);
      return false;
    }

    // Check if automation is completely depleted
    if (automationInfo.balance === 0) {
      logger.info(`[Auto-Executor] User ${telegramId}: Automation depleted (0 SOL remaining)`);

      // Auto-restart: close old automation and create new one
      logger.info(`[Auto-Executor] User ${telegramId}: 🔄 Auto-restarting automation (completely depleted)...`);

      try {
        const { closeUserAutomation, createUserAutomation } = await import('./userAutomation');

        // Close old automation account
        const closeResult = await closeUserAutomation(userWallet, telegramId);
        if (closeResult.success) {
          logger.info(`[Auto-Executor] User ${telegramId}: Closed depleted automation`);
        }

        // Wait a bit for the close to finalize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create new automation account with automation_budget_percent
        const createResult = await createUserAutomation(userWallet, telegramId);
        if (createResult.success) {
          logger.info(`[Auto-Executor] User ${telegramId}: ✅ Created new automation: ${createResult.targetRounds} rounds @ ${createResult.depositedSol?.toFixed(4)} SOL | ${createResult.signature}`);
          // Refresh automation info and continue to try deploying this round
          // If already deployed, the "AlreadyDeployed" error will be caught gracefully
          automationInfo = await getAutomationInfo(userPublicKey);
          if (!automationInfo) {
            logger.error(`[Auto-Executor] User ${telegramId}: Failed to get new automation info`);
            return false;
          }
        } else {
          logger.warn(`[Auto-Executor] User ${telegramId}: Failed to create new automation: ${createResult.error}`);

          // Notify user about automation stopping due to insufficient funds
          if (createResult.error?.includes('Insufficient balance')) {
            try {
              const { Telegraf } = await import('telegraf');
              const botToken = process.env.TELEGRAM_BOT_TOKEN;
              if (botToken) {
                const bot = new Telegraf(botToken);
                const message = `⚠️ *Automation Stopped*\n\nYour automation has stopped due to insufficient SOL balance.\n\n${createResult.error}\n\nPlease add more SOL to your wallet or adjust your automation settings (/settings) to continue.`;
                await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
              }
            } catch (notifyError) {
              logger.error(`[Auto-Executor] Failed to send low balance notification to ${telegramId}:`, notifyError);
            }
          }

          return false;
        }
      } catch (error) {
        logger.error(`[Auto-Executor] User ${telegramId}: Auto-restart failed:`, error);
        return false;
      }
    }

    // Check if we have enough balance for this round
    if (automationInfo.balance < automationInfo.costPerRound) {
      logger.info(`[Auto-Executor] User ${telegramId}: Budget depleted (${(automationInfo.balance / 1e9).toFixed(4)} SOL < ${(automationInfo.costPerRound / 1e9).toFixed(4)} SOL)`);

      // Auto-restart: close old automation and create new one
      logger.info(`[Auto-Executor] User ${telegramId}: 🔄 Auto-restarting automation (budget depleted)...`);

      try {
        const { closeUserAutomation, createUserAutomation } = await import('./userAutomation');

        // Close old automation account (returns remaining SOL)
        const closeResult = await closeUserAutomation(userWallet, telegramId);
        if (closeResult.success) {
          logger.info(`[Auto-Executor] User ${telegramId}: Closed depleted automation, returned ${closeResult.returnedSol?.toFixed(4)} SOL`);
        }

        // Wait a bit for the close to finalize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create new automation account with automation_budget_percent
        const createResult = await createUserAutomation(userWallet, telegramId);
        if (createResult.success) {
          logger.info(`[Auto-Executor] User ${telegramId}: ✅ Created new automation: ${createResult.targetRounds} rounds @ ${createResult.depositedSol?.toFixed(4)} SOL | ${createResult.signature}`);
          // Refresh automation info and continue to try deploying this round
          // If already deployed, the "AlreadyDeployed" error will be caught gracefully
          automationInfo = await getAutomationInfo(userPublicKey);
          if (!automationInfo) {
            logger.error(`[Auto-Executor] User ${telegramId}: Failed to get new automation info after restart`);
            return false;
          }
        } else {
          logger.warn(`[Auto-Executor] User ${telegramId}: Failed to create new automation: ${createResult.error}`);

          // Notify user about automation stopping due to insufficient funds
          if (createResult.error?.includes('Insufficient balance')) {
            try {
              const { Telegraf } = await import('telegraf');
              const botToken = process.env.TELEGRAM_BOT_TOKEN;
              if (botToken) {
                const bot = new Telegraf(botToken);
                const message = `⚠️ *Automation Stopped*\n\nYour automation has stopped due to insufficient SOL balance.\n\n${createResult.error}\n\nPlease add more SOL to your wallet or adjust your automation settings (/settings) to continue.`;
                await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
              }
            } catch (notifyError) {
              logger.error(`[Auto-Executor] Failed to send low balance notification to ${telegramId}:`, notifyError);
            }
          }

          return false;
        }
      } catch (error) {
        logger.error(`[Auto-Executor] User ${telegramId}: Auto-restart failed:`, error);
        return false;
      }
    }

    // Check if round is still active
    const connection = getConnection();
    const currentSlot = await connection.getSlot();
    if (new BN(currentSlot).gte(board.endSlot)) {
      logger.info(`[Auto-Executor] User ${telegramId}: ⏸️ Skipped - Round has ended`);
      return false;
    }

    // Get miner and check if checkpoint is needed
    const miner = await fetchMiner(userPublicKey);

    if (miner && miner.checkpointId.lt(board.roundId)) {
      const roundsBehind = board.roundId.sub(miner.checkpointId).toNumber();
      const startRoundId = miner.checkpointId.toNumber();
      const endRoundId = board.roundId.toNumber() - 1; // Exclude current round
      logger.info(`[Auto-Executor] User ${telegramId}: Checkpointing ${roundsBehind} round(s)...`);

      try {
        const checkpointIx = await buildCheckpointInstruction(undefined, userPublicKey);
        const tx = new Transaction().add(checkpointIx);
        tx.feePayer = userPublicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const signature = await connection.sendTransaction(tx, [userWallet]);
        await connection.confirmTransaction(signature);

        logger.info(`[Auto-Executor] User ${telegramId}: Checkpointed | ${signature}`);

        // Update user_rounds with winning squares for completed rounds
        // Limit backfill to last 10 rounds to avoid excessive RPC calls
        const maxBackfill = 10;
        const backfillStart = Math.max(startRoundId, endRoundId - maxBackfill + 1);

        if (endRoundId - startRoundId >= maxBackfill) {
          logger.info(`[Auto-Executor] User ${telegramId}: Skipping backfill for ${endRoundId - startRoundId - maxBackfill + 1} old rounds to save RPC calls`);
        }

        for (let roundId = backfillStart; roundId <= endRoundId; roundId++) {
          try {
            const winningSquare = await getRoundWinningSquare(roundId);
            if (winningSquare >= 0) {
              await updateRoundResult(PLATFORM, telegramId, roundId, winningSquare);
              logger.debug(`[Auto-Executor] User ${telegramId}: Updated round ${roundId} with winning square ${winningSquare}`);
            }
            // Small delay between RPC calls to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (updateError) {
            logger.debug(`[Auto-Executor] User ${telegramId}: Failed to update round ${roundId} result:`, updateError);
          }
        }

        // Small delay after checkpoint
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error: any) {
        const errorMsg = error?.message || error?.toString() || String(error);
        logger.error(`[Auto-Executor] User ${telegramId}: Checkpoint failed: ${errorMsg}`);
        if (error?.logs) {
          logger.error(`[Auto-Executor] Transaction logs:`, error.logs);
        }
        // Continue anyway - checkpoint might not always be needed
      }
    }

    // Check if referral is initialized (required for Lode protocol)
    const hasReferral = await isReferralInitialized(userPublicKey);
    if (!hasReferral) {
      logger.info(`[Auto-Executor] User ${telegramId}: Registering referral...`);
      try {
        const registerInstruction = buildRegisterReferralInstruction(DEFAULT_REFERRER, userPublicKey);
        const registerTx = new Transaction().add(registerInstruction);
        registerTx.feePayer = userPublicKey;
        registerTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const registerSig = await connection.sendTransaction(registerTx, [userWallet]);
        await connection.confirmTransaction(registerSig);
        logger.info(`[Auto-Executor] User ${telegramId}: Referral registered | ${registerSig}`);

        // Small delay after registration
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (refError: any) {
        logger.error(`[Auto-Executor] User ${telegramId}: Failed to register referral: ${refError.message}`);
        return false;
      }
    }

    // Build execute automation instruction
    logger.info(`[Auto-Executor] User ${telegramId}: Executing automation for round ${board.roundId.toString()}...`);

    const executeInstructions = await buildExecuteAutomationInstruction(userPublicKey);
    const tx = new Transaction();

    for (const ix of executeInstructions) {
      tx.add(ix);
    }

    tx.feePayer = userPublicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await connection.sendTransaction(tx, [userWallet]);
    await connection.confirmTransaction(signature);

    const solPerRound = automationInfo.costPerRound / 1e9;
    const remainingBalance = (automationInfo.balance - automationInfo.costPerRound) / 1e9;
    const remainingRounds = Math.floor(remainingBalance / solPerRound);

    logger.info(`[Auto-Executor] User ${telegramId}: ✅ Deployed ${solPerRound.toFixed(4)} SOL | ${remainingRounds} rounds left | ${signature}`);

    // Record transaction
    try {
      const { priceInUsd: orbPriceUsd } = await getOrbPrice();
      const devFee = solPerRound * 0.01; // 1% dev fee (100 basis points)

      await recordTransaction({
        type: 'deploy',
        signature,
        roundId: board.roundId.toNumber(),
        solAmount: solPerRound,
        status: 'success',
        notes: `User ${telegramId} auto-deployed via automation (dev fee: ${devFee.toFixed(6)} SOL)`,
        orbPriceUsd,
        txFeeSol: 0.000005,
        devFeeSol: devFee,
        walletAddress: userPublicKey.toBase58(),
        telegramId,
      });
    } catch (error) {
      logger.debug(`[Auto-Executor] Failed to record transaction for user ${telegramId}:`, error);
    }

    // Record user round participation with deployed squares
    try {
      const deployedSquares = await getUserDeployedSquares(telegramId);
      await recordUserRound(
        PLATFORM,
        telegramId,
        board.roundId.toNumber(),
        currentMotherload,
        solPerRound,
        deployedSquares.length,
        deployedSquares
      );
    } catch (error) {
      logger.debug(`[Auto-Executor] Failed to record round for user ${telegramId}:`, error);
    }

    return true;

  } catch (error: any) {
    const errorMsg = String(error?.message || error?.toString() || JSON.stringify(error) || 'Unknown error');

    // Log full error details for debugging
    if (error?.logs) {
      logger.error(`[Auto-Executor] User ${telegramId}: Transaction logs:`, error.logs.join('\n'));
    }

    // Handle common errors
    if (errorMsg.includes('not checkpointed') || errorMsg.includes('checkpoint')) {
      logger.warn(`[Auto-Executor] User ${telegramId}: Checkpoint required - will retry next cycle`);
    } else if (errorMsg.includes('AlreadyDeployed') || errorMsg.includes('already deployed')) {
      logger.debug(`[Auto-Executor] User ${telegramId}: Already deployed this round`);
    } else if (errorMsg.includes('insufficient')) {
      logger.warn(`[Auto-Executor] User ${telegramId}: Insufficient balance`);
    } else if (errorMsg.includes('AccountNotInitialized')) {
      logger.error(`[Auto-Executor] User ${telegramId}: Account not initialized (likely referral issue)`);
    } else if (errorMsg.includes('NotAuthorized') || errorMsg.includes('6001')) {
      // Automation authorization failed - likely created with old/wrong settings
      // Force restart by closing and recreating
      logger.warn(`[Auto-Executor] User ${telegramId}: Authorization failed - forcing automation restart...`);
      try {
        const { closeUserAutomation, createUserAutomation } = await import('./userAutomation');

        // Close the problematic automation
        const closeResult = await closeUserAutomation(userWallet, telegramId);
        if (closeResult.success) {
          logger.info(`[Auto-Executor] User ${telegramId}: Closed old automation, returned ${closeResult.returnedSol?.toFixed(4)} SOL`);

          // Wait for finalization
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Create new automation with proper settings
          const createResult = await createUserAutomation(userWallet, telegramId);
          if (createResult.success) {
            logger.info(`[Auto-Executor] User ${telegramId}: ✅ Recreated automation: ${createResult.targetRounds} rounds @ ${createResult.depositedSol?.toFixed(4)} SOL`);
          } else {
            logger.error(`[Auto-Executor] User ${telegramId}: Failed to recreate automation: ${createResult.error}`);
          }
        }
      } catch (restartError: any) {
        logger.error(`[Auto-Executor] User ${telegramId}: Force restart failed: ${restartError.message}`);
      }
    } else {
      logger.error(`[Auto-Executor] User ${telegramId}: Execution failed: ${errorMsg}`);
    }

    return false;
  }
}

/**
 * Main executor loop - monitors rounds and executes automation for all users
 */
async function executorLoop(): Promise<void> {
  try {
    // Fetch current board state
    const board = await fetchBoard();
    const currentRoundId = board.roundId.toString();

    // Check if this is a new round
    if (currentRoundId !== lastRoundId) {
      logger.info(`[Auto-Executor] 🔄 New round detected: ${currentRoundId}`);
      lastRoundId = currentRoundId;

      // Fetch treasury for motherload check
      const treasury = await fetchTreasury();
      const currentMotherload = Number(treasury.motherlodeBl) / SOL_MULTIPLIER;
      logger.info(`[Auto-Executor] Motherload: ${currentMotherload.toFixed(2)} SOL`);

      // Get all users with active automation
      const users = await getUsersWithActiveAutomation();

      if (users.length === 0) {
        logger.debug('[Auto-Executor] No users with active automation accounts');
        return;
      }

      logger.info(`[Auto-Executor] Found ${users.length} user(s) with active automation`);

      // Execute automation for each user
      for (const user of users) {
        try {
          logger.info(`[Auto-Executor] Processing user ${user.telegram_id}...`);
          const userWallet = await getUserWallet(user.telegram_id);
          if (!userWallet) {
            logger.warn(`[Auto-Executor] User ${user.telegram_id}: Wallet not found`);
            continue;
          }

          const executed = await executeUserAutomation(user.telegram_id, userWallet, board, treasury);
          if (!executed) {
            logger.debug(`[Auto-Executor] User ${user.telegram_id}: Execution skipped (no action taken)`);
          }

          // Small delay between users to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(`[Auto-Executor] Failed to execute automation for user ${user.telegram_id}:`, error);
        }
      }
    }

  } catch (error) {
    logger.error('[Auto-Executor] Executor loop error:', error);
  }
}

/**
 * Initialize the automation executor service
 */
export function initializeAutoExecutor(): void {
  if (isRunning) {
    logger.warn('[Auto-Executor] Service already running');
    return;
  }

  logger.info('[Auto-Executor] Starting automation executor service...');
  isRunning = true;

  // Run executor loop every 15 seconds
  const checkInterval = 15000;

  executorInterval = setInterval(async () => {
    if (isRunning) {
      await executorLoop();
    }
  }, checkInterval);

  // Run immediately on startup
  executorLoop().catch(error => {
    logger.error('[Auto-Executor] Initial loop failed:', error);
  });

  logger.info(`[Auto-Executor] ✅ Service started (checking every ${checkInterval / 1000}s)`);
}

/**
 * Stop the automation executor service
 */
export function stopAutoExecutor(): void {
  if (!isRunning) {
    logger.warn('[Auto-Executor] Service not running');
    return;
  }

  logger.info('[Auto-Executor] Stopping automation executor service...');
  isRunning = false;

  if (executorInterval) {
    clearInterval(executorInterval);
    executorInterval = null;
  }

  logger.info('[Auto-Executor] ✅ Service stopped');
}

/**
 * Get executor service status
 */
export function getAutoExecutorStatus(): { running: boolean; lastRound: string | null } {
  return {
    running: isRunning,
    lastRound: lastRoundId,
  };
}

/**
 * Manually trigger executor loop (for testing)
 */
export async function manualTriggerAutoExecutor(): Promise<void> {
  logger.info('[Auto-Executor] Manual trigger requested');
  await executorLoop();
}
