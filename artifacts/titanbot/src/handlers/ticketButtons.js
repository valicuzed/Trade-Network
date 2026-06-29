import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
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
      
      // ── Eligibility checks (system-specific) ──────────────────────────────
      const minMembershipDays = effectiveConfig.minMembershipDays || 0;
      const minSuccessfulTrades = effectiveConfig.minSuccessfulTrades || 0;
      const isOwner = interaction.user.id === interaction.guild.ownerId;

      if (!isOwner && (minMembershipDays > 0 || minSuccessfulTrades > 0)) {
        const failures = [];

        if (minMembershipDays > 0) {
          const joinedAt = interaction.member.joinedTimestamp;
          const daysSinceJoin = joinedAt ? (Date.now() - joinedAt) / 86_400_000 : 0;
          if (daysSinceJoin < minMembershipDays) {
            const daysLeft = Math.ceil(minMembershipDays - daysSinceJoin);
            failures.push(
              `❌ **Server membership:** Must be a member for at least **${minMembershipDays} day${minMembershipDays !== 1 ? 's' : ''}**.\nYou joined <t:${Math.floor(joinedAt / 1000)}:R> — **${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining**.`,
            );
          }
        }

        if (minSuccessfulTrades > 0) {
          const { getClosedTicketCountForUser } = await import('../utils/database/tickets.js');
          const closedCount = await getClosedTicketCountForUser(interaction.guildId, interaction.user.id);
          if (closedCount < minSuccessfulTrades) {
            failures.push(
              `❌ **Successful trades:** Need at least **${minSuccessfulTrades} successful trade${minSuccessfulTrades !== 1 ? 's' : ''}**.\nYou currently have **${closedCount}**.`,
            );
          }
        }

        if (failures.length > 0) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('⛔ Eligibility Requirements Not Met')
                .setDescription(`You do not meet the requirements to apply:\n\n${failures.join('\n\n')}`)
                .setColor(0xED4245)
                .setFooter({ text: 'Meet the requirements above and try again.' }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      // ── Middleman Application: skip modal, open ticket immediately ─────────
      const systemName = effectiveConfig.ticketSystemName?.toLowerCase() ?? '';
      const isMiddlemanSystem = systemName.includes('middleman');
      const isDisputeSystem = systemName.includes('dispute');
      const isScamSystem = systemName.includes('scam');
      const isNoModalSystem = isMiddlemanSystem || isDisputeSystem;

      if (isScamSystem) {
        const scamModalCustomId = systemId ? `create_scam_ticket_modal:${systemId}` : 'create_scam_ticket_modal';
        const scamModal = new ModalBuilder()
          .setCustomId(scamModalCustomId)
          .setTitle('Report a Scam');

        const gameInput = new TextInputBuilder()
          .setCustomId('scam_game')
          .setLabel('What game did the scam take place in?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. GAG 2, Donut SMP...')
          .setRequired(true)
          .setMaxLength(100);

        const scammerInput = new TextInputBuilder()
          .setCustomId('scammer_mention')
          .setLabel("Scammer's @ or username")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('@username or paste their User ID')
          .setRequired(true)
          .setMaxLength(100);

        scamModal.addComponents(
          new ActionRowBuilder().addComponents(gameInput),
          new ActionRowBuilder().addComponents(scammerInput),
        );
        await interaction.showModal(scamModal);
        return;
      }

      if (isNoModalSystem) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const categoryId = effectiveConfig.ticketCategoryId || null;
        const ticketReason = isDisputeSystem ? 'Dispute Ticket' : 'Middleman Application';

        const result = await createTicket(
          interaction.guild,
          interaction.member,
          categoryId,
          ticketReason,
          'none',
          null,
          systemConfig
        );

        if (result.success) {
          if (isDisputeSystem) {
            await result.channel.send({
              content: [
                '### Please state:',
                '* The other user\'s username',
                '* What was agreed in the trade',
                '* What went wrong',
                '* Any proof (screenshots, messages, etc.)',
              ].join('\n'),
            });
            await interaction.editReply({
              embeds: [successEmbed('Dispute Opened', `Your dispute ticket has been created in ${result.channel}!`)],
            });
          } else {
            await result.channel.send({
              content: [
                '* Discord username:',
                '* Timezone:',
                '* How active are you per day?',
                '* Have you ever been a middleman or done safe trading before? (yes/no + short explanation)',
                '* In simple words, what does a middleman do?',
                '* What would you do if someone tries to rush you or bypass the system?',
                '* Two players disagree during a trade. What do you do?',
              ].join('\n'),
            });
            await interaction.editReply({
              embeds: [successEmbed('Application Opened', `Your application ticket has been created in ${result.channel}!`)],
            });
          }
        } else {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to create ticket.' });
        }
        return;
      }
      // ──────────────────────────────────────────────────────────────────────

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

const createScamTicketModalHandler = {
  name: 'create_scam_ticket_modal',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const systemId = args?.[0] || null;
      const config = await getGuildConfig(client, interaction.guildId);
      const systemConfig = systemId ? (config.ticketSystems?.[systemId] ?? null) : null;
      const effectiveConfig = systemConfig ? { ...config, ...systemConfig } : config;
      const categoryId = effectiveConfig.ticketCategoryId || null;

      const scamGame = interaction.fields.getTextInputValue('scam_game')?.trim() || 'Unknown game';
      const scammerRaw = interaction.fields.getTextInputValue('scammer_mention')?.trim() || 'Unknown';

      // Use only the game as the ticket reason (channel name stays clean)
      const reason = `Scam Report – ${scamGame}`;

      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        'none',
        null,
        systemConfig
      );

      if (result.success) {
        // Send scammer info as the first message (not in channel name)
        await result.channel.send({
          content: [
            '### Scam Report',
            `**Game:** ${scamGame}`,
            `**Reported scammer:** ${scammerRaw}`,
            '',
            'Please provide any screenshots or evidence below.',
          ].join('\n'),
        });

        await interaction.editReply({
          embeds: [successEmbed('Report Opened', `Your scam report has been created in ${result.channel}!`)],
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to create ticket.' });
      }
    } catch (error) {
      logger.error('Error creating scam ticket:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while creating your report.' });
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

      const ticketReason = permissionCheck.context?.ticketData?.reason ?? '';
      const isMMApplication = ticketReason === 'Middleman Application';
      const isDisputeTicket = ticketReason === 'Dispute Ticket';

      if (isMMApplication) {
        const mmModal = new ModalBuilder()
          .setCustomId('ticket_close_mm_modal')
          .setTitle('Close Application');
        const decisionInput = new TextInputBuilder()
          .setCustomId('decision')
          .setLabel("Type 'Accept' or 'Denied' to close")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Accept  /  Denied')
          .setRequired(true)
          .setMaxLength(10);
        mmModal.addComponents(new ActionRowBuilder().addComponents(decisionInput));
        await interaction.showModal(mmModal);
        return;
      }

      if (isDisputeTicket) {
        const disputeModal = new ModalBuilder()
          .setCustomId('ticket_close_dispute_modal')
          .setTitle('Close Dispute');
        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason for closing')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Briefly describe how this dispute was resolved...')
          .setRequired(true)
          .setMaxLength(500);
        disputeModal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(disputeModal);
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

      const claimerId = permissionCheck.context?.ticketData?.claimedBy ?? null;
      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Closed', 'This ticket has been closed.')],
          flags: MessageFlags.Ephemeral
        });

        // ── Trial middleman auto-promotion check ───────────────────────────
        if (reason === 'success' && claimerId) {
          try {
            const claimer = await interaction.guild.members.fetch(claimerId).catch(() => null);
            const trialRole = interaction.guild.roles.cache.find(r =>
              r.name.toLowerCase().includes('middleman') && r.name.toLowerCase().includes('trial')
            );

            if (claimer && trialRole && claimer.roles.cache.has(trialRole.id)) {
              const { getSuccessfulTradesAsClaimer } = await import('../utils/database/tickets.js');
              const tradeCount = await getSuccessfulTradesAsClaimer(interaction.guildId, claimerId);

              if (tradeCount >= 5) {
                const verifiedRole = interaction.guild.roles.cache.find(r =>
                  r.name.toLowerCase().includes('verified') && r.name.toLowerCase().includes('middleman')
                );

                if (verifiedRole) {
                  await claimer.roles.add(verifiedRole).catch(err =>
                    logger.warn(`Could not assign Verified Middleman role to ${claimerId}: ${err.message}`)
                  );
                  await claimer.roles.remove(trialRole).catch(() => {});
                }

                const assignmentsChannel = interaction.guild.channels.cache.find(c =>
                  c.name.toLowerCase().replace(/[-_\s]/g, '').includes('middlemanassign') ||
                  c.name.toLowerCase().includes('assignments')
                );

                if (assignmentsChannel) {
                  const roleMention = verifiedRole?.toString() ?? '@Verified Middleman';
                  await assignmentsChannel.send(
                    `${claimer.toString()} Has been PROMOTED to ${roleMention}!`
                  );
                }
              }
            }
          } catch (promoErr) {
            logger.warn(`Trial middleman promotion check failed: ${promoErr.message}`);
          }
        }
        // ──────────────────────────────────────────────────────────────────
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

const closeDisputeModalHandler = {
  name: 'ticket_close_dispute_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction, client, 'close this dispute', { allowTicketCreator: false }, 2000
      );
      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const reason = interaction.fields.getTextInputValue('reason')?.trim() || 'Dispute resolved';
      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Dispute Closed', 'The dispute ticket has been closed.')],
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to close dispute ticket.' });
      }
    } catch (error) {
      logger.error('Error closing dispute modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the dispute.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the dispute.' });
      }
    }
  }
};

const closeMMModalHandler = {
  name: 'ticket_close_mm_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction, client, 'close this application', { allowTicketCreator: false }, 2000
      );
      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const raw = interaction.fields.getTextInputValue('decision')?.trim().toLowerCase();
      if (raw !== 'accept' && raw !== 'denied') {
        await interaction.editReply({
          embeds: [errorEmbed('Invalid Input', "You must type exactly **Accept** or **Denied**.")],
        });
        return;
      }

      const ticketData = permissionCheck.context?.ticketData;
      const applicantId = ticketData?.userId;
      const applicant = applicantId
        ? await interaction.guild.members.fetch(applicantId).catch(() => null)
        : null;

      // Find the middleman assignments channel by name
      const assignmentsChannel = interaction.guild.channels.cache.find(c =>
        c.name.toLowerCase().replace(/[-_\s]/g, '').includes('middlemanassign') ||
        c.name.toLowerCase().replace(/[-_\s]/g, '').includes('mmmassign') ||
        c.name.toLowerCase().includes('assignments')
      );

      if (raw === 'accept') {
        // Find the Middleman (Trial) role by name
        const trialRole = interaction.guild.roles.cache.find(r =>
          r.name.toLowerCase().includes('middleman') && r.name.toLowerCase().includes('trial')
        );

        if (applicant && trialRole) {
          await applicant.roles.add(trialRole).catch(err =>
            logger.warn(`Could not assign trial role to ${applicantId}: ${err.message}`)
          );
        }

        if (assignmentsChannel) {
          const userMention = applicant?.toString() ?? `<@${applicantId}>`;
          const roleMention = trialRole?.toString() ?? '@Middleman (Trial)';
          await assignmentsChannel.send(`${userMention} Has been PROMOTED to ${roleMention}!`);
        }
      } else {
        if (assignmentsChannel) {
          const userMention = applicant?.toString() ?? `<@${applicantId}>`;
          await assignmentsChannel.send(`${userMention} Has been DENIED the Middleman (Trial) position.`);
        }
      }

      const result = await closeTicket(interaction.channel, interaction.user, raw);
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Application Closed', `The application has been **${raw === 'accept' ? 'accepted' : 'denied'}**.`)],
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to close application ticket.' });
      }
    } catch (error) {
      logger.error('Error closing MM application modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the application.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the application.' });
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
  createScamTicketModalHandler,
  closeTicketModalHandler,
  closeDisputeModalHandler,
  closeMMModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler 
};