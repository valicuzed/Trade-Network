import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, errorEmbed } from '../utils/embeds.js';
import { createTicket, closeTicket, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { getTicketPermissionContext } from '../utils/ticketPermissions.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a server.' });
  }

  return false;
}

async function replyPermissionCheckFailure(interaction, permissionCheck) {
  let type = ErrorTypes.UNKNOWN;
  if (permissionCheck.error === 'Permission Denied') {
    type = ErrorTypes.PERMISSION;
  } else if (permissionCheck.error === 'Request Timeout') {
    type = ErrorTypes.RATE_LIMIT;
  }

  await replyUserError(interaction, { type, message: permissionCheck.details });
}

async function checkTicketPermissionWithTimeout(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;

  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );

    const context = await Promise.race([contextPromise, timeoutPromise]);

    if (!context.ticketData) {
      return { success: false, error: 'Not a Ticket Channel', details: 'This action can only be used in a valid ticket channel.' };
    }

    const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
    if (!allowed) {
      const permissionMessage = allowTicketCreator
        ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
        : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';
      return { success: false, error: 'Permission Denied', details: `${permissionMessage}\n\nYou cannot ${actionLabel}.` };
    }

    return { success: true, context };
  } catch (error) {
    if (error.message === 'Timeout') {
      return { success: false, error: 'Request Timeout', details: 'The permission check took too long. Please try again.' };
    }
    return { success: false, error: 'Error', details: `Failed to check permissions: ${error.message}` };
  }
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;

  const context = await getTicketPermissionContext({ client, interaction });

  if (!context.ticketData) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a valid ticket channel.' });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';

    await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `${permissionMessage}\n\nYou cannot ${actionLabel}.` });
    return null;
  }

  return context;
}

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You are creating tickets too quickly. Please wait a minute and try again.' });
        return;
      }

      // args[0] is the systemId for named ticket systems (e.g. create_ticket:mm-app → args=['mm-app'])
      const systemId = args?.[0] || null;
      const config = await getGuildConfig(client, interaction.guildId);

      // Resolve system-specific config (or fall back to flat config for the default system)
      const systemConfig = systemId ? (config.ticketSystems?.[systemId] ?? null) : null;
      const effectiveConfig = systemConfig ? { ...config, ...systemConfig } : config;
      const maxTicketsPerUser = effectiveConfig.maxTicketsPerUser ?? 3;
      
      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      
      if (currentTicketCount >= maxTicketsPerUser) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `You have reached the maximum number of open tickets (${maxTicketsPerUser}).\n\nPlease close your existing tickets before creating a new one.\n\n**Current Tickets:** ${currentTicketCount}/${maxTicketsPerUser}` });
      }
      
      const modalCustomId = systemId ? `create_ticket_modal:${systemId}` : 'create_ticket_modal';
      const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle('Create a Ticket');

      const gameInput = new TextInputBuilder()
        .setCustomId('trade_game')
        .setLabel('Game (where the trade takes place)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. GAG 2, Donut SMP...')
        .setRequired(true)
        .setMaxLength(100);

      const descInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Describe your trade')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe your trade...')
        .setRequired(true)
        .setMaxLength(1000);

      const traderInput = new TextInputBuilder()
        .setCustomId('other_trader')
        .setLabel('Other traders @')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('@username or paste their User ID')
        .setRequired(true)
        .setMaxLength(100);

      const gameRow = new ActionRowBuilder().addComponents(gameInput);
      const descRow = new ActionRowBuilder().addComponents(descInput);
      const traderRow = new ActionRowBuilder().addComponents(traderInput);
      modal.addComponents(gameRow, descRow, traderRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket creation form.' });
      }
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      // args[0] is the systemId when the modal customId is 'create_ticket_modal:SYSTEM_ID'
      const systemId = args?.[0] || null;
      const config = await getGuildConfig(client, interaction.guildId);
      const systemConfig = systemId ? (config.ticketSystems?.[systemId] ?? null) : null;
      const effectiveConfig = systemConfig ? { ...config, ...systemConfig } : config;
      const categoryId = effectiveConfig.ticketCategoryId || null;

      const tradeGame = interaction.fields.getTextInputValue('trade_game');
      const tradeDesc = interaction.fields.getTextInputValue('reason');
      const otherTraderRaw = interaction.fields.getTextInputValue('other_trader')?.trim() || '';
      const reason = `**Game:** ${tradeGame}\n**Trade:** ${tradeDesc}`;

      // Parse user mention (<@123>) or raw user ID
      let extraUserId = null;
      if (otherTraderRaw) {
        const mentionMatch = otherTraderRaw.match(/^<@!?(\d+)>$/);
        if (mentionMatch) {
          extraUserId = mentionMatch[1];
        } else if (/^\d{17,20}$/.test(otherTraderRaw)) {
          extraUserId = otherTraderRaw;
        } else {
          // Try to find by username in the guild
          const found = interaction.guild.members.cache.find(
            m => m.user.username.toLowerCase() === otherTraderRaw.replace(/^@/, '').toLowerCase()
              || m.displayName.toLowerCase() === otherTraderRaw.replace(/^@/, '').toLowerCase()
          );
          if (found) extraUserId = found.id;
        }
      }

      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        'none',
        extraUserId,
        systemConfig
      );
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed(
            'Ticket Created',
            `Your ticket has been created in ${result.channel}!`
          )]
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to create ticket.' });
      }
    } catch (error) {
      logger.error('Error creating ticket:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while creating your ticket.' });
    }
  }
};

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'close this ticket',
        { allowTicketCreator: true },
        2000 
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Close Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel("Type 'success' or 'cancel' to close")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("success  /  cancel")
        .setRequired(true)
        .setMaxLength(10);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);

      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket close form.' });
      }
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'close this ticket',
        { allowTicketCreator: true },
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim().toLowerCase();
      if (providedReason !== 'success' && providedReason !== 'cancel') {
        await interaction.editReply({
          embeds: [errorEmbed('Invalid Input', "You must type exactly **success** or **cancel** to close this ticket.")],
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      const reason = providedReason;

      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Closed', 'This ticket has been closed.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to close ticket.' });
      }
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the ticket.' });
      }
    }
  }
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'claim tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const result = await claimTicket(interaction.channel, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Claimed', 'You have successfully claimed this ticket!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to claim ticket.' });
      }
    } catch (error) {
      logger.error('Error claiming ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while claiming the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while claiming the ticket.' });
      }
    }
  }
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'change ticket priority',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const priority = args?.[0];
      if (!priority) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'A priority value is required.' });
        return;
      }

      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Priority Updated', `Ticket priority set to ${priority}.`)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to update priority.' });
      }
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' });
      }
    }
  }
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'pin tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const channel = interaction.channel;
      const category = channel.parent;

      if (!category) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This ticket is not in a category.' });
        return;
      }

      const hasPingEmoji = channel.name.startsWith('📌');
      
      if (hasPingEmoji) {
        
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({
          name: newName,
          position: 999 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: '📌 Ticket Unpinned',
            description: 'This ticket has been unpinned and moved back to normal position.',
            color: 0x95A5A6
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket unpinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: newName,
          userId: interaction.user.id
        });
      } else {
        
        const pinnedName = `📌 ${channel.name}`;
        await channel.edit({
          name: pinnedName,
          position: 0 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: '📌 Ticket Pinned',
            description: 'This ticket has been pinned to the top of the category.',
            color: 0x3498db
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket pinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: pinnedName,
          userId: interaction.user.id
        });
      }

      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: hasPingEmoji ? 'unpin' : 'pin',
          ticketId: channel.id,
          ticketNumber: channel.name.replace(/[^0-9]/g, ''),
          userId: interaction.user.id,
          executorId: interaction.user.id,
          metadata: {
            isPinned: !hasPingEmoji,
            newChannelName: hasPingEmoji ? channel.name.replace(/^📌\s*/, '') : `📌 ${channel.name}`
          }
        }
      });

    } catch (error) {
      logger.error('Error pinning/unpinning ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to pin/unpin the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to pin/unpin the ticket.' });
      }
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'unclaim tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Unclaimed', 'You have successfully unclaimed this ticket!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to unclaim ticket.' });
      }
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
      }
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'reopen tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        let reopenMessage = 'You have successfully reopened this ticket!';
        if (result.openCategoryMoveFailed) {
          reopenMessage += '\n\n⚠️ The ticket was reopened, but it could not be moved to the configured open ticket category.';
        }

        await interaction.editReply({
          embeds: [successEmbed('Ticket Reopened', reopenMessage)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to reopen ticket.' });
      }
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
      }
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'delete tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { deleteTicket } = await import('../services/ticket.js');
      const result = await deleteTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Deleted', 'This ticket will be permanently deleted in 3 seconds.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to delete ticket.' });
      }
    } catch (error) {
      logger.error('Error deleting ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while deleting the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while deleting the ticket.' });
      }
    }
  }
};

export default createTicketHandler;
export { 
  createTicketModalHandler, 
  closeTicketModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler 
};