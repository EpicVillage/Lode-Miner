import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getConnection } from '../../src/utils/solana';
import bs58 from 'bs58';
import logger from '../../src/utils/logger';
import {
  Platform,
  getUser,
  saveUser,
  getUserPrivateKey,
  getLinkedAccount
} from './users';

// LODE token mint address (previously ORB)
const LODE_MINT = new PublicKey('CXBVSveFCtdih8mhVWtyrLcyPvpzNejCARHYhCzhLode');
// Backwards compatibility alias
const ORB_MINT = LODE_MINT;

/**
 * Shared Wallet Operations
 *
 * Platform-agnostic wallet management for all supported platforms
 */

export interface WalletBalances {
  sol: number;
  orb: number;
  publicKey: string;
}

/**
 * Generate a new Solana wallet
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
 * Validate a private key string
 */
export function validatePrivateKey(privateKeyString: string): {
  valid: boolean;
  keypair?: Keypair;
  publicKey?: string;
  error?: string;
} {
  try {
    // Try to decode the private key
    let secretKey: Uint8Array;

    // Check if it's base58 encoded
    if (privateKeyString.length === 88 || privateKeyString.length === 87) {
      secretKey = bs58.decode(privateKeyString);
    }
    // Check if it's a JSON array
    else if (privateKeyString.startsWith('[')) {
      const parsed = JSON.parse(privateKeyString);
      if (!Array.isArray(parsed) || parsed.length !== 64) {
        return { valid: false, error: 'Invalid private key format' };
      }
      secretKey = Uint8Array.from(parsed);
    }
    // Check if it's hex encoded
    else if (/^[0-9a-fA-F]+$/.test(privateKeyString) && privateKeyString.length === 128) {
      secretKey = Uint8Array.from(Buffer.from(privateKeyString, 'hex'));
    }
    else {
      return { valid: false, error: 'Unrecognized private key format' };
    }

    // Verify it's 64 bytes
    if (secretKey.length !== 64) {
      return { valid: false, error: 'Private key must be 64 bytes' };
    }

    // Create keypair and verify
    const keypair = Keypair.fromSecretKey(secretKey);
    const publicKey = keypair.publicKey.toBase58();

    return { valid: true, keypair, publicKey };
  } catch (error: any) {
    return { valid: false, error: error.message || 'Invalid private key' };
  }
}

/**
 * Get wallet for a user (returns Keypair)
 */
export async function getUserWallet(platform: Platform, platformId: string): Promise<Keypair | null> {
  // First check if this account is linked and should use the other platform's wallet
  const linked = await getLinkedAccount(platform, platformId);

  // If linked and this is Discord, use the Telegram wallet (Telegram is primary)
  if (linked?.linked_at && platform === 'discord' && linked.telegram_id) {
    const telegramKey = await getUserPrivateKey('telegram', linked.telegram_id);
    if (telegramKey) {
      const result = validatePrivateKey(telegramKey);
      return result.keypair || null;
    }
  }

  // Otherwise get this platform's wallet
  const privateKey = await getUserPrivateKey(platform, platformId);
  if (!privateKey) return null;

  const result = validatePrivateKey(privateKey);
  return result.keypair || null;
}

/**
 * Get user's wallet balances
 */
export async function getUserBalances(platform: Platform, platformId: string): Promise<WalletBalances | null> {
  const wallet = await getUserWallet(platform, platformId);
  if (!wallet) return null;

  try {
    const connection = getConnection();
    const publicKey = wallet.publicKey;

    // Fetch SOL balance
    const solBalance = await connection.getBalance(publicKey);
    const sol = solBalance / LAMPORTS_PER_SOL;

    // Fetch LODE balance
    let orb = 0;
    try {
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        publicKey,
        { mint: ORB_MINT }
      );
      if (tokenAccounts.value.length > 0) {
        const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        orb = parseFloat(balance.value.uiAmount?.toString() || '0');
      }
    } catch (tokenError) {
      logger.debug(`[Shared Wallet] No LODE token account for ${platform}:${platformId}`);
    }

    return {
      sol,
      orb,
      publicKey: publicKey.toBase58(),
    };
  } catch (error) {
    logger.error(`[Shared Wallet] Failed to get balances for ${platform}:${platformId}:`, error);
    return null;
  }
}

/**
 * Register a new wallet for a user
 */
export async function registerWallet(
  platform: Platform,
  platformId: string,
  privateKey: string,
  username?: string
): Promise<{ success: boolean; publicKey?: string; error?: string }> {
  const validation = validatePrivateKey(privateKey);

  if (!validation.valid || !validation.keypair) {
    return { success: false, error: validation.error || 'Invalid private key' };
  }

  // Convert to base58 for consistent storage
  const privateKeyBase58 = bs58.encode(validation.keypair.secretKey);

  await saveUser(platform, platformId, privateKeyBase58, validation.publicKey!, username);

  return { success: true, publicKey: validation.publicKey };
}

/**
 * Generate and register a new wallet for a user
 */
export async function generateAndRegisterWallet(
  platform: Platform,
  platformId: string,
  username?: string
): Promise<{ success: boolean; publicKey?: string; privateKey?: string; error?: string }> {
  try {
    const { keypair, privateKeyBase58, publicKey } = generateSolanaWallet();

    await saveUser(platform, platformId, privateKeyBase58, publicKey, username);

    return { success: true, publicKey, privateKey: privateKeyBase58 };
  } catch (error: any) {
    logger.error(`[Shared Wallet] Failed to generate wallet for ${platform}:${platformId}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Check if user has a wallet
 */
export async function hasWallet(platform: Platform, platformId: string): Promise<boolean> {
  const user = await getUser(platform, platformId);
  return user !== null;
}

/**
 * Get user's public key
 */
export async function getUserPublicKey(platform: Platform, platformId: string): Promise<string | null> {
  // Check for linked account first
  const linked = await getLinkedAccount(platform, platformId);
  if (linked?.linked_at && platform === 'discord' && linked.telegram_id) {
    const telegramUser = await getUser('telegram', linked.telegram_id);
    return telegramUser?.public_key || null;
  }

  const user = await getUser(platform, platformId);
  return user?.public_key || null;
}
