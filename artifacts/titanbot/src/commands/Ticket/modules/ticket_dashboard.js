import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getGuildConfig } from '../../../services/guildConfig.js';
import { getGuildConfigKey } from '../../../utils/database.js';
import { getGuildTicketStats } from '../../../utils/database/tickets.js';
import { getUserTicketCount } from '../../../services/ticket.js';
import {
    getTicketSystemPanelStatus,
    messageHasButtonCustomId,
    formatPanelStatusField,
} from '../../../utils/panelStatus.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';

// ── system helpers ────────────────────────────────────────────────────────────

function getSystemConfig(rootConfig, systemId) {
    if (!systemId || systemId === 'default') return rootConfig;
    return rootConfig.ticketSystems?.[systemId] ?? null;
}

function getAllSystems(rootConfig) {
    const systems = [];
    if (rootConfig.ticketPanelChannelId) {
        systems.push({
            id: 'default',
            name: rootConfig.ticketSystemName || 'Default',
            config: rootConfig,
        });
    }
    for (const [id, sys] of Object.entries(rootConfig.ticketSystems || {})) {
        systems.push({ id, name: sys.ticketSystemName || id, config: sys });
    }
    return systems;
}

function panelButtonCustomId(systemId) {
    return (!systemId || systemId === 'default') ? 'create_ticket' : `create_ticket:${systemId}`;
}

// ── component builders ────────────────────────────────────────────────────────

function buildButtonRow(systemConfig, guildId, disabled = false, panelStatus = null, systemId = 'default') {
    const sid = systemId || 'default';
    const dmEnabled = systemConfig.dmOnClose !== false;
    const showRepost = panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';
    const buttons = [];

    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`ticket_cfg_repost_${guildId}_${sid}`)
                .setLabel('Repost Panel')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📌')
                .setDisabled(disabled),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_dm_toggle_${guildId}_${sid}`)
            .setLabel('DM on Close')
            .setStyle(dmEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
            .setEmoji(dmEnabled ? '📬' : '📭')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_staff_role_btn_${guildId}_${sid}`)
            .setLabel('Staff Role 1')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛡️')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_staff_role2_btn_${guildId}_${sid}`)
            .setLabel('Staff Role 2')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛡️')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_delete_${guildId}_${sid}`)
            .setLabel('Delete System')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
            .setDisabled(disabled),
    );

    return new ActionRowBuilder().addComponents(buttons);
}

async function persistPanelMessageId(client, guildId, rootConfig, messageId, systemId = 'default') {
    const sys = getSystemConfig(rootConfig, systemId);
    if (!sys || !messageId || sys.ticketPanelMessageId === messageId) return;
    sys.ticketPanelMessageId = messageId;
    if (client.db) {
        await client.db.set(getGuildConfigKey(guildId), rootConfig);
    }
}

function buildPanelEmbed(config) {
    return new EmbedBuilder()
        .setTitle('Trade Ticket')
        .setDescription(config.ticketPanelMessage || 'Click the button below to create a support ticket.')
        .setColor(getColor('info'));
}

function buildPanelButtonRow(config, systemId = 'default') {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(panelButtonCustomId(systemId))
            .setLabel(config.ticketButtonLabel || 'Create Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📩'),
    );
}

async function repostTicketPanel(client, guild, systemConfig, guildId, rootConfig, systemId = 'default') {
    const channel = await guild.channels.fetch(systemConfig.ticketPanelChannelId).catch(() => null);
    if (!channel) {
        throw new TitanBotError(
            'Panel channel missing',
            ErrorTypes.CONFIGURATION,
            'The configured ticket panel channel no longer exists. Set a new panel channel from the dashboard.',
        );
    }

    const sentPanel = await channel.send({
        embeds: [buildPanelEmbed(systemConfig)],
        components: [buildPanelButtonRow(systemConfig, systemId)],
    });

    await persistPanelMessageId(client, guildId, rootConfig, sentPanel.id, systemId);
    return sentPanel;
}

function formatCloseDuration(ms) {
    if (ms == null) return '`N/A`';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return '<1m';
}

function buildDashboardEmbed(config, guild, panelStatus = null, ticketStats = null, systemId = 'default', systemName = null) {
    const panelChannel = config.ticketPanelChannelId ? `<#${config.ticketPanelChannelId}>` : '`Not set`';
    const staffRole = config.ticketStaffRoleId ? `<@&${config.ticketStaffRoleId}>` : '`Not set`';
    const staffRole2 = config.ticketStaffRoleId2 ? `<@&${config.ticketStaffRoleId2}>` : '`Not set`';
    const ticketLogsChannel = config.ticketLogsChannelId ? `<#${config.ticketLogsChannelId}>` : '`Not set`';
    const transcriptChannel = config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : '`Not set`';

    const openCategoryChannel = config.ticketCategoryId ? guild.channels.cache.get(config.ticketCategoryId) : null;
    const openCategory = openCategoryChannel ? openCategoryChannel.toString() : '`Not set`';

    const closedCategoryChannel = config.ticketClosedCategoryId ? guild.channels.cache.get(config.ticketClosedCategoryId) : null;
    const closedCategory = closedCategoryChannel ? closedCategoryChannel.toString() : '`Not set`';

    const rawMsg = config.ticketPanelMessage || 'Click the button below to create a support ticket.';
    const panelMsg = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;
    const btnLabel = `\`${config.ticketButtonLabel || 'Create Ticket'}\``;

    const panelStatusValue = formatPanelStatusField(panelStatus);

    const openTickets = ticketStats ? String(ticketStats.openCount) : '`—`';
    const avgCloseTime = ticketStats ? formatCloseDuration(ticketStats.avgCloseTimeMs) : '`—`';
    const feedbackSummary = ticketStats?.feedbackCount
        ? `${ticketStats.avgRating}/5 (${ticketStats.feedbackCount} rating${ticketStats.feedbackCount !== 1 ? 's' : ''})`
        : '`No ratings yet`';

    const title = systemName && systemId !== 'default'
        ? `🎫 Dashboard — ${systemName}`
        : '🎫 Ticket System Dashboard';

    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(`Manage ticket system settings for **${guild.name}**.\nSelect an option below to modify a setting.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Panel Status', value: panelStatusValue, inline: false },
            { name: 'Panel Channel', value: panelChannel, inline: true },
            { name: 'Staff Role 1', value: staffRole, inline: true },
            { name: 'Staff Role 2', value: staffRole2, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Open Tickets Category', value: openCategory, inline: true },
            { name: 'Closed Tickets Category', value: closedCategory, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Panel Message', value: panelMsg, inline: false },
            { name: 'Button Label', value: btnLabel, inline: true },
            { name: 'Max Tickets/User', value: String(config.maxTicketsPerUser || 3), inline: true },
            { name: 'DM on Close', value: config.dmOnClose !== false ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Ticket Logs Channel', value: ticketLogsChannel, inline: true },
            { name: 'Transcript Channel', value: transcriptChannel, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Open Tickets', value: openTickets, inline: true },
            { name: 'Avg Close Time', value: avgCloseTime, inline: true },
            { name: 'Feedback Rating', value: feedbackSummary, inline: true },
            {
                name: '🎯 Eligibility Requirements',
                value: (() => {
                    const parts = [];
                    if (config.minMembershipDays > 0) parts.push(`${config.minMembershipDays}d membership`);
                    if (config.minSuccessfulTrades > 0) parts.push(`${config.minSuccessfulTrades} trades`);
                    return parts.length > 0 ? parts.join(' · ') : '`None`';
                })(),
                inline: false,
            },
        )
        .setFooter({ text: 'Select an option below • Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId, systemId = 'default') {
    const sid = systemId || 'default';
    return new StringSelectMenuBuilder()
        .setCustomId(`ticket_config_${guildId}_${sid}`)
        .setPlaceholder('Select a setting to configure...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Panel Message')
                .setDescription('Change the message displayed on the ticket creation panel')
                .setValue('panel_message')
                .setEmoji('📝'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Button Label')
                .setDescription('Change the label on the Create Ticket button')
                .setValue('button_label')
                .setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Open Tickets Category')
                .setDescription('Category where new tickets are created')
                .setValue('open_category')
                .setEmoji('📁'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Closed Tickets Category')
                .setDescription('Category where closed tickets are moved')
                .setValue('closed_category')
                .setEmoji('📂'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Max Tickets per User')
                .setDescription('Limit how many open tickets one user can have at once')
                .setValue('max_tickets')
                .setEmoji('🔢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Ticket Logs Channel')
                .setDescription('Channel to receive ticket feedback, lifecycle events, and logs')
                .setValue('logs_channel')
                .setEmoji('🎫'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Transcript Channel')
                .setDescription('Channel to receive auto-generated transcripts on deletion')
                .setValue('transcript_channel')
                .setEmoji('📜'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Eligibility Requirements')
                .setDescription('Min. membership days and successful trades required to open a ticket')
                .setValue('eligibility')
                .setEmoji('🎯'),
        );
}

async function refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId = 'default') {
    const sid = systemId || 'default';
    const panelStatus = client
        ? await getTicketSystemPanelStatus(client, rootInteraction.guild, systemConfig, sid)
        : null;
    const ticketStats = client ? await getGuildTicketStats(guildId) : null;

    if (panelStatus?.recoveredId) {
        await persistPanelMessageId(client, guildId, rootConfig, panelStatus.recoveredId, sid);
    }

    const systemName = systemConfig.ticketSystemName || (sid === 'default' ? 'Default' : sid);
    const buttonRow = buildButtonRow(systemConfig, guildId, false, panelStatus, sid);
    const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId, sid));
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(systemConfig, rootInteraction.guild, panelStatus, ticketStats, sid, systemName)],
        components: [buttonRow, selectRow],
    }).catch(() => {});
}

async function updateLivePanel(client, guild, systemConfig, guildId, systemId = 'default') {
    if (!systemConfig.ticketPanelChannelId) return false;
    try {
        const sid = systemId || 'default';
        const panelStatus = await getTicketSystemPanelStatus(client, guild, systemConfig, sid);
        if (panelStatus.recoveredId) {
            systemConfig.ticketPanelMessageId = panelStatus.recoveredId;
        }
        if (!panelStatus.exists || !panelStatus.message) return false;

        await panelStatus.message.edit({
            embeds: [buildPanelEmbed(systemConfig)],
            components: [buildPanelButtonRow(systemConfig, sid)],
        });
        return true;
    } catch (error) {
        logger.warn('Failed to update live ticket panel:', error.message);
        return false;
    }
}

// ── execute ───────────────────────────────────────────────────────────────────

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        try {
            const guildId = interaction.guild.id;
            const rootConfig = await getGuildConfig(client, guildId);
            const systems = getAllSystems(rootConfig);

            if (systems.length === 0) {
                throw new TitanBotError(
                    'Ticket system not configured',
                    ErrorTypes.CONFIGURATION,
                    'The ticket system has not been set up yet. Run `/ticket setup` first to configure it.',
                );
            }

            if (systems.length === 1) {
                return openSystemDashboard(interaction, rootConfig, systems[0].id, client);
            }

            // Multiple systems — show picker
            const pickerSelect = new StringSelectMenuBuilder()
                .setCustomId(`ticket_system_picker_${guildId}`)
                .setPlaceholder('Select a ticket system to manage...')
                .addOptions(
                    systems.map(s =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(s.name)
                            .setDescription(
                                s.config.ticketPanelChannelId
                                    ? `Panel channel: #${s.config.ticketPanelChannelId}`
                                    : 'No panel channel configured',
                            )
                            .setValue(s.id)
                            .setEmoji('🎫'),
                    ),
                );

            const pickerEmbed = new EmbedBuilder()
                .setTitle('🎫 Select Ticket System')
                .setDescription(`This server has **${systems.length}** ticket systems. Pick one to manage.`)
                .setColor(getColor('info'))
                .addFields(
                    systems.map(s => ({
                        name: s.name,
                        value: s.config.ticketPanelChannelId
                            ? `<#${s.config.ticketPanelChannelId}>`
                            : '`No panel channel`',
                        inline: true,
                    })),
                )
                .setTimestamp();

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [pickerEmbed],
                components: [new ActionRowBuilder().addComponents(pickerSelect)],
            });

            const picked = await interaction.channel.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                filter: i =>
                    i.user.id === interaction.user.id &&
                    i.customId === `ticket_system_picker_${guildId}`,
                time: 60_000,
            }).catch(() => null);

            if (!picked) return;
            await picked.deferUpdate();

            return openSystemDashboard(interaction, rootConfig, picked.values[0], client);

        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Ticket dashboard execute error:', error);
            throw new TitanBotError(
                `Ticket config failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the ticket configuration dashboard.',
            );
        }
    },
};

async function openSystemDashboard(interaction, rootConfig, systemId, client) {
    const guildId = interaction.guild.id;
    const sid = systemId || 'default';
    const systemConfig = getSystemConfig(rootConfig, sid);

    if (!systemConfig) {
        throw new TitanBotError(
            'System not found',
            ErrorTypes.CONFIGURATION,
            `Could not find a ticket system with ID "${sid}". Use \`/ticket list\` to see available systems.`,
        );
    }

    const systemName = systemConfig.ticketSystemName || (sid === 'default' ? 'Default' : sid);

    const panelStatus = await getTicketSystemPanelStatus(client, interaction.guild, systemConfig, sid);
    if (panelStatus?.recoveredId) {
        await persistPanelMessageId(client, guildId, rootConfig, panelStatus.recoveredId, sid);
    }

    const ticketStats = await getGuildTicketStats(guildId);
    const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId, sid));
    const buttonRow = buildButtonRow(systemConfig, guildId, false, panelStatus, sid);

    await startDashboardSession({
        interaction,
        embeds: [buildDashboardEmbed(systemConfig, interaction.guild, panelStatus, ticketStats, sid, systemName)],
        components: [buttonRow, selectRow],
        selectMenuId: `ticket_config_${guildId}_${sid}`,
        buttonMatcher: (customId) =>
            customId === `ticket_cfg_repost_${guildId}_${sid}` ||
            customId === `ticket_cfg_dm_toggle_${guildId}_${sid}` ||
            customId === `ticket_cfg_staff_role_btn_${guildId}_${sid}` ||
            customId === `ticket_cfg_staff_role2_btn_${guildId}_${sid}` ||
            customId === `ticket_cfg_delete_${guildId}_${sid}`,
        onSelect: async (selectInteraction) => {
            const selectedOption = selectInteraction.values[0];
            switch (selectedOption) {
                case 'panel_message':
                    await handlePanelMessage(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'button_label':
                    await handleButtonLabel(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'open_category':
                    await handleOpenCategory(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'closed_category':
                    await handleClosedCategory(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'max_tickets':
                    await handleMaxTickets(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'logs_channel':
                    await handleLogsChannel(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'transcript_channel':
                    await handleTranscriptChannel(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
                case 'eligibility':
                    await handleEligibilityRequirements(selectInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
                    break;
            }
        },
        onButton: async (btnInteraction) => {
            if (btnInteraction.customId === `ticket_cfg_repost_${guildId}_${sid}`) {
                await handleRepostPanel(btnInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
            } else if (btnInteraction.customId === `ticket_cfg_dm_toggle_${guildId}_${sid}`) {
                await handleDmOnClose(btnInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
            } else if (btnInteraction.customId === `ticket_cfg_staff_role_btn_${guildId}_${sid}`) {
                await handleStaffRole(btnInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
            } else if (btnInteraction.customId === `ticket_cfg_staff_role2_btn_${guildId}_${sid}`) {
                await handleStaffRole2(btnInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
            } else if (btnInteraction.customId === `ticket_cfg_delete_${guildId}_${sid}`) {
                await handleDeleteSystem(btnInteraction, interaction, systemConfig, guildId, client, rootConfig, sid);
            }
        },
    });
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handlePanelMessage(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_panel_msg')
        .setTitle('📝 Edit Panel Message')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_msg_input')
                    .setLabel('Panel Message')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(
                        systemConfig.ticketPanelMessage ||
                            'Click the button below to create a support ticket.',
                    )
                    .setMaxLength(2000)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('Click the button below to create a support ticket.'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_panel_msg' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newMessage = submitted.fields.getTextInputValue('panel_msg_input').trim();
    systemConfig.ticketPanelMessage = newMessage;
    await client.db.set(getGuildConfigKey(guildId), rootConfig);

    const panelUpdated = await updateLivePanel(client, rootInteraction.guild, systemConfig, guildId, systemId);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Panel Message Updated',
                `The panel message has been updated.${
                    panelUpdated
                        ? '\nThe live ticket panel has also been refreshed.'
                        : '\n> **Note:** The live panel could not be located. Use **Repost Panel** on the dashboard to restore it.'
                }`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
}

async function handleButtonLabel(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_btn_label')
        .setTitle('🏷️ Edit Button Label')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('btn_label_input')
                    .setLabel('Button Label (max 80 characters)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(systemConfig.ticketButtonLabel || 'Create Ticket')
                    .setMaxLength(80)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('Create Ticket'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_btn_label' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newLabel = submitted.fields.getTextInputValue('btn_label_input').trim();
    systemConfig.ticketButtonLabel = newLabel;
    await client.db.set(getGuildConfigKey(guildId), rootConfig);

    const panelUpdated = await updateLivePanel(client, rootInteraction.guild, systemConfig, guildId, systemId);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Button Label Updated',
                `Button label changed to \`${newLabel}\`.${
                    panelUpdated
                        ? '\nThe live ticket panel button has also been updated.'
                        : '\n> **Note:** The live panel could not be located. Use **Repost Panel** on the dashboard to restore it.'
                }`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
}

async function handleStaffRole(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await selectInteraction.deferUpdate();

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('ticket_cfg_staff_role')
        .setPlaceholder('Select the staff role...')
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(roleSelect);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('🛡️ Change Staff Role')
                .setDescription(
                    `**Current:** ${systemConfig.ticketStaffRoleId ? `<@&${systemConfig.ticketStaffRoleId}>` : '`Not set`'}\n\nSelect the role that should have staff access to manage tickets.`,
                )
                .setColor(getColor('info')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_staff_role',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();

        systemConfig.ticketStaffRoleId = role.id;
        await client.db.set(getGuildConfigKey(guildId), rootConfig);

        await roleInteraction.followUp({
            embeds: [successEmbed('Staff Role Updated', `Staff role set to ${role}.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No role was selected. The staff role was not changed.',
            }).catch(() => {});
        }
    });
}

async function handleStaffRole2(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await selectInteraction.deferUpdate();

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('ticket_cfg_staff_role2')
        .setPlaceholder('Select the second staff role...')
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(roleSelect);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('🛡️ Change Staff Role 2')
                .setDescription(
                    `**Current:** ${systemConfig.ticketStaffRoleId2 ? `<@&${systemConfig.ticketStaffRoleId2}>` : '`Not set`'}\n\nSelect the second role that should be pinged and have access to tickets.`,
                )
                .setColor(getColor('info')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i => i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_staff_role2',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();

        systemConfig.ticketStaffRoleId2 = role.id;
        await client.db.set(getGuildConfigKey(guildId), rootConfig);

        await roleInteraction.followUp({
            embeds: [successEmbed('Staff Role 2 Updated', `Second staff role set to ${role}.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No role was selected. The second staff role was not changed.',
            }).catch(() => {});
        }
    });
}

async function handleOpenCategory(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_open_cat')
        .setPlaceholder('Select a category...')
        .addChannelTypes(ChannelType.GuildCategory)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('📁 Change Open Tickets Category')
                .setDescription(
                    `**Current:** ${systemConfig.ticketCategoryId ? `<#${systemConfig.ticketCategoryId}>` : '`Not set`'}\n\nSelect the category where new tickets will be created.`,
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const catCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_open_cat',
        time: 60_000,
        max: 1,
    });

    catCollector.on('collect', async catInteraction => {
        await catInteraction.deferUpdate();
        const category = catInteraction.channels.first();

        systemConfig.ticketCategoryId = category.id;
        await client.db.set(getGuildConfigKey(guildId), rootConfig);

        await catInteraction.followUp({
            embeds: [
                successEmbed(
                    'Open Category Updated',
                    `New tickets will now be created in **${category.name}**.`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
    });

    catCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No category was selected. The setting was not changed.',
            }).catch(() => {});
        }
    });
}

async function handleClosedCategory(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_closed_cat')
        .setPlaceholder('Select a category...')
        .addChannelTypes(ChannelType.GuildCategory)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('📂 Change Closed Tickets Category')
                .setDescription(
                    `**Current:** ${systemConfig.ticketClosedCategoryId ? `<#${systemConfig.ticketClosedCategoryId}>` : '`Not set`'}\n\nSelect the category where closed tickets will be moved.`,
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const catCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_closed_cat',
        time: 60_000,
        max: 1,
    });

    catCollector.on('collect', async catInteraction => {
        await catInteraction.deferUpdate();
        const category = catInteraction.channels.first();

        systemConfig.ticketClosedCategoryId = category.id;
        await client.db.set(getGuildConfigKey(guildId), rootConfig);

        await catInteraction.followUp({
            embeds: [
                successEmbed(
                    'Closed Category Updated',
                    `Closed tickets will now be moved to **${category.name}**.`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
    });

    catCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No category was selected. The setting was not changed.',
            }).catch(() => {});
        }
    });
}

async function handleMaxTickets(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_max_tickets')
        .setTitle('Set Max Tickets per User')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('max_tickets_input')
                    .setLabel('Max Open Tickets (1–10)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(systemConfig.maxTicketsPerUser || 3))
                    .setMaxLength(2)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('3'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_max_tickets' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const raw = submitted.fields.getTextInputValue('max_tickets_input').trim();
    const newMax = parseInt(raw, 10);

    if (Number.isNaN(newMax) || newMax < 1 || newMax > 10) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: 'Max tickets must be a whole number between **1** and **10**.',
        });
        return;
    }

    systemConfig.maxTicketsPerUser = newMax;
    await client.db.set(getGuildConfigKey(guildId), rootConfig);

    await submitted.reply({
        embeds: [
            successEmbed(
                'Max Tickets Updated',
                `Users can now have at most **${newMax}** open ticket${newMax !== 1 ? 's' : ''} at a time.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
}

async function handleDmOnClose(btnInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await btnInteraction.deferUpdate();

    const newState = systemConfig.dmOnClose === false;
    systemConfig.dmOnClose = newState;
    await client.db.set(getGuildConfigKey(guildId), rootConfig);

    await btnInteraction.followUp({
        embeds: [
            successEmbed(
                'DM on Close Updated',
                `Users will **${newState ? 'now' : 'no longer'}** receive a DM when their ticket is closed.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
}

async function handleLogsChannel(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_logs_channel')
        .setPlaceholder('Select a channel...')
        .addChannelTypes(ChannelType.GuildText)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('🎫 Select Ticket Logs Channel')
                .setDescription('Choose where ticket feedback, lifecycle events (open, close, claim, etc.), and other logs will be sent.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i => i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_logs_channel',
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async channelInteraction => {
        await channelInteraction.deferUpdate();
        const channel = channelInteraction.channels.first();

        systemConfig.ticketLogsChannelId = channel.id;
        await client.db.set(getGuildConfigKey(guildId), rootConfig);

        await channelInteraction.followUp({
            embeds: [successEmbed('Logs Channel Updated', `Ticket logs will be sent to ${channel}`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No channel selected. No changes were made.',
            }).catch(() => {});
        }
    });
}

async function handleTranscriptChannel(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_transcript_channel')
        .setPlaceholder('Select a channel...')
        .addChannelTypes(ChannelType.GuildText)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('📜 Select Transcript Channel')
                .setDescription('Choose where auto-generated transcripts will be sent when tickets are deleted.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i => i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_transcript_channel',
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async channelInteraction => {
        await channelInteraction.deferUpdate();
        const channel = channelInteraction.channels.first();

        systemConfig.ticketTranscriptChannelId = channel.id;
        await client.db.set(getGuildConfigKey(guildId), rootConfig);

        await channelInteraction.followUp({
            embeds: [successEmbed('Transcript Channel Updated', `Transcripts will be sent to ${channel}`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No channel selected. No changes were made.',
            }).catch(() => {});
        }
    });
}

async function handleEligibilityRequirements(selectInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_eligibility')
        .setTitle('🎯 Eligibility Requirements')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('min_days')
                    .setLabel('Min. membership days (0 = disabled)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(systemConfig.minMembershipDays || 0))
                    .setMaxLength(3)
                    .setRequired(true)
                    .setPlaceholder('5'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('min_trades')
                    .setLabel('Min. successful trades (0 = disabled)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(systemConfig.minSuccessfulTrades || 0))
                    .setMaxLength(3)
                    .setRequired(true)
                    .setPlaceholder('5'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_eligibility' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const minDays = parseInt(submitted.fields.getTextInputValue('min_days').trim(), 10);
    const minTrades = parseInt(submitted.fields.getTextInputValue('min_trades').trim(), 10);

    if (Number.isNaN(minDays) || minDays < 0 || minDays > 365) {
        return replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Membership days must be a number between **0** and **365**.' });
    }
    if (Number.isNaN(minTrades) || minTrades < 0 || minTrades > 100) {
        return replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Successful trades must be a number between **0** and **100**.' });
    }

    systemConfig.minMembershipDays = minDays;
    systemConfig.minSuccessfulTrades = minTrades;
    await client.db.set(getGuildConfigKey(guildId), rootConfig);

    const parts = [];
    if (minDays > 0) parts.push(`**${minDays}** day${minDays !== 1 ? 's' : ''} membership`);
    if (minTrades > 0) parts.push(`**${minTrades}** successful trade${minTrades !== 1 ? 's' : ''}`);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Eligibility Requirements Updated',
                parts.length > 0
                    ? `Users must have ${parts.join(' and ')} to open a ticket in this system.`
                    : 'All eligibility requirements have been **disabled** — anyone can open a ticket.',
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
}

async function handleCheckUser(selectInteraction, rootInteraction, systemConfig, guildId, client) {
    await selectInteraction.deferUpdate();

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('ticket_cfg_check_user')
        .setPlaceholder('Select a user to check...')
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(userSelect);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Check User Tickets')
                .setDescription('Select a user to view their current open ticket count.')
                .setColor(getColor('info')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
    });

    const userCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.UserSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_check_user',
        time: 60_000,
        max: 1,
    });

    userCollector.on('collect', async userInteraction => {
        await userInteraction.deferUpdate();
        const targetUser = userInteraction.users.first();
        const maxTickets = systemConfig.maxTicketsPerUser || 3;
        const openCount = await getUserTicketCount(guildId, targetUser.id);
        const atLimit = openCount >= maxTickets;

        await userInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`Ticket Check — ${targetUser.username}`)
                    .setDescription(
                        `**Open Tickets:** ${openCount} / ${maxTickets}\n` +
                            `**Remaining:** ${Math.max(0, maxTickets - openCount)}\n\n` +
                            (atLimit
                                ? '⚠️ This user has reached their ticket limit.'
                                : '✅ This user can still open more tickets.'),
                    )
                    .setColor(atLimit ? getColor('error') : getColor('success'))
                    .setThumbnail(targetUser.displayAvatarURL({ size: 64 }))
                    .setTimestamp(),
            ],
            flags: MessageFlags.Ephemeral,
        });
    });

    userCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No user was selected.',
            }).catch(() => {});
        }
    });
}

async function handleRepostPanel(btnInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    await btnInteraction.deferUpdate();

    const panelStatus = await getTicketSystemPanelStatus(client, rootInteraction.guild, systemConfig, systemId);
    if (panelStatus.exists) {
        await btnInteraction.followUp({
            embeds: [infoEmbed('Panel Already Active', 'The ticket panel is already posted in the configured channel.')],
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
        return;
    }

    const sentPanel = await repostTicketPanel(client, rootInteraction.guild, systemConfig, guildId, rootConfig, systemId);

    await btnInteraction.followUp({
        embeds: [
            successEmbed(
                'Panel Reposted',
                `A new ticket panel was posted in <#${systemConfig.ticketPanelChannelId}>.${
                    sentPanel.url ? `\n[Open panel message](${sentPanel.url})` : ''
                }`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
}

async function handleDeleteSystem(btnInteraction, rootInteraction, systemConfig, guildId, client, rootConfig, systemId) {
    const deleteModal = new ModalBuilder()
        .setCustomId('ticket_delete_confirm_modal')
        .setTitle('Delete Ticket System')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('delete_confirmation')
                    .setLabel('Type "DELETE" to confirm')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('DELETE')
                    .setMaxLength(6)
                    .setMinLength(6)
                    .setRequired(true),
            ),
        );

    await btnInteraction.showModal(deleteModal);

    const submitted = await btnInteraction
        .awaitModalSubmit({
            filter: i => i.customId === 'ticket_delete_confirm_modal' && i.user.id === btnInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) {
        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
        return;
    }

    const confirmation = submitted.fields.getTextInputValue('delete_confirmation').trim();

    if (confirmation !== 'DELETE') {
        await replyUserError(submitted, { type: ErrorTypes.UNKNOWN, message: 'You must type "DELETE" exactly to confirm deletion.' });
        await refreshDashboard(rootInteraction, systemConfig, guildId, client, rootConfig, systemId);
        return;
    }

    await submitted.deferUpdate();

    // Delete the panel message from Discord
    if (systemConfig.ticketPanelChannelId) {
        try {
            const panelChannel = await client.guilds.cache
                .get(guildId)?.channels.fetch(systemConfig.ticketPanelChannelId).catch(() => null);
            if (panelChannel) {
                const btnCustomId = panelButtonCustomId(systemId);
                if (systemConfig.ticketPanelMessageId) {
                    const panelMessage = await panelChannel.messages
                        .fetch(systemConfig.ticketPanelMessageId).catch(() => null);
                    if (panelMessage) await panelMessage.delete().catch(() => {});
                } else {
                    const messages = await panelChannel.messages.fetch({ limit: 50 }).catch(() => null);
                    if (messages) {
                        const found = messages.find(
                            m => m.author.id === client.user.id && messageHasButtonCustomId(m, btnCustomId),
                        );
                        if (found) await found.delete().catch(() => {});
                    }
                }
            }
        } catch (panelDeleteError) {
            logger.warn('Could not delete ticket panel message:', panelDeleteError.message);
        }
    }

    // Remove from config
    if (!systemId || systemId === 'default') {
        const keysToDelete = [
            'ticketPanelChannelId', 'ticketPanelMessageId', 'ticketStaffRoleId', 'ticketStaffRoleId2',
            'ticketCategoryId', 'ticketClosedCategoryId', 'ticketPanelMessage', 'ticketButtonLabel',
            'maxTicketsPerUser', 'dmOnClose', 'ticketSystemName',
        ];
        for (const key of keysToDelete) delete rootConfig[key];
    } else {
        delete rootConfig.ticketSystems[systemId];
    }

    await client.db.set(getGuildConfigKey(guildId), rootConfig);

    const sysLabel = systemConfig.ticketSystemName || (systemId === 'default' ? 'default' : systemId);

    await submitted.followUp({
        embeds: [
            successEmbed(
                '✅ Ticket System Deleted',
                `The "${sysLabel}" ticket system has been removed. Run \`/ticket setup\` to create a new one.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [
            new EmbedBuilder()
                .setTitle('Ticket System Deleted')
                .setDescription('The ticket system configuration has been cleared.')
                .setColor(getColor('error'))
                .setTimestamp(),
        ],
        components: [],
    }).catch(() => {});
}
