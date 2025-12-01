import { Keypair, PublicKey, SystemProgram, TransactionInstruction, Transaction } from '@solana/web3.js';
import { getConnection } from '../../src/utils/solana';
import { getAutomationPDA, getMinerPDA, fetchTreasury } from '../../src/utils/accounts';
import { buildAutomateInstruction, AutomationStrategy } from '../../src/utils/program';
import { getOrbPrice } from '../../src/utils/jupiter';
import { recordTransaction } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { Platform, getUserWallet, getUserSettings } from '../database';

const LODE_PROGRAM_ID = new PublicKey('main99FJE8twaLPzw9nr3GqnSTVg8h4nyiMEDutnx64'); // LODE program

export interface AutomationInfo {
  pda: PublicKey;
  amountPerSquare: number;
  balance: number;
  mask: number;
  costPerRound: number;
}

export interface AutomationStatus {
  active: boolean;
  balance?: number;
  costPerRound?: number;
  estimatedRounds?: number;
}

export interface AutomationResult {
  success: boolean;
  signature?: string;
  depositedSol?: number;
  returnedSol?: number;
  targetRounds?: number;
  error?: string;
}

/**
 * Get automation account info for a wallet
 */
async function getAutomationInfo(publicKey: PublicKey): Promise<AutomationInfo | null> {
  const connection = getConnection();
  const [automationPDA] = getAutomationPDA(publicKey);
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
 * Calculate target rounds based on budget
 */
function calculateTargetRounds(maxBudget: number, solPerRound: number): number {
  const maxRounds = Math.floor(maxBudget / solPerRound);
  return Math.min(maxRounds, 1000);
}

/**
 * Build close automation instruction
 */
function buildCloseAutomationInstruction(publicKey: PublicKey): TransactionInstruction {
  const [minerPDA] = getMinerPDA(publicKey);
  const [automationPDA] = getAutomationPDA(publicKey);

  const AUTOMATE_DISCRIMINATOR = 0x00;
  const data = Buffer.alloc(34);
  data.writeUInt8(AUTOMATE_DISCRIMINATOR, 0);

  const keys = [
    { pubkey: publicKey, isSigner: true, isWritable: true },
    { pubkey: automationPDA, isSigner: false, isWritable: true },
    { pubkey: PublicKey.default, isSigner: false, isWritable: true },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: LODE_PROGRAM_ID,
    data,
  });
}

/**
 * Get automation status for a user
 */
export async function getAutomationStatus(
  platform: Platform,
  platformId: string
): Promise<AutomationStatus> {
  try {
    const wallet = await getUserWallet(platform, platformId);
    if (!wallet) {
      return { active: false };
    }

    const automationInfo = await getAutomationInfo(wallet.publicKey);

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
    logger.error(`[Shared Automation] Failed to get status for ${platform}:${platformId}:`, error);
    return { active: false };
  }
}

/**
 * Start automation for a user
 */
export async function startAutomation(
  platform: Platform,
  platformId: string
): Promise<AutomationResult> {
  try {
    const wallet = await getUserWallet(platform, platformId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    logger.info(`[Shared Automation] Starting automation for ${platform}:${platformId}...`);

    // Check if automation already exists
    const existingAutomation = await getAutomationInfo(wallet.publicKey);
    if (existingAutomation && existingAutomation.balance > 0) {
      return { success: false, error: 'Automation already active - stop it first to restart' };
    }

    // Get user settings
    const settings = await getUserSettings(platform, platformId);

    // Get wallet balance
    const connection = getConnection();
    const balance = await connection.getBalance(wallet.publicKey);
    const solBalance = balance / 1e9;
    logger.info(`[Shared Automation] Wallet balance: ${solBalance.toFixed(4)} SOL`);

    // Calculate costs
    const solPerBlock = settings.sol_per_block;
    const blocksPerRound = settings.num_blocks;
    const solPerRound = solPerBlock * blocksPerRound;

    // Calculate budget
    const maxBudget = solBalance * (settings.automation_budget_percent / 100);
    const targetRounds = calculateTargetRounds(maxBudget, solPerRound);
    const usableBudget = targetRounds * solPerRound;

    logger.info(`[Shared Automation] Allocating ${usableBudget.toFixed(4)} SOL for ${targetRounds} rounds`);

    if (usableBudget < solPerRound) {
      return {
        success: false,
        error: `Insufficient balance - need at least ${solPerRound.toFixed(4)} SOL`,
      };
    }

    // Get motherload for logging
    let motherloadLode = 0;
    try {
      const treasury = await fetchTreasury();
      motherloadLode = Number(treasury.motherlode) / 1e9;
    } catch {
      logger.debug('[Shared Automation] Could not fetch treasury for logging');
    }

    // Build automation instruction
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
      wallet.publicKey,
      wallet.publicKey
    );

    // Send transaction
    const tx = new Transaction().add(instruction);
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(signature);

    logger.info(`[Shared Automation] Started: ${signature}`);

    // Record transaction
    try {
      const { priceInUsd: orbPriceUsd } = await getOrbPrice();
      await recordTransaction({
        type: 'automation_setup',
        signature,
        solAmount: deposit,
        status: 'success',
        notes: `${platform}:${platformId} started: ${targetRounds} rounds @ ${solPerRound.toFixed(4)} SOL/round (motherload: ${motherloadLode.toFixed(2)} LODE)`,
        orbPriceUsd,
        txFeeSol: 0.005,
        walletAddress: wallet.publicKey.toBase58(),
        telegramId: platform === 'telegram' ? platformId : undefined,
      });
    } catch (error) {
      logger.error('[Shared Automation] Failed to record transaction:', error);
    }

    return {
      success: true,
      signature,
      depositedSol: deposit,
      targetRounds,
    };
  } catch (error: any) {
    logger.error(`[Shared Automation] Failed to start for ${platform}:${platformId}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Stop automation for a user
 */
export async function stopAutomation(
  platform: Platform,
  platformId: string
): Promise<AutomationResult> {
  try {
    const wallet = await getUserWallet(platform, platformId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    logger.info(`[Shared Automation] Stopping automation for ${platform}:${platformId}...`);

    const automationInfo = await getAutomationInfo(wallet.publicKey);
    if (!automationInfo || automationInfo.balance === 0) {
      return { success: false, error: 'No active automation to stop' };
    }

    const returnedSol = automationInfo.balance / 1e9;
    logger.info(`[Shared Automation] Will return ${returnedSol.toFixed(4)} SOL`);

    const closeInstruction = buildCloseAutomationInstruction(wallet.publicKey);

    const connection = getConnection();
    const tx = new Transaction().add(closeInstruction);
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(signature);

    logger.info(`[Shared Automation] Stopped: ${signature}`);

    // Record transaction
    try {
      const { priceInUsd: orbPriceUsd } = await getOrbPrice();
      await recordTransaction({
        type: 'automation_close',
        signature,
        solAmount: returnedSol,
        status: 'success',
        notes: `${platform}:${platformId} stopped - returned ${returnedSol.toFixed(4)} SOL`,
        orbPriceUsd,
        txFeeSol: 0.0005,
        walletAddress: wallet.publicKey.toBase58(),
        telegramId: platform === 'telegram' ? platformId : undefined,
      });
    } catch (error) {
      logger.error('[Shared Automation] Failed to record transaction:', error);
    }

    return {
      success: true,
      signature,
      returnedSol,
    };
  } catch (error: any) {
    logger.error(`[Shared Automation] Failed to stop for ${platform}:${platformId}:`, error);
    return { success: false, error: error.message };
  }
}
