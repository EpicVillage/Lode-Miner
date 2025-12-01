import { Keypair, TransactionInstruction, PublicKey } from '@solana/web3.js';
import { getUserWallet } from './userWallet';
import { getUserSettings } from './userSettings';
import { recordTransaction } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { getOrbPrice, swapOrbToSol, getSwapQuote } from '../../src/utils/jupiter';
import {
  buildClaimSolInstruction,
  buildClaimTokenInstruction,
  buildDeployInstruction,
  sendAndConfirmTransaction
} from '../../src/utils/program';
import { fetchMiner, fetchStake, fetchBoard, fetchRound } from '../../src/utils/accounts';
import { formatSOL, formatLODE } from './formatters';
import { LODE_MULTIPLIER, SOL_MULTIPLIER } from '../../src/utils/config';

/**
 * User-specific blockchain operations for telegram bot users
 * Handles claiming, swapping, deploying for individual users
 */

export interface ClaimResult {
  success: boolean;
  solAmount?: number;
  orbAmount?: number;
  signature?: string;
  error?: string;
}

export interface SwapResult {
  success: boolean;
  orbSwapped?: number;
  solReceived?: number;
  signature?: string;
  error?: string;
}

export interface DeployResult {
  success: boolean;
  solDeployed?: number;
  roundId?: number;
  signature?: string;
  error?: string;
}

/**
 * Claim SOL rewards from mining for a user
 */
export async function claimUserSol(
  telegramId: string
): Promise<ClaimResult> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const settings = await getUserSettings(telegramId);

    logger.info(`[User Claim] Claiming SOL rewards for ${telegramId}`);

    // Fetch miner account for mining rewards
    const miner = await fetchMiner(wallet.publicKey);

    if (!miner) {
      return { success: false, error: 'No miner account found' };
    }

    const miningSol = Number(miner.rewardsSol) / 1e9;

    if (miningSol === 0) {
      return { success: false, error: 'No SOL rewards to claim' };
    }

    logger.info(`[User Claim] Mining Rewards: ${miningSol.toFixed(4)} SOL`);

    // Build and send claim instruction
    const instruction = buildClaimSolInstruction(wallet.publicKey);
    const { signature } = await sendAndConfirmTransaction([instruction], 'Claim SOL', { wallet });

    // Record transaction
    await recordTransaction({
      type: 'claim_sol',
      signature,
      solAmount: miningSol,
      status: 'success',
      notes: `Claimed ${miningSol.toFixed(4)} SOL for user ${telegramId}`,
      walletAddress: wallet.publicKey.toBase58(),
      telegramId,
    });

    logger.info(`[User Claim] Successfully claimed ${miningSol.toFixed(4)} SOL | ${signature}`);

    return { success: true, solAmount: miningSol, signature };
  } catch (error: any) {
    logger.error('[User Claim] Failed to claim SOL:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Claim LODE rewards from mining for a user
 */
export async function claimUserOrb(
  telegramId: string
): Promise<ClaimResult> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const settings = await getUserSettings(telegramId);

    logger.info(`[User Claim] Claiming LODE rewards for ${telegramId}`);

    // Fetch miner account for mining rewards
    const miner = await fetchMiner(wallet.publicKey);

    if (!miner) {
      return { success: false, error: 'No miner account found' };
    }

    const miningOrb = Number(miner.rewardsToken) / LODE_MULTIPLIER;

    if (miningOrb === 0) {
      return { success: false, error: 'No LODE rewards to claim' };
    }

    logger.info(`[User Claim] Mining Rewards: ${miningOrb.toFixed(2)} LODE`);

    // Build and send claim instruction
    const instruction = await buildClaimTokenInstruction(wallet.publicKey);
    const { signature } = await sendAndConfirmTransaction([instruction], 'Claim LODE', { wallet });

    // Record transaction
    await recordTransaction({
      type: 'claim_orb',
      signature,
      orbAmount: miningOrb,
      status: 'success',
      notes: `Claimed ${miningOrb.toFixed(2)} LODE for user ${telegramId}`,
      walletAddress: wallet.publicKey.toBase58(),
      telegramId,
    });

    logger.info(`[User Claim] Successfully claimed ${miningOrb.toFixed(2)} LODE | ${signature}`);

    return { success: true, orbAmount: miningOrb, signature };
  } catch (error: any) {
    logger.error('[User Claim] Failed to claim LODE:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Claim staking rewards for a user
 */
export async function claimUserStakingRewards(
  telegramId: string
): Promise<ClaimResult> {
  try {
    // Use the real implementation from userStaking
    const { claimUserStakingRewards: claimStaking } = await import('./userStaking');
    const result = await claimStaking(telegramId);

    if (result.success && result.amount) {
      return {
        success: true,
        orbAmount: result.amount,
        solAmount: 0, // Staking rewards are LODE only
        signature: result.signature
      };
    }

    return { success: false, error: result.error };
  } catch (error: any) {
    logger.error('[User Claim] Failed to claim staking rewards:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Swap LODE to SOL for a user
 */
export async function swapUserOrbToSol(
  telegramId: string,
  amount: number
): Promise<SwapResult> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const settings = await getUserSettings(telegramId);

    logger.info(`[User Swap] Swapping ${amount.toFixed(2)} LODE to SOL for ${telegramId}`);

    // Validate amount
    if (amount <= 0) {
      return { success: false, error: 'Swap amount must be greater than 0' };
    }

    if (amount < settings.min_swap_amount) {
      return { success: false, error: `Minimum swap amount is ${settings.min_swap_amount} LODE` };
    }

    // Check LODE balance
    const { getUserBalances } = await import('./userWallet');
    const balances = await getUserBalances(telegramId);

    if (!balances || balances.orb < amount) {
      return { success: false, error: `Insufficient LODE balance. Need ${amount} LODE, have ${balances?.orb.toFixed(2) || 0} LODE` };
    }

    // Check price protection
    if (settings.min_orb_price > 0) {
      const lodePrice = await getOrbPrice();
      if (lodePrice.priceInUsd < settings.min_orb_price) {
        return {
          success: false,
          error: `LODE price ($${lodePrice.priceInUsd.toFixed(2)}) below minimum ($${settings.min_orb_price})`
        };
      }
    }

    // Get quote
    const quote = await getSwapQuote(amount, settings.slippage_bps);
    if (!quote) {
      return { success: false, error: 'Failed to get swap quote' };
    }

    const expectedSol = Number(quote.outAmount) / 1e9;
    logger.info(`[User Swap] Expected output: ${expectedSol.toFixed(4)} SOL`);

    // Execute swap with user's wallet
    const result = await swapOrbToSol(amount, settings.slippage_bps, wallet);

    if (result.success) {
      // Record transaction
      await recordTransaction({
        type: 'swap',
        signature: result.signature,
        orbAmount: amount,
        solAmount: result.solReceived || 0,
        status: 'success',
        notes: `Swapped ${amount.toFixed(2)} LODE → ${result.solReceived?.toFixed(4)} SOL for user ${telegramId}`,
        walletAddress: wallet.publicKey.toBase58(),
        telegramId,
      });

      logger.info(`[User Swap] Successfully swapped ${amount.toFixed(2)} LODE → ${result.solReceived?.toFixed(4)} SOL | ${result.signature}`);

      return { success: true, orbSwapped: amount, solReceived: result.solReceived, signature: result.signature };
    } else {
      return { success: false, error: 'Swap failed' };
    }
  } catch (error: any) {
    logger.error('[User Swap] Failed to swap:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Deploy SOL to current round for a user
 */
export async function deployUserSol(
  telegramId: string,
  amount: number
): Promise<DeployResult> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const settings = await getUserSettings(telegramId);

    logger.info(`[User Deploy] Deploying ${amount.toFixed(4)} SOL for ${telegramId}`);

    // Validate amount
    if (amount <= 0) {
      return { success: false, error: 'Deployment amount must be greater than 0' };
    }

    // Check SOL balance
    const { getUserBalances } = await import('./userWallet');
    const balances = await getUserBalances(telegramId);

    if (!balances || balances.sol < amount) {
      return {
        success: false,
        error: `Insufficient SOL balance. Need ${amount} SOL, have ${balances?.sol.toFixed(4) || 0} SOL`
      };
    }

    // Get current board info
    const board = await fetchBoard();
    const roundId = Number(board.roundId);

    // Fetch round to get motherload
    const round = await fetchRound(board.roundId);
    const motherloadSol = Number(round.motherlode) / SOL_MULTIPLIER;

    logger.info(`[User Deploy] Current round: ${roundId}, Motherload: ${motherloadSol.toFixed(2)} SOL`);

    // Build and send deploy instructions (includes dev fee transfer)
    const instructions = await buildDeployInstruction(amount, 25, wallet.publicKey);
    const { signature } = await sendAndConfirmTransaction(instructions, 'Deploy', { wallet });

    // Calculate 1% dev fee (100 basis points)
    const devFee = amount * 0.01;

    // Record transaction
    await recordTransaction({
      type: 'deploy',
      signature,
      roundId,
      solAmount: amount,
      status: 'success',
      notes: `Deployed ${amount.toFixed(4)} SOL to round ${roundId} for user ${telegramId} (dev fee: ${devFee.toFixed(6)} SOL)`,
      txFeeSol: 0.000005,
      devFeeSol: devFee,
      walletAddress: wallet.publicKey.toBase58(),
      telegramId,
    });

    // Record user round participation with deployed squares
    const { recordUserRound, getUserDeployedSquares } = await import('./userRounds');
    const deployedSquares = await getUserDeployedSquares(telegramId);
    await recordUserRound(
      telegramId,
      roundId,
      motherloadSol,
      amount,
      deployedSquares.length,
      deployedSquares
    );

    logger.info(`[User Deploy] Successfully deployed ${amount.toFixed(4)} SOL to round ${roundId} | ${signature}`);

    return { success: true, solDeployed: amount, roundId, signature };
  } catch (error: any) {
    logger.error('[User Deploy] Failed to deploy:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get claimable rewards for a user
 */
export async function getUserClaimableRewards(
  telegramId: string
): Promise<{
  miningSol: number;
  miningOrb: number;
  stakingSol: number;
  stakingOrb: number;
  totalSol: number;
  totalOrb: number;
}> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { miningSol: 0, miningOrb: 0, stakingSol: 0, stakingOrb: 0, totalSol: 0, totalOrb: 0 };
    }

    let miningSol = 0, miningOrb = 0, stakingSol = 0, stakingOrb = 0;

    // Fetch miner account
    const miner = await fetchMiner(wallet.publicKey);
    if (miner) {
      miningSol = Number(miner.rewardsSol) / 1e9;
      miningOrb = Number(miner.rewardsToken) / LODE_MULTIPLIER;
    }

    // Fetch stake account
    // In Lode: staking LODE tokens earns SOL rewards
    const stake = await fetchStake(wallet.publicKey);
    if (stake) {
      stakingSol = Number(stake.rewards) / 1e9;
      stakingOrb = 0; // Staking in Lode only earns SOL, not tokens
    }

    return {
      miningSol,
      miningOrb,
      stakingSol,
      stakingOrb,
      totalSol: miningSol + stakingSol,
      totalOrb: miningOrb + stakingOrb,
    };
  } catch (error) {
    logger.error('[User Operations] Failed to get claimable rewards:', error);
    return { miningSol: 0, miningOrb: 0, stakingSol: 0, stakingOrb: 0, totalSol: 0, totalOrb: 0 };
  }
}
