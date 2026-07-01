import { Events, EmbedBuilder, Colors } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';
import { addXp } from '../services/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commandAliases.js';
import { getPrefixRestriction } from '../config/prefixRestrictions.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';
import { getTicketData } from '../utils/database.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (message.author.bot || !message.guild) return;

      logger.debug(`Message received from ${message.author.tag}: ${message.content}`);

      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) return;

      const ticketCommandProcessed = await handleTicketCommands(message, client);
      if (ticketCommandProcessed) return;

      await handlePrefixCommand(message, client);
      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

async function handleTicketCommands(message, client) {
  const cmd = message.content.trim().toLowerCase();
  if (cmd !== '!deconf' && cmd !== '!relconf' && cmd !== '!feerec') return false;

  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const staffRoleId = guildConfig?.ticketStaffRoleId;
    const staffRoleId2 = guildConfig?.ticketStaffRoleId2;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return false;

    const isStaff =
      (staffRoleId && member.roles.cache.has(staffRoleId)) ||
      (staffRoleId2 && member.roles.cache.has(staffRoleId2));

    if (!isStaff) {
      const reply = await message.reply({ content: '❌ Only middlemen can use this command.' });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      await message.delete().catch(() => {});
      return true;
    }

    const ticketData = await getTicketData(message.guild.id, message.channel.id);
    if (!ticketData) {
      const reply = await message.reply({ content: '❌ This command can only be used inside a ticket channel.' });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      await message.delete().catch(() => {});
      return true;
    }

    const ticketCreator = await message.guild.members.fetch(ticketData.userId).catch(() => null);
    const ticketNumber = ticketData.id ? `<#${message.channel.id}>` : message.channel.toString();

    if (cmd === '!feerec') {
      const targetChannel = message.guild.channels.cache.find(
        c => c.name === 'fee-logs'
      );
      if (!targetChannel) {
        const reply = await message.reply({ content: '❌ Could not find a channel named `fee-logs`.' });
        setTimeout(() => reply.delete().catch(() => {}), 7000);
        await message.delete().catch(() => {});
        return true;
      }

      const embed = new EmbedBuilder()
        .setTitle('💰 Fee Received')
        .setColor(Colors.Yellow)
        .setDescription(
          `A middleman fee has been received for a completed trade.\n\n` +
          `**Ticket:** ${ticketNumber}\n` +
          `**Trader:** ${ticketCreator ? ticketCreator.toString() : `<@${ticketData.userId}>`}\n` +
          `**Middleman:** ${member.toString()}`
        )
        .setTimestamp();

      await targetChannel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
      return true;
    }

    if (cmd === '!deconf') {
      const targetChannel = message.guild.channels.cache.find(
        c => c.name === 'deposit-confirmations'
      );
      if (!targetChannel) {
        const reply = await message.reply({ content: '❌ Could not find a channel named `deposit-confirmations`.' });
        setTimeout(() => reply.delete().catch(() => {}), 7000);
        await message.delete().catch(() => {});
        return true;
      }

      const embed = new EmbedBuilder()
        .setTitle('✅ Deposit Confirmed')
        .setColor(Colors.Green)
        .setDescription(
          `Both traders have deposited their items to the middleman.\n\n` +
          `**Ticket:** ${ticketNumber}\n` +
          `**Trader:** ${ticketCreator ? ticketCreator.toString() : `<@${ticketData.userId}>`}\n` +
          `**Middleman:** ${member.toString()}`
        )
        .setTimestamp();

      await targetChannel.send({ embeds: [embed] });
      await message.delete().catch(() => {});

    } else if (cmd === '!relconf') {
      const targetChannel = message.guild.channels.cache.find(
        c => c.name === 'release-confirmation'
      );
      if (!targetChannel) {
        const reply = await message.reply({ content: '❌ Could not find a channel named `release-confirmation`.' });
        setTimeout(() => reply.delete().catch(() => {}), 7000);
        await message.delete().catch(() => {});
        return true;
      }

      const embed = new EmbedBuilder()
        .setTitle('🎉 Release Confirmed')
        .setColor(Colors.Gold)
        .setDescription(
          `The middleman has released the items. Trade complete!\n\n` +
          `**Ticket:** ${ticketNumber}\n` +
          `**Trader:** ${ticketCreator ? ticketCreator.toString() : `<@${ticketData.userId}>`}\n` +
          `**Middleman:** ${member.toString()}`
        )
        .setTimestamp();

      await targetChannel.send({ embeds: [embed] });
      await message.delete().catch(() => {});
    }

    return true;
  } catch (error) {
    logger.error('Error handling ticket command:', error);
    return false;
  }
}

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || client.config.bot.prefix || '!';
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) {
      return; 
    }

    let { commandName, args } = parsed;
    const musicPrefixShortcut = commandName.toLowerCase();
    const MUSIC_PREFIX_SHORTCUTS = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']);
    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    logger.info(`Prefix command detected: ${commandName}, args: ${args.join(', ')}`);

    const resolvedCommandName = resolveCommandAlias(commandName);
    logger.info(`Resolved command name: ${resolvedCommandName}`);
    const command = client.commands.get(resolvedCommandName);

    if (!command) {
      logger.warn(`Command not found: ${resolvedCommandName}`);
      return; 
    }

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      const embed = createEmbed({
        title: 'Command Disabled',
        description: 'This command has been disabled for this server.',
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    const mockInteractionForProtection = {
      guildId: message.guild.id,
      user: message.author,
    };
    const abuseProtection = await enforceAbuseProtection(
      mockInteractionForProtection,
      command,
      resolvedCommandName,
    );
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    logger.info(`Executing prefix command: ${prefix}${commandName} (resolved to ${resolvedCommandName}) by ${message.author.tag}`);
    
    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => {
        failureMessage.delete().catch(() => {});
      }, 10000);

      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    
    if (!levelingConfig?.enabled) {
      return;
    }

    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
      return;
    }

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => {
        return null;
      });
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
        return;
      }
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
      return;
    }

    if (!message.content || message.content.trim().length === 0) {
      return;
    }

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);

    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    const timeSinceLastMessage = now - (userData.lastMessage || 0);

    if (timeSinceLastMessage < cooldownTime * 1000) {
      return;
    }

    const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;
    const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

    const safeMinXP = Math.max(1, minXP);
    const safeMaxXP = Math.max(safeMinXP, maxXP);

    const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

    let finalXP = xpToGive;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);
    
    if (result.success && result.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}