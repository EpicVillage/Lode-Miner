import { Keypair, PublicKey } from '@solana/web3.js';
import { getConnection } from '../../src/utils/solana';
import { getAutomationPDA, getMinerPDA, fetchBoard, fetchTreasury, isReferralInitialized } from '../../src/utils/accounts';
import { sendAndConfirmTransaction, buildAutomateInstruction, buildRegisterReferralInstruction, buildCancelAutomateInstruction, AutomationStrategy } from '../../src/utils/program';
import { TransactionInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { getOrbPrice } from '../../src/utils/jupiter';
import { recordTransaction } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { config, LODE_MULTIPLIER } from '../../src/utils/config';

// Default referrer address (dev wallet for referral rewards)
const DEFAULT_REFERRER = new PublicKey('9LGAtUrQx8u3YXF5traoUtFBN3w62bgqohLc1Npkh3Yq');

/**
 * User-specific automation utilities for Telegram bot
 *
 * These functions work with a user's wallet instead of the global wallet
 */

/**
 * Check if automation account exists and get its info for a specific user wallet
 */
async function getAutomationInfo(userWallet: Keypair) {
  const connection = getConnection();
  const [automationPDA] = getAutomationPDA(userWallet.publicKey);
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
}

/**
 * Calculate target rounds - use full budget allocation
 */
function calculateTargetRounds(maxBudget: number, solPerRound: number): number {
  const maxRounds = Math.floor(maxBudget / solPerRound);
  return Math.min(maxRounds, 1000);
}

// Note: buildCancelAutomateInstruction is imported from program.ts

/**
 * Close automation account for a specific user
 */
export async function closeUserAutomation(userWallet: Keypair, telegramId: string): Promise<{
  success: boolean;
  signature?: string;
  returnedSol?: number;
  error?: string;
}> {
  try {
    logger.info(`[User Automation] Closing automation for telegram user ${telegramId}...`);

    const automationInfo = await getAutomationInfo(userWallet);
    if (!automationInfo || automationInfo.balance === 0) {
      return {
        success: false,
        error: 'No automation account found',
      };
    }

    const returnedSol = automationInfo.balance / 1e9;
    logger.info(`[User Automation] Will return ${returnedSol.toFixed(4)} SOL to user`);

    const closeInstruction = buildCancelAutomateInstruction(userWallet.publicKey);

    // Build transaction with user's wallet as signer
    const { Transaction, sendAndConfirmTransaction: sendTx } = await import('@solana/web3.js');
    const connection = getConnection();
    const tx = new Transaction().add(closeInstruction);
    tx.feePayer = userWallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await connection.sendTransaction(tx, [userWallet]);
    await connection.confirmTransaction(signature);

    logger.info(`[User Automation] Closed: ${signature}`);

    // Record transaction
    try {
      const { priceInUsd: orbPriceUsd } = await getOrbPrice();
      await recordTransaction({
        type: 'automation_close',
        signature,
        solAmount: returnedSol,
        status: 'success',
        notes: `User ${telegramId} closed automation - returned ${returnedSol.toFixed(4)} SOL`,
        orbPriceUsd,
        txFeeSol: 0.0005,
        walletAddress: userWallet.publicKey.toBase58(),
        telegramId,
      });
    } catch (error) {
      logger.error('[User Automation] Failed to record transaction:', error);
    }

    return {
      success: true,
      signature,
      returnedSol,
    };
  } catch (error) {
    logger.error('[User Automation] Failed to close:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Create automation account for a specific user
 */
export async function createUserAutomation(userWallet: Keypair, telegramId: string): Promise<{
  success: boolean;
  signature?: string;
  depositedSol?: number;
  targetRounds?: number;
  error?: string;
}> {
  try {
    logger.info(`[User Automation] Creating automation for telegram user ${telegramId}...`);

    // Load user-specific settings
    const { getUserSettings } = await import('./userSettings');
    const userSettings = await getUserSettings(telegramId);

    // Check if automation already exists
    const existingAutomation = await getAutomationInfo(userWallet);
    if (existingAutomation && existingAutomation.balance > 0) {
      return {
        success: false,
        error: 'Automation already exists - close it first',
      };
    }

    // Check if referral is initialized (required for Lode protocol)
    const hasReferral = await isReferralInitialized(userWallet.publicKey);
    if (!hasReferral) {
      logger.info(`[User Automation] User ${telegramId} needs referral registration...`);

      try {
        const connection = getConnection();
        const registerInstruction = buildRegisterReferralInstruction(DEFAULT_REFERRER, userWallet.publicKey);

        const { Transaction: TxClass } = await import('@solana/web3.js');
        const registerTx = new TxClass().add(registerInstruction);
        registerTx.feePayer = userWallet.publicKey;
        registerTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const registerSig = await connection.sendTransaction(registerTx, [userWallet]);
        await connection.confirmTransaction(registerSig);

        logger.info(`[User Automation] Referral registered: ${registerSig}`);
      } catch (refError) {
        logger.error('[User Automation] Failed to register referral:', refError);
        return {
          success: false,
          error: 'Failed to register referral - required for automation',
        };
      }
    }

    // Get wallet balance
    const connection = getConnection();
    const balance = await connection.getBalance(userWallet.publicKey);
    const solBalance = balance / 1e9;
    logger.info(`[User Automation] User wallet balance: ${solBalance.toFixed(4)} SOL`);

    // Use user-specific settings
    const solPerBlock = userSettings.sol_per_block;
    const blocksPerRound = userSettings.num_blocks;
    const solPerRound = solPerBlock * blocksPerRound;

    logger.info(`[User Automation] User settings: ${solPerBlock} SOL/block × ${blocksPerRound} blocks = ${solPerRound.toFixed(4)} SOL/round`);

    // Calculate budget using user's automation budget percentage
    const maxBudget = solBalance * (userSettings.automation_budget_percent / 100);
    const targetRounds = calculateTargetRounds(maxBudget, solPerRound);
    const usableBudget = targetRounds * solPerRound;

    logger.info(`[User Automation] Allocating ${usableBudget.toFixed(4)} SOL for ${targetRounds} rounds`);

    if (usableBudget < solPerRound) {
      return {
        success: false,
        error: `Insufficient balance - need at least ${solPerRound.toFixed(4)} SOL`,
      };
    }

    // Get motherload for logging (optional - skip if fails)
    let motherloadOrb = 0;
    try {
      const treasury = await fetchTreasury();
      motherloadOrb = Number(treasury.motherlodeBl) / LODE_MULTIPLIER;
    } catch (error) {
      logger.debug('[User Automation] Could not fetch treasury for logging, continuing anyway');
    }

    // Create automation instruction
    const deposit = usableBudget;
    const feePerExecution = 0.00001;
    const strategy = AutomationStrategy.Random;
    const squareMask = BigInt(blocksPerRound);

    const instruction = buildAutomateInstruction(
      solPerBlock,
      deposit,
      feePerExecution,
      strategy,
      squareMask,
      userWallet.publicKey,   // executor parameter (self-execute)
      userWallet.publicKey    // walletPublicKey parameter (for multi-user support)
    );

    // Build and send transaction
    const { Transaction } = await import('@solana/web3.js');
    const tx = new Transaction().add(instruction);
    tx.feePayer = userWallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await connection.sendTransaction(tx, [userWallet]);
    await connection.confirmTransaction(signature);

    logger.info(`[User Automation] Created: ${signature}`);

    // Record transaction
    try {
      const { priceInUsd: orbPriceUsd } = await getOrbPrice();
      await recordTransaction({
        type: 'automation_setup',
        signature,
        solAmount: deposit,
        status: 'success',
        notes: `User ${telegramId} setup: ${targetRounds} rounds @ ${solPerRound.toFixed(4)} SOL/round (motherload: ${motherloadOrb.toFixed(2)} LODE)`,
        orbPriceUsd,
        txFeeSol: 0.005,
        walletAddress: userWallet.publicKey.toBase58(),
        telegramId,
      });
    } catch (error) {
      logger.error('[User Automation] Failed to record transaction:', error);
    }

    return {
      success: true,
      signature,
      depositedSol: deposit,
      targetRounds,
    };
  } catch (error) {
    logger.error('[User Automation] Failed to create:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get automation status for a user
 */
export async function getUserAutomationStatus(userWallet: Keypair): Promise<{
  active: boolean;
  balance?: number;
  costPerRound?: number;
  estimatedRounds?: number;
}> {
  try {
    const automationInfo = await getAutomationInfo(userWallet);

    if (!automationInfo || automationInfo.balance === 0) {
      return { active: false };
    }

    const balance = automationInfo.balance / 1e9;
    const costPerRound = automationInfo.costPerRound / 1e9;
    const estimatedRounds = costPerRound > 0 ? Math.floor(balance / costPerRound) : 0;

    return {
      active: true,
      balance,
      costPerRound,
      estimatedRounds,
    };
  } catch (error) {
    logger.error('[User Automation] Failed to get status:', error);
    return { active: false };
  }
}
