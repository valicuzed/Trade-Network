// ticketLogging.js

import { ChannelType } from 'discord.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logger } from './logger.js';
import {
  buildStandardLogEmbed,
  formatRatingStars,
  resolveUserAuthor,
} from './logEmbeds.js';

export async function logTicketEvent({ client, guildId, event }) {
  try {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.warn(`logTicketEvent invoked without valid guild: ${guildId}`);
      return;
    }

    const config = await getGuildConfig(client, guildId);

    // For close events: log to the completed trades channel unless it's a scam ticket.
    if (event.type === 'close') {
      const tradeReason = (event.metadata?.tradeReason || '').trim();
      const isScamTicket = tradeReason.startsWith('Scam Report');
      if (isScamTicket) return; // Never log scam ticket closes to the trades log

      const logChannelId = config.ticketLogsChannelId || null;
      if (!logChannelId) return;

      const logChannel = guild.channels.cache.get(logChannelId)
        || await guild.channels.fetch(logChannelId).catch(() => null);
      if (!logChannel) return;

      const permissions = logChannel.permissionsFor(guild.members.me);
      if (!permissions.has(['SendMessages', 'EmbedLinks'])) return;

      const embed = await createTradeOutcomeEmbed(guild, event);
      await logChannel.send({ embeds: [embed] });
      logger.info(`Ticket close logged in guild ${guildId}`);
      return;
    }

    // Suppress all other lifecycle events (open, delete, claim, etc.)
    // from posting to the public log channel.
    if (['open', 'delete', 'claim', 'unclaim', 'priority', 'pin', 'unpin'].includes(event.type)) {
      return;
    }

    const logChannelId = getLogChannelForEventType(config, event.type);
    if (!logChannelId) {
      return;
    }

    const channel = guild.channels.cache.get(logChannelId) || await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel) {
      logger.warn(`Ticket log channel not found: ${logChannelId} for event type: ${event.type}`);
      return;
    }

    const permissions = channel.permissionsFor(guild.members.me);
    if (!permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions in ticket log channel: ${logChannelId}`);
      return;
    }

    const embed = await createTicketLogEmbed(guild, event);

    const messageOptions = { embeds: [embed] };

    if (event.attachments && event.attachments.length > 0) {
      messageOptions.files = event.attachments;
    }

    await channel.send(messageOptions);
    logger.info(`Ticket event logged: ${event.type} in guild ${guildId}`);
  } catch (error) {
    logger.error('Error logging ticket event:', error);
  }
}

function parseTradeReason(raw) {
  if (!raw) return { game: null, trade: null };
  const gameMatch = raw.match(/\*\*Game:\*\*\s*(.+)/);
  const tradeMatch = raw.match(/\*\*Trade:\*\*\s*([\s\S]+)/);
  return {
    game: gameMatch ? gameMatch[1].trim() : null,
    trade: tradeMatch ? tradeMatch[1].trim() : null,
  };
}

async function createTradeOutcomeEmbed(guild, event) {
  const { EmbedBuilder } = await import('discord.js');
  const { game, trade } = parseTradeReason(event.metadata?.tradeReason);
  const creatorMention = event.userId ? `<@${event.userId}>` : 'Unknown';
  const closedByMention = event.executorId ? `<@${event.executorId}>` : 'Unknown';
  const closeNote = (event.reason && event.reason !== 'Closed') ? event.reason : null;

  const embed = new EmbedBuilder()
    .setTitle('🔒 Ticket Closed')
    .setColor(0x5865F2)
    .setTimestamp();

  if (game) embed.addFields({ name: 'Game', value: game, inline: true });
  if (trade) embed.addFields({ name: 'Trade', value: trade, inline: false });
  embed.addFields({ name: 'Creator', value: creatorMention, inline: true });
  embed.addFields({ name: 'Closed by', value: closedByMention, inline: true });
  if (closeNote) embed.addFields({ name: 'Reason', value: closeNote, inline: false });

  return embed;
}

export async function logTicketFeedback({
  client,
  guildId,
  ticketNumber,
  ticketChannelId,
  userId,
  rating = null,
  comment = null,
}) {
  await logTicketEvent({
    client,
    guildId,
    event: {
      type: 'feedback',
      ticketId: ticketChannelId,
      ticketNumber,
      userId,
      metadata: {
        rating,
        comment,
      },
    },
  });
}

function getLogChannelForEventType(config, eventType) {
  switch (eventType) {
    case 'transcript':
      return config.ticketTranscriptChannelId || null;

    case 'open':
    case 'close':
    case 'delete':
    case 'claim':
    case 'unclaim':
    case 'priority':
    case 'pin':
    case 'unpin':
    case 'feedback':
      return config.ticketLogsChannelId || null;

    default:
      return null;
  }
}

const TICKET_EVENT_STYLES = {
  open: { color: 0x5865F2, title: 'Ticket Created' },
  close: { color: 0xED4245, title: 'Ticket Closed' },
  delete: { color: 0x8b0000, title: 'Ticket Deleted' },
  claim: { color: 0x5865F2, title: 'Ticket Claimed' },
  unclaim: { color: 0xFAA61A, title: 'Ticket Unclaimed' },
  priority: { color: 0x9b59b6, title: 'Priority Updated' },
  transcript: { color: 0x57F287, title: 'Transcript Generated' },
  feedback: { color: 0x57F287, title: 'Feedback Received' },
};

async function createTicketLogEmbed(guild, event) {
  const style = TICKET_EVENT_STYLES[event.type] || { color: 0x95a5a6, title: 'Ticket Event' };
  const ticketNumber = event.ticketNumber || event.ticketId;
  const ticketRef = ticketNumber ? `#${ticketNumber}` : 'Unknown';
  const channelMention = event.ticketId ? `<#${event.ticketId}>` : null;
  const executorMention = event.executorId ? `<@${event.executorId}>` : null;
  const userMention = event.userId ? `<@${event.userId}>` : null;

  let inlineFields = [];
  let fields = [];
  let author = null;
  let footer = { text: 'TitanBot Ticketing' };

  switch (event.type) {
    case 'open':
      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'close':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Closed by', value: executorMention || 'Unknown', inline: true },
      ];
      if (channelMention) {
        inlineFields.push({ name: 'Channel', value: channelMention, inline: true });
      }
      if (event.reason) {
        fields.push({ name: 'Reason', value: String(event.reason).slice(0, 1024), inline: false });
      }
      break;

    case 'delete':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Deleted by', value: executorMention || 'Unknown', inline: true },
      ];
      break;

    case 'claim':
    case 'unclaim':
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        {
          name: event.type === 'claim' ? 'Claimed by' : 'Unclaimed by',
          value: executorMention || 'Unknown',
          inline: true,
        },
      ];
      break;

    case 'priority': {
      const priorityEmojis = { none: '⚪', low: '🔵', medium: '🟢', high: '🟡', urgent: '🔴' };
      const priorityLabel = event.priority
        ? `${priorityEmojis[event.priority] || '⚪'} ${event.priority.charAt(0).toUpperCase()}${event.priority.slice(1)}`
        : 'Unknown';
      author = await resolveUserAuthor(guild.client, event.executorId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Priority', value: priorityLabel, inline: true },
        { name: 'Updated by', value: executorMention || 'Unknown', inline: true },
      ];
      break;
    }

    case 'transcript':
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Creator', value: userMention || 'Unknown', inline: true },
      ];
      if (event.metadata?.messageCount) {
        inlineFields.push({ name: 'Messages', value: String(event.metadata.messageCount), inline: true });
      }
      if (event.metadata?.duration) {
        fields.push({ name: 'Duration', value: String(event.metadata.duration), inline: false });
      }
      if (event.metadata?.subject || event.reason) {
        fields.push({
          name: 'Subject',
          value: String(event.metadata?.subject || event.reason).slice(0, 1024),
          inline: false,
        });
      }
      break;

    case 'feedback': {
      const rating = event.metadata?.rating ?? event.rating;
      const comment = event.metadata?.comment;
      const ratingDisplay = formatRatingStars(rating) || 'No rating';

      author = await resolveUserAuthor(guild.client, event.userId);
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
        { name: 'Rating', value: ratingDisplay, inline: true },
      ];

      if (comment) {
        fields.push({
          name: 'Comment',
          value: String(comment).slice(0, 1024),
          inline: false,
        });
      }
      break;
    }

    default:
      inlineFields = [
        { name: 'Ticket', value: ticketRef, inline: true },
      ];
      if (event.reason) {
        fields.push({ name: 'Details', value: String(event.reason).slice(0, 1024), inline: false });
      }
  }

  const titlePrefix = event.type === 'feedback' ? '⭐ ' : '';
  return buildStandardLogEmbed({
    color: style.color,
    title: `${titlePrefix}${style.title}`,
    inlineFields,
    fields,
    author,
    footer,
  });
}

export async function getTicketLoggingConfig(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  return {
    enabled: !!(config.ticketLogsChannelId || config.ticketTranscriptChannelId),
    lifecycleChannelId: config.ticketLogsChannelId || null,
    transcriptChannelId: config.ticketTranscriptChannelId || null,
  };
}

export function validateLogChannel(channel, botMember) {
  if (!channel || channel.type !== ChannelType.GuildText) {
    return {
      valid: false,
      error: 'Channel must be a text channel.',
    };
  }

  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = ['SendMessages', 'EmbedLinks'];

  const missing = requiredPermissions.filter((perm) => !permissions.has(perm));

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing permissions: ${missing.join(', ')}`,
    };
  }

  return { valid: true };
}

