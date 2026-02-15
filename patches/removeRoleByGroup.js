
// Devilwolf: remove_rol by Group (Buttons -> Role -> Auto remove on channel access)
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, Events } = require('discord.js');
const { MongoClient } = require('mongodb');

let clientRef;
async function getDb() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) return null;
  const mc = new MongoClient(uri);
  await mc.connect();
  return mc.db();
}

function attach(client){
  if (!client || client.__rrg_attached) return;
  client.__rrg_attached = true;
  clientRef = client;

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand && interaction.isChatInputCommand() && interaction.commandName === 'remove_rol') {
        const db = await getDb(); if(!db) return;
        const g = await db.collection('guildGroups').findOne({ guildId: interaction.guild.id });
        if(!g?.groups?.length){
          return interaction.reply({ content:'No hay grupos configurados.', ephemeral:true });
        }
        const embed = new EmbedBuilder()
          .setTitle('Remove Role por Grupo')
          .setDescription('Selecciona el grupo donde se eliminará un rol al acceder a sus canales');
        const rows = [];
        let row = new ActionRowBuilder();
        let count=0;
        for (const grp of g.groups.slice(0,25)) {
          if (count===5){ rows.push(row); row = new ActionRowBuilder(); count=0; }
          row.addComponents(new ButtonBuilder()
            .setCustomId(`rr_group_${grp.id}`)
            .setLabel(`Grupo ${grp.id}`)
            .setStyle(ButtonStyle.Primary));
          count++;
        }
        if (row.components?.length) rows.push(row);
        return interaction.reply({ embeds:[embed], components:rows, ephemeral:true });
      }

      if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('rr_group_')) {
        const groupId = interaction.customId.split('_')[2];
        const roleMenu = new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId(`rr_role_${groupId}`)
            .setPlaceholder('Selecciona el rol a eliminar')
        );
        return interaction.update({
          content: 'Selecciona el rol que se eliminará al entrar en los canales del grupo',
          embeds: [],
          components: [roleMenu]
        });
      }

      if (interaction.isRoleSelectMenu && interaction.isRoleSelectMenu() && interaction.customId.startsWith('rr_role_')) {
        const db = await getDb(); if(!db) return;
        const groupId = interaction.customId.split('_')[2];
        const roleId = interaction.values[0];
        await db.collection('removeRoleGroups').updateOne(
          { guildId: interaction.guild.id, groupId },
          { $set: { roleId } },
          { upsert: true }
        );
        return interaction.reply({ content:'Rol configurado correctamente.', ephemeral:true });
      }
    } catch(e){}
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      if (!newState.channelId) return;
      const member = newState.member;
      const db = await getDb(); if(!db) return;

      const guildData = await db.collection('guildGroups').findOne({ guildId: member.guild.id });
      if(!guildData?.groups?.length) return;

      const configs = await db.collection('removeRoleGroups').find({ guildId: member.guild.id }).toArray();
      if(!configs?.length) return;

      for (const cfg of configs){
        const group = guildData.groups.find(g=>g.id===cfg.groupId);
        if(!group?.channels?.length) continue;
        const hit = group.channels.some(c=>c.channelId===newState.channelId);
        if(hit && member.roles.cache.has(cfg.roleId)){
          await member.roles.remove(cfg.roleId).catch(()=>{});
        }
      }
    } catch(e){}
  });
}

// Try auto-attach
if (globalThis?.client) attach(globalThis.client);
setInterval(()=>{ if(!clientRef && globalThis?.client) attach(globalThis.client); }, 2000);

module.exports = { attach };
