import { runQuery, getQuery, allQuery } from '../../src/utils/database';
import logger from '../../src/utils/logger';
import { formatLODE, formatSOL, formatTimestamp } from './formatters';
import { UserRound as SharedUserRound } from '../../shared/database/rounds';
import { LODE_MULTIPLIER } from '../../src/utils/config';

/**
 * User-specific rounds tracking for telegram bot users
 * Tracks participation in mining rounds
 */

/**
 * Initialize user_rounds table
 */
export async function initializeUserRoundsTable(): Promise<void> {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS user_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      motherlode REAL DEFAULT 0,
      deployed_sol REAL DEFAULT 0,
      squares_deployed INTEGER DEFAULT 0,
      deployed_squares TEXT DEFAULT '[]',
      winning_square INTEGER DEFAULT -1,
      hit INTEGER DEFAULT 0,
      won INTEGER DEFAULT 0,
      rewards_claimed REAL DEFAULT 0,
      orb_rewards REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      UNIQUE(telegram_id, round_id)
    )
  `);

  // Create indexes for faster queries
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_rounds_telegram_id ON user_rounds(telegram_id)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_rounds_round_id ON user_rounds(round_id)`);

  // Migration: Add new columns to existing tables
  const migrations = [
    `ALTER TABLE user_rounds ADD COLUMN deployed_squares TEXT DEFAULT '[]'`,
    `ALTER TABLE user_rounds ADD COLUMN winning_square INTEGER DEFAULT -1`,
    `ALTER TABLE user_rounds ADD COLUMN hit INTEGER DEFAULT 0`,
  ];

  for (const sql of migrations) {
    try {
      await runQuery(sql);
    } catch (error: any) {
      // Ignore duplicate column errors
      if (!error.message?.includes('duplicate column')) {
        throw error;
      }
    }
  }

  logger.info('[Telegram DB] User rounds table initialized');
}

export interface DeployedSquare {
  square: number;
  amount: number; // SOL amount
}

export interface UserRound {
  id: number;
  telegram_id: string;
  round_id: number;
  timestamp: number;
  motherlode: number;
  deployed_sol: number;
  squares_deployed: number;
  deployed_squares: DeployedSquare[];
  winning_square: number;
  hit: boolean;
  won: boolean;
  rewards_claimed: number;
  orb_rewards: number;
  created_at: number;
}

/**
 * Record user participation in a round
 */
export async function recordUserRound(
  telegramId: string,
  roundId: number,
  motherlode: number,
  deployedSol: number,
  squaresDeployed: number,
  deployedSquares: DeployedSquare[] = []
): Promise<void> {
  const deployedSquaresJson = JSON.stringify(deployedSquares);

  await runQuery(`
    INSERT INTO user_rounds (
      telegram_id, round_id, timestamp, motherlode, deployed_sol, squares_deployed, deployed_squares
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, round_id) DO UPDATE SET
      motherlode = excluded.motherlode,
      deployed_sol = user_rounds.deployed_sol + excluded.deployed_sol,
      squares_deployed = excluded.squares_deployed,
      deployed_squares = excluded.deployed_squares
  `, [telegramId, roundId, Date.now(), motherlode, deployedSol, squaresDeployed, deployedSquaresJson]);

  logger.debug(`[User Rounds] Recorded round ${roundId} for ${telegramId}: ${deployedSol} SOL deployed to ${squaresDeployed} squares`);
}

/**
 * Update round result with winning square and hit status
 */
export async function updateRoundResult(
  telegramId: string,
  roundId: number,
  winningSquare: number
): Promise<void> {
  // First get the deployed squares for this user's round
  const userRound = await getUserRound(telegramId, roundId);
  if (!userRound) {
    logger.debug(`[User Rounds] No round record found for ${telegramId} round ${roundId}`);
    return;
  }

  // Check if user hit the winning square
  const hit = userRound.deployed_squares.some(ds => ds.square === winningSquare);

  await runQuery(`
    UPDATE user_rounds
    SET winning_square = ?, hit = ?
    WHERE telegram_id = ? AND round_id = ?
  `, [winningSquare, hit ? 1 : 0, telegramId, roundId]);

  logger.debug(`[User Rounds] Updated round ${roundId} for ${telegramId}: winning=${winningSquare}, hit=${hit}`);
}

/**
 * Update all pending rounds with winning square (batch update after round ends)
 */
export async function updateAllRoundsResult(
  roundId: number,
  winningSquare: number
): Promise<void> {
  // Get all user rounds for this round that don't have winning_square set
  const pendingRounds = await allQuery<any>(`
    SELECT telegram_id, deployed_squares FROM user_rounds
    WHERE round_id = ? AND winning_square = -1
  `, [roundId]);

  for (const row of pendingRounds) {
    const deployedSquares: DeployedSquare[] = JSON.parse(row.deployed_squares || '[]');
    const hit = deployedSquares.some(ds => ds.square === winningSquare);

    await runQuery(`
      UPDATE user_rounds
      SET winning_square = ?, hit = ?
      WHERE telegram_id = ? AND round_id = ?
    `, [winningSquare, hit ? 1 : 0, row.telegram_id, roundId]);
  }

  logger.info(`[User Rounds] Updated ${pendingRounds.length} user rounds for round ${roundId} with winning square ${winningSquare}`);
}

/**
 * Update round win status and rewards
 */
export async function updateUserRoundRewards(
  telegramId: string,
  roundId: number,
  won: boolean,
  rewardsClaimed: number,
  orbRewards: number
): Promise<void> {
  await runQuery(`
    UPDATE user_rounds
    SET won = ?, rewards_claimed = ?, orb_rewards = ?
    WHERE telegram_id = ? AND round_id = ?
  `, [won ? 1 : 0, rewardsClaimed, orbRewards, telegramId, roundId]);

  logger.debug(`[User Rounds] Updated round ${roundId} rewards for ${telegramId}: ${rewardsClaimed} SOL, ${orbRewards} LODE`);
}

/**
 * Get user's recent rounds
 */
export async function getUserRecentRounds(
  telegramId: string,
  limit: number = 10
): Promise<UserRound[]> {
  const rows = await allQuery<any>(`
    SELECT * FROM user_rounds
    WHERE telegram_id = ?
    ORDER BY round_id DESC
    LIMIT ?
  `, [telegramId, limit]);

  return rows.map(convertRoundFromDb);
}

/**
 * Get user's round statistics
 */
export async function getUserRoundStats(telegramId: string): Promise<{
  totalRounds: number;
  totalDeployed: number;
  totalWins: number;
  totalRewardsSol: number;
  totalRewardsOrb: number;
  winRate: number;
  avgDeployment: number;
  avgMotherlode: number;
}> {
  const stats = await getQuery<{
    total_rounds: number;
    total_deployed: number;
    total_wins: number;
    total_rewards_sol: number;
    total_rewards_orb: number;
    avg_deployment: number;
    avg_motherlode: number;
  }>(`
    SELECT
      COUNT(*) as total_rounds,
      COALESCE(SUM(deployed_sol), 0) as total_deployed,
      COALESCE(SUM(won), 0) as total_wins,
      COALESCE(SUM(rewards_claimed), 0) as total_rewards_sol,
      COALESCE(SUM(orb_rewards), 0) as total_rewards_orb,
      COALESCE(AVG(deployed_sol), 0) as avg_deployment,
      COALESCE(AVG(motherlode), 0) as avg_motherlode
    FROM user_rounds
    WHERE telegram_id = ?
  `, [telegramId]);

  const totalRounds = stats?.total_rounds || 0;
  const totalWins = stats?.total_wins || 0;
  const winRate = totalRounds > 0 ? (totalWins / totalRounds) * 100 : 0;

  return {
    totalRounds,
    totalDeployed: stats?.total_deployed || 0,
    totalWins,
    totalRewardsSol: stats?.total_rewards_sol || 0,
    totalRewardsOrb: stats?.total_rewards_orb || 0,
    winRate,
    avgDeployment: stats?.avg_deployment || 0,
    avgMotherlode: stats?.avg_motherlode || 0,
  };
}

/**
 * Get specific round info for user
 */
export async function getUserRound(
  telegramId: string,
  roundId: number
): Promise<UserRound | null> {
  const row = await getQuery<any>(`
    SELECT * FROM user_rounds
    WHERE telegram_id = ? AND round_id = ?
  `, [telegramId, roundId]);

  return row ? convertRoundFromDb(row) : null;
}

/**
 * Convert database row to UserRound object
 */
function convertRoundFromDb(row: any): UserRound {
  let deployedSquares: DeployedSquare[] = [];
  try {
    deployedSquares = JSON.parse(row.deployed_squares || '[]');
  } catch {
    deployedSquares = [];
  }

  return {
    id: row.id,
    telegram_id: row.telegram_id,
    round_id: row.round_id,
    timestamp: row.timestamp,
    motherlode: row.motherlode,
    deployed_sol: row.deployed_sol,
    squares_deployed: row.squares_deployed,
    deployed_squares: deployedSquares,
    winning_square: row.winning_square ?? -1,
    hit: row.hit === 1,
    won: row.won === 1,
    rewards_claimed: row.rewards_claimed,
    orb_rewards: row.orb_rewards,
    created_at: row.created_at,
  };
}

/**
 * Format recent rounds for display
 * Accepts both local UserRound and SharedUserRound types
 */
export function formatRecentRoundsDisplay(rounds: (UserRound | SharedUserRound)[]): string {
  if (rounds.length === 0) {
    return `📜 *Recent Rounds*\n\nNo rounds participated yet.`;
  }

  const roundsList = rounds.map((round, index) => {
    // Determine status emoji and text
    let statusEmoji = '⏳';
    let statusText = 'Pending';

    if (round.winning_square >= 0) {
      if (round.hit) {
        statusEmoji = '✅';
        statusText = 'HIT';
      } else {
        statusEmoji = '❌';
        statusText = 'MISSED';
      }
    }

    // Format deployed squares
    let squaresInfo = '';
    if (round.deployed_squares.length > 0) {
      const squareNums = round.deployed_squares.map(ds => ds.square + 1).join(', ');
      squaresInfo = `Sq: ${squareNums}`;
    }

    // Winning square info
    let winningInfo = '';
    if (round.winning_square >= 0) {
      winningInfo = ` → Won: ${round.winning_square + 1}`;
    }

    // Rewards if any
    const rewards = round.rewards_claimed > 0 || round.orb_rewards > 0
      ? `\n   💰 +${formatSOL(round.rewards_claimed)} +${formatLODE(round.orb_rewards)}`
      : '';

    return `${statusEmoji} *#${round.round_id}* ${statusText}
   ${formatSOL(round.deployed_sol)} deployed${squaresInfo ? ` (${squaresInfo})` : ''}${winningInfo}${rewards}`;
  }).join('\n\n');

  return `📜 *Recent Rounds*\n\n${roundsList}`;
}

/**
 * Format round stats for display
 */
export function formatRoundStatsDisplay(stats: {
  totalRounds: number;
  totalDeployed: number;
  totalWins: number;
  totalRewardsSol: number;
  totalRewardsOrb: number;
  winRate: number;
  avgDeployment: number;
  avgMotherlode: number;
}): string {
  return `
📊 *Round Statistics*

*Overall Performance:*
• Total Rounds: ${stats.totalRounds}
• Total Deployed: ${formatSOL(stats.totalDeployed)}
• Total Wins: ${stats.totalWins}
• Win Rate: ${stats.winRate.toFixed(1)}%

*Rewards Earned:*
• SOL Rewards: ${formatSOL(stats.totalRewardsSol)}
• LODE Rewards: ${formatLODE(stats.totalRewardsOrb)}

*Averages:*
• Avg Deployment: ${formatSOL(stats.avgDeployment)}
• Avg Motherlode: ${formatLODE(stats.avgMotherlode)}
`.trim();
}

/**
 * Calculate winning square from round's slotHash
 * The winning square is determined by the first byte of the sample mod 25
 */
export function calculateWinningSquare(slotHash: Buffer): number {
  if (!slotHash || slotHash.length < 1) {
    return -1;
  }
  return slotHash[0] % 25;
}

/**
 * Get user's deployed squares from Miner account on-chain
 */
export async function getUserDeployedSquares(telegramId: string): Promise<DeployedSquare[]> {
  try {
    const { getUserWallet } = await import('./userWallet');
    const { fetchMiner } = await import('../../src/utils/accounts');

    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return [];
    }

    const miner = await fetchMiner(wallet.publicKey);
    if (!miner) {
      return [];
    }

    // Convert deployed array to DeployedSquare objects
    const deployedSquares: DeployedSquare[] = [];
    for (let i = 0; i < 25; i++) {
      const amount = Number(miner.deployed[i]) / 1e9; // Convert lamports to SOL
      if (amount > 0) {
        deployedSquares.push({ square: i, amount });
      }
    }

    return deployedSquares;
  } catch (error) {
    logger.error('[User Rounds] Failed to get deployed squares:', error);
    return [];
  }
}

/**
 * Get winning square for a specific round from on-chain data
 */
export async function getRoundWinningSquare(roundId: number): Promise<number> {
  try {
    const { fetchRound } = await import('../../src/utils/accounts');
    const BN = (await import('bn.js')).default;

    const round = await fetchRound(new BN(roundId));
    return calculateWinningSquare(round.slotHash);
  } catch (error) {
    logger.error(`[User Rounds] Failed to get winning square for round ${roundId}:`, error);
    return -1;
  }
}

/**
 * Get current round info from blockchain
 */
export async function getCurrentRoundInfo(): Promise<{
  roundId: number;
  motherlode: number;
  prizePool: number;
  timeRemaining: number;
  participants: number;
} | null> {
  try {
    const { fetchBoard, fetchRound } = await import('../../src/utils/accounts');

    // Fetch board to get current round ID
    const board = await fetchBoard();
    const roundId = Number(board.roundId);

    // Fetch round details to get motherload
    const round = await fetchRound(board.roundId);
    const motherlode = Number(round.motherlode) / LODE_MULTIPLIER;

    // Prize pool is the total LODE in the round
    const prizePool = motherlode;

    // Calculate time remaining (rounds are ~60 seconds)
    // This is approximate since we don't have exact timestamp
    const timeRemaining = 0; // TODO: Calculate based on block time

    // Participants count (if available from round data)
    const participants = 0; // TODO: Extract from round data if available

    logger.debug(`[User Rounds] Current round ${roundId}, motherload: ${motherlode.toFixed(2)} LODE`);

    return {
      roundId,
      motherlode,
      prizePool,
      timeRemaining,
      participants,
    };
  } catch (error) {
    logger.error('[User Rounds] Failed to get current round info:', error);
    return null;
  }
}

/**
 * Format current round info for display
 */
export function formatCurrentRoundDisplay(roundInfo: {
  roundId: number;
  motherlode: number;
  prizePool: number;
  timeRemaining: number;
  participants: number;
} | null): string {
  if (!roundInfo) {
    return `
🎯 *Current Round*

Unable to fetch current round information.
`.trim();
  }

  const timeRemainingStr = roundInfo.timeRemaining > 0
    ? `${Math.floor(roundInfo.timeRemaining / 60)}m ${roundInfo.timeRemaining % 60}s`
    : 'Round ended';

  return `
🎯 *Current Round #${roundInfo.roundId}*

*Prize Pool:* ${formatLODE(roundInfo.prizePool)}
*Motherlode:* ${formatLODE(roundInfo.motherlode)}
*Participants:* ${roundInfo.participants}
*Time Remaining:* ${timeRemainingStr}
`.trim();
}
