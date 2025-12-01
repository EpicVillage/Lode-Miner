import { InlineKeyboardMarkup } from 'telegraf/types';
import { getUserSettings, updateUserSetting, resetUserSettings, UserSettings } from './userSettings';
import { formatSOL, formatLODE } from './formatters';

/**
 * Interactive settings configuration for telegram bot
 * Provides UI for updating user settings
 */

export interface SettingDefinition {
  key: keyof UserSettings;
  name: string;
  description: string;
  type: 'number' | 'boolean' | 'string';
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
}

export const SETTING_CATEGORIES = {
  mining: {
    name: '⛏️ Mining',
    settings: [
      {
        key: 'motherload_threshold' as keyof UserSettings,
        name: 'Motherload Threshold',
        description: 'Minimum motherload to trigger mining',
        type: 'number' as const,
        min: 0,
        max: 1000,
        unit: 'LODE',
      },
      {
        key: 'sol_per_block' as keyof UserSettings,
        name: 'SOL Per Block',
        description: 'Amount of SOL to deploy per block',
        type: 'number' as const,
        min: 0.001,
        max: 1,
        unit: 'SOL',
      },
      {
        key: 'num_blocks' as keyof UserSettings,
        name: 'Number of Blocks',
        description: 'Number of blocks to mine per round',
        type: 'number' as const,
        min: 1,
        max: 25,
        unit: 'blocks',
      },
    ],
  },
  automation: {
    name: '🤖 Automation',
    settings: [
      {
        key: 'automation_budget_percent' as keyof UserSettings,
        name: 'Automation Budget',
        description: 'Percentage of wallet to allocate',
        type: 'number' as const,
        min: 10,
        max: 99,
        unit: '%',
      },
      {
        key: 'auto_claim_sol_threshold' as keyof UserSettings,
        name: 'Auto-Claim SOL Threshold',
        description: 'Min SOL to auto-claim',
        type: 'number' as const,
        min: 0,
        max: 10,
        unit: 'SOL',
      },
      {
        key: 'auto_claim_orb_threshold' as keyof UserSettings,
        name: 'Auto-Claim LODE Threshold',
        description: 'Min LODE to auto-claim',
        type: 'number' as const,
        min: 0,
        max: 10000,
        unit: 'LODE',
      },
      {
        key: 'auto_claim_staking_threshold' as keyof UserSettings,
        name: 'Auto-Claim Staking Threshold',
        description: 'Min staking LODE to auto-claim',
        type: 'number' as const,
        min: 0,
        max: 10,
        unit: 'LODE',
      },
    ],
  },
  swap: {
    name: '💱 Swap',
    settings: [
      {
        key: 'auto_swap_enabled' as keyof UserSettings,
        name: 'Auto-Swap',
        description: 'Enable automatic LODE to SOL swapping',
        type: 'boolean' as const,
      },
      {
        key: 'swap_threshold' as keyof UserSettings,
        name: 'Swap Threshold',
        description: 'Min LODE balance to trigger swap',
        type: 'number' as const,
        min: 0,
        max: 1000,
        unit: 'LODE',
      },
      {
        key: 'min_orb_price' as keyof UserSettings,
        name: 'Min LODE Price',
        description: 'Minimum price to allow swap (dump protection)',
        type: 'number' as const,
        min: 0,
        max: 200,
        unit: 'USD',
      },
      {
        key: 'min_orb_to_keep' as keyof UserSettings,
        name: 'Min LODE to Keep',
        description: 'Always keep this much LODE',
        type: 'number' as const,
        min: 0,
        max: 50,
        unit: 'LODE',
      },
      {
        key: 'min_swap_amount' as keyof UserSettings,
        name: 'Min Swap Amount',
        description: 'Minimum amount per swap',
        type: 'number' as const,
        min: 1,
        max: 10000,
        unit: 'LODE',
      },
      {
        key: 'slippage_bps' as keyof UserSettings,
        name: 'Slippage',
        description: 'Max slippage tolerance',
        type: 'number' as const,
        min: 10,
        max: 1000,
        unit: 'bps',
      },
    ],
  },
  staking: {
    name: '🏦 Staking',
    settings: [
      {
        key: 'auto_stake_enabled' as keyof UserSettings,
        name: 'Auto-Stake',
        description: 'Enable automatic LODE staking',
        type: 'boolean' as const,
      },
      {
        key: 'stake_threshold' as keyof UserSettings,
        name: 'Stake Threshold',
        description: 'Min LODE to trigger auto-stake',
        type: 'number' as const,
        min: 0,
        max: 500,
        unit: 'LODE',
      },
    ],
  },
  transfer: {
    name: '📤 Auto-Transfer',
    settings: [
      {
        key: 'auto_transfer_enabled' as keyof UserSettings,
        name: 'Auto-Transfer',
        description: 'Enable automatic LODE transfers',
        type: 'boolean' as const,
      },
      {
        key: 'orb_transfer_threshold' as keyof UserSettings,
        name: 'Transfer Threshold',
        description: 'Min LODE balance to trigger transfer',
        type: 'number' as const,
        min: 1,
        max: 1000,
        unit: 'LODE',
      },
    ],
  },
};

/**
 * Generate category selection keyboard
 */
export function getCategoryKeyboard(): InlineKeyboardMarkup {
  const categories = Object.entries(SETTING_CATEGORIES);
  const buttons = categories.map(([key, cat]) => ([
    { text: cat.name, callback_data: `settings_cat_${key}` }
  ]));

  buttons.push([{ text: '🏠 Main Menu', callback_data: 'start' }]);

  return { inline_keyboard: buttons };
}

/**
 * Generate settings list keyboard for a category
 */
export function getCategorySettingsKeyboard(categoryKey: string, currentSettings: UserSettings): InlineKeyboardMarkup {
  const category = SETTING_CATEGORIES[categoryKey as keyof typeof SETTING_CATEGORIES];
  if (!category) {
    return { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'start' }]] };
  }

  const buttons = category.settings.map(setting => {
    const currentValue = currentSettings[setting.key];
    let valueDisplay = '';

    if (setting.type === 'boolean') {
      valueDisplay = currentValue ? '✅' : '❌';
    } else if (setting.type === 'number') {
      valueDisplay = `${currentValue}${setting.unit || ''}`;
    } else {
      valueDisplay = String(currentValue);
    }

    return [{
      text: `${setting.name}: ${valueDisplay}`,
      callback_data: `settings_edit_${categoryKey}_${setting.key}`
    }];
  });

  // Add special "Set Recipient" button for transfer category
  if (categoryKey === 'transfer') {
    const recipientSet = currentSettings.transfer_recipient_address ? '✅' : '❌';
    buttons.push([{
      text: `📍 Set Recipient Address: ${recipientSet}`,
      callback_data: 'set_transfer_recipient_prompt'
    }]);
  }

  buttons.push([{ text: '⬅️ Back', callback_data: 'settings_menu' }]);

  return { inline_keyboard: buttons };
}

/**
 * Generate edit keyboard for a specific setting
 */
export function getSettingEditKeyboard(
  categoryKey: string,
  settingKey: string,
  currentValue: any,
  definition: SettingDefinition
): InlineKeyboardMarkup {
  const buttons: any[][] = [];

  if (definition.type === 'boolean') {
    // Show single toggle button based on current state
    if (currentValue) {
      // Currently enabled, show disable button
      buttons.push([
        { text: '❌ Disable', callback_data: `settings_set_${categoryKey}_${settingKey}_false` }
      ]);
    } else {
      // Currently disabled, show enable button
      buttons.push([
        { text: '✅ Enable', callback_data: `settings_set_${categoryKey}_${settingKey}_true` }
      ]);
    }
  } else if (definition.type === 'string' && definition.options) {
    definition.options.forEach(option => {
      const isSelected = currentValue === option;
      buttons.push([{
        text: isSelected ? `✅ ${option}` : option,
        callback_data: `settings_set_${categoryKey}_${settingKey}_${option}`
      }]);
    });
  } else {
    // Number type - show input prompt
    buttons.push([{
      text: '✏️ Enter New Value',
      callback_data: `settings_input_${categoryKey}_${settingKey}`
    }]);
  }

  buttons.push([{ text: '⬅️ Back', callback_data: `settings_cat_${categoryKey}` }]);

  return { inline_keyboard: buttons };
}

/**
 * Format setting display message
 */
export function formatSettingMessage(
  categoryKey: string,
  settingKey: string,
  currentValue: any,
  definition: SettingDefinition
): string {
  let valueDisplay = '';

  if (definition.type === 'boolean') {
    valueDisplay = currentValue ? '✅ Enabled' : '❌ Disabled';
  } else if (definition.type === 'number') {
    valueDisplay = `${currentValue} ${definition.unit || ''}`;
  } else {
    valueDisplay = String(currentValue);
  }

  let constraints = '';
  if (definition.type === 'number' && (definition.min !== undefined || definition.max !== undefined)) {
    constraints = `\n\n*Range:* ${definition.min || 0} - ${definition.max || '∞'} ${definition.unit || ''}`;
  } else if (definition.type === 'string' && definition.options) {
    constraints = `\n\n*Options:* ${definition.options.join(', ')}`;
  }

  return `⚙️ *${definition.name}*

${definition.description}

*Current Value:* ${valueDisplay}${constraints}`;
}

/**
 * Validate and parse setting value
 */
export function validateSettingValue(
  definition: SettingDefinition,
  value: string
): { valid: boolean; parsedValue?: any; error?: string } {
  if (definition.type === 'boolean') {
    const boolValue = value.toLowerCase() === 'true' || value === '1';
    return { valid: true, parsedValue: boolValue };
  }

  if (definition.type === 'number') {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      return { valid: false, error: 'Invalid number' };
    }

    if (definition.min !== undefined && numValue < definition.min) {
      return { valid: false, error: `Value must be at least ${definition.min}` };
    }

    if (definition.max !== undefined && numValue > definition.max) {
      return { valid: false, error: `Value must be at most ${definition.max}` };
    }

    return { valid: true, parsedValue: numValue };
  }

  if (definition.type === 'string') {
    if (definition.options && !definition.options.includes(value)) {
      return { valid: false, error: `Invalid option. Choose from: ${definition.options.join(', ')}` };
    }

    return { valid: true, parsedValue: value };
  }

  return { valid: false, error: 'Unknown setting type' };
}

/**
 * Get setting definition
 */
export function getSettingDefinition(categoryKey: string, settingKey: string): SettingDefinition | null {
  const category = SETTING_CATEGORIES[categoryKey as keyof typeof SETTING_CATEGORIES];
  if (!category) return null;

  return category.settings.find(s => s.key === settingKey) || null;
}
