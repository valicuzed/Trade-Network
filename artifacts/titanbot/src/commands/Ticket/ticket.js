import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getGuildConfig } from '../../services/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import ticketConfig from './modules/ticket_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Manages the server's ticket system.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription(
                    "Sets up the ticket creation panel in a specified channel.",
                )
                .addChannelOption((option) =>
                    option
.setName("panel_channel")
                        .setDescription(
                            "The channel where the ticket panel will be sent.",
                        )
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )

                .addStringOption((option) =>
                    option
                        .setName("panel_message")
                        .setDescription(
                            "The main message/description for the ticket panel.",
                        )
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_label")
                        .setDescription(
                            "The label for the ticket creation button (default: Create Ticket)",
                        )
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("category")
                        .setDescription(
                            "The category where new tickets will be created (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("closed_category")
                        .setDescription(
                            "The category where closed tickets will be moved (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addRoleOption((option) =>
                    option
                        .setName("staff_role")
                        .setDescription(
                            "The role that can access tickets (optional).",
                        )
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("max_tickets_per_user")
                        .setDescription("Maximum number of tickets a user can create (default: 3)")
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName("dm_on_close")
                        .setDescription("Send DM to user when their ticket is closed (default: true)")
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("name")
                        .setDescription("Name for this system (e.g. 'Middleman Application'). Required when adding a 2nd+ system.")
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the interactive ticket system dashboard"),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("list")
                .setDescription("List all configured ticket systems for this server"),
        ),
    category: "ticket",

    async execute(interaction, config, client) {
        try {
            
            const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
            if (!deferred) {
                return;
            }

            if (
                !interaction.member.permissions.has(
                    PermissionFlagsBits.ManageChannels,
                )
            ) {
                logger.warn('Ticket command permission denied', {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'ticket'
                });
                return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the `Manage Channels` permission for this action.' });
            }

            const subcommand = interaction.options.getSubcommand();

        if (subcommand === "dashboard") {
            return ticketConfig.execute(interaction, config, client);
        }

        if (subcommand === "list") {
            const existingConfig = await getGuildConfig(client, interaction.guildId);
            const { getGuildConfigKey } = await import('../../utils/database.js');
            const systems = [];
            if (existingConfig?.ticketPanelChannelId) {
                systems.push({
                    id: 'default',
                    name: existingConfig.ticketSystemName || 'Default',
                    panelChannelId: existingConfig.ticketPanelChannelId,
                    buttonId: 'create_ticket',
                });
            }
            for (const [id, sys] of Object.entries(existingConfig?.ticketSystems || {})) {
                systems.push({
                    id,
                    name: sys.ticketSystemName || id,
                    panelChannelId: sys.ticketPanelChannelId,
                    buttonId: `create_ticket:${id}`,
                });
            }
            if (systems.length === 0) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [infoEmbed('No Ticket Systems', 'No ticket systems have been set up. Use `/ticket setup` to create one.')],
                });
            }
            const { EmbedBuilder } = await import('discord.js');
            const listEmbed = new EmbedBuilder()
                .setTitle(`🎫 Ticket Systems (${systems.length})`)
                .setColor(0x5865F2)
                .addFields(systems.map(s => ({
                    name: s.name,
                    value: `Panel: ${s.panelChannelId ? `<#${s.panelChannelId}>` : '`not set`'}\nButton ID: \`${s.buttonId}\``,
                    inline: true,
                })))
                .setTimestamp();
            return await InteractionHelper.safeEditReply(interaction, { embeds: [listEmbed] });
        }

        if (subcommand === "setup") {
            const existingConfig = await getGuildConfig(client, interaction.guildId);

            const systemName = interaction.options.getString("name")?.trim() || null;
            const hasDefaultSystem = !!existingConfig?.ticketPanelChannelId;
            const namedSystems = existingConfig?.ticketSystems || {};
            const hasAnything = hasDefaultSystem || Object.keys(namedSystems).length > 0;

            // Require a name when a system already exists
            if (hasAnything && !systemName) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: `This server already has a ticket system. Provide a **name** to create an additional one (e.g., \`name: Middleman Application\`).\n\nUse \`/ticket list\` to see existing systems, or \`/ticket dashboard\` to manage them.`,
                });
            }

            // Derive a safe systemId from the name (or null for the first/default system)
            let systemId = null;
            let buttonCustomId = 'create_ticket';
            if (systemName) {
                systemId = systemName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'system';
                if (namedSystems[systemId]) {
                    return await replyUserError(interaction, {
                        type: ErrorTypes.UNKNOWN,
                        message: `A ticket system named **"${systemName}"** (id: \`${systemId}\`) already exists. Choose a different name.`,
                    });
                }
                buttonCustomId = `create_ticket:${systemId}`;
            }

            const panelChannel = interaction.options.getChannel("panel_channel");
            const categoryChannel = interaction.options.getChannel("category");
            const closedCategoryChannel = interaction.options.getChannel("closed_category");
            const staffRole = interaction.options.getRole("staff_role");
            const panelMessage = interaction.options.getString("panel_message") || "Click the button below to create a support ticket.";
            const buttonLabel = interaction.options.getString("button_label") || "Create Ticket";
            const maxTicketsPerUser = interaction.options.getInteger("max_tickets_per_user") || 3;
            const dmOnClose = interaction.options.getBoolean("dm_on_close") !== false;

            const setupEmbed = createEmbed({
                title: systemName || "Trade Ticket",
                description: panelMessage,
                color: getColor('info'),
            });

            const ticketButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(buttonCustomId)
                    .setLabel(buttonLabel)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji("📩"),
            );

            try {
                const sentPanel = await panelChannel.send({
                    embeds: [setupEmbed],
                    components: [ticketButton],
                });

                if (client.db && interaction.guildId) {
                    const { getGuildConfigKey } = await import('../../utils/database.js');
                    const configKey = getGuildConfigKey(interaction.guildId);
                    const systemData = {
                        ticketSystemName: systemName || null,
                        ticketCategoryId: categoryChannel?.id || null,
                        ticketClosedCategoryId: closedCategoryChannel?.id || null,
                        ticketStaffRoleId: staffRole?.id || null,
                        ticketPanelChannelId: panelChannel.id,
                        ticketPanelMessageId: sentPanel?.id || null,
                        ticketPanelMessage: panelMessage,
                        ticketButtonLabel: buttonLabel,
                        maxTicketsPerUser,
                        dmOnClose,
                    };

                    if (systemId) {
                        // Named system — store under ticketSystems
                        if (!existingConfig.ticketSystems) existingConfig.ticketSystems = {};
                        existingConfig.ticketSystems[systemId] = systemData;
                    } else {
                        // Default system — flat fields
                        Object.assign(existingConfig, systemData);
                    }

                    await client.db.set(configKey, existingConfig);
                    logger.info('Ticket configuration saved', {
                        guildId: interaction.guildId,
                        systemId: systemId || 'default',
                        systemName,
                        panelChannelId: panelChannel.id,
                        maxTickets: maxTicketsPerUser,
                        dmOnClose,
                    });
                }

                let successMessage = `The ticket creation panel has been sent to ${panelChannel}.`;
                if (systemName) successMessage = `**"${systemName}"** system created! Panel sent to ${panelChannel}.`;
                if (categoryChannel) successMessage += ` New tickets will be created in the **${categoryChannel.name}** category.`;
                if (closedCategoryChannel) successMessage += ` Closed tickets will be moved to **${closedCategoryChannel.name}**.`;
                if (staffRole) successMessage += ` **${staffRole.name}** role will have access to tickets.`;
                successMessage += `\n\n**Max Tickets Per User:** ${maxTicketsPerUser}\n**DM on Close:** ${dmOnClose ? 'Enabled' : 'Disabled'}`;
                if (systemId) successMessage += `\n**System ID:** \`${systemId}\` (button: \`${buttonCustomId}\`)`;

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed("Ticket Panel Set Up", successMessage)],
                });

                logger.info('Ticket panel setup completed', {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    systemId: systemId || 'default',
                    panelChannelId: panelChannel.id,
                    commandName: 'ticket_setup',
                });

            } catch (error) {
                logger.error('Ticket setup error', {
                    error: error.message,
                    stack: error.stack,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'ticket_setup',
                });
                if (interaction.deferred || interaction.replied) {
                    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not send the ticket panel or save configuration. Check the bot\'s permissions and database connection.' }).catch(() => {});
                } else {
                    await handleInteractionError(interaction, error, { commandName: 'ticket_setup', source: 'ticket_setup_command' });
                }
            }
        }
        } catch (error) {
            logger.error('Error executing ticket command', {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'ticket'
            });
            await handleInteractionError(interaction, error, {
                commandName: 'ticket',
                source: 'ticket_command_main'
            });
        }
    }
};