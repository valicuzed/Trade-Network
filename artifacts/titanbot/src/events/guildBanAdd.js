import { Events, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    try {
      const { guild, user, reason } = ban;

      const banLogChannel = guild.channels.cache.find(c =>
        c.name.toLowerCase().replace(/[-_\s]/g, '').includes('banlog')
      );
      if (!banLogChannel) return;

      const permissions = banLogChannel.permissionsFor(guild.members.me);
      if (!permissions?.has(['SendMessages', 'EmbedLinks'])) return;

      const embed = new EmbedBuilder()
        .setTitle('🔨 User Banned')
        .setColor(0xED4245)
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'User', value: `${user.toString()} (${user.tag})`, inline: true },
          { name: 'User ID', value: `\`${user.id}\``, inline: true },
          { name: 'Reason', value: reason || 'No reason provided', inline: false },
        )
        .setTimestamp();

      await banLogChannel.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Error in guildBanAdd event:', error);
    }
  }
};
