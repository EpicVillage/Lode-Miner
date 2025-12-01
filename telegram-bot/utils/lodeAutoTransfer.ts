import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getUserWallet } from './userWallet';
import { getUserSettings } from './userSettings';
import { getConnection } from '../../src/utils/solana';
import { recordTransaction } from '../../src/utils/database';
import { sendNotification } from './notifications';
import logger from '../../src/utils/logger';
import { config, LODE_MULTIPLIER } from '../../src/utils/config';

/**
 * LODE Auto-Transfer Utility
 *
 * Automatically transfers LODE tokens when balance reaches threshold
 */

export interface TransferResult {
  transferred: boolean;
  amount?: number;
  signature?: string;
  error?: string;
  reason?: string;
}

/**
 * Validate Solana wallet address
 */
export function validateRecipientAddress(address: string): { valid: boolean; error?: string } {
  if (!address || address.trim() === '') {
    return { valid: false, error: 'Address cannot be empty' };
  }

  try {
    const pubkey = new PublicKey(address);

    // Check if it's a valid base58 address (32 bytes)
    if (pubkey.toBytes().length !== 32) {
      return { valid: false, error: 'Invalid address format' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid Solana address format' };
  }
}

/**
 * Get current LODE balance for a user
 */
async function getUserLodeBalance(telegramId: string): Promise<number> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return 0;
    }

    const connection = getConnection();
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      { mint: config.lodeTokenMint }
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    return parseFloat(balance.value.uiAmount?.toString() || '0');
  } catch (error) {
    logger.error(`[Auto-Transfer] Failed to get LODE balance for ${telegramId}:`, error);
    return 0;
  }
}

/**
 * Transfer LODE tokens to recipient address
 */
async function transferLode(
  telegramId: string,
  recipientAddress: string,
  amount: number
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const wallet = await getUserWallet(telegramId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const connection = getConnection();
    const recipient = new PublicKey(recipientAddress);

    // Get source token account
    const sourceTokenAccount = await getAssociatedTokenAddress(
      config.lodeTokenMint,
      wallet.publicKey
    );

    // Get or create destination token account
    const destinationTokenAccount = await getAssociatedTokenAddress(
      config.lodeTokenMint,
      recipient
    );

    // Check if destination account exists
    const destinationAccountInfo = await connection.getAccountInfo(destinationTokenAccount);

    const transaction = new Transaction();

    // If destination account doesn't exist, we need to create it
    // Note: In production, you might want to use createAssociatedTokenAccountInstruction
    // For simplicity, we'll assume the recipient has a LODE token account

    // Create transfer instruction
    const transferInstruction = createTransferInstruction(
      sourceTokenAccount,
      destinationTokenAccount,
      wallet.publicKey,
      Math.floor(amount * LODE_MULTIPLIER), // Convert to LODE base units (11 decimals)
      [],
      TOKEN_PROGRAM_ID
    );

    transaction.add(transferInstruction);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    // Sign and send transaction
    transaction.sign(wallet);
    const signature = await connection.sendRawTransaction(transaction.serialize());

    // Confirm transaction
    await connection.confirmTransaction(signature, 'confirmed');

    logger.info(`[Auto-Transfer] Transferred ${amount} LODE to ${recipientAddress} for ${telegramId}`);

    return { success: true, signature };
  } catch (error: any) {
    logger.error(`[Auto-Transfer] Transfer failed for ${telegramId}:`, error);
    return { success: false, error: error.message || 'Transfer failed' };
  }
}

/**
 * Check if auto-transfer conditions are met and execute if needed
 */
export async function checkAndExecuteLodeTransfer(telegramId: string): Promise<TransferResult> {
  try {
    // Get user settings
    const settings = await getUserSettings(telegramId);

    // Check if auto-transfer is enabled
    if (!settings.auto_transfer_enabled) {
      return {
        transferred: false,
        reason: 'Auto-transfer is disabled'
      };
    }

    // Check if recipient address is set
    if (!settings.transfer_recipient_address) {
      return {
        transferred: false,
        reason: 'No recipient address configured'
      };
    }

    // Validate recipient address
    const validation = validateRecipientAddress(settings.transfer_recipient_address);
    if (!validation.valid) {
      return {
        transferred: false,
        error: `Invalid recipient address: ${validation.error}`
      };
    }

    // Get current LODE balance
    const currentBalance = await getUserLodeBalance(telegramId);

    // Check if balance meets threshold (using orb_transfer_threshold for backwards compat)
    if (currentBalance < settings.orb_transfer_threshold) {
      return {
        transferred: false,
        reason: `Balance (${currentBalance.toFixed(2)} LODE) below threshold (${settings.orb_transfer_threshold} LODE)`
      };
    }

    // Calculate amount to transfer (all LODE above 0 to clear the balance)
    const transferAmount = currentBalance;

    // Execute transfer
    const transferResult = await transferLode(
      telegramId,
      settings.transfer_recipient_address,
      transferAmount
    );

    if (!transferResult.success) {
      // Notify user of failure
      const { NotificationType } = await import('./notifications');
      await sendNotification(
        telegramId,
        NotificationType.TRANSACTION_FAILED,
        '❌ Auto-Transfer Failed',
        `Failed to transfer ${transferAmount.toFixed(2)} LODE\n\nError: ${transferResult.error}`
      );

      return {
        transferred: false,
        error: transferResult.error
      };
    }

    // Record transaction
    const wallet = await getUserWallet(telegramId);
    await recordTransaction({
      type: 'swap',
      signature: transferResult.signature!,
      orbAmount: transferAmount,
      status: 'success',
      notes: `Auto-transfer ${transferAmount.toFixed(2)} LODE to ${settings.transfer_recipient_address} for user ${telegramId}`,
      walletAddress: wallet?.publicKey.toBase58(),
      telegramId,
    });

    // Notify user of success
    const { NotificationType } = await import('./notifications');
    await sendNotification(
      telegramId,
      NotificationType.TRANSACTION_SUCCESS,
      '✅ Auto-Transfer Completed',
      `Transferred ${transferAmount.toFixed(2)} LODE to:\n\`${settings.transfer_recipient_address}\`\n\nSignature: \`${transferResult.signature}\``
    );

    logger.info(`[Auto-Transfer] Successfully transferred ${transferAmount} LODE for ${telegramId}`);

    return {
      transferred: true,
      amount: transferAmount,
      signature: transferResult.signature
    };
  } catch (error: any) {
    logger.error(`[Auto-Transfer] Check failed for ${telegramId}:`, error);
    return {
      transferred: false,
      error: error.message || 'Unknown error'
    };
  }
}

// Backwards compatibility alias
export const checkAndExecuteOrbTransfer = checkAndExecuteLodeTransfer;

/**
 * Manually trigger auto-transfer check (for testing or manual execution)
 */
export async function manualTriggerTransfer(telegramId: string): Promise<TransferResult> {
  logger.info(`[Auto-Transfer] Manual trigger for ${telegramId}`);
  return await checkAndExecuteLodeTransfer(telegramId);
}

/**
 * Get auto-transfer status for display
 */
export async function getAutoTransferStatus(telegramId: string): Promise<{
  enabled: boolean;
  threshold: number;
  recipientAddress: string | null;
  currentBalance: number;
  willTransfer: boolean;
}> {
  const settings = await getUserSettings(telegramId);
  const currentBalance = await getUserLodeBalance(telegramId);

  const willTransfer = !!(
    settings.auto_transfer_enabled &&
    settings.transfer_recipient_address &&
    validateRecipientAddress(settings.transfer_recipient_address).valid &&
    currentBalance >= settings.orb_transfer_threshold
  );

  return {
    enabled: settings.auto_transfer_enabled,
    threshold: settings.orb_transfer_threshold,
    recipientAddress: settings.transfer_recipient_address,
    currentBalance,
    willTransfer
  };
}
