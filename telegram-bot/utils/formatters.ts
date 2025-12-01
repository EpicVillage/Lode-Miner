/**
 * Message formatting utilities for Telegram bot
 */

export function formatSOL(amount: number): string {
  return `${amount.toFixed(4)} SOL`;
}

export function formatLODE(amount: number): string {
  return `${amount.toFixed(2)} LODE`;
}

// Alias for backwards compatibility
export const formatORB = formatLODE;

export function formatUSD(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatPercent(percent: number): string {
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(2)}%`;
}

export function formatStatus(status: string): string {
  const statusEmojis: Record<string, string> = {
    mining: '⛏️ Mining',
    paused: '⏸️ Paused',
    stopped: '⏹️ Stopped',
    starting: '🔄 Starting',
    error: '❌ Error',
  };
  return statusEmojis[status] || status;
}

export function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export function escapeMarkdown(text: string): string {
  // Escape special Markdown characters
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

export function formatTransactionType(type: string): string {
  const typeEmojis: Record<string, string> = {
    deploy: '🔵 Deploy',
    claim_sol: '💰 Claim SOL',
    claim_lode: '🔮 Claim LODE',
    swap: '🔄 Swap',
    stake: '📊 Stake',
    automation_setup: '🤖 Auto Setup',
    automation_close: '⏹️ Auto Close',
  };
  return typeEmojis[type] || type;
}
