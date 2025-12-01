import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from './solana';
import { config } from './config';
import { Board, Round, Miner, Stake, Treasury, Referral, Premine, LodeConfig, Automation } from '../types';
import logger from './logger';

// PDA seeds (from Lode source code)
const BOARD_SEED = Buffer.from('board');
const ROUND_SEED = Buffer.from('round');
const MINER_SEED = Buffer.from('miner');
const STAKE_SEED = Buffer.from('stake');
const TREASURY_SEED = Buffer.from('treasury');
const AUTOMATION_SEED = Buffer.from('automation');
const CONFIG_SEED = Buffer.from('config');
const REFERRAL_SEED = Buffer.from('referral');
const PREMINE_SEED = Buffer.from('premine');

// Helper to deserialize u64 (8 bytes) as BN
function deserializeU64(buffer: Buffer, offset: number): BN {
  return new BN(buffer.slice(offset, offset + 8), 'le');
}

// Helper to deserialize an array of 25 u64 values
function deserializeU64Array25(buffer: Buffer, offset: number): BN[] {
  const array: BN[] = [];
  for (let i = 0; i < 25; i++) {
    array.push(deserializeU64(buffer, offset + i * 8));
  }
  return array;
}

// Helper to calculate accrued staking rewards from I80F48 reward factors
// Formula: (treasuryFactor - stakeFactor) * stakeBalance
// I80F48 has 48 fractional bits, so we need to shift right by 48 after multiplication
export function calculateAccruedStakingRewards(
  treasuryStakeRewardsFactor: Buffer,
  stakeRewardsFactor: Buffer,
  stakeBalance: BN
): BN {
  // Read 16-byte buffers as 128-bit little-endian integers
  const treasuryLow = treasuryStakeRewardsFactor.readBigUInt64LE(0);
  const treasuryHigh = treasuryStakeRewardsFactor.readBigUInt64LE(8);
  const treasuryFactor = (treasuryHigh << BigInt(64)) | treasuryLow;

  const stakeLow = stakeRewardsFactor.readBigUInt64LE(0);
  const stakeHigh = stakeRewardsFactor.readBigUInt64LE(8);
  const stakeFactor = (stakeHigh << BigInt(64)) | stakeLow;

  // Calculate difference in factors
  const factorDiff = treasuryFactor - stakeFactor;

  // Multiply by stake balance (which is in lamports, u64)
  const balanceBigInt = BigInt(stakeBalance.toString());
  const result = factorDiff * balanceBigInt;

  // I80F48 has 48 fractional bits, so shift right by 48 to get the integer part
  const accruedLamports = result >> BigInt(48);

  // Convert to BN and ensure non-negative
  return accruedLamports >= BigInt(0) ? new BN(accruedLamports.toString()) : new BN(0);
}

// Get Board PDA
export function getBoardPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BOARD_SEED],
    config.lodeProgramId
  );
}

// Get Round PDA for a specific round ID
export function getRoundPDA(roundId: BN): [PublicKey, number] {
  const roundIdBuffer = roundId.toArrayLike(Buffer, 'le', 8);
  return PublicKey.findProgramAddressSync(
    [ROUND_SEED, roundIdBuffer],
    config.lodeProgramId
  );
}

// Get Miner PDA for a specific authority
export function getMinerPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MINER_SEED, authority.toBuffer()],
    config.lodeProgramId
  );
}

// Get Stake PDA for a specific authority
export function getStakePDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STAKE_SEED, authority.toBuffer()],
    config.lodeProgramId
  );
}

// Get Treasury PDA (singleton)
export function getTreasuryPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TREASURY_SEED],
    config.lodeProgramId
  );
}

// Get Automation PDA for a specific authority
export function getAutomationPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AUTOMATION_SEED, authority.toBuffer()],
    config.lodeProgramId
  );
}

// Get Config PDA (singleton)
export function getConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    config.lodeProgramId
  );
}

// Get Referral PDA for a specific authority (Lode-specific)
export function getReferralPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REFERRAL_SEED, authority.toBuffer()],
    config.lodeProgramId
  );
}

// Get Premine PDA (singleton, Lode-specific)
export function getPreminePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PREMINE_SEED],
    config.lodeProgramId
  );
}

// Fetch entropy var address from Config account
export async function fetchEntropyVarAddress(): Promise<PublicKey> {
  const connection = getConnection();
  const [configPDA] = getConfigPDA();

  const accountInfo = await connection.getAccountInfo(configPDA);
  if (!accountInfo || accountInfo.data.length < 168) {
    throw new Error('Config account not found or invalid');
  }

  // Lode Config structure (from IDL):
  // - discriminator: 8 bytes (offset 0)
  // - admin: 32 bytes (offset 8)
  // - bury_authority: 32 bytes (offset 40)
  // - fee_collector: 32 bytes (offset 72)
  // - swap_program: 32 bytes (offset 104)
  // - var_address: 32 bytes (offset 136)
  // - buffer: 8 bytes (offset 168)
  const varAddress = new PublicKey(accountInfo.data.slice(136, 168));

  return varAddress;
}

// Check if automation account is initialized
export async function isAutomationInitialized(authority: PublicKey): Promise<boolean> {
  try {
    const connection = getConnection();
    const [automationPDA] = getAutomationPDA(authority);
    const accountInfo = await connection.getAccountInfo(automationPDA);
    return accountInfo !== null && accountInfo.data.length > 0;
  } catch (error) {
    logger.debug('Error checking automation account:', error);
    return false;
  }
}

// Check if referral account is initialized
export async function isReferralInitialized(authority: PublicKey): Promise<boolean> {
  try {
    const connection = getConnection();
    const [referralPDA] = getReferralPDA(authority);
    const accountInfo = await connection.getAccountInfo(referralPDA);
    return accountInfo !== null && accountInfo.data.length > 0;
  } catch (error) {
    logger.debug('Error checking referral account:', error);
    return false;
  }
}

// Fetch and deserialize Board account
export async function fetchBoard(): Promise<Board> {
  const connection = getConnection();
  const [boardPDA] = getBoardPDA();

  logger.debug(`Fetching Board account: ${boardPDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(boardPDA);
  if (!accountInfo) {
    throw new Error('Board account not found');
  }

  const data = accountInfo.data;

  // Parse Board structure (Anchor discriminator + fields)
  // Discriminator: 8 bytes
  // round_id: u64, start_slot: u64, end_slot: u64
  const board: Board = {
    roundId: deserializeU64(data, 8),
    startSlot: deserializeU64(data, 16),
    endSlot: deserializeU64(data, 24),
  };

  logger.debug(`Board: roundId=${board.roundId.toString()}, startSlot=${board.startSlot.toString()}, endSlot=${board.endSlot.toString()}`);

  return board;
}

// Fetch and deserialize Round account
export async function fetchRound(roundId: BN): Promise<Round> {
  const connection = getConnection();
  const [roundPDA] = getRoundPDA(roundId);

  logger.debug(`Fetching Round account: ${roundPDA.toBase58()} (roundId=${roundId.toString()})`);

  const accountInfo = await connection.getAccountInfo(roundPDA);
  if (!accountInfo) {
    throw new Error(`Round account not found for roundId ${roundId.toString()}`);
  }

  const data = accountInfo.data;

  // Parse Round structure (from Lode IDL)
  // pub struct Round {
  //   pub id: u64,                    // Offset 8
  //   pub deployed: [u64; 25],        // Offset 16-215 (200 bytes)
  //   pub slot_hash: [u8; 32],        // Offset 216-247 (32 bytes)
  //   pub count: [u64; 25],           // Offset 248-447 (200 bytes)
  //   pub expires_at: u64,            // Offset 448
  //   pub motherlode: u64,            // Offset 456
  //   pub rent_payer: Pubkey,         // Offset 464
  //   pub top_miner: Pubkey,          // Offset 496
  //   pub top_miner_reward: u64,      // Offset 528
  //   pub total_deployed: u64,        // Offset 536
  //   pub total_vaulted: u64,         // Offset 544
  //   pub total_stake_rewards: u64,   // Offset 552
  //   pub total_winnings: u64,        // Offset 560
  // }

  const round: Round = {
    id: deserializeU64(data, 8),
    deployed: deserializeU64Array25(data, 16),
    slotHash: data.slice(216, 248),
    count: deserializeU64Array25(data, 248),
    expireSlot: deserializeU64(data, 448),
    motherlode: deserializeU64(data, 456),
    rentPayer: new PublicKey(data.slice(464, 496)),
    topMiner: new PublicKey(data.slice(496, 528)),
    topMinerReward: deserializeU64(data, 528),
    totalDeployed: deserializeU64(data, 536),
    totalVaulted: deserializeU64(data, 544),
    totalStakeRewards: deserializeU64(data, 552),
    totalWinnings: deserializeU64(data, 560),
  };

  logger.debug(`Round ${round.id.toString()}: motherlode=${round.motherlode.toString()}, totalDeployed=${round.totalDeployed.toString()}`);

  return round;
}

// Fetch and deserialize Miner account
export async function fetchMiner(authority: PublicKey): Promise<Miner | null> {
  const connection = getConnection();
  const [minerPDA] = getMinerPDA(authority);

  logger.debug(`Fetching Miner account: ${minerPDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(minerPDA);
  if (!accountInfo) {
    logger.debug('Miner account not found (not initialized yet)');
    return null;
  }

  const data = accountInfo.data;

  // Parse Miner structure (from Lode IDL)
  // pub struct Miner {
  //   pub authority: Pubkey,              // Offset 8 (32 bytes)
  //   pub deployed: [u64; 25],            // Offset 40 (200 bytes)
  //   pub cumulative: [u64; 25],          // Offset 240 (200 bytes)
  //   pub checkpoint_fee: u64,            // Offset 440 (8 bytes)
  //   pub checkpoint_id: u64,             // Offset 448 (8 bytes)
  //   pub last_claim_token_at: i64,       // Offset 456 (8 bytes)
  //   pub last_claim_sol_at: i64,         // Offset 464 (8 bytes)
  //   pub rewards_factor: Numeric (i128), // Offset 472 (16 bytes)
  //   pub rewards_sol: u64,               // Offset 488 (8 bytes)
  //   pub rewards_token: u64,             // Offset 496 (8 bytes)
  //   pub refined_token: u64,             // Offset 504 (8 bytes)
  //   pub round_id: u64,                  // Offset 512 (8 bytes)
  //   pub lifetime_rewards_sol: u64,      // Offset 520 (8 bytes)
  //   pub lifetime_rewards_token: u64,    // Offset 528 (8 bytes)
  // }
  let offset = 8; // Skip discriminator

  const miner: Miner = {
    authority: new PublicKey(data.slice(offset, offset + 32)),
    deployed: deserializeU64Array25(data, offset + 32),
    cumulative: deserializeU64Array25(data, offset + 232),
    checkpointFee: deserializeU64(data, offset + 432),
    checkpointId: deserializeU64(data, offset + 440),
    lastClaimTokenAt: deserializeU64(data, offset + 448),
    lastClaimSolAt: deserializeU64(data, offset + 456),
    rewardsFactor: deserializeU64(data, offset + 464), // Just read first 8 bytes of Numeric
    rewardsSol: deserializeU64(data, offset + 480),
    rewardsToken: deserializeU64(data, offset + 488),
    refinedToken: deserializeU64(data, offset + 496),
    roundId: deserializeU64(data, offset + 504),
    lifetimeRewardsSol: deserializeU64(data, offset + 512),
    lifetimeRewardsToken: deserializeU64(data, offset + 520),
  };

  logger.debug(`Miner: roundId=${miner.roundId.toString()}, checkpointId=${miner.checkpointId.toString()}, rewardsSol=${miner.rewardsSol.toString()}, rewardsToken=${miner.rewardsToken.toString()}`);

  return miner;
}

// Fetch and deserialize Stake account
export async function fetchStake(authority: PublicKey): Promise<Stake | null> {
  const connection = getConnection();
  const [stakePDA] = getStakePDA(authority);

  logger.debug(`Fetching Stake account: ${stakePDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(stakePDA);
  if (!accountInfo) {
    logger.debug('Stake account not found (no staking yet)');
    return null;
  }

  const data = accountInfo.data;

  // Parse Stake structure (from Lode IDL)
  // pub struct Stake {
  //   pub authority: Pubkey,          // Offset 8 (32 bytes)
  //   pub balance: u64,               // Offset 40 (8 bytes)
  //   pub last_claim_at: i64,         // Offset 48 (8 bytes)
  //   pub last_deposit_at: i64,       // Offset 56 (8 bytes)
  //   pub last_withdraw_at: i64,      // Offset 64 (8 bytes)
  //   pub rewards_factor: Numeric,    // Offset 72 (16 bytes)
  //   pub rewards: u64,               // Offset 88 (8 bytes) - SOL rewards
  //   pub lifetime_rewards: u64,      // Offset 96 (8 bytes)
  //   pub is_seeker: u64,             // Offset 104 (8 bytes)
  // }
  let offset = 8; // Skip discriminator

  const stake: Stake = {
    authority: new PublicKey(data.slice(offset, offset + 32)),
    balance: deserializeU64(data, offset + 32),
    lastClaimAt: deserializeU64(data, offset + 40),
    lastDepositAt: deserializeU64(data, offset + 48),
    lastWithdrawAt: deserializeU64(data, offset + 56),
    rewardsFactor: data.slice(offset + 64, offset + 80),
    rewards: deserializeU64(data, offset + 80),
    lifetimeRewards: deserializeU64(data, offset + 88),
    isSeeker: deserializeU64(data, offset + 96),
  };

  logger.debug(`Stake: balance=${stake.balance.toString()}, claimable SOL=${stake.rewards.toString()}`);

  return stake;
}

// Fetch and deserialize Treasury account (global singleton)
export async function fetchTreasury(): Promise<Treasury> {
  const connection = getConnection();
  const [treasuryPDA] = getTreasuryPDA();

  logger.debug(`Fetching Treasury account: ${treasuryPDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(treasuryPDA);
  if (!accountInfo) {
    throw new Error('Treasury account not found');
  }

  const data = accountInfo.data;

  // Parse Treasury structure (from Lode IDL)
  // pub struct Treasury {
  //   pub buyback_bl: u64,                // Offset 8
  //   pub motherlode_bl: u64,             // Offset 16
  //   pub stake_rw_bl: u64,               // Offset 24
  //   pub miner_rewards_factor: Numeric,  // Offset 32 (16 bytes)
  //   pub stake_rewards_factor: Numeric,  // Offset 48 (16 bytes)
  //   pub total_staked: u64,              // Offset 64
  //   pub total_unclaimed: u64,           // Offset 72
  //   pub total_refined: u64,             // Offset 80
  // }

  const treasury: Treasury = {
    buybackBl: deserializeU64(data, 8),
    motherlodeBl: deserializeU64(data, 16),
    stakeRwBl: deserializeU64(data, 24),
    minerRewardsFactor: data.slice(32, 48),
    stakeRewardsFactor: data.slice(48, 64),
    totalStaked: deserializeU64(data, 64),
    totalUnclaimed: deserializeU64(data, 72),
    totalRefined: deserializeU64(data, 80),
  };

  logger.debug(`Treasury: motherlodeBl=${treasury.motherlodeBl.toString()}, totalStaked=${treasury.totalStaked.toString()}`);

  return treasury;
}

// Fetch and deserialize Referral account (Lode-specific)
export async function fetchReferral(authority: PublicKey): Promise<Referral | null> {
  const connection = getConnection();
  const [referralPDA] = getReferralPDA(authority);

  logger.debug(`Fetching Referral account: ${referralPDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(referralPDA);
  if (!accountInfo) {
    logger.debug('Referral account not found (not registered yet)');
    return null;
  }

  const data = accountInfo.data;

  // Parse Referral structure (from Lode IDL)
  // pub struct Referral {
  //   pub authority: Pubkey,          // Offset 8 (32 bytes)
  //   pub referrer: Pubkey,           // Offset 40 (32 bytes)
  //   pub pending_rewards: u64,       // Offset 72 (8 bytes)
  //   pub claimed_rewards: u64,       // Offset 80 (8 bytes)
  //   pub created_at: i64,            // Offset 88 (8 bytes)
  // }
  let offset = 8;

  const referral: Referral = {
    authority: new PublicKey(data.slice(offset, offset + 32)),
    referrer: new PublicKey(data.slice(offset + 32, offset + 64)),
    pendingRewards: deserializeU64(data, offset + 64),
    claimedRewards: deserializeU64(data, offset + 72),
    createdAt: deserializeU64(data, offset + 80),
  };

  logger.debug(`Referral: referrer=${referral.referrer.toBase58()}, pendingRewards=${referral.pendingRewards.toString()}`);

  return referral;
}

// Fetch and deserialize Premine account (Lode-specific)
export async function fetchPremine(): Promise<Premine | null> {
  const connection = getConnection();
  const [preminePDA] = getPreminePDA();

  logger.debug(`Fetching Premine account: ${preminePDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(preminePDA);
  if (!accountInfo) {
    logger.debug('Premine account not found');
    return null;
  }

  const data = accountInfo.data;

  // Parse Premine structure (from Lode IDL)
  // pub struct Premine {
  //   pub is_enabled: bool,           // Offset 8 (1 byte)
  //   pub total_collected: u64,       // Offset 9 (8 bytes)
  // }
  const premine: Premine = {
    isEnabled: data[8] === 1,
    totalCollected: deserializeU64(data, 9),
  };

  logger.debug(`Premine: isEnabled=${premine.isEnabled}, totalCollected=${premine.totalCollected.toString()}`);

  return premine;
}

// Fetch and deserialize Automation account
export async function fetchAutomation(authority: PublicKey): Promise<Automation | null> {
  const connection = getConnection();
  const [automationPDA] = getAutomationPDA(authority);

  logger.debug(`Fetching Automation account: ${automationPDA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(automationPDA);
  if (!accountInfo) {
    logger.debug('Automation account not found');
    return null;
  }

  const data = accountInfo.data;

  // Parse Automation structure (from Lode IDL)
  // pub struct Automation {
  //   pub amount: u64,               // Offset 8
  //   pub authority: Pubkey,         // Offset 16
  //   pub balance: u64,              // Offset 48
  //   pub executor: Pubkey,          // Offset 56
  //   pub fee: u64,                  // Offset 88
  //   pub strategy: u64,             // Offset 96
  //   pub mask: u64,                 // Offset 104
  // }
  const automation: Automation = {
    amount: deserializeU64(data, 8),
    authority: new PublicKey(data.slice(16, 48)),
    balance: deserializeU64(data, 48),
    executor: new PublicKey(data.slice(56, 88)),
    fee: deserializeU64(data, 88),
    strategy: deserializeU64(data, 96),
    mask: deserializeU64(data, 104),
  };

  logger.debug(`Automation: amount=${automation.amount.toString()}, balance=${automation.balance.toString()}`);

  return automation;
}

export default {
  getBoardPDA,
  getRoundPDA,
  getMinerPDA,
  getStakePDA,
  getTreasuryPDA,
  getAutomationPDA,
  getConfigPDA,
  getReferralPDA,
  getPreminePDA,
  fetchBoard,
  fetchRound,
  fetchMiner,
  fetchStake,
  fetchTreasury,
  fetchReferral,
  fetchPremine,
  fetchAutomation,
};
