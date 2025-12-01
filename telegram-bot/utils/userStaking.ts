import { runQuery, getQuery, recordTransaction } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { getUserWallet } from './userWallet';
import { getConnection } from '../../src/utils/solana';
import { fetchStake } from '../../src/utils/accounts';
import { formatLODE, formatSOL } from './formatters';
import { PublicKey, Transaction } from '@solana/web3.js';
import { buildStakeDepositInstruction, buildStakeClaimInstruction, sendAndConfirmTransaction } from '../../src/utils/program';
import { getUserBalances } from './userWallet';
import { LODE_MULTIPLIER } from '../../src/utils/config';

/**
 * User-specific staking operations for telegram bot users
 */

export interface UserStakingInfo {
  telegram_id: string;
  staked_amount: number;
  accrued_rewards: number;
  last_updated: number;
}

/**
 * Get user staking info from blockchain
 */
export async function getUserStakingInfo(telegramId: string): Promise<UserStakingInfo | null> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return null;
    }

    // Fetch stake account from blockchain
    const stake = await fetchStake(wallet.publicKey);
    if (!stake) {
      return null;
    }

    const stakedAmount = Number(stake.balance) / LODE_MULTIPLIER;
    // In Lode: staking LODE tokens earns SOL rewards (stored in 'rewards')
    const accruedRewards = Number(stake.rewards) / 1e9;

    // Update database record
    await updateUserStakingInfo(telegramId, stakedAmount, accruedRewards);

    return {
      telegram_id: telegramId,
      staked_amount: stakedAmount,
      accrued_rewards: accruedRewards,
      last_updated: Date.now(),
    };
  } catch (error) {
    logger.error('[User Staking] Failed to get staking info:', error);
    // Fallback to database
    const row = await getQuery<UserStakingInfo>(`
      SELECT * FROM user_staking WHERE telegram_id = ?
    `, [telegramId]);
    return row || null;
  }
}

/**
 * Create or update user staking record
 */
export async function updateUserStakingInfo(
  telegramId: string,
  stakedAmount: number,
  accruedRewards: number
): Promise<void> {
  await runQuery(`
    INSERT INTO user_staking (telegram_id, staked_amount, accrued_rewards, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      staked_amount = excluded.staked_amount,
      accrued_rewards = excluded.accrued_rewards,
      last_updated = excluded.last_updated
  `, [telegramId, stakedAmount, accruedRewards, Date.now()]);

  logger.debug(`[User Staking] Updated staking info for ${telegramId}: ${stakedAmount} staked, ${accruedRewards} rewards`);
}

/**
 * Stake ORB for a user
 */
export async function stakeUserOrb(
  telegramId: string,
  amount: number
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    // Validate amount
    if (amount <= 0) {
      return { success: false, error: 'Stake amount must be greater than 0' };
    }

    // Check LODE balance
    const balances = await getUserBalances(telegramId);
    if (!balances || balances.orb < amount) {
      return {
        success: false,
        error: `Insufficient LODE balance. Need ${amount} LODE, have ${balances?.orb.toFixed(2) || 0} LODE`
      };
    }

    logger.info(`[User Staking] Staking ${amount} LODE for ${telegramId}`);

    // Build and send stake instruction
    const instruction = await buildStakeDepositInstruction(amount, wallet.publicKey);
    const { signature } = await sendAndConfirmTransaction([instruction], 'Stake', { wallet });

    // Update database with new staked amount
    const currentInfo = await getUserStakingInfo(telegramId);
    const newStakedAmount = (currentInfo?.staked_amount || 0) + amount;
    await updateUserStakingInfo(telegramId, newStakedAmount, currentInfo?.accrued_rewards || 0);

    // Record transaction
    await recordTransaction({
      type: 'stake',
      signature,
      orbAmount: amount,
      status: 'success',
      notes: `Staked ${amount} LODE for user ${telegramId}`,
      walletAddress: wallet.publicKey.toBase58(),
      telegramId,
    });

    logger.info(`[User Staking] Successfully staked ${amount} LODE | ${signature}`);

    return { success: true, signature };
  } catch (error: any) {
    logger.error('[User Staking] Failed to stake LODE:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Claim staking rewards for a user
 */
export async function claimUserStakingRewards(
  telegramId: string
): Promise<{ success: boolean; amount?: number; signature?: string; error?: string }> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const stakingInfo = await getUserStakingInfo(telegramId);
    if (!stakingInfo || stakingInfo.accrued_rewards === 0) {
      return { success: false, error: 'No rewards to claim' };
    }

    const claimedAmount = stakingInfo.accrued_rewards;

    logger.info(`[User Staking] Claiming ${claimedAmount} SOL staking rewards for ${telegramId}`);

    // Build and send claim yield instruction (In Lode: staking earns SOL rewards)
    const instruction = buildStakeClaimInstruction(wallet.publicKey);
    const { signature } = await sendAndConfirmTransaction([instruction], 'Claim Staking Rewards', { wallet });

    // Update staking info (reset rewards)
    await updateUserStakingInfo(telegramId, stakingInfo.staked_amount, 0);

    // Record transaction
    await recordTransaction({
      type: 'claim_sol',
      signature,
      solAmount: claimedAmount,
      status: 'success',
      notes: `Claimed ${claimedAmount} SOL staking rewards for user ${telegramId}`,
      walletAddress: wallet.publicKey.toBase58(),
      telegramId,
    });

    logger.info(`[User Staking] Successfully claimed ${claimedAmount} SOL staking rewards | ${signature}`);

    return { success: true, amount: claimedAmount, signature };
  } catch (error: any) {
    logger.error('[User Staking] Failed to claim rewards:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get staking pool info from blockchain
 */
export async function getStakingPoolInfo(): Promise<{
  totalStaked: number;
  rewardRate: number;
  poolAddress: string;
}> {
  try {
    // TODO: Implement actual blockchain query
    // This is a placeholder
    return {
      totalStaked: 0,
      rewardRate: 0,
      poolAddress: 'N/A',
    };
  } catch (error) {
    logger.error('[User Staking] Failed to get pool info:', error);
    return {
      totalStaked: 0,
      rewardRate: 0,
      poolAddress: 'N/A',
    };
  }
}

/**
 * Format staking info for display
 */
export function formatStakingDisplay(
  stakingInfo: UserStakingInfo | null,
  poolInfo?: { totalStaked: number; rewardRate: number }
): string {
  if (!stakingInfo || stakingInfo.staked_amount === 0) {
    return `
🏦 *Staking Status*

You have no LODE staked.

Use /stake to start earning rewards!
`.trim();
  }

  const lastUpdated = new Date(stakingInfo.last_updated).toLocaleString();

  return `
🏦 *Staking Status*

*Your Stake:*
• Staked Amount: ${formatLODE(stakingInfo.staked_amount)}
• Accrued Rewards: ${formatLODE(stakingInfo.accrued_rewards)}
• Last Updated: ${lastUpdated}

${poolInfo ? `*Pool Info:*
• Total Staked: ${formatLODE(poolInfo.totalStaked)}
• Reward Rate: ${poolInfo.rewardRate}% APY` : ''}

${stakingInfo.accrued_rewards > 0 ? '✨ You have rewards to claim!' : ''}
`.trim();
}
