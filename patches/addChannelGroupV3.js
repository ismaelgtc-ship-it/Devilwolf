
// Devilwolf: add_channel v3 (Group -> Flags -> Apply to mirror channels)
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, Events } = require('discord.js');
const { MongoClient } = require('mongodb');

async function getDb(){
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if(!uri) return null;
  const mc = new MongoClient(uri);
  await mc.connect();
  return mc.db();
}

const LANGS = [
  { label:'Español', value:'es', emoji:'🇪🇸' },
  { label:'Inglés', value:'en', emoji:'🇬🇧' },
  { label:'Francés', value:'fr', emoji:'🇫🇷' },
  { label:'Alemán', value:'de', emoji:'🇩🇪' },
  { label:'Italiano', value:'it', emoji:'🇮🇹' },
  { label:'Japonés', value:'ja', emoji:'🇯🇵' }
];

function attach(client){
  if (!client || client.__addch3_attached) return;
  client.__addch3_attached = true;

  client.on(Events.InteractionCreate, async (interaction)=>{
    try{
      if(interaction.isChatInputCommand() && interaction.commandName==='add_channel'){
        const db = await getDb(); if(!db) return;
        const g = await db.collection('guildGroups').findOne({ guildId: interaction.guild.id });
        if(!g?.groups?.length){
          return interaction.reply({ content:'No hay grupos.', ephemeral:true });
        }
        const embed = new EmbedBuilder()
          .setTitle('Añadir Idiomas al Grupo')
          .setDescription('Selecciona el grupo');
        const row = new ActionRowBuilder();
        for(const grp of g.groups.slice(0,5)){
          row.addComponents(new ButtonBuilder()
            .setCustomId(`acg_${grp.id}`)
            .setLabel(`Grupo ${grp.id}`)
            .setStyle(ButtonStyle.Primary));
        }
        return interaction.reply({ embeds:[embed], components:[row], ephemeral:true });
      }

      if(interaction.isButton() && interaction.customId.startsWith('acg_')){
        const groupId = interaction.customId.split('_')[1];
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`acg_lang_${groupId}`)
          .setPlaceholder('Selecciona idiomas')
          .setMinValues(1)
          .setMaxValues(LANGS.length)
          .addOptions(LANGS);
        const row = new ActionRowBuilder().addComponents(menu);
        return interaction.update({
          content:'Selecciona los idiomas que quieres añadir al grupo',
          embeds:[],
          components:[row]
        });
      }

      if(interaction.isStringSelectMenu() && interaction.customId.startsWith('acg_lang_')){
        const db = await getDb(); if(!db) return;
        const groupId = interaction.customId.split('_')[2];
        const langs = interaction.values;
        await db.collection('groupMirrorLangs').updateOne(
          { guildId: interaction.guild.id, groupId },
          { $set: { mirrorLanguages: langs } },
          { upsert:true }
        );
        return interaction.reply({ content:'Idiomas añadidos al grupo correctamente.', ephemeral:true });
      }

    }catch(e){}
  });
}

if (globalThis?.client) attach(globalThis.client);
setInterval(()=>{ if(globalThis?.client && !globalThis.client.__addch3_attached) attach(globalThis.client); }, 2000);

module.exports = { attach };
