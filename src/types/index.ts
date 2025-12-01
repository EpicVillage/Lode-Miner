import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

// Board account - tracks current round info
export interface Board {
  roundId: BN;      // Current round number
  startSlot: BN;    // When current round started
  endSlot: BN;      // When current round ends
}

// Round account - tracks game state for a round
export interface Round {
  deployed: BN[];       // Array of 25 u64 values (SOL deployed per square)
  motherlode: BN;       // LODE vault balance for this round
  totalDeployed: BN;    // Total SOL deployed across all squares
  totalWinnings: BN;    // Total winnings distributed
  totalStakeRewards: BN; // Total SOL to staking rewards
  totalVaulted: BN;     // Total SOL vaulted for buyback
  // Additional fields from the contract
  id: BN;               // Round ID
  expireSlot: BN;       // When the round expires
  slotHash: Buffer;     // Slot hash for randomness
  count: BN[];          // Count of miners per square
  rentPayer: PublicKey; // Rent payer for this round
  topMiner: PublicKey;  // Top miner of the round
  topMinerReward: BN;   // Top miner's bonus reward
}

// Miner account - tracks individual miner state
export interface Miner {
  authority: PublicKey;         // Account owner
  deployed: BN[];               // Array of 25 u64 values (your SOL in each square)
  cumulative: BN[];             // Array of 25 u64 values (cumulative SOL at time of deploy)
  roundId: BN;                  // Round you're currently in
  checkpointFee: BN;            // Reserve funds for checkpoint payments
  checkpointId: BN;             // Last round when checkpointing occurred
  lastClaimTokenAt: BN;         // Timestamp of last LODE claim
  lastClaimSolAt: BN;           // Timestamp of last SOL claim
  rewardsFactor: BN;            // Current rewards multiplier
  rewardsSol: BN;               // Claimable SOL amount
  rewardsToken: BN;             // Claimable LODE amount
  refinedToken: BN;             // LODE earned from claim fees
  lifetimeRewardsSol: BN;       // Total SOL earned
  lifetimeRewardsToken: BN;     // Total LODE earned
}

// Stake account - tracks staking info
// In Lode: stake LODE tokens, earn SOL rewards
export interface Stake {
  authority: PublicKey;     // Account owner
  balance: BN;              // Staked LODE amount
  lastClaimAt: BN;          // Timestamp of last claim
  lastDepositAt: BN;        // Timestamp of last deposit
  lastWithdrawAt: BN;       // Timestamp of last withdrawal
  rewardsFactor: Buffer;    // I80F48 rewards factor (16 bytes)
  rewards: BN;              // Claimable SOL from staking
  lifetimeRewards: BN;      // Total SOL earned from staking
  isSeeker: BN;             // Deprecated field
}

// Treasury account - global singleton for rewards
export interface Treasury {
  buybackBl: BN;              // SOL balance for buy-bury
  motherlodeBl: BN;           // LODE in the global rewards pool
  stakeRwBl: BN;              // SOL in stake rewards
  minerRewardsFactor: Buffer; // I80F48 miner rewards factor (16 bytes)
  stakeRewardsFactor: Buffer; // I80F48 stake rewards factor (16 bytes)
  totalStaked: BN;            // Current total staking deposits
  totalUnclaimed: BN;         // Unclaimed mining rewards
  totalRefined: BN;           // Refined mining rewards
}

// Referral account - tracks referral relationship (Lode-specific)
export interface Referral {
  authority: PublicKey;       // The referee who registered
  referrer: PublicKey;        // The referrer who referred this user
  pendingRewards: BN;         // Pending LODE rewards for referrer
  claimedRewards: BN;         // Total LODE already claimed
  createdAt: BN;              // Timestamp of creation
}

// Premine account - holds SOL during premine mode (Lode-specific)
export interface Premine {
  isEnabled: boolean;         // Premine mode flag
  totalCollected: BN;         // Total SOL collected
}

// Config account - program configuration
export interface LodeConfig {
  admin: PublicKey;           // Admin authority
  buryAuthority: PublicKey;   // Bury authority
  feeCollector: PublicKey;    // Fee collector
  swapProgram: PublicKey;     // Swap program
  varAddress: PublicKey;      // Entropy var address
  buffer: BN;                 // Buffer value
}

// Jupiter swap types
export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

export interface JupiterSwapResponse {
  swapTransaction: string;  // Base64 encoded transaction
  lastValidBlockHeight: number;
}

// Helper types
export interface DeploymentStrategy {
  type: 'all' | 'specific' | 'random';
  squares?: number[];  // For 'specific' strategy
}

export interface ClaimOptions {
  claimSol: boolean;
  claimToken: boolean;
  fromMining: boolean;
  fromStaking: boolean;
}

// Automation account structure
export interface Automation {
  amount: BN;           // SOL to deploy per territory per round
  authority: PublicKey; // Owner of the automation
  balance: BN;          // SOL balance left
  executor: PublicKey;  // Bot/service that executes
  fee: BN;              // Fee for executor
  strategy: BN;         // Deployment strategy
  mask: BN;             // Square mask for preferred strategy
}
