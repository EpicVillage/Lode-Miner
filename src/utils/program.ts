import {
  SystemProgram,
  TransactionInstruction,
  Transaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  Keypair,
  SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import BN from 'bn.js';
import { config, LODE_MULTIPLIER } from './config';
import { getWallet } from './wallet';
import { getConnection } from './solana';
import { getMinerPDA, getStakePDA, getAutomationPDA, getBoardPDA, getRoundPDA, getReferralPDA, getTreasuryPDA, getPreminePDA, getConfigPDA, fetchEntropyVarAddress } from './accounts';
import logger from './logger';
import { retry } from './retry';
import { buildComputeBudgetInstructions, COMPUTE_UNIT_LIMITS, parseFeeLevel } from './feeEstimation';

// Lode instruction discriminators (Anchor 8-byte format)
const DISCRIMINATORS = {
  DEPLOY: Buffer.from([67, 36, 143, 118, 36, 164, 92, 217]),
  AUTOMATE: Buffer.from([84, 106, 174, 94, 7, 64, 22, 130]),
  CANCEL_AUTOMATE: Buffer.from([247, 104, 181, 222, 216, 159, 79, 180]),
  CHECKPOINT: Buffer.from([213, 200, 19, 204, 240, 143, 184, 252]),
  CLAIM_SOL: Buffer.from([139, 113, 179, 189, 190, 30, 132, 195]),
  CLAIM_TOKEN: Buffer.from([116, 206, 27, 191, 166, 19, 0, 73]),
  REGISTER_REFERRAL: Buffer.from([158, 196, 134, 102, 193, 102, 184, 86]),
  STAKE_DEPOSIT: Buffer.from([75, 168, 115, 239, 194, 115, 22, 98]),
  STAKE_WITHDRAW: Buffer.from([199, 13, 168, 20, 92, 151, 29, 56]),
  STAKE_CLAIM: Buffer.from([206, 208, 31, 82, 213, 249, 175, 1]),
};

// Entropy program ID (used for randomness in Lode)
const ENTROPY_PROGRAM_ID = new PublicKey('3jSkUuYBoJzQPMEzTvkDFXCZUBksPamrVhrnHR9igu2X');

// Dev fee configuration
const DEV_FEE_WALLET = new PublicKey('9LGAtUrQx8u3YXF5traoUtFBN3w62bgqohLc1Npkh3Yq');
const DEV_FEE_BPS = 100; // 1% (100 basis points)

// Automation strategies
export enum AutomationStrategy {
  Random = 0,    // Deploys to random squares
  Preferred = 1, // Deploys to specific squares based on mask
}

// Build development fee transfer instruction (1% of deployment amount)
export function buildDevFeeTransferInstruction(deploymentAmount: number, walletPublicKey?: PublicKey): TransactionInstruction | null {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;

  // Skip dev fee if the wallet IS the dev fee wallet (no self-payment)
  if (signerPublicKey.equals(DEV_FEE_WALLET)) {
    logger.debug('Skipping dev fee (wallet is dev fee wallet)');
    return null;
  }

  // Calculate fee (1% = 100 basis points)
  const feeLamports = Math.floor((deploymentAmount * LAMPORTS_PER_SOL * DEV_FEE_BPS) / 10000);

  logger.debug(`Dev fee: ${feeLamports} lamports (${feeLamports / LAMPORTS_PER_SOL} SOL) for ${deploymentAmount} SOL deployment`);

  return SystemProgram.transfer({
    fromPubkey: signerPublicKey,
    toPubkey: DEV_FEE_WALLET,
    lamports: feeLamports,
  });
}

// Build Register Referral instruction (required before first deploy in Lode)
export function buildRegisterReferralInstruction(
  referrerAddress: PublicKey,
  walletPublicKey?: PublicKey
): TransactionInstruction {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [referralPDA] = getReferralPDA(signerPublicKey);

  // Build instruction data: 8-byte discriminator only
  const data = Buffer.alloc(8);
  DISCRIMINATORS.REGISTER_REFERRAL.copy(data, 0);

  // Account keys (4 accounts from IDL):
  // 0. authority - signer, writable
  // 1. referrer - the address of who referred this user
  // 2. referral - Referral PDA, writable
  // 3. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: referrerAddress, isSigner: false, isWritable: false },
    { pubkey: referralPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Deploy instruction for Lode
export async function buildDeployInstruction(
  amount: number,
  squares: number = 25,
  walletPublicKey?: PublicKey
): Promise<TransactionInstruction[]> {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [minerPDA] = getMinerPDA(signerPublicKey);
  const [automationPDA] = getAutomationPDA(signerPublicKey);
  const [boardPDA] = getBoardPDA();
  const [referralPDA] = getReferralPDA(signerPublicKey);
  const [configPDA] = getConfigPDA();

  // Get current board to get round info
  const { fetchBoard } = await import('./accounts');
  const board = await fetchBoard();
  const [roundPDA] = getRoundPDA(board.roundId);

  // Get entropy var address from config
  const entropyVarAddress = await fetchEntropyVarAddress();

  // Convert SOL amount to lamports
  const amountLamports = new BN(amount * LAMPORTS_PER_SOL);

  // Build instruction data (8 + 8 + 4 = 20 bytes):
  // - 8 bytes: discriminator
  // - 8 bytes: amount (u64 LE)
  // - 4 bytes: squares (u32 LE)
  const data = Buffer.alloc(20);
  DISCRIMINATORS.DEPLOY.copy(data, 0);
  amountLamports.toArrayLike(Buffer, 'le', 8).copy(data, 8);
  data.writeUInt32LE(squares, 16);

  logger.debug(`Deploy instruction: amount=${amount} SOL (${amountLamports.toString()} lamports), squares=${squares}`);

  // Account keys (11 accounts from IDL):
  // 0. signer - writable, signer
  // 1. authority - writable
  // 2. config - Config PDA
  // 3. automation - Automation PDA (optional, writable)
  // 4. board - Board PDA, writable
  // 5. miner - Miner PDA, writable
  // 6. round - Round PDA, writable
  // 7. entropy_var - writable
  // 8. entropy_program
  // 9. referral - Referral PDA
  // 10. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: signerPublicKey, isSigner: false, isWritable: true },
    { pubkey: configPDA, isSigner: false, isWritable: false },
    { pubkey: automationPDA, isSigner: false, isWritable: true },
    { pubkey: boardPDA, isSigner: false, isWritable: true },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: roundPDA, isSigner: false, isWritable: true },
    { pubkey: entropyVarAddress, isSigner: false, isWritable: true },
    { pubkey: ENTROPY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: referralPDA, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const deployInstruction = new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });

  // Build dev fee transfer instruction
  const feeInstruction = buildDevFeeTransferInstruction(amount, signerPublicKey);

  if (feeInstruction) {
    return [feeInstruction, deployInstruction];
  } else {
    return [deployInstruction];
  }
}

// Build Automate instruction (setup automated mining)
export function buildAutomateInstruction(
  amountPerSquare: number,
  deposit: number,
  feePerExecution: number,
  strategy: AutomationStrategy = AutomationStrategy.Random,
  squareMask: bigint = BigInt(25),
  executor?: PublicKey,
  walletPublicKey?: PublicKey
): TransactionInstruction {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [minerPDA] = getMinerPDA(signerPublicKey);
  const [automationPDA] = getAutomationPDA(signerPublicKey);
  const [referralPDA] = getReferralPDA(signerPublicKey);
  const executorKey = executor || signerPublicKey;

  // Build instruction data (8 + 8 + 8 + 8 + 8 + 1 = 41 bytes):
  // - 8 bytes: discriminator
  // - 8 bytes: amount (u64 LE, in lamports)
  // - 8 bytes: deposit (u64 LE, in lamports)
  // - 8 bytes: fee (u64 LE, in lamports)
  // - 8 bytes: mask (u64 LE)
  // - 1 byte: strategy (u8)
  const data = Buffer.alloc(41);
  let offset = 0;

  DISCRIMINATORS.AUTOMATE.copy(data, offset);
  offset += 8;

  const amountLamports = BigInt(Math.floor(amountPerSquare * LAMPORTS_PER_SOL));
  data.writeBigUInt64LE(amountLamports, offset);
  offset += 8;

  const depositLamports = BigInt(Math.floor(deposit * LAMPORTS_PER_SOL));
  data.writeBigUInt64LE(depositLamports, offset);
  offset += 8;

  const feeLamports = BigInt(Math.floor(feePerExecution * LAMPORTS_PER_SOL));
  data.writeBigUInt64LE(feeLamports, offset);
  offset += 8;

  data.writeBigUInt64LE(squareMask, offset);
  offset += 8;

  data.writeUInt8(strategy, offset);

  // Account keys (6 accounts from IDL):
  // 0. authority - signer, writable
  // 1. automation - Automation PDA, writable
  // 2. executor
  // 3. referral - Referral PDA
  // 4. miner - Miner PDA, writable
  // 5. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: automationPDA, isSigner: false, isWritable: true },
    { pubkey: executorKey, isSigner: false, isWritable: false },
    { pubkey: referralPDA, isSigner: false, isWritable: false },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Cancel Automate instruction
export function buildCancelAutomateInstruction(walletPublicKey?: PublicKey): TransactionInstruction {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [automationPDA] = getAutomationPDA(signerPublicKey);

  const data = Buffer.alloc(8);
  DISCRIMINATORS.CANCEL_AUTOMATE.copy(data, 0);

  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: automationPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Checkpoint instruction
export async function buildCheckpointInstruction(roundId?: BN, walletPublicKey?: PublicKey): Promise<TransactionInstruction> {
  const connection = getConnection();
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [boardPDA] = getBoardPDA();
  const [minerPDA] = getMinerPDA(signerPublicKey);
  const [treasuryPDA] = getTreasuryPDA();
  const [referralPDA] = getReferralPDA(signerPublicKey);

  // Get miner to determine which round to checkpoint
  let checkpointRoundId: BN;
  if (roundId) {
    checkpointRoundId = roundId;
  } else {
    const minerAccount = await connection.getAccountInfo(minerPDA);
    if (minerAccount && minerAccount.data.length >= 520) {
      // Read miner's round_id from the account
      const minerRoundId = minerAccount.data.readBigUInt64LE(512);
      checkpointRoundId = new BN(minerRoundId.toString());
      logger.debug(`Miner round_id: ${checkpointRoundId.toString()}`);
    } else {
      const { fetchBoard } = await import('./accounts');
      const board = await fetchBoard();
      checkpointRoundId = board.roundId.subn(1);
    }
  }

  const [roundPDA] = getRoundPDA(checkpointRoundId);

  const data = Buffer.alloc(8);
  DISCRIMINATORS.CHECKPOINT.copy(data, 0);

  logger.debug(`Building checkpoint for round ${checkpointRoundId.toString()}`);

  // Account keys (6 accounts from IDL):
  // 0. signer - writable, signer
  // 1. board - Board PDA
  // 2. miner - Miner PDA, writable
  // 3. round - Round PDA, writable
  // 4. treasury - Treasury PDA, writable
  // 5. referral - Referral PDA, writable
  // 6. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: boardPDA, isSigner: false, isWritable: false },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: roundPDA, isSigner: false, isWritable: true },
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },
    { pubkey: referralPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Claim SOL instruction
export function buildClaimSolInstruction(walletPublicKey?: PublicKey): TransactionInstruction {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [minerPDA] = getMinerPDA(signerPublicKey);

  const data = Buffer.alloc(8);
  DISCRIMINATORS.CLAIM_SOL.copy(data, 0);

  // Account keys (3 accounts from IDL):
  // 0. authority - signer, writable
  // 1. miner - Miner PDA, writable
  // 2. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Claim Token (LODE) instruction
export async function buildClaimTokenInstruction(walletPublicKey?: PublicKey): Promise<TransactionInstruction> {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [minerPDA] = getMinerPDA(signerPublicKey);
  const [treasuryPDA] = getTreasuryPDA();
  const [preminePDA] = getPreminePDA();
  const [configPDA] = getConfigPDA();

  // Get token accounts
  const walletLodeAta = await getAssociatedTokenAddress(config.lodeTokenMint, signerPublicKey);
  const treasuryLodeAta = await getAssociatedTokenAddress(config.lodeTokenMint, treasuryPDA, true);

  const data = Buffer.alloc(8);
  DISCRIMINATORS.CLAIM_TOKEN.copy(data, 0);

  // Account keys (11 accounts - verified from on-chain successful tx):
  // 0. authority - signer, writable
  // 1. miner - Miner PDA, writable
  // 2. treasury - Treasury PDA, writable
  // 3. config - Config PDA (verified position)
  // 4. premine - Premine PDA, writable
  // 5. mint - LODE token mint, writable
  // 6. treasury_tokens - Treasury's LODE ATA, writable
  // 7. recipient - Wallet's LODE ATA, writable
  // 8. token_program
  // 9. associated_token_program
  // 10. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },
    { pubkey: configPDA, isSigner: false, isWritable: false },
    { pubkey: preminePDA, isSigner: false, isWritable: true },
    { pubkey: config.lodeTokenMint, isSigner: false, isWritable: true },
    { pubkey: treasuryLodeAta, isSigner: false, isWritable: true },
    { pubkey: walletLodeAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Stake Deposit instruction (stake LODE tokens)
export async function buildStakeDepositInstruction(amount: number, walletPublicKey?: PublicKey): Promise<TransactionInstruction> {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [stakePDA] = getStakePDA(signerPublicKey);
  const [treasuryPDA] = getTreasuryPDA();

  // Get token accounts
  const senderLodeAta = await getAssociatedTokenAddress(config.lodeTokenMint, signerPublicKey);
  const stakeLodeAta = await getAssociatedTokenAddress(config.lodeTokenMint, stakePDA, true);

  // Convert amount to LODE base units (11 decimals)
  const amountLamports = new BN(amount * LODE_MULTIPLIER);

  // Build instruction data (8 + 8 = 16 bytes)
  const data = Buffer.alloc(16);
  DISCRIMINATORS.STAKE_DEPOSIT.copy(data, 0);
  amountLamports.toArrayLike(Buffer, 'le', 8).copy(data, 8);

  // Account keys (10 accounts from IDL):
  // 0. signer - writable, signer
  // 1. stake - Stake PDA, writable
  // 2. treasury - Treasury PDA, writable
  // 3. mint - LODE mint
  // 4. sender_tokens - Signer's LODE ATA, writable
  // 5. stake_tokens - Stake's LODE ATA, writable
  // 6. clock
  // 7. token_program
  // 8. associated_token_program
  // 9. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: stakePDA, isSigner: false, isWritable: true },
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },
    { pubkey: config.lodeTokenMint, isSigner: false, isWritable: false },
    { pubkey: senderLodeAta, isSigner: false, isWritable: true },
    { pubkey: stakeLodeAta, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Stake Withdraw instruction (withdraw LODE tokens)
export async function buildStakeWithdrawInstruction(amount: number, walletPublicKey?: PublicKey): Promise<TransactionInstruction> {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [stakePDA] = getStakePDA(signerPublicKey);
  const [treasuryPDA] = getTreasuryPDA();

  // Get token accounts
  const senderLodeAta = await getAssociatedTokenAddress(config.lodeTokenMint, signerPublicKey);
  const stakeLodeAta = await getAssociatedTokenAddress(config.lodeTokenMint, stakePDA, true);

  // Convert amount to LODE base units (11 decimals)
  const amountLamports = new BN(amount * LODE_MULTIPLIER);

  // Build instruction data (8 + 8 = 16 bytes)
  const data = Buffer.alloc(16);
  DISCRIMINATORS.STAKE_WITHDRAW.copy(data, 0);
  amountLamports.toArrayLike(Buffer, 'le', 8).copy(data, 8);

  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: stakePDA, isSigner: false, isWritable: true },
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },
    { pubkey: config.lodeTokenMint, isSigner: false, isWritable: false },
    { pubkey: senderLodeAta, isSigner: false, isWritable: true },
    { pubkey: stakeLodeAta, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Stake Claim instruction (claim SOL rewards from staking)
export function buildStakeClaimInstruction(walletPublicKey?: PublicKey): TransactionInstruction {
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [stakePDA] = getStakePDA(signerPublicKey);
  const [treasuryPDA] = getTreasuryPDA();

  const data = Buffer.alloc(8);
  DISCRIMINATORS.STAKE_CLAIM.copy(data, 0);

  // Account keys (5 accounts from IDL):
  // 0. signer - writable, signer
  // 1. stake - Stake PDA, writable
  // 2. treasury - Treasury PDA, writable
  // 3. recipient - where SOL goes, writable
  // 4. clock
  // 5. system_program
  const keys = [
    { pubkey: signerPublicKey, isSigner: true, isWritable: true },
    { pubkey: stakePDA, isSigner: false, isWritable: true },
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },
    { pubkey: signerPublicKey, isSigner: false, isWritable: true }, // recipient = signer
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.lodeProgramId,
    data,
  });
}

// Build Execute Automation instruction (for bot execution)
export async function buildExecuteAutomationInstruction(walletPublicKey?: PublicKey): Promise<TransactionInstruction[]> {
  // In Lode, execute automation uses the same deploy instruction
  // but the automation PDA handles the amount/squares
  const connection = getConnection();
  const signerPublicKey = walletPublicKey || getWallet().publicKey;
  const [automationPDA] = getAutomationPDA(signerPublicKey);

  // Fetch automation account to get the configured amount
  const automationAccount = await connection.getAccountInfo(automationPDA);
  if (!automationAccount || automationAccount.data.length < 112) {
    throw new Error('Automation account not found or invalid');
  }

  // Read amount per square from automation account (offset 8, u64 LE)
  const amountPerSquare = automationAccount.data.readBigUInt64LE(8);
  // Read mask (number of squares) from automation account (offset 104, u64 LE)
  const mask = automationAccount.data.readBigUInt64LE(104);

  const amountSol = Number(amountPerSquare) / LAMPORTS_PER_SOL;
  const squares = Number(mask);

  logger.debug(`Execute automation: ${amountSol} SOL x ${squares} squares`);

  // Use the deploy instruction with automation parameters
  return buildDeployInstruction(amountSol * squares, squares, signerPublicKey);
}

// Send and confirm transaction with retries and dynamic fee estimation
export async function sendAndConfirmTransaction(
  instructions: TransactionInstruction[],
  context: string,
  options?: {
    computeUnitLimit?: number;
    accounts?: PublicKey[];
    wallet?: Keypair;
  }
): Promise<{ signature: string; fee: number }> {
  const connection = getConnection();
  const wallet = options?.wallet || getWallet();

  return await retry(
    async () => {
      // Determine compute unit limit based on context
      let computeUnitLimit = options?.computeUnitLimit;
      if (!computeUnitLimit) {
        if (context.includes('Deploy') || context.includes('Automation')) {
          computeUnitLimit = COMPUTE_UNIT_LIMITS.DEPLOY;
        } else if (context.includes('Claim SOL')) {
          computeUnitLimit = COMPUTE_UNIT_LIMITS.CLAIM_SOL;
        } else if (context.includes('Claim') && context.includes('Token')) {
          computeUnitLimit = COMPUTE_UNIT_LIMITS.CLAIM_LODE;
        } else if (context.includes('Stake')) {
          computeUnitLimit = COMPUTE_UNIT_LIMITS.STAKE;
        } else if (context.includes('Checkpoint')) {
          computeUnitLimit = COMPUTE_UNIT_LIMITS.CHECKPOINT;
        } else {
          computeUnitLimit = 200000;
        }
      }

      const accounts = options?.accounts || extractAccountsFromInstructions(instructions);

      const feeLevel = parseFeeLevel(config.priorityFeeLevel);
      const computeBudgetIxs = await buildComputeBudgetInstructions(
        connection,
        accounts,
        feeLevel,
        computeUnitLimit
      );

      const transaction = new Transaction();
      computeBudgetIxs.forEach(ix => transaction.add(ix));
      instructions.forEach(ix => transaction.add(ix));

      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;

      transaction.sign(wallet);

      // Simulate first
      try {
        const simulation = await connection.simulateTransaction(transaction);
        if (simulation.value.err) {
          logger.error(`${context}: Simulation failed with error:`, simulation.value.err);
          const logs = simulation.value.logs || [];
          if (logs.length > 0) {
            logger.error(`${context}: Simulation logs:`);
            logs.forEach(log => logger.error(`  ${log}`));
          }
          const logsStr = logs.join(' | ');
          throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)} | Logs: ${logsStr}`);
        }
      } catch (simError: any) {
        logger.error(`${context}: Simulation error:`, simError.message);
        throw simError;
      }

      let signature: string;
      try {
        signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
      } catch (error: any) {
        logger.error(`${context}: Transaction send failed`);
        if (error.logs) {
          logger.error(`${context}: Error logs:`, error.logs);
        }
        if (error.message) {
          logger.error(`${context}: Error message:`, error.message);
        }
        throw error;
      }

      logger.debug(`${context}: Transaction sent: ${signature}`);

      await connection.confirmTransaction(signature, 'confirmed');

      logger.debug(`${context}: Transaction confirmed: ${signature}`);

      let actualFee = 0;
      try {
        const txDetails = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (txDetails && txDetails.meta) {
          actualFee = txDetails.meta.fee / 1e9;
          logger.debug(`${context}: Actual fee paid: ${actualFee.toFixed(6)} SOL`);
        }
      } catch (error) {
        logger.warn(`${context}: Failed to fetch transaction fee:`, error);
      }

      return { signature, fee: actualFee };
    },
    {
      maxRetries: config.deployMaxRetries,
      shouldRetry: (error: Error) => {
        const errorMsg = String(error.message || error);
        const isAlreadyProcessed = errorMsg.includes('AlreadyProcessed');
        const isCheckpoint = context.includes('Checkpoint');

        if (isCheckpoint && isAlreadyProcessed) {
          return false;
        }

        return true;
      },
    },
    context
  );
}

// Helper: Extract unique writable accounts from instructions for fee estimation
function extractAccountsFromInstructions(instructions: TransactionInstruction[]): PublicKey[] {
  const accountSet = new Set<string>();

  instructions.forEach(ix => {
    ix.keys.forEach(key => {
      if (key.isWritable) {
        accountSet.add(key.pubkey.toBase58());
      }
    });
  });

  return Array.from(accountSet).map(addr => new PublicKey(addr));
}

export default {
  buildDevFeeTransferInstruction,
  buildRegisterReferralInstruction,
  buildDeployInstruction,
  buildAutomateInstruction,
  buildCancelAutomateInstruction,
  buildCheckpointInstruction,
  buildClaimSolInstruction,
  buildClaimTokenInstruction,
  buildStakeDepositInstruction,
  buildStakeWithdrawInstruction,
  buildStakeClaimInstruction,
  buildExecuteAutomationInstruction,
  sendAndConfirmTransaction,
};
