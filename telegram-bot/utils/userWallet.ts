import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { getUserPrivateKey } from './userDatabase';
import { getConnection } from '../../src/utils/solana';
import { getSolBalance as getGlobalSolBalance, getOrbBalance as getGlobalOrbBalance } from '../../src/utils/wallet';
import { getConfig } from '../../src/utils/config';
import logger from '../../src/utils/logger';

/**
 * User Wallet Utilities
 *
 * Provides wallet operations for specific Telegram users
 */

/**
 * Generate a new Solana wallet
 * Returns the keypair, base58-encoded private key, and public key
 */
export function generateSolanaWallet(): {
  keypair: Keypair;
  privateKeyBase58: string;
  publicKey: string;
} {
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const publicKey = keypair.publicKey.toBase58();

  return { keypair, privateKeyBase58, publicKey };
}

/**
 * Get wallet keypair for a user
 */
export async function getUserWallet(telegramId: string): Promise<Keypair | null> {
  const privateKey = await getUserPrivateKey(telegramId);
  if (!privateKey) {
    logger.error(`[User Wallet] No private key returned for ${telegramId}`);
    return null;
  }

  try {
    // Support both base58 and array formats
    let secretKey: Uint8Array;

    if (privateKey.startsWith('[')) {
      // Array format: [1,2,3,...]
      const numbers = JSON.parse(privateKey);
      secretKey = new Uint8Array(numbers);
    } else {
      // Base58 format
      secretKey = bs58.decode(privateKey);
    }

    if (secretKey.length !== 64) {
      logger.error(`[User Wallet] Invalid secret key size: ${secretKey.length} bytes (expected 64)`);
      throw new Error(`Invalid private key format. Please provide a base58-encoded private key.`);
    }

    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    logger.error(`[User Wallet] Failed to load wallet for ${telegramId}:`, error);
    if (error instanceof Error) {
      logger.error(`[User Wallet] Error message: ${error.message}`);
    }
    return null;
  }
}

/**
 * Get SOL balance for a user's wallet
 */
export async function getUserSolBalance(telegramId: string): Promise<number> {
  const wallet = await getUserWallet(telegramId);
  if (!wallet) {
    return 0;
  }

  try {
    const connection = getConnection();
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / 1e9;
  } catch (error) {
    logger.error(`[User Wallet] Failed to get SOL balance for ${telegramId}:`, error);
    return 0;
  }
}

/**
 * Get ORB balance for a user's wallet
 */
export async function getUserOrbBalance(telegramId: string): Promise<number> {
  const wallet = await getUserWallet(telegramId);
  if (!wallet) {
    return 0;
  }

  try {
    // Get LODE token balance for user wallet
    const connection = getConnection();
    const config = getConfig();
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      { mint: config.lodeTokenMint } // LODE token mint
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    return parseFloat(balance.value.uiAmount?.toString() || '0');
  } catch (error) {
    logger.error(`[User Wallet] Failed to get LODE balance for ${telegramId}:`, error);
    return 0;
  }
}

/**
 * Get both SOL and ORB balances for a user
 */
export async function getUserBalances(telegramId: string): Promise<{
  sol: number;
  orb: number;
  solBalance?: number; // Legacy compatibility
  orbBalance?: number; // Legacy compatibility
}> {
  const [sol, orb] = await Promise.all([
    getUserSolBalance(telegramId),
    getUserOrbBalance(telegramId),
  ]);

  return {
    sol,
    orb,
    solBalance: sol, // Legacy compatibility
    orbBalance: orb, // Legacy compatibility
  };
}

/**
 * Validate a private key and return public key if valid
 */
export function validatePrivateKey(privateKey: string): { valid: boolean; publicKey?: string; error?: string } {
  try {
    let secretKey: Uint8Array;

    if (privateKey.startsWith('[')) {
      // Array format: [1,2,3,...]
      const numbers = JSON.parse(privateKey);
      if (!Array.isArray(numbers) || numbers.length !== 64) {
        return { valid: false, error: 'Invalid array format. Must be 64 numbers.' };
      }
      secretKey = new Uint8Array(numbers);
    } else {
      // Base58 format
      secretKey = bs58.decode(privateKey);
      if (secretKey.length !== 64) {
        return { valid: false, error: 'Invalid private key length. Must be 64 bytes.' };
      }
    }

    const keypair = Keypair.fromSecretKey(secretKey);
    return {
      valid: true,
      publicKey: keypair.publicKey.toBase58(),
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid private key format',
    };
  }
}
