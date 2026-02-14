import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags, Collection, REST, Routes, ChannelType, SlashCommandBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle} from "discord.js";
import Tesseract from "tesseract.js";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import { MongoClient } from "mongodb";

process.on("uncaughtException", (err) => console.error("uncaughtException", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));

console.log("DEVILWOLF_BUILD=DEFINITIVE");

const NL = "\n";

const app = express();

/**
 * ALWAYS-ON / SELF-HEAL (Koyeb)
 * Nota: si el servicio está configurado para "scale to zero", el código NO puede impedir que Koyeb lo duerma.
 * Esto añade:
 *  - pings internos + pings externos opcionales (KEEPALIVE_URL)
 *  - logs de reconexión Discord
 *  - handlers de errores fatales para reinicio automático del contenedor
 */
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || ""; // ej: https://tu-servicio.koyeb.app/health
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 60_000); // 60s

async function safeFetch(url, timeoutMs = 10_000) {
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "devilwolf-keepalive" } });
    clearTimeout(t);
    // leemos poco (evita streams colgados)
    try { await res.text(); } catch {}
    if (!res.ok) console.warn(`⚠️ keepalive non-200: ${res.status} ${url}`);
  } catch (e) {
    console.warn("⚠️ keepalive ping failed:", e?.message || e);
  }
}

function startKeepalive(localPort) {
  const local = `http://127.0.0.1:${localPort}/health`;
  // ping local para mantener event-loop vivo y detectar si el health responde
  setInterval(() => { safeFetch(local); }, KEEPALIVE_INTERVAL_MS).unref?.();

  // ping externo opcional (sirve para rutas públicas / wake)
  if (KEEPALIVE_URL) {
    setInterval(() => { safeFetch(KEEPALIVE_URL); }, KEEPALIVE_INTERVAL_MS).unref?.();
    console.log(`🔁 Keepalive externo activo: ${KEEPALIVE_URL} cada ${KEEPALIVE_INTERVAL_MS}ms`);
  } else {
    console.log(`🔁 Keepalive interno activo (local /health) cada ${KEEPALIVE_INTERVAL_MS}ms`);
  }
}

// Self-heal: log + reinicio controlado para que Koyeb relance el contenedor
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException (reiniciando contenedor):", err);
  // exit para que Koyeb reinicie automáticamente
  process.exit(1);
});

app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).send("ok"));
const PORT = parseInt(process.env.PORT || process.env.KOYEB_PORT || "8000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Health server listening on ${PORT}`);
  startKeepalive(PORT);
});
const AUTO_DELETE_MS = parseInt(process.env.AUTO_DELETE_MS || "30000", 10);
const OCR_CHANNEL_ID = process.env.OCR_CHANNEL_ID || "";

const AI_TRANSLATE_URL = process.env.AI_TRANSLATE_URL || "";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "llama3-70b-8192";
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || "20000", 10);

if (!AI_TRANSLATE_URL || !AI_API_KEY) {
  console.error("Missing AI_TRANSLATE_URL or AI_API_KEY");
}

const LANGS = [
  { key: "es", label: "🇪🇸", to: "es", name: "Spanish" },
  { key: "en", label: "🇬🇧", to: "en", name: "English" },
  { key: "fr", label: "🇫🇷", to: "fr", name: "French" },
  { key: "pt", label: "🇵🇹", to: "pt", name: "Portuguese" },
  { key: "de", label: "🇩🇪", to: "de", name: "German" },
  { key: "el", label: "🇬🇷", to: "el", name: "Greek" },
  { key: "pl", label: "🇵🇱", to: "pl", name: "Polish" },
  { key: "ar", label: "🇸🇦", to: "ar", name: "Arabic" },
  { key: "ru", label: "🇷🇺", to: "ru", name: "Russian" },
  { key: "ja", label: "🇯🇵", to: "ja", name: "Japanese" },
  { key: "ko", label: "🇰🇷", to: "ko", name: "Korean" },
  { key: "zh", label: "🇨🇳", to: "zh", name: "Chinese" },
  { key: "vi", label: "🇻🇳", to: "vi", name: "Vietnamese" }
];


// =====================
// SELECT_LANGUAGE (Wizard + Translate + Roles + Mongo)
// =====================
const SL_LANGS = [
  { key: "es", label: "🇪🇸", name: "Spanish" },
  { key: "en", label: "🇬🇧", name: "English" },
  { key: "fr", label: "🇫🇷", name: "French" },
  { key: "pt", label: "🇵🇹", name: "Portuguese" },
  { key: "de", label: "🇩🇪", name: "German" },
  { key: "el", label: "🇬🇷", name: "Greek" },
  { key: "pl", label: "🇵🇱", name: "Polish" },
  { key: "ar", label: "🇸🇦", name: "Arabic" },
  { key: "ru", label: "🇷🇺", name: "Russian" },
  { key: "ja", label: "🇯🇵", name: "Japanese" },
  { key: "ko", label: "🇰🇷", name: "Korean" },
  { key: "zh", label: "🇨🇳", name: "Chinese" },
  { key: "vi", label: "🇻🇳", name: "Vietnamese" }
];

function slPickLangFromLocale(locale) {
  const l = (locale || "").toLowerCase();
  const p = l.split("-")[0];
  const found = SL_LANGS.find(x => x.key === p);
  return found ? found.key : "en";
}

function slBuildTranslateRow(messageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sl:tr:${messageId}`).setLabel("TRANSLATE").setStyle(ButtonStyle.Primary)
  );
}

function slBuildFlagsRows(messageId) {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;
  for (const l of SL_LANGS) {
    if (count === 5) { rows.push(row); row = new ActionRowBuilder(); count = 0; }
    row.addComponents(
      new ButtonBuilder().setCustomId(`sl:flag:${l.key}:${messageId}`).setLabel(l.label).setStyle(ButtonStyle.Secondary)
    );
    count++;
  }
  if (count) rows.push(row);
  return rows;
}

// Wizard state (configuración de roles por idioma con RoleSelectMenuBuilder -> buscador nativo)
const slWizard = new Map();

const slModalPending = new Map();

function slClassifyMedia(url) {
  const u = (url || "").trim();
  if (!u) return { imageUrl: "", linkUrl: "" };
  const lower = u.toLowerCase();

  const isImage =
    lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
    lower.endsWith(".webp") || lower.endsWith(".gif") ||
    (lower.includes("cdn.discordapp.com") && (lower.includes(".png") || lower.includes(".jpg") || lower.includes(".jpeg") || lower.includes(".webp") || lower.includes(".gif")));

  const isVideo =
    lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov") || lower.endsWith(".m4v") ||
    lower.includes("youtube.com/") || lower.includes("youtu.be/") || lower.includes("twitch.tv/") || lower.includes("vimeo.com/");

  if (isImage) return { imageUrl: u, linkUrl: "" };
  if (isVideo) return { imageUrl: "", linkUrl: u };
  return { imageUrl: "", linkUrl: u };
}
 // userId -> { channelId, title, textOriginal, imageUrl, roleMap }

function slBuildConfigFlagsRows() {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;
  for (const l of SL_LANGS) {
    if (count === 5) { rows.push(row); row = new ActionRowBuilder(); count = 0; }
    row.addComponents(
      new ButtonBuilder().setCustomId(`slcfg:lang:${l.key}`).setLabel(l.label).setStyle(ButtonStyle.Secondary)
    );
    count++;
  }
  if (count) rows.push(row);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("slcfg:publish").setLabel("ACEPTAR").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("slcfg:cancel").setLabel("CANCELAR").setStyle(ButtonStyle.Danger)
    )
  );
  return rows;
}

function slBuildRoleSelectRow(langKey) {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(`slcfg:role:${langKey}`)
    .setPlaceholder(`BUSCAR Y SELECCIONAR ROL (${langKey.toUpperCase()})`)
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder().addComponents(menu);
}

const SL_DB_PATH = process.env.SL_DB_PATH || "./data/selectLanguage.json";
let slCol = null;
let slCache = { messages: {}, removeRules: {} };

function slEnsureDB() {
  const dir = SL_DB_PATH.split("/").slice(0, -1).join("/") || ".";
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (!fs.existsSync(SL_DB_PATH)) {
    try { fs.writeFileSync(SL_DB_PATH, JSON.stringify({ messages: {}, removeRules: {} }, null, 2)); } catch {}
  }
}

function slLoadDB() {
  if (slCol) return slCache;
  slEnsureDB();
  try { return JSON.parse(fs.readFileSync(SL_DB_PATH, "utf-8")); }
  catch { return { messages: {}, removeRules: {} }; }
}

function slSaveDB(db) {
  if (slCol) {
    slCache = db;
    slCol.updateOne({ _id: "config" }, { $set: db }, { upsert: true }).catch(()=>{});
    return;
  }
  slEnsureDB();
  fs.writeFileSync(SL_DB_PATH, JSON.stringify(db, null, 2));
}

async function slMongoInit() {
  try {
    if (!mongoClient) return;
    const db = mongoClient.db();
    slCol = db.collection("select_language");
    const doc = await slCol.findOne({ _id: "config" }).catch(()=>null);
    if (doc) slCache = doc;
    else await slCol.updateOne({ _id: "config" }, { $setOnInsert: slCache }, { upsert: true }).catch(()=>{});
  } catch (e) {
    console.error("SelectLanguage Mongo init error:", e);
    slCol = null;
    slEnsureDB();
  }
}

function slSummary(roleMap) {
  const lines = [];
  for (const l of SL_LANGS) {
    const rid = roleMap?.[l.key];
    if (rid) lines.push(`${l.label}  <@&${rid}>`);
  }
  return lines.length ? lines.join("\n") : "Sin roles asignados todavía.";
}


async function slOpenModal(interaction) {
  const channel = interaction.options.getChannel("canal");
  const imgAtt = interaction.options.getAttachment("imagen");
  const optUrl = interaction.options.getString("url") || "";
  const attachmentUrl = imgAtt?.url || "";

  if (!channel?.isTextBased?.()) {
    return interaction.reply({ content: "❌ Canal inválido.", flags: MessageFlags.Ephemeral });
  }

  slModalPending.set(interaction.user.id, { channelId: channel.id, attachmentUrl, optUrl });

  const modal = new ModalBuilder()
    .setCustomId("slcfg:modal")
    .setTitle("Select your language");

  const titleInput = new TextInputBuilder()
    .setCustomId("sl_title")
    .setLabel("Título")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200)
    .setRequired(true);

  const textInput = new TextInputBuilder()
    .setCustomId("sl_text")
    .setLabel("Texto")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true);

  const urlInput = new TextInputBuilder()
    .setCustomId("sl_url")
    .setLabel("URL opcional (imagen/gif/video)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("https://...");

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(textInput),
    new ActionRowBuilder().addComponents(urlInput)
  );

  return interaction.showModal(modal);
}

async function slStartWizardFromModal(interaction, payload) {
  const { channelId, attachmentUrl, optUrl } = payload || {};
  const title = (interaction.fields.getTextInputValue("sl_title") || "").trim();
  const textOriginal = (interaction.fields.getTextInputValue("sl_text") || "").trim();
  const modalUrl = (interaction.fields.getTextInputValue("sl_url") || "").trim();

  const mediaCandidate = attachmentUrl || modalUrl || optUrl || "";
  const { imageUrl, linkUrl } = slClassifyMedia(mediaCandidate);

  slWizard.set(interaction.user.id, { channelId, title, textOriginal, imageUrl, linkUrl, roleMap: {} });

  return interaction.reply({
    content:
      `**${title.toUpperCase()}**\n` +
      `Editor guardado. Ahora asigna roles a cada bandera (pulsa bandera → elige rol).\n` +
      `Cuando termines, pulsa **ACEPTAR**.\n\n` +
      `Media: ${mediaCandidate ? "✅ añadida" : "—"} (adjunto/URL)`,
    components: slBuildConfigFlagsRows(),
    flags: MessageFlags.Ephemeral
  });
}

async function slPublish(interaction) {
  const st = slWizard.get(interaction.user.id);
  if (!st) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral });

  const channel = await client.channels.fetch(st.channelId).catch(()=>null);
  if (!channel?.isTextBased?.()) return interaction.reply({ content: "❌ Canal inválido.", flags: MessageFlags.Ephemeral });

  const titleUp = (st.title || "").toUpperCase();
  
const embed = {
  title: titleUp,
  description: [
    `**${titleUp}**`,
    "",
    (st.textOriginal || "").trim(),
    st.linkUrl ? "" : "",
    st.linkUrl ? `🔗 ${st.linkUrl}` : ""
  ].filter(Boolean).join("\n").trim(),
  image: st.imageUrl ? { url: st.imageUrl } : undefined
};

  
const sent = await channel.send({
  content: st.linkUrl ? st.linkUrl : undefined,
  embeds: [embed],
  components: [slBuildTranslateRow("pending"), ...slBuildFlagsRows("pending")]
});

  await sent.edit({ components: [slBuildTranslateRow(sent.id), ...slBuildFlagsRows(sent.id)] });

  const db = slLoadDB();
  db.messages ||= {};
  db.messages[sent.id] = {
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: sent.id,
    title: st.title,
    textOriginal: st.textOriginal,
    imageUrl: st.imageUrl,
    roleMap: st.roleMap || {}
  };
  slSaveDB(db);

  slWizard.delete(interaction.user.id);
  return interaction.update({ content: "✅ PUBLICADO.", components: [] }).catch(()=>{});
}

async function slHandleTranslateButton(interaction, messageId) {
  const db = slLoadDB();
  const cfg = db.messages?.[messageId];
  if (!cfg) return interaction.reply({ content: "⚠️ No encuentro la configuración.", flags: MessageFlags.Ephemeral });

  // Preferencia guardada
  let target = await getUserLang(interaction.guildId, interaction.user.id).catch(()=>null);

  if (!target) {
    // Si no hay preferencia, intenta por rol asignado a idioma en este anuncio
    const member = interaction.member;
    for (const [lang, roleId] of Object.entries(cfg.roleMap || {})) {
      if (!roleId) continue;
      if (member?.roles?.cache?.has?.(roleId)) { target = lang; break; }
    }
  }
  if (!target) target = slPickLangFromLocale(interaction.locale);

  const translatedArr = await aiTranslateBatch([cfg.textOriginal], target, target);
  const translated = translatedArr?.[0] || cfg.textOriginal;

  return interaction.reply({ content: `**${target.toUpperCase()}**\n${translated}`, flags: MessageFlags.Ephemeral });
}

async function slHandleFlagButton(interaction, lang, messageId) {
  const db = slLoadDB();
  const cfg = db.messages?.[messageId];
  if (!cfg) return interaction.reply({ content: "⚠️ No encuentro la configuración.", flags: MessageFlags.Ephemeral });

  const roleId = cfg.roleMap?.[lang];
  if (!roleId) return interaction.reply({ content: `⚠️ No hay rol configurado para ${lang.toUpperCase()}.`, flags: MessageFlags.Ephemeral });

  const me = interaction.guild?.members?.me;
  if (!me?.permissions?.has?.("ManageRoles")) {
    return interaction.reply({ content: "❌ No tengo permiso ManageRoles.", flags: MessageFlags.Ephemeral });
  }

  const member = interaction.member;
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return interaction.reply({ content: "❌ Rol no encontrado.", flags: MessageFlags.Ephemeral });
  if (me.roles.highest.position <= role.position) {
    return interaction.reply({ content: "❌ Rol por encima de mi jerarquía.", flags: MessageFlags.Ephemeral });
  }

  const otherRoleIds = Object.values(cfg.roleMap || {}).filter(Boolean).filter(r => r !== roleId);
  try {
    if (otherRoleIds.length) {
      const toRemove = otherRoleIds.filter(r => member.roles.cache.has(r));
      if (toRemove.length) await member.roles.remove(toRemove).catch(()=>{});
    }
    if (!member.roles.cache.has(roleId)) await member.roles.add(roleId);
  } catch {
    return interaction.reply({ content: "❌ No pude modificar tus roles.", flags: MessageFlags.Ephemeral });
  }

  // Guardar preferencia de idioma del usuario para OCR
  await setUserLang(interaction.guildId, interaction.user.id, lang).catch(()=>{});

  return interaction.reply({ content: `✅ Idioma asignado: ${lang.toUpperCase()}.`, flags: MessageFlags.Ephemeral });
}

// REMOVE_ROL wizard (con buscador y selección marcable)
const rrWizard = new Map(); // userId -> { channelId, rolesToRemove }

function rrBuildChannelSelect() {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId("rrcfg:channel")
    .setPlaceholder("BUSCAR Y SELECCIONAR 1+ CANALES")
    .setMinValues(1)
    .setMaxValues(25)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  return new ActionRowBuilder().addComponents(menu);
}

function rrBuildRoleSelect() {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId("rrcfg:roles")
    .setPlaceholder("BUSCAR Y MARCAR ROLES A ELIMINAR")
    .setMinValues(1)
    .setMaxValues(25);
  return new ActionRowBuilder().addComponents(menu);
}

function rrBuildAcceptRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rrcfg:accept").setLabel("ACEPTAR").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("rrcfg:cancel").setLabel("CANCELAR").setStyle(ButtonStyle.Danger)
  );
}

async function rrStartWizard(interaction) {
  rrWizard.set(interaction.user.id, { channelId: null, rolesToRemove: [] });
  return interaction.reply({
    content: "**REMOVE_ROL**\nSelecciona canal y luego roles (con buscador).",
    components: [rrBuildChannelSelect()],
    flags: MessageFlags.Ephemeral
  });
}

async function rrOnMemberUpdate(oldMember, newMember) {
  try {
    const db = slLoadDB();
    const rulesByGuild = db.removeRules?.[newMember.guild.id];
    if (!rulesByGuild) return;

    for (const [channelId, rule] of Object.entries(rulesByGuild)) {
      const ch = await newMember.guild.channels.fetch(channelId).catch(()=>null);
      if (!ch) continue;

      const before = ch.permissionsFor(oldMember).has("ViewChannel");
      const after  = ch.permissionsFor(newMember).has("ViewChannel");
      if (before || !after) continue;

      const rolesToRemove = (rule?.rolesToRemove || []).filter(Boolean);
      if (!rolesToRemove.length) continue;

      const me = newMember.guild.members.me;
      if (!me?.permissions?.has?.("ManageRoles")) continue;

      const removable = rolesToRemove.filter(rid => {
        const role = newMember.guild.roles.cache.get(rid);
        return role && me.roles.highest.position > role.position;
      });

      if (!removable.length) continue;
      await newMember.roles.remove(removable).catch(()=>{});
    }
  } catch (e) {
    console.error("remove_rol GuildMemberUpdate error:", e);
  }
}

// =====================
// MIRROR (Función Espejo)
// =====================
const MIRROR_LANGS = [
  { key: "en", label: "🇬🇧", to: "en", name: "English" },
  { key: "es", label: "🇪🇸", to: "es", name: "Spanish" },
  { key: "fr", label: "🇫🇷", to: "fr", name: "French" },
  { key: "pt", label: "🇵🇹", to: "pt", name: "Portuguese" },
  { key: "de", label: "🇩🇪", to: "de", name: "German" },
  { key: "el", label: "🇬🇷", to: "el", name: "Greek" },
  { key: "pl", label: "🇵🇱", to: "pl", name: "Polish" },
  { key: "ar", label: "🇸🇦", to: "ar", name: "Arabic" },
  { key: "ru", label: "🇷🇺", to: "ru", name: "Russian" },
  { key: "ja", label: "🇯🇵", to: "ja", name: "Japanese" },
  { key: "ko", label: "🇰🇷", to: "ko", name: "Korean" },
  { key: "zh", label: "🇨🇳", to: "zh", name: "Chinese" },
  { key: "vi", label: "🇻🇳", to: "vi", name: "Vietnamese" }
];

const MIRROR_DB_PATH = process.env.MIRROR_DB_PATH || "./data/mirrorGroups.json";

// Cache de webhooks para impersonar usuario en espejo
const mirrorWebhookCache = new Collection();

async function mirrorGetOrCreateWebhook(channel) {
  const cached = mirrorWebhookCache.get(channel.id);
  if (cached) return cached;

  const hooks = await channel.fetchWebhooks().catch(() => null);
  let hook = hooks?.find(h => h?.name === "DEVILWOLF_MIRROR");

  if (!hook) {
    hook = await channel.createWebhook({ name: "DEVILWOLF_MIRROR" }).catch(() => null);
  }

  if (hook) mirrorWebhookCache.set(channel.id, hook);
  return hook;
}

function mirrorExtractUrls(text) {
  const urlRe = /(https?:\/\/[^\s<>()]+)|((?:(?:www\.)[^\s<>()]+))/gi;
  const urls = [];
  const cleaned = (text || "").replace(urlRe, (m)=>{ urls.push(m); return ""; });
  return { cleaned: cleaned.replace(/\s+/g," ").trim(), urls };
}

function mirrorMemberColorInt(member) {
  const hex = member?.displayHexColor;
  if (!hex || hex === "#000000") return null;
  try { return parseInt(hex.replace("#",""), 16); } catch { return null; }
}

const MONGO_URI = process.env.MONGO_URI || "";
let mongoClient = null;
let mirrorCol = null;
let mirrorCache = { groups: {} };

async function mirrorMongoInit() {
  if (!MONGO_URI) return;
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db();
    mirrorCol = db.collection("mirror");
    const doc = await mirrorCol.findOne({ _id: "config" });
    if (doc && doc.groups) mirrorCache = { groups: doc.groups };
    else {
      await mirrorCol.updateOne({_id:"config"}, {$setOnInsert:{groups:{}}}, {upsert:true});
      mirrorCache = { groups: {} };
    }
  } catch (e) {
    console.error("Mongo init error:", e);
    // Fallback a JSON local si Mongo falla
    mirrorCol = null;
    ensureMirrorDB();
  }
}


// =====================
// USER PREFS (Mongo): idioma por usuario
// =====================
let userPrefsCol = null;

async function userPrefsMongoInit() {
  try {
    if (!mongoClient) return;
    const db = mongoClient.db();
    userPrefsCol = db.collection("user_prefs");
  } catch {
    userPrefsCol = null;
  }
}

async function setUserLang(guildId, userId, lang) {
  if (!guildId || !userId || !lang) return;
  if (!userPrefsCol) return;
  await userPrefsCol.updateOne(
    { _id: `${guildId}:${userId}` },
    { $set: { lang, updatedAt: new Date() } },
    { upsert: true }
  ).catch(()=>{});
}

async function getUserLang(guildId, userId) {
  if (!guildId || !userId) return null;
  if (!userPrefsCol) return null;
  const doc = await userPrefsCol.findOne({ _id: `${guildId}:${userId}` }).catch(()=>null);
  return doc?.lang || null;
}

function ensureMirrorDB() {
  const dir = MIRROR_DB_PATH.split("/").slice(0, -1).join("/") || ".";
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (!fs.existsSync(MIRROR_DB_PATH)) {
    try { fs.writeFileSync(MIRROR_DB_PATH, JSON.stringify({ groups: {} }, null, 2)); } catch {}
  }
}

function loadMirrorDB() {
  if (mirrorCol) return mirrorCache;
  ensureMirrorDB();
  try {
    return JSON.parse(fs.readFileSync(MIRROR_DB_PATH, "utf-8"));
  } catch {
    return { groups: {} };
  }
}

function saveMirrorDB(db) {
  if (mirrorCol) {
    mirrorCache = db;
    mirrorCol.updateOne({_id:"config"}, {$set: db}, {upsert:true}).catch(()=>{});
    return;
  }
  ensureMirrorDB();
  fs.writeFileSync(MIRROR_DB_PATH, JSON.stringify(db, null, 2));
}

function mirrorGetGroups() {
  const db = loadMirrorDB();
  return Object.keys(db.groups || {});
}

function mirrorCreateGroup(name) {
  const db = loadMirrorDB();
  db.groups ||= {};
  if (!db.groups[name]) db.groups[name] = { channels: [] };
  saveMirrorDB(db);
}

function mirrorDeleteGroups(names) {
  const db = loadMirrorDB();
  db.groups ||= {};
  for (const n of names) delete db.groups[n];
  saveMirrorDB(db);
}

function mirrorAddChannel(groupName, channelId, langCode) {
  const db = loadMirrorDB();
  db.groups ||= {};
  if (!db.groups[groupName]) db.groups[groupName] = { channels: [] };
  const arr = db.groups[groupName].channels ||= [];
  // upsert
  const existing = arr.find(x => x.channelId === channelId);
  if (existing) existing.lang = langCode;
  else arr.push({ channelId, lang: langCode });
  saveMirrorDB(db);
}

function mirrorRemoveChannel(groupName, channelId) {
  const db = loadMirrorDB();
  db.groups ||= {};
  if (!db.groups[groupName]) return;
  db.groups[groupName].channels = (db.groups[groupName].channels || []).filter(x => x.channelId !== channelId);
  saveMirrorDB(db);
}

function mirrorFindGroupByChannel(channelId) {
  const db = loadMirrorDB();
  const groups = db.groups || {};
  for (const [g, data] of Object.entries(groups)) {
    const ch = (data.channels || []).find(x => x.channelId === channelId);
    if (ch) return { groupName: g, group: data, channel: ch };
  }
  return null;
}

function mirrorGetGroupChannels(groupName) {
  const db = loadMirrorDB();
  const g = db.groups?.[groupName];
  return g?.channels || [];
}

// UI builders
function mirrorBuildGroupSelect(customId, groups, placeholder="Selecciona grupo", min=1, max=1) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(min)
    .setMaxValues(max);

  for (const g of groups.slice(0, 25)) {
    menu.addOptions({ label: g, value: g });
  }
  return new ActionRowBuilder().addComponents(menu);
}

function mirrorBuildLangSelect(customId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Selecciona idioma")
    .setMinValues(1)
    .setMaxValues(1);

  for (const l of MIRROR_LANGS.slice(0, 25)) {
    menu.addOptions({ label: `${l.label} ${l.name}`, value: l.to });
  }
  return new ActionRowBuilder().addComponents(menu);
}

function mirrorBuildChannelSelect(customId) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Selecciona canal")
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  return new ActionRowBuilder().addComponents(menu);
}

// Temp wizard state
const mirrorWizard = new Map(); // userId -> { step, groupName, channelId }

async function registerAllCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.warn("Commands not registered: missing DISCORD_CLIENT_ID or DISCORD_TOKEN");
    return;
  }

  const mirror = [
    new SlashCommandBuilder()
      .setName("crear_grupo")
      .setDescription("Crear grupo de alianzas (espejo)")
      .addStringOption(o => o.setName("nombre").setDescription("Nombre del grupo").setRequired(true)),
    new SlashCommandBuilder()
      .setName("eliminar_grupo")
      .setDescription("Eliminar grupos de alianzas (espejo)"),
    new SlashCommandBuilder()
      .setName("añadir_canal")
      .setDescription("Añadir canal a un grupo (espejo)"),
    new SlashCommandBuilder()
      .setName("remover_canal")
      .setDescription("Remover canal de un grupo (espejo)"),
    new SlashCommandBuilder()
      .setName("limpiar")
      .setDescription("Borra una cantidad de mensajes del canal (y del grupo espejo si aplica)")
      .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad a borrar (1-1000)").setRequired(true))
  ];

  const ocr = new SlashCommandBuilder()
    .setName("ocr")
    .setDescription("OCR de burbujas (Turbo)")
    .addAttachmentOption(o => o.setName("imagen").setDescription("Imagen adjunta").setRequired(false))
    .addStringOption(o => o.setName("url").setDescription("URL de imagen o link de mensaje").setRequired(false));

  
const select = new SlashCommandBuilder()
  .setName("select_language")
  .setDescription("Publica anuncio con Translate + banderas (wizard roles con editor modal)")
  .addChannelOption(o => o.setName("canal").setDescription("Canal destino").setRequired(true))
  .addAttachmentOption(o => o.setName("imagen").setDescription("Adjunta imagen/GIF (opcional)").setRequired(false))
  .addStringOption(o => o.setName("url").setDescription("URL opcional (imagen/gif/video) si no adjuntas archivo").setRequired(false));

  const remove = new SlashCommandBuilder()
    .setName("remove_rol")
  try {
    if (guildId) {
      // Limpia global para evitar comandos duplicados si se usan guild commands
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      console.log("🧹 Global slash commands cleared.");

      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log("✅ All slash commands registered (guild).");
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("✅ All slash commands registered (global).");
    }
  } catch (e) {
    console.error("❌ Error registering slash commands:", e);
  }
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});


client.on("warn", (m) => console.warn("⚠️ discord warn:", m));
client.on("error", (e) => console.error("❌ discord client error:", e));
client.on("shardError", (e) => console.error("❌ discord shardError:", e));
client.on("shardDisconnect", (event, id) => console.warn(`⚠️ discord shardDisconnect shard=${id} code=${event?.code}`));
client.on("shardReconnecting", (id) => console.log(`🔄 discord shardReconnecting shard=${id}`));
client.on("shardReady", (id) => console.log(`✅ discord shardReady shard=${id}`));

client.once(Events.ClientReady, async () => {
  await mirrorMongoInit();
  await userPrefsMongoInit();
  await slMongoInit();
  console.log(`Bot conectado como ${client.user.tag}`);
  await registerAllCommands();
});
const requests = new Map();

function isOCRChannel(message) {
  if (!message.guild) return false;
  if (OCR_CHANNEL_ID && message.channel?.id === OCR_CHANNEL_ID) return true;
  const name = (message.channel?.name || "").toLowerCase();
  return name === "ocr";
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/\S+/i);
  if (!m) return null;
  return m[0].replace(/[)\],.!?]+$/g, "");
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function resolveImageUrlFromMessage(message) {
  if (message.attachments?.size) {
    const att = message.attachments.first();
    if (att?.url) return att.url;
  }

  const content = message.content || "";

  const linkMatch = content.match(/https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i);
  if (linkMatch) {
    const channelId = linkMatch[2];
    const messageId = linkMatch[3];
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch?.isTextBased?.()) {
        const linkedMsg = await ch.messages.fetch(messageId);
        if (linkedMsg?.attachments?.size) {
          const att2 = linkedMsg.attachments.first();
          if (att2?.url) return att2.url;
        }
        const emb = linkedMsg?.embeds?.find(e => e?.image?.url || e?.thumbnail?.url);
        if (emb?.image?.url) return emb.image.url;
        if (emb?.thumbnail?.url) return emb.thumbnail.url;
      }
    } catch {}
  }

  const url = extractFirstUrl(content);
  if (!url) return null;

  if (/\.(png|jpg|jpeg|webp|gif)$/i.test(url)) return url;

  try {
    const head = await fetchWithTimeout(url, { method: "HEAD" }, 8000);
    const ct = (head.headers.get("content-type") || "").toLowerCase();
    if (ct.startsWith("image/")) return url;
  } catch {}

  try {
    const get = await fetchWithTimeout(url, { method: "GET" }, 8000);
    const ct = (get.headers.get("content-type") || "").toLowerCase();
    if (ct.startsWith("image/")) return url;
  } catch {}

  return null;
}


async function ocrRunAndDm(user, imageUrl, targetLang) {
  let imgBuf;
  try {
    const res = await fetchWithTimeout(imageUrl, {}, 20000);
    if (!res.ok) throw new Error("fetch failed");
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) throw new Error("not image");
    imgBuf = Buffer.from(await res.arrayBuffer());
  } catch {
    return { ok: false, error: "fetch" };
  }

  let outBuf;
  try {
    outBuf = await processImage(imgBuf, targetLang);
  } catch (e) {
    console.error(e);
    return { ok: false, error: "process" };
  }

  try {
    await user.send({
      files: [{ attachment: outBuf, name: "translated.png" }],
      components: [buildDmRow()]
    });
  } catch {
    return { ok: false, error: "dm" };
  }

  return { ok: true };
}

function buildLangRows(requestId) {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;

  for (const l of LANGS) {
    if (count === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
      count = 0;
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`lang:${l.key}:${requestId}`)
        .setLabel(l.label)
        .setStyle(ButtonStyle.Secondary)
    );
    count++;
  }
  if (count) rows.push(row);
  return rows;
}

function buildDmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dm:clear").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("dm:close").setLabel("Close DM").setStyle(ButtonStyle.Danger)
  );
}

async function googleTranslateBatch(texts, to) {
  // Free unofficial endpoint (no key). Best-effort.
  const out = [];
  for (const t of texts) {
    const q = encodeURIComponent(t || "");
    if (!q) { out.push(""); continue; }
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${q}`;
    try {
      const res = await fetchWithTimeout(url, { method: "GET" }, 12000);
      if (!res.ok) throw new Error("gtx");
      const j = await res.json();
      const chunks = (j?.[0] || []).map(x => x?.[0]).filter(Boolean);
      out.push(chunks.join(""));
    } catch {
      out.push(t);
    }
  }
  return out;
}

async function aiTranslateBatch(texts, to, toName = "") {
  // Always translate; fallback to Google if AI fails/missing.
  const clean = texts.map(s => (s || "").replace(/\s+/g, " ").trim());
  const want = toName || to;

  // If AI not configured, go direct to Google.
  if (!AI_TRANSLATE_URL || !AI_API_KEY) {
    return await googleTranslateBatch(clean, to);
  }

  const prompt = [
    `Translate each input string to ${want} (language code: ${to}).`,
    `Return ONLY a valid JSON array of strings.`,
    `Same length and same order as input. No extra keys. No commentary.`,
    JSON.stringify(clean)
  ].join(NL);

  let aiOk = false;
  try {
    const res = await fetchWithTimeout(
      AI_TRANSLATE_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: "system", content: "You are a translation engine. Output JSON only. No markdown." },
            { role: "user", content: prompt }
          ],
          temperature: 0
        })
      },
      AI_TIMEOUT_MS
    );

    const json = await res.json().catch(() => null);
    const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "[]";

    const arr = JSON.parse(content);
    if (Array.isArray(arr) && arr.length === clean.length) {
      aiOk = true;
      return arr.map(x => (typeof x === "string" ? x : String(x)));
    }
  } catch {}

  // Fallback
  if (!aiOk) {
    return await googleTranslateBatch(clean, to);
  }
  return clean;
}

async function preprocessForOCR(inputBuffer) {
  return await sharp(inputBuffer)
    .rotate()
    .resize({ width: 1800, withoutEnlargement: true })
    .grayscale()
    .normalise()
    .sharpen()
    .png()
    .toBuffer();
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

async function processImage(inputBuffer, targetLang) {
  const image = await loadImage(inputBuffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  // --- Detect chat bubbles by color-connected components on downscaled image ---
  const scale = 0.25;
  const sw = Math.max(1, Math.floor(canvas.width * scale));
  const sh = Math.max(1, Math.floor(canvas.height * scale));
  const sc = createCanvas(sw, sh);
  const sctx = sc.getContext("2d");
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const img = sctx.getImageData(0, 0, sw, sh);
  const d = img.data;

  const idx = (x, y) => (y * sw + x) * 4;
  const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  // Beige fill heuristic for Age of Origins chat bubbles:
  // high luminance, R and G high, B moderately high.
  function isBubbleFill(i) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const L = lum(i);
    if (L < 120) return false;
    if (r < 150 || g < 140 || b < 90) return false;
    // avoid pure white UI areas
    if (r > 245 && g > 245 && b > 245) return false;
    // beige-ish (R,G close, B lower)
    if (r - b < 30) return false;
    return true;
  }

  const seen = new Uint8Array(sw * sh);
  const rects = [];
  const qx = new Int32Array(sw * sh);
  const qy = new Int32Array(sw * sh);

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = y * sw + x;
      if (seen[si]) continue;
      const i = idx(x, y);
      if (!isBubbleFill(i)) continue;

      // BFS
      let qh = 0, qt = 0;
      qx[qt] = x; qy[qt] = y; qt++;
      seen[si] = 1;

      let minX = x, minY = y, maxX = x, maxY = y;
      let area = 0;

      while (qh < qt) {
        const cx = qx[qh], cy = qy[qh]; qh++;
        area++;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;

        // 4-neighbors
        const nbs = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
        for (const [nx, ny] of nbs) {
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          const nsi = ny * sw + nx;
          if (seen[nsi]) continue;
          const ni = idx(nx, ny);
          if (!isBubbleFill(ni)) continue;
          seen[nsi] = 1;
          qx[qt] = nx; qy[qt] = ny; qt++;
        }
      }

      const w = (maxX - minX + 1);
      const h = (maxY - minY + 1);

      // Filter components: big enough and roughly rectangular speech-bubble areas
      if (area < 1500) continue;
      if (w < 120 || h < 40) continue;
      const ar = w / h;
      if (ar < 1.2 || ar > 12.0) continue;

      rects.push({ minX, minY, maxX, maxY, area });
    }
  }

  // Merge overlapping rectangles (downscaled space)
  rects.sort((a,b)=> (a.minY-b.minY) || (a.minX-b.minX));
  const merged = [];
  function overlaps(a,b) {
    const ax0=a.minX-10, ay0=a.minY-10, ax1=a.maxX+10, ay1=a.maxY+10;
    const bx0=b.minX, by0=b.minY, bx1=b.maxX, by1=b.maxY;
    return !(bx1 < ax0 || bx0 > ax1 || by1 < ay0 || by0 > ay1);
  }
  for (const r of rects) {
    let placed=false;
    for (const m of merged) {
      if (overlaps(m,r)) {
        m.minX=Math.min(m.minX,r.minX);
        m.minY=Math.min(m.minY,r.minY);
        m.maxX=Math.max(m.maxX,r.maxX);
        m.maxY=Math.max(m.maxY,r.maxY);
        m.area += r.area;
        placed=true;
        break;
      }
    }
    if (!placed) merged.push({ ...r });
  }

  // Convert to original scale, add inset to stay within border
  const bubbles = merged
    .map(r => {
      const x0 = clamp(Math.floor(r.minX / scale), 0, canvas.width-1);
      const y0 = clamp(Math.floor(r.minY / scale), 0, canvas.height-1);
      const x1 = clamp(Math.ceil((r.maxX+1) / scale), 0, canvas.width);
      const y1 = clamp(Math.ceil((r.maxY+1) / scale), 0, canvas.height);
      const w = Math.max(10, x1 - x0);
      const h = Math.max(10, y1 - y0);
      const inset = Math.max(8, Math.floor(Math.min(w, h) * 0.05));
      return {
        x: x0 + inset,
        y: y0 + inset,
        w: Math.max(10, w - inset*2),
        h: Math.max(10, h - inset*2)
      };
    })
    // remove tiny after inset
    .filter(b => b.w > 80 && b.h > 30)
    // sort top to bottom
    .sort((a,b)=> (a.y-b.y) || (a.x-b.x));

  if (!bubbles.length) {
    // fallback: do old whole-image OCR by returning original
    return canvas.toBuffer("image/png");
  }

  // OCR each bubble crop
  const texts = [];
  const hints = [];

  for (const b of bubbles) {
    const crop = await sharp(inputBuffer)
      .extract({ left: Math.floor(b.x), top: Math.floor(b.y), width: Math.floor(b.w), height: Math.floor(b.h) })
      .png()
      .toBuffer();

    const pre = await preprocessForOCR(crop);
    const { data } = await Tesseract.recognize(pre, "eng", { logger: () => {} });
    let t = (data.text || "").replace(/\s+/g, " ").trim();
    // drop strange symbols
    t = t.replace(/[^A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF .,!?:;()\-\"'\n\r\t]/g, "").replace(/\s+/g, " ").trim();
    texts.push(t);
    // font hint from average line height if possible
    const hs = (data.lines || []).map(l => (l?.bbox ? ((l.bbox.y1 ?? l.bbox.bottom) - (l.bbox.y0 ?? l.bbox.top)) : 0)).filter(v=>v>0).sort((a,b)=>a-b);
    hints.push(hs.length ? hs[Math.floor(hs.length/2)] : 18);
  }

  const translated = await aiTranslateBatch(texts, targetLang, (LANGS.find(l=>l.to===targetLang)?.name || ""));

  function sampleAvgColor(x, y, w, h) {
    const sx = clamp(Math.floor((x + w/2) * scale), 0, sw-1);
    const sy = clamp(Math.floor((y + h/2) * scale), 0, sh-1);
    const ii = idx(sx, sy);
    return [d[ii], d[ii+1], d[ii+2]];
  }

  function wrap(text, fontSize, maxWidth) {
    ctx.font = `bold ${fontSize}px Arial`;
    const words = (text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const out = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
    return out;
  }

  // Render back into each bubble, fully covering old text area
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    const txt = (translated[i] || "").trim();
    if (!txt) continue;

    const bg = sampleAvgColor(b.x, b.y, b.w, b.h);
    ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(b.x, b.y, b.w, b.h);

    const pad = Math.max(10, Math.floor(Math.min(b.w, b.h) * 0.08));
    const maxW = Math.max(10, b.w - pad*2);
    const maxH = Math.max(10, b.h - pad*2);

    // Use OCR hint to match original; scale back from preprocessed space (~ resize to 1800px width)
    let fontSize = Math.max(18, Math.floor(hints[i] * 0.90 * 0.90));
    fontSize = Math.min(fontSize, Math.floor(b.h * 0.70));

    while (fontSize > 12) {
      const linesArr = wrap(txt, fontSize, maxW);
      const lineH = Math.floor(fontSize * 1.15);
      if (linesArr.length * lineH <= maxH) break;
      fontSize--;
    }

    const linesArr = wrap(txt, fontSize, maxW);
    const lineH = Math.floor(fontSize * 1.15);
    const totalH = linesArr.length * lineH;

    const startY = b.y + pad + Math.max(0, Math.floor((maxH - totalH) / 2));
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.fillStyle = "black";
    ctx.textBaseline = "top";

    for (let li = 0; li < linesArr.length; li++) {
      const lw = ctx.measureText(linesArr[li]).width;
      const startX = b.x + pad + Math.max(0, Math.floor((maxW - lw) / 2));
      ctx.fillText(linesArr[li], startX, startY + li*lineH);
    }
  }

  return canvas.toBuffer("image/png");
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;

    // ----- Mirror routing -----
    if (message.guild && message.channel?.id) {
      // Evita bucles: no replicar mensajes de webhooks/bots
      if (message.webhookId) return;

      const hit = mirrorFindGroupByChannel(message.channel.id);
      if (hit) {
        const peers = (hit.group.channels || []).filter(x => x.channelId !== message.channel.id);

        const rawContent = (message.content || "").trim();
        const urlRegex = /https?:\/\/\S+/gi;
        const urlsInText = rawContent.match(urlRegex) || [];
        const textForTranslate = rawContent.replace(urlRegex, "").trim();
        const attachmentCount = message.attachments?.size || 0;

        // Nada que replicar
        if (!textForTranslate && !urlsInText.length && !attachmentCount) {
          // no-op
        } else {
          const member = message.member || (message.guild ? await message.guild.members.fetch(message.author.id).catch(() => null) : null);
          const avatarURL =
            member?.displayAvatarURL?.({ size: 128 }) ||
            message.author.displayAvatarURL?.({ size: 128 }) ||
            undefined;

          for (const p of peers) {
            try {
              const destCh = await client.channels.fetch(p.channelId).catch(() => null);
              if (!destCh?.isTextBased?.()) continue;

              let translatedText = "";
              if (textForTranslate) {
                const translatedArr = await aiTranslateBatch(
                  [textForTranslate],
                  p.lang,
                  (MIRROR_LANGS.find(l => l.to === p.lang)?.name || "")
                );
                translatedText = (translatedArr?.[0] || "").trim();
              }

              const textUrls = urlsInText.filter(Boolean);
              const userMention = `<@${message.author.id}>`;
              const contentInline = [userMention, translatedText, ...textUrls].filter(Boolean).join(NL) || undefined;

              const filesPayload = Array.from(message.attachments?.values?.() || [])
                .map(a => ({ attachment: a.url, name: a.name || "file" }));

              const hook = await mirrorGetOrCreateWebhook(destCh);
              const sendPayload = {
                username: (member?.displayName || message.author.username),
                avatarURL,
                content: contentInline,
                files: filesPayload.length ? filesPayload : undefined,
                allowedMentions: { parse: [], users: [message.author.id] }
              };

              if (hook) await hook.send(sendPayload).catch(() => {});
              else await destCh.send(sendPayload).catch(() => {});
            } catch {}
          }
        }
      }
    }

    if (!isOCRChannel(message)) return;

    const imageUrl = await resolveImageUrlFromMessage(message);
    if (!imageUrl) return;

    const savedLang = await getUserLang(message.guildId, message.author.id).catch(()=>null);
    if (savedLang) {
      const status = await message.reply({ content: "Procesando OCR..." }).catch(()=>null);
      await ocrRunAndDm(message.author, imageUrl, savedLang);
      setTimeout(async () => {
        try { await status?.delete(); } catch {}
        try { await message.delete(); } catch {}
      }, AUTO_DELETE_MS);
      return;
    }

    const requestId = `${message.id}:${message.author.id}`;
    requests.set(requestId, { userId: message.author.id, imageUrl, createdAt: Date.now() });

    const selector = await message.reply({
      content: "Selecciona idioma:",
      components: buildLangRows(requestId)
    });

    setTimeout(async () => {
      try { await selector.delete(); } catch {}
      try { await message.delete(); } catch {}
      requests.delete(requestId);
    }, AUTO_DELETE_MS);
  } catch (e) {
    console.error(e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {

// ----- Select_language modal -----
if (interaction.isModalSubmit()) {
  const cid = interaction.customId || "";
  if (cid === "slcfg:modal") {
    const payload = slModalPending.get(interaction.user.id);
    slModalPending.delete(interaction.user.id);
    if (!payload?.channelId) {
      return interaction.reply({ content: "⚠️ Modal expirado. Vuelve a ejecutar /select_language.", flags: MessageFlags.Ephemeral });
    }
    return await slStartWizardFromModal(interaction, payload);
  }
}

    // ----- Select_language buttons -----
    
    if (interaction.isAnySelectMenu()) {
      const cid = interaction.customId || "";

      if (cid.startsWith("slcfg:role:")) {
        const langKey = cid.split(":")[2];
        const st = slWizard.get(interaction.user.id);
        if (!st) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const roleId = interaction.values?.[0];
        st.roleMap ||= {};
        st.roleMap[langKey] = roleId;
        slWizard.set(interaction.user.id, st);
        return interaction.reply({ content: `✅ ${langKey.toUpperCase()} → <@&${roleId}>\n${slSummary(st.roleMap)}`, flags: MessageFlags.Ephemeral }).catch(()=>{});
      }

      if (cid === "rrcfg:channel") {
        const st = rrWizard.get(interaction.user.id);
        if (!st) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        st.channelIds = (interaction.values || []).slice(0, 25);
        rrWizard.set(interaction.user.id, st);
        const chText = st.channelIds.length ? st.channelIds.map(id => `<#${id}>`).join(", ") : "—";
        return interaction.update({
          content: `**REMOVE_ROL**
CANALES: ${chText}
SELECCIONA ROLES Y PULSA **ACEPTAR**.`,
          components: [rrBuildRoleSelect(), rrBuildAcceptRow()]
        }).catch(()=>{});
      }

      if (cid === "rrcfg:roles") {
        const st = rrWizard.get(interaction.user.id);
        if (!st) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        st.rolesToRemove = interaction.values || [];
        rrWizard.set(interaction.user.id, st);
        return interaction.reply({ content: `✅ ROLES: ${st.rolesToRemove.map(r=>`<@&${r}>`).join(" ")}`, flags: MessageFlags.Ephemeral }).catch(()=>{});
      }

      // ----- MIRROR select menus -----
      if (cid.startsWith("mirror:del:groups:")) {
        const owner = cid.split(":")[3];
        if (owner !== interaction.user.id) return interaction.reply({ content: "⚠️ No autorizado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const selected = interaction.values || [];
        if (!selected.length) return interaction.reply({ content: "Nada seleccionado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        mirrorDeleteGroups(selected);
        return interaction.update({ content: `✅ Eliminados: ${selected.join(", ")}`, components: [] }).catch(()=>{});
      }

      if (cid.startsWith("mirror:add:group:")) {
        const owner = cid.split(":")[3];
        if (owner !== interaction.user.id) return interaction.reply({ content: "⚠️ No autorizado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const groupName = interaction.values?.[0];
        if (!groupName) return interaction.reply({ content: "Grupo inválido.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        mirrorWizard.set(interaction.user.id, { step: "add_channel", groupName });
        return interaction.update({ content: `Grupo: ${groupName}\nSelecciona canal:`, components: [mirrorBuildChannelSelect(`mirror:add:channel:${interaction.user.id}`)] }).catch(()=>{});
      }

      if (cid.startsWith("mirror:add:channel:")) {
        const owner = cid.split(":")[3];
        if (owner !== interaction.user.id) return interaction.reply({ content: "⚠️ No autorizado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const channelId = interaction.values?.[0];
        const st = mirrorWizard.get(interaction.user.id);
        if (!st?.groupName) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        mirrorWizard.set(interaction.user.id, { step: "add_lang", groupName: st.groupName, channelId });
        return interaction.update({ content: `Grupo: ${st.groupName}\nCanal: <#${channelId}>\nSelecciona idioma:`, components: [mirrorBuildLangSelect(`mirror:add:lang:${interaction.user.id}`)] }).catch(()=>{});
      }

      if (cid.startsWith("mirror:add:lang:")) {
        const owner = cid.split(":")[3];
        if (owner !== interaction.user.id) return interaction.reply({ content: "⚠️ No autorizado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const langCode = interaction.values?.[0];
        const st = mirrorWizard.get(interaction.user.id);
        if (!st?.groupName || !st?.channelId) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        mirrorAddChannel(st.groupName, st.channelId, langCode);
        mirrorWizard.delete(interaction.user.id);
        return interaction.update({ content: `✅ Añadido <#${st.channelId}> a ${st.groupName} (${langCode})`, components: [] }).catch(()=>{});
      }

      if (cid.startsWith("mirror:rm:group:")) {
        const owner = cid.split(":")[3];
        if (owner !== interaction.user.id) return interaction.reply({ content: "⚠️ No autorizado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const groupName = interaction.values?.[0];
        if (!groupName) return interaction.reply({ content: "Grupo inválido.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        mirrorWizard.set(interaction.user.id, { step: "rm_channel", groupName });
        return interaction.update({ content: `Grupo: ${groupName}\nSelecciona canal a remover:`, components: [mirrorBuildChannelSelect(`mirror:rm:channel:${interaction.user.id}`)] }).catch(()=>{});
      }

      if (cid.startsWith("mirror:rm:channel:")) {
        const owner = cid.split(":")[3];
        if (owner !== interaction.user.id) return interaction.reply({ content: "⚠️ No autorizado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        const channelId = interaction.values?.[0];
        const st = mirrorWizard.get(interaction.user.id);
        if (!st?.groupName) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
        mirrorRemoveChannel(st.groupName, channelId);
        mirrorWizard.delete(interaction.user.id);
        return interaction.update({ content: `✅ Removido <#${channelId}> de ${st.groupName}`, components: [] }).catch(()=>{});
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId || "";


      if (cid.startsWith("slcfg:")) {
        const parts = cid.split(":");
        if (parts[1] === "lang") {
          const langKey = parts[2];
          const st = slWizard.get(interaction.user.id);
          if (!st) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
          return interaction.reply({ content: `**${(st.title||"").toUpperCase()}**\nROL PARA ${langKey.toUpperCase()}:`, components: [slBuildRoleSelectRow(langKey)], flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
        if (parts[1] === "publish") return await slPublish(interaction);
        if (parts[1] === "cancel") {
          slWizard.delete(interaction.user.id);
          return interaction.update({ content: "✅ CANCELADO.", components: [] }).catch(()=>{});
        }
      }

      if (cid.startsWith("rrcfg:")) {
        if (cid === "rrcfg:accept") {
          const st = rrWizard.get(interaction.user.id);
          const channels = (st?.channelIds || []).filter(Boolean);
          if (!channels.length || !(st.rolesToRemove||[]).length) {
            return interaction.reply({ content: "⚠️ FALTA CANAL(ES) O ROLES.", flags: MessageFlags.Ephemeral }).catch(()=>{});
          }
          const db = slLoadDB();
          db.removeRules ||= {};
          db.removeRules[interaction.guildId] ||= {};
          for (const chId of channels) {
            db.removeRules[interaction.guildId][chId] = Array.from(new Set(st.rolesToRemove));
          }
          slSaveDB(db);
          rrWizard.delete(interaction.user.id);
          const chText = channels.map(id => `<#${id}>`).join(", ");
          return interaction.update({
            content: `✅ Guardado. CANALES: ${chText}
ROLES: ${st.rolesToRemove.map(r=>`<@&${r}>`).join(" ")}`,
            components: []
          }).catch(()=>{});
        }

        if (cid === "rrcfg:cancel") {
          rrWizard.delete(interaction.user.id);
          return interaction.update({ content: "✅ CANCELADO.", components: [] }).catch(()=>{});
        }
      }


      if (cid.startsWith("slcfg:")) {
        const parts = cid.split(":");
        if (parts[1] === "lang") {
          const langKey = parts[2];
          const st = slWizard.get(interaction.user.id);
          if (!st) return interaction.reply({ content: "⚠️ Wizard expirado.", flags: MessageFlags.Ephemeral }).catch(()=>{});
          return interaction.reply({ content: `**${(st.title||"").toUpperCase()}**\nROL PARA ${langKey.toUpperCase()}:`, components: [slBuildRoleSelectRow(langKey)], flags: MessageFlags.Ephemeral }).catch(()=>{});
        }
        if (parts[1] === "publish") return await slPublish(interaction);
        if (parts[1] === "cancel") {
          slWizard.delete(interaction.user.id);
          return interaction.update({ content: "✅ CANCELADO.", components: [] }).catch(()=>{});
        }
      }

      if (cid.startsWith("rrcfg:")) {
        if (cid === "rrcfg:accept") {
          const st = rrWizard.get(interaction.user.id);
          if (!st?.channelId || !(st.rolesToRemove||[]).length) return interaction.reply({ content: "⚠️ FALTA CANAL O ROLES.", flags: MessageFlags.Ephemeral }).catch(()=>{});
          const db = slLoadDB();
          db.removeRules ||= {};
          db.removeRules[interaction.guildId] ||= {};
          db.removeRules[interaction.guildId][st.channelId] = { rolesToRemove: st.rolesToRemove };
          slSaveDB(db);
          rrWizard.delete(interaction.user.id);
          return interaction.update({ content: "✅ GUARDADO.", components: [] }).catch(()=>{});
        }
        if (cid === "rrcfg:cancel") {
          rrWizard.delete(interaction.user.id);
          return interaction.update({ content: "✅ CANCELADO.", components: [] }).catch(()=>{});
        }
      }

      const parts = (interaction.customId || "").split(":");
      if (parts[0] === "sl") {
        if (parts[1] === "tr") return await slHandleTranslateButton(interaction, parts[2]);
        if (parts[1] === "flag") return await slHandleFlagButton(interaction, parts[2], parts[3]);
      }
    }

    // ----- Mirror slash commands -----
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "select_language") return await slOpenModal(interaction);
      if (interaction.commandName === "remove_rol") return await rrStartWizard(interaction);
      const cmd = interaction.commandName;


      // /ocr (manual)
      if (cmd === "ocr") {
        const att = interaction.options.getAttachment("imagen");
        const url = interaction.options.getString("url");

        let imageUrl = null;
        if (att?.url) imageUrl = att.url;
        else if (url) imageUrl = url;

        if (!imageUrl) {
          return interaction.reply({ content: "❌ Adjunta una imagen o proporciona una URL.", flags: MessageFlags.Ephemeral });
        }

        // Reutiliza el resolvedor (soporta links de mensajes y urls)
        const fakeMsg = { guild: interaction.guild, channel: interaction.channel, content: String(imageUrl) };
        fakeMsg.attachments = {
          size: att ? 1 : 0,
          first: () => (att ? { url: att.url } : null)
        };

        const resolved = await resolveImageUrlFromMessage(fakeMsg);
        if (!resolved) {
          return interaction.reply({ content: "❌ No pude resolver una imagen válida desde esa entrada.", flags: MessageFlags.Ephemeral });
        }

        const savedLang = await getUserLang(interaction.guildId, interaction.user.id).catch(()=>null);
        if (savedLang) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(()=>{});
          await ocrRunAndDm(interaction.user, resolved, savedLang);
          return interaction.editReply({ content: "Done." }).catch(()=>{});
        }

        const requestId = `${interaction.id}:${interaction.user.id}`;
        requests.set(requestId, { userId: interaction.user.id, imageUrl: resolved, createdAt: Date.now() });

        return interaction.reply({
          content: "Selecciona idioma:",
          components: buildLangRows(requestId),
          flags: MessageFlags.Ephemeral
        });
      }

      // /select_language
      if (cmd === "select_language") return await slHandleSelectLanguageCommand(interaction);

      // /remove_rol
      if (cmd === "remove_rol") return await slHandleRemoveRolCommand(interaction);

      if (cmd === "limpiar") {
        const amountRaw = interaction.options.getInteger("cantidad", true);
        const amount = Math.max(1, Math.min(1000, amountRaw));

        await interaction.reply({ content: `Limpiando ${amount} mensajes...`, flags: MessageFlags.Ephemeral }).catch(()=>{});

        const ch = interaction.channel;
        if (!ch || !ch.isTextBased?.()) return;

        const bulkDeleteN = async (channel, nToDelete) => {
          let remaining = nToDelete;
          let total = 0;
          while (remaining > 0) {
            const batch = Math.min(100, remaining);
            const deleted = await channel.bulkDelete(batch, true).catch(()=>null);
            const count = deleted?.size || 0;
            total += count;
            remaining -= batch;
            if (count < 2) break;
          }
          return total;
        };

        let totalDeleted = 0;

        try {
          const hit = mirrorFindGroupByChannel(ch.id);
          if (hit) {
            for (const entry of (hit.group.channels || [])) {
              const destCh = await client.channels.fetch(entry.channelId).catch(()=>null);
              if (!destCh?.isTextBased?.()) continue;
              totalDeleted += await bulkDeleteN(destCh, amount);
            }
          } else {
            totalDeleted += await bulkDeleteN(ch, amount);
          }
        } catch {}

        await interaction.followUp({ content: `Hecho. Eliminados ~${totalDeleted} mensajes.`, flags: MessageFlags.Ephemeral }).catch(()=>{});
        return;
      }

      if (cmd === "crear_grupo") {
        const name = (interaction.options.getString("nombre") || "").trim();
        if (!name) return interaction.reply({ content: "Nombre inválido.", flags: MessageFlags.Ephemeral });
        mirrorCreateGroup(name);
        return interaction.reply({ content: "OK", flags: MessageFlags.Ephemeral });
      }

      if (cmd === "eliminar_grupo") {
        const groups = mirrorGetGroups();
        if (!groups.length) return interaction.reply({ content: "No hay grupos.", flags: MessageFlags.Ephemeral });

        const row = mirrorBuildGroupSelect(`mirror:del:groups:${interaction.user.id}`, groups, "Selecciona grupos a eliminar", 1, Math.min(25, groups.length));
        return interaction.reply({ content: "Selecciona grupos:", components: [row], flags: MessageFlags.Ephemeral });
      }

      if (cmd === "añadir_canal") {
        const groups = mirrorGetGroups();
        if (!groups.length) return interaction.reply({ content: "No hay grupos. Usa /crear_grupo", flags: MessageFlags.Ephemeral });

        mirrorWizard.set(interaction.user.id, { step: "add_group" });
        const row = mirrorBuildGroupSelect(`mirror:add:group:${interaction.user.id}`, groups, "Selecciona grupo", 1, 1);
        return interaction.reply({ content: "Selecciona grupo:", components: [row], flags: MessageFlags.Ephemeral });
      }

      if (cmd === "remover_canal") {
        const groups = mirrorGetGroups();
        if (!groups.length) return interaction.reply({ content: "No hay grupos.", flags: MessageFlags.Ephemeral });

        mirrorWizard.set(interaction.user.id, { step: "rm_group" });
        const row = mirrorBuildGroupSelect(`mirror:rm:group:${interaction.user.id}`, groups, "Selecciona grupo", 1, 1);
        return interaction.reply({ content: "Selecciona grupo:", components: [row], flags: MessageFlags.Ephemeral });
      }
    }

    // ----- Mirror menus -----
    
    // ----- Existing OCR buttons -----
    if (!interaction.isButton()) return;

    const id = interaction.customId || "";

    if (id === "dm:clear") {
      try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        await interaction.message.delete().catch(() => {});
      } catch {}
      return;
    }

    if (id === "dm:close") {
      try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

        const ch = interaction.channel;
        const botId = client.user?.id;
        if (ch?.isDMBased?.() && botId) {
          let before;
          let scanned = 0;
          while (scanned < 800) {
            const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
            if (!batch || batch.size === 0) break;
            const msgs = Array.from(batch.values());
            before = msgs[msgs.length - 1].id;
            scanned += msgs.length;
            for (const m of msgs) {
              if (m.author?.id === botId) await m.delete().catch(() => {});
            }
          }
        }
        await interaction.message.delete().catch(() => {});
      } catch {}
      return;
    }

    if (!id.startsWith("lang:")) return;

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    } catch {
      return;
    }

    const parts = id.split(":");
    const langKey = parts[1];
    const requestId = parts.slice(2).join(":");

    const req = requests.get(requestId);
    if (!req || interaction.user?.id !== req.userId) {
      await interaction.editReply({ content: "Expired." }).catch(() => {});
      return;
    }

    const lang = LANGS.find(x => x.key === langKey) || LANGS[0];
    await setUserLang(interaction.guildId, interaction.user.id, lang.to).catch(()=>{});

    let imgBuf;
    try {
      const res = await fetchWithTimeout(req.imageUrl, {}, 20000);
      if (!res.ok) throw new Error("fetch failed");
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("image/")) throw new Error("not image");
      imgBuf = Buffer.from(await res.arrayBuffer());
    } catch {
      await interaction.editReply({ content: "Error." }).catch(() => {});
      return;
    }

    let outBuf;
    try {
      outBuf = await processImage(imgBuf, lang.to);
    } catch (e) {
      console.error(e);
      await interaction.editReply({ content: "Error." }).catch(() => {});
      return;
    }

    try {
      await interaction.user.send({
        files: [{ attachment: outBuf, name: "translated.png" }],
        components: [buildDmRow()]
      });
    } catch {}

    await interaction.editReply({ content: "Done." }).catch(() => {});


// Auto-cleanup after processing (original msg + selector)
try {
  const msgId = (requestId.split(":")[0] || "").trim();
  const ch = interaction.channel;
  setTimeout(async () => {
    try { await interaction.message?.delete?.().catch(() => {}); } catch {}
    try {
      if (msgId && ch?.messages?.fetch) {
        const om = await ch.messages.fetch(msgId).catch(() => null);
        await om?.delete?.().catch(() => {});
      }
    } catch {}
    try { requests.delete(requestId); } catch {}
  }, AUTO_DELETE_MS);
} catch {}

    try {
      if (interaction.message?.editable) {
        await interaction.message.edit({ components: [] }).catch(() => {});
      }
    } catch {}
  } catch (e) {
    console.error(e);
    try {
      if (interaction.isRepliable()) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: "Error.", flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
          await interaction.editReply({ content: "Error." }).catch(() => {});
        }
      }
    } catch {}
  }
});


const __TOKEN = process.env.DISCORD_TOKEN;

let __isLeader = false;
let __leaderMongoReady = false;

async function ensureLeaderMongo() {
  if (__leaderMongoReady) return true;
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI env var (needed for failover leader lock).");
    return false;
  }
  try {
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGO_URI);
    }
    // connect only once
    await mongoClient.connect();
    __leaderMongoReady = true;
    return true;
  } catch (e) {
    console.error("❌ Failed to connect Mongo for leader lock:", e);
    return false;
  }
}

async function leaderTick() {
  if (!__TOKEN) return console.error("❌ Missing DISCORD_TOKEN env var.");
  const ok = await ensureLeaderMongo();
  if (!ok) return;

  const lease = Number(process.env.LEADER_LEASE_MS || 60000);
    const me = process.env.INSTANCE_ID || process.env.HOSTNAME || "unknown-host";
  const now = Date.now();

  try {
    const col = mongoClient.db().collection("leader");
    await col.updateOne({_id:"devilwolf"}, {$setOnInsert:{instance:"", lastSeen:0}}, {upsert:true});
    const doc = await col.findOne({_id:"devilwolf"});

    if (!doc || (now - (doc.lastSeen||0)) > lease) {
      await col.updateOne({_id:"devilwolf"}, {$set:{instance:me,lastSeen:now}}, {upsert:true});
    }

    const cur = await col.findOne({_id:"devilwolf"});
    const leader = cur?.instance === me;

    if (leader && !__isLeader) {
      __isLeader = true;
      console.log("🟢 Leader acquired by:", me);
      client.once(Events.ClientReady, (c) => {
        console.log(`🐺 Devilwolf conectado como ${c.user.tag}`);
      });
      client.login(__TOKEN).catch((e)=>console.error("❌ Discord login failed:", e));
    }

    if (!leader && __isLeader) {
      __isLeader = false;
      console.log("🟡 Leadership lost. Standby mode (no destroy).");
      // standby: do not destroy client on Koyeb/PC failover
      // keep connection alive; handlers should check __isLeader as needed
      
    }

    if (leader) {
      await col.updateOne({_id:"devilwolf"}, {$set:{instance:me,lastSeen:now}}, {upsert:true});
    }
  } catch (e) {
    console.error("Leader tick error:", e);
  }
}

setInterval(leaderTick, 15000).unref?.();
leaderTick();

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  await rrOnMemberUpdate(oldMember, newMember);

  try { await slOnMemberUpdate(oldMember, newMember); } catch (e) { console.error("remove_rol GuildMemberUpdate error:", e); }
});
