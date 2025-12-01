import { runQuery, getQuery, allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { formatSOL, formatORB, formatUSD, formatPercent } from './formatters';

/**
 * User-specific PnL calculation and tracking
 * Calculates profit/loss for individual telegram users
 */

/**
 * Initialize user_balance_history table
 */
export async function initializeUserBalanceHistoryTable(): Promise<void> {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS user_balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      sol_balance REAL DEFAULT 0,
      orb_balance REAL DEFAULT 0,
      orb_price_usd REAL DEFAULT 0,
      portfolio_value_usd REAL DEFAULT 0,
      automation_sol REAL DEFAULT 0,
      claimable_sol REAL DEFAULT 0,
      claimable_orb REAL DEFAULT 0,
      staked_orb REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  // Create index for faster queries
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_balance_history_telegram_id ON user_balance_history(telegram_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_balance_history_timestamp ON user_balance_history(timestamp)`);

  logger.info('[Telegram DB] User balance history table initialized');
}

export interface UserPnLSummary {
  // Income (what you earned)
  totalOrbEarned: number;
  totalOrbClaimed: number;
  totalSolClaimed: number;
  totalSwappedOrb: number;
  totalSwappedSol: number;

  // Expenses (what you spent)
  totalSolDeployed: number;
  totalFeesPaid: number;
  totalProtocolFees: number;
  totalTxFees: number;

  // Current Holdings
  currentOrbBalance: number;
  currentSolBalance: number;
  currentAutomationBalance: number;
  claimableSol: number;
  claimableOrb: number;

  // Profit Calculation
  netSolPnl: number;
  netOrbPnl: number;
  totalPnlSol: number;
  totalPnlUsd: number;
  roiPercent: number;

  // Stats
  roundsParticipated: number;
  totalTransactions: number;
  successfulTransactions: number;
  successRate: number;

  // Prices
  avgOrbPriceUsd: number;
  currentOrbPriceUsd: number;
}

/**
 * Calculate comprehensive PnL for a user
 */
export async function calculateUserPnL(
  telegramId: string,
  publicKey: string,
  currentOrbBalance: number,
  currentSolBalance: number,
  currentAutomationBalance: number,
  claimableSol: number,
  claimableOrb: number,
  currentOrbPriceUsd: number
): Promise<UserPnLSummary> {
  // Get transaction summary for this user
  const txSummary = await getQuery<{
    total_deployed: number;
    total_claimed_sol: number;
    total_claimed_orb: number;
    total_swapped_orb: number;
    total_swapped_sol: number;
    total_fees: number;
    total_protocol_fees: number;
    total_tx_fees: number;
    total_orb_earned: number;
  }>(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'automation_setup' THEN sol_amount WHEN type = 'automation_close' THEN -sol_amount ELSE 0 END), 0) as total_deployed,
      COALESCE(SUM(CASE WHEN type = 'claim_sol' THEN sol_amount ELSE 0 END), 0) as total_claimed_sol,
      COALESCE(SUM(CASE WHEN type = 'claim_orb' THEN orb_amount ELSE 0 END), 0) as total_claimed_orb,
      COALESCE(SUM(CASE WHEN type = 'swap' THEN orb_amount ELSE 0 END), 0) as total_swapped_orb,
      COALESCE(SUM(CASE WHEN type = 'swap' THEN sol_amount ELSE 0 END), 0) as total_swapped_sol,
      COALESCE(SUM(tx_fee_sol), 0) as total_tx_fees,
      COALESCE(SUM(protocol_fee_sol), 0) as total_protocol_fees,
      COALESCE(SUM(CASE WHEN type IN ('deploy', 'claim_sol', 'claim_orb', 'mine') THEN orb_amount ELSE 0 END), 0) as total_orb_earned
    FROM transactions
    WHERE (wallet_address = ? OR wallet_address IS NULL) AND status = 'success'
  `, [publicKey]);

  // Get rounds participated count
  const roundsCount = await getQuery<{ count: number }>(`
    SELECT COUNT(*) as count FROM user_rounds WHERE telegram_id = ?
  `, [telegramId]);

  // Get transaction counts
  const txCounts = await getQuery<{
    total: number;
    successful: number;
  }>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful
    FROM transactions
    WHERE wallet_address = ? OR wallet_address IS NULL
  `, [publicKey]);

  // Get average ORB price from transactions
  const avgPrice = await getQuery<{ avg_price: number }>(`
    SELECT AVG(orb_price_usd) as avg_price
    FROM transactions
    WHERE (wallet_address = ? OR wallet_address IS NULL) AND orb_price_usd > 0
  `, [publicKey]);

  const totalSolDeployed = txSummary?.total_deployed || 0;
  const totalClaimedSol = txSummary?.total_claimed_sol || 0;
  const totalClaimedOrb = txSummary?.total_claimed_orb || 0;
  const totalSwappedOrb = txSummary?.total_swapped_orb || 0;
  const totalSwappedSol = txSummary?.total_swapped_sol || 0;
  const totalTxFees = txSummary?.total_tx_fees || 0;
  const totalProtocolFees = txSummary?.total_protocol_fees || 0;
  const totalOrbEarned = txSummary?.total_orb_earned || 0;
  const totalFeesPaid = totalTxFees + totalProtocolFees;

  const roundsParticipated = roundsCount?.count || 0;
  const totalTransactions = txCounts?.total || 0;
  const successfulTransactions = txCounts?.successful || 0;
  const successRate = totalTransactions > 0 ? (successfulTransactions / totalTransactions) * 100 : 0;
  const avgOrbPriceUsd = avgPrice?.avg_price || currentOrbPriceUsd;

  // Calculate net ORB balance (earned - swapped)
  const netOrbPnl = totalClaimedOrb - totalSwappedOrb;

  // Calculate net SOL PnL (claimed + swapped + automation balance - deployed - fees)
  const totalSolReceived = totalClaimedSol + totalSwappedSol + currentAutomationBalance + claimableSol;
  const netSolPnl = totalSolReceived - totalSolDeployed - totalFeesPaid;

  // Total current holdings value in SOL
  const currentOrbValue = (currentOrbBalance + claimableOrb) * (currentOrbPriceUsd / 100); // Rough conversion
  const totalPnlSol = netSolPnl + currentOrbValue;

  // Total PnL in USD
  const totalPnlUsd = (netSolPnl * 100) + ((currentOrbBalance + claimableOrb) * currentOrbPriceUsd);

  // Calculate ROI
  let roiPercent = 0;
  if (totalSolDeployed > 0) {
    const totalCurrentValue = currentSolBalance + currentAutomationBalance + claimableSol + currentOrbValue;
    roiPercent = ((totalCurrentValue - totalSolDeployed) / totalSolDeployed) * 100;
  }

  return {
    // Income
    totalOrbEarned,
    totalOrbClaimed: totalClaimedOrb,
    totalSolClaimed: totalClaimedSol,
    totalSwappedOrb,
    totalSwappedSol,

    // Expenses
    totalSolDeployed,
    totalFeesPaid,
    totalProtocolFees,
    totalTxFees,

    // Current Holdings
    currentOrbBalance,
    currentSolBalance,
    currentAutomationBalance,
    claimableSol,
    claimableOrb,

    // Profit
    netSolPnl,
    netOrbPnl,
    totalPnlSol,
    totalPnlUsd,
    roiPercent,

    // Stats
    roundsParticipated,
    totalTransactions,
    successfulTransactions,
    successRate,

    // Prices
    avgOrbPriceUsd,
    currentOrbPriceUsd,
  };
}

/**
 * Format PnL summary for display
 */
export function formatPnLDisplay(pnl: UserPnLSummary): string {
  const profitEmoji = pnl.netSolPnl >= 0 ? '📈' : '📉';
  const roiEmoji = pnl.roiPercent >= 0 ? '✅' : '❌';

  return `
💰 *Profit & Loss Summary*

${profitEmoji} *Net P/L:* ${formatSOL(pnl.netSolPnl)} (${formatPercent(pnl.roiPercent)})
${roiEmoji} *ROI:* ${formatPercent(pnl.roiPercent)}

*📊 Income Breakdown:*
• LODE Earned: ${formatORB(pnl.totalOrbEarned)}
• LODE Claimed: ${formatORB(pnl.totalOrbClaimed)}
• SOL from Mining: ${formatSOL(pnl.totalSolClaimed)}
• SOL from Swaps: ${formatSOL(pnl.totalSwappedSol)}
• LODE Swapped: ${formatORB(pnl.totalSwappedOrb)}

*💸 Expense Breakdown:*
• Total Deployed: ${formatSOL(pnl.totalSolDeployed)}
• Total Fees: ${formatSOL(pnl.totalFeesPaid)}
  - Protocol Fees: ${formatSOL(pnl.totalProtocolFees)}
  - Transaction Fees: ${formatSOL(pnl.totalTxFees)}

*💼 Current Holdings:*
• Wallet SOL: ${formatSOL(pnl.currentSolBalance)}
• Wallet LODE: ${formatORB(pnl.currentOrbBalance)}
• Automation SOL: ${formatSOL(pnl.currentAutomationBalance)}
• Claimable SOL: ${formatSOL(pnl.claimableSol)}
• Claimable LODE: ${formatORB(pnl.claimableOrb)}
• LODE Value: ${formatUSD(pnl.currentOrbBalance * pnl.currentOrbPriceUsd)}

*📈 Performance:*
• Rounds Participated: ${pnl.roundsParticipated}
• Total Transactions: ${pnl.totalTransactions}
• Success Rate: ${formatPercent(pnl.successRate)}
• Avg LODE Price: ${formatUSD(pnl.avgOrbPriceUsd)}
`.trim();
}

/**
 * Record balance snapshot for historical tracking
 */
export async function recordUserBalanceSnapshot(
  telegramId: string,
  solBalance: number,
  orbBalance: number,
  orbPriceUsd: number,
  automationSol: number = 0,
  claimableSol: number = 0,
  claimableOrb: number = 0,
  stakedOrb: number = 0
): Promise<void> {
  const portfolioValueUsd = (solBalance * 100) + (orbBalance * orbPriceUsd) + (automationSol * 100) + (claimableSol * 100) + (claimableOrb * orbPriceUsd) + (stakedOrb * orbPriceUsd);

  await allQuery(`
    INSERT INTO user_balance_history (
      telegram_id, timestamp, sol_balance, orb_balance, orb_price_usd, portfolio_value_usd,
      automation_sol, claimable_sol, claimable_orb, staked_orb
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [telegramId, Date.now(), solBalance, orbBalance, orbPriceUsd, portfolioValueUsd, automationSol, claimableSol, claimableOrb, stakedOrb]);

  logger.debug(`[User PnL] Recorded balance snapshot for ${telegramId}`);
}

/**
 * Get balance history for a user
 */
export async function getUserBalanceHistory(
  telegramId: string,
  limit: number = 100
): Promise<any[]> {
  return allQuery(`
    SELECT * FROM user_balance_history
    WHERE telegram_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `, [telegramId, limit]);
}
