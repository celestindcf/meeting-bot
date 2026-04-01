const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, REST, Routes } = require('discord.js');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
const path = require('path');
const { checkLicence, isPremium } = require('./licenceChecker');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_CLIENT_ID';
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://cdevaux112_db_user:39lSnyFFMsXw58w9@meeting-bot-1.pit4jyx.mongodb.net/?appName=meeting-bot-1';
const PANEL_URL = process.env.PANEL_URL || 'https://meeting-bot-9now.onrender.com';

let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db('meetingbot');
  console.log('✅ MongoDB connecté !');
}
function col(name) { return db.collection(name); }

const STAFF_LEVELS = {
  1: { name: 'Membre', color: 0x57F287 },
  2: { name: 'Organisateur', color: 0xFEE75C },
  3: { name: 'Admin', color: 0xED4245 },
  4: { name: 'Super Admin', color: 0x5865F2 }
};

function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Message d'erreur licence ─────────────────────────────────────────────────
function noLicenceEmbed() {
  return new EmbedBuilder()
    .setTitle('❌ Licence requise')
    .setColor(0xED4245)
    .setDescription('Ce serveur n\'a pas de licence active pour MeetingBot.\nContactez-nous pour obtenir une licence !')
    .setFooter({ text: 'NCL Services' });
}

function noPremiumEmbed(feature) {
  return new EmbedBuilder()
    .setTitle('⭐ Fonctionnalité Premium')
    .setColor(0xFEE75C)
    .setDescription(`**${feature}** est réservé aux serveurs Premium.\nPassez en premium pour débloquer cette fonctionnalité !`)
    .setFooter({ text: 'NCL Services' });
}

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent]
});

const commands = [
  new SlashCommandBuilder().setName('reunion').setDescription('Gérer les réunions')
    .addSubcommand(s => s.setName('creer').setDescription('Créer une réunion')
      .addStringOption(o => o.setName('titre').setDescription('Titre').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('Date (JJ/MM/AAAA HH:MM)').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Description')))
    .addSubcommand(s => s.setName('liste').setDescription('Calendrier des réunions'))
    .addSubcommand(s => s.setName('annuler').setDescription('Annuler')
      .addStringOption(o => o.setName('id').setDescription('ID réunion').setRequired(true))),

  new SlashCommandBuilder().setName('sujet').setDescription('Gérer les sujets')
    .addSubcommand(s => s.setName('proposer').setDescription('Proposer un sujet')
      .addStringOption(o => o.setName('sujet').setDescription('Votre sujet').setRequired(true))
      .addStringOption(o => o.setName('reunion_id').setDescription('ID réunion')))
    .addSubcommand(s => s.setName('liste').setDescription('Voir les sujets')
      .addStringOption(o => o.setName('reunion_id').setDescription('ID réunion')))
    .addSubcommand(s => s.setName('vote').setDescription('Lancer un vote')
      .addStringOption(o => o.setName('reunion_id').setDescription('ID réunion').setRequired(true))),

  new SlashCommandBuilder().setName('voc').setDescription('Chef de vocal')
    .addSubcommand(s => s.setName('sujet').setDescription('Sujet actuel')
      .addStringOption(o => o.setName('sujet').setDescription('Sujet').setRequired(true)))
    .addSubcommand(s => s.setName('prochain').setDescription('Sujet suivant'))
    .addSubcommand(s => s.setName('terminer').setDescription('Terminer la réunion')),

  new SlashCommandBuilder().setName('panel').setDescription('Lien du panel web'),

  new SlashCommandBuilder().setName('setup').setDescription('Configurer le bot')
    .addChannelOption(o => o.setName('canal_reunions').setDescription('Canal annonces').setRequired(true))
    .addRoleOption(o => o.setName('role_chef').setDescription('Rôle chef vocal'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('staffadd').setDescription('Ajouter un staff + créer accès panel')
    .addUserOption(o => o.setName('membre').setDescription('Membre Discord').setRequired(true))
    .addStringOption(o => o.setName('username').setDescription('Identifiant panel').setRequired(true))
    .addIntegerOption(o => o.setName('niveau').setDescription('Niveau 1-4').setRequired(true).setMinValue(1).setMaxValue(4))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('staffliste').setDescription('Liste du staff'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commandes enregistrées !');
  } catch (e) { console.error('❌', e); }
}

discordClient.once('ready', async () => {
  console.log(`🤖 ${discordClient.user.tag} connecté !`);
  await registerCommands();
});

discordClient.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    if (interaction.isButton()) await handleButton(interaction);
    if (interaction.isModalSubmit()) await handleModal(interaction);
  } catch (err) {
    console.error(err);
    const reply = { content: '❌ Erreur.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

async function handleCommand(interaction) {
  const { commandName, options, guildId, user, guild } = interaction;

  // ── Commandes sans vérification licence ──
  if (commandName === 'setup' || commandName === 'panel') {
    if (commandName === 'setup') {
      const channel = options.getChannel('canal_reunions');
      const role = options.getRole('role_chef');
      await col('configs').updateOne({ guildId }, { $set: { guildId, meetingChannel: channel.id, chefRole: role?.id || null, setupBy: user.id, setupAt: new Date().toISOString() } }, { upsert: true });
      const embed = new EmbedBuilder().setTitle('⚙️ Configuration enregistrée').setColor(0x5865F2)
        .addFields({ name: '📢 Canal', value: `<#${channel.id}>`, inline: true }, { name: '👑 Chef', value: role ? `<@&${role.id}>` : 'Non défini', inline: true });
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
    if (commandName === 'panel') {
      const embed = new EmbedBuilder().setTitle('🖥️ Panel des réunions').setColor(0x57F287)
        .setDescription(`🔗 **[Ouvrir le panel](${PANEL_URL}/?guild=${guildId})**`)
        .setFooter({ text: guild.name });
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  }

  // ── Vérification licence pour toutes les autres commandes ──
  const licence = await checkLicence(guildId);
  if (!licence.valid) {
    const reasons = {
      NO_LICENCE: 'Ce serveur n\'a pas de licence active.',
      BLOCKED: 'La licence de ce serveur a été révoquée.',
      EXPIRED: 'La licence de ce serveur a expiré.'
    };
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle('❌ Licence requise').setColor(0xED4245).setDescription(reasons[licence.reason] || 'Licence invalide. Contactez-nous !')], ephemeral: true });
    return;
  }

  if (commandName === 'staffadd') {
    const target = options.getUser('membre');
    const username = options.getString('username');
    const niveau = options.getInteger('niveau');
    const existing = await col('users').findOne({ guildId, username });
    if (existing) { await interaction.reply({ content: `❌ Nom d'utilisateur \`${username}\` déjà pris.`, ephemeral: true }); return; }
    const password = genPassword();
    const hashedPwd = await bcrypt.hash(password, 10);
    const count = await col('users').countDocuments({ guildId });
    await col('users').insertOne({ id: uuidv4(), username, password: hashedPwd, discordId: target.id, discordTag: target.tag, guildId, role: count === 0 ? 'admin' : 'staff', niveau, createdAt: new Date().toISOString() });
    try {
      const embed = new EmbedBuilder().setTitle('🖥️ Accès Panel — Réunions').setColor(0x5865F2)
        .setDescription(`Bienvenue dans l'équipe de **${guild.name}** !`)
        .addFields(
          { name: '👤 Identifiant', value: `\`${username}\``, inline: true },
          { name: '🔑 Mot de passe', value: `\`${password}\``, inline: true },
          { name: '🏅 Niveau', value: `${niveau} — ${STAFF_LEVELS[niveau].name}`, inline: true },
          { name: '🔗 Panel', value: `${PANEL_URL}/?guild=${guildId}` }
        ).setFooter({ text: '⚠️ Ne partagez jamais vos identifiants.' });
      await target.send({ embeds: [embed] });
      const confEmbed = new EmbedBuilder().setTitle('✅ Staff ajouté').setColor(STAFF_LEVELS[niveau].color)
        .addFields({ name: '👤 Membre', value: `<@${target.id}>`, inline: true }, { name: '🏅 Niveau', value: `${niveau} — ${STAFF_LEVELS[niveau].name}`, inline: true }, { name: '📩 MP', value: '✅ Identifiants envoyés' });
      await interaction.reply({ embeds: [confEmbed], ephemeral: true });
    } catch {
      await interaction.reply({ content: `⚠️ Compte créé mais MP impossible (DMs fermés).\n**Identifiant:** \`${username}\`\n**Mot de passe:** \`${password}\``, ephemeral: true });
    }
    return;
  }

  if (commandName === 'staffliste') {
    const staff = await col('users').find({ guildId }).sort({ niveau: -1 }).toArray();
    if (!staff.length) { await interaction.reply({ content: '❌ Aucun staff.', ephemeral: true }); return; }
    const embed = new EmbedBuilder().setTitle('👥 Staff').setColor(0x5865F2)
      .setDescription(staff.map(s => `**[Niv.${s.niveau}] ${STAFF_LEVELS[s.niveau]?.name}** — ${s.discordId ? `<@${s.discordId}>` : s.username}`).join('\n'));
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (commandName === 'reunion') {
    const sub = options.getSubcommand();
    const config = await col('configs').findOne({ guildId }) || {};
    if (sub === 'creer') {
      const titre = options.getString('titre');
      const dateStr = options.getString('date');
      const description = options.getString('description') || '';
      const [datePart, timePart] = dateStr.split(' ');
      const [day, month, year] = datePart.split('/');
      const [hour, min] = (timePart || '00:00').split(':');
      const meetingDate = new Date(year, month - 1, day, hour, min);
      if (isNaN(meetingDate)) { await interaction.reply({ content: '❌ Format invalide: JJ/MM/AAAA HH:MM', ephemeral: true }); return; }
      const meeting = { id: uuidv4().slice(0, 8), guildId, titre, description, date: meetingDate.toISOString(), createdBy: user.id, createdAt: new Date().toISOString(), status: 'planifiee', subjects: [] };
      await col('meetings').insertOne(meeting);
      const embed = new EmbedBuilder().setTitle('📅 Nouvelle réunion !').setColor(0x57F287)
        .addFields({ name: '📌 Titre', value: titre }, { name: '🗓️ Date', value: `<t:${Math.floor(meetingDate.getTime()/1000)}:F>`, inline: true }, { name: '🆔 ID', value: `\`${meeting.id}\``, inline: true }, { name: '📝 Description', value: description || '*Aucune*' })
        .setFooter({ text: `Par ${user.username}` }).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`propose_subject_${meeting.id}`).setLabel('📢 Proposer un sujet').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`view_subjects_${meeting.id}`).setLabel('📋 Voir les sujets').setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({ embeds: [embed], components: [row] });
      if (config.meetingChannel) { const ch = guild.channels.cache.get(config.meetingChannel); if (ch) await ch.send({ embeds: [embed], components: [row] }); }
      return;
    }
    if (sub === 'liste') {
      const all = await col('meetings').find({ guildId, status: { $ne: 'terminee' } }).sort({ date: 1 }).toArray();
      const upcoming = all.filter(m => new Date(m.date) >= new Date());
      if (!upcoming.length) { await interaction.reply({ content: '📅 Aucune réunion planifiée.', ephemeral: true }); return; }
      const embed = new EmbedBuilder().setTitle('📅 Calendrier').setColor(0x5865F2)
        .setDescription(upcoming.map((m, i) => `**${i+1}. ${m.titre}**\n📅 <t:${Math.floor(new Date(m.date).getTime()/1000)}:F> · 🆔 \`${m.id}\``).join('\n\n'));
      await interaction.reply({ embeds: [embed] });
      return;
    }
    if (sub === 'annuler') {
      const id = options.getString('id');
      const result = await col('meetings').updateOne({ guildId, id }, { $set: { status: 'annulee' } });
      if (result.matchedCount === 0) { await interaction.reply({ content: '❌ Réunion introuvable.', ephemeral: true }); return; }
      await interaction.reply({ content: `✅ Réunion \`${id}\` annulée.`, ephemeral: true });
      return;
    }
  }

  if (commandName === 'sujet') {
    const sub = options.getSubcommand();
    if (sub === 'proposer') {
      const texte = options.getString('sujet');
      const reunionId = options.getString('reunion_id');
      const subject = { id: uuidv4().slice(0, 8), guildId, texte, proposePar: user.id, proposeAt: new Date().toISOString(), reunionId: reunionId || null, votes: 0, votedBy: [] };
      await col('subjects').insertOne(subject);
      if (reunionId) await col('meetings').updateOne({ guildId, id: reunionId }, { $push: { subjects: subject.id } });
      const embed = new EmbedBuilder().setTitle('💬 Sujet proposé').setColor(0xFEE75C)
        .addFields({ name: '📝 Sujet', value: texte }, { name: '👤 Par', value: `<@${user.id}>`, inline: true }, { name: '📅 Réunion', value: reunionId ? `\`${reunionId}\`` : 'Générique', inline: true });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_${subject.id}`).setLabel('👍 Voter').setStyle(ButtonStyle.Success));
      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }
    if (sub === 'liste') {
      const reunionId = options.getString('reunion_id');
      const subjects = await col('subjects').find({ guildId, ...(reunionId ? { reunionId } : { reunionId: null }) }).sort({ votes: -1 }).toArray();
      if (!subjects.length) { await interaction.reply({ content: '📋 Aucun sujet.', ephemeral: true }); return; }
      const embed = new EmbedBuilder().setTitle('📋 Sujets').setColor(0xEB459E)
        .setDescription(subjects.map((s, i) => `${['🥇','🥈','🥉'][i]||`${i+1}.`} **${s.texte}**\n   👍 ${s.votes} · <@${s.proposePar}>`).join('\n\n'));
      await interaction.reply({ embeds: [embed] });
      return;
    }
    if (sub === 'vote') {
      const reunionId = options.getString('reunion_id');
      const meeting = await col('meetings').findOne({ guildId, id: reunionId });
      if (!meeting) { await interaction.reply({ content: '❌ Réunion introuvable.', ephemeral: true }); return; }
      const subjects = await col('subjects').find({ guildId, reunionId }).toArray();
      if (!subjects.length) { await interaction.reply({ content: '📋 Aucun sujet.', ephemeral: true }); return; }
      const embed = new EmbedBuilder().setTitle(`🗳️ Vote — ${meeting.titre}`).setColor(0xED4245)
        .addFields(subjects.map(s => ({ name: `📌 ${s.texte}`, value: `👍 ${s.votes} · ID: \`${s.id}\`` })));
      const buttons = subjects.slice(0, 5).map(s => new ButtonBuilder().setCustomId(`vote_${s.id}`).setLabel(`Voter: ${s.texte.slice(0, 40)}`).setStyle(ButtonStyle.Primary));
      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i+5)));
      await interaction.reply({ embeds: [embed], components: rows });
      return;
    }
  }

  if (commandName === 'voc') {
    const sub = options.getSubcommand();
    if (sub === 'sujet') {
      const sujet = options.getString('sujet');
      await col('sessions').updateOne({ guildId }, { $set: { guildId, currentSubject: sujet, startedAt: new Date().toISOString(), hostId: user.id } }, { upsert: true });
      const embed = new EmbedBuilder().setTitle('🎙️ Sujet en cours').setColor(0xED4245).setDescription(`**${sujet}**`).setFooter({ text: `Chef: ${user.username}` }).setTimestamp();
      await interaction.reply({ embeds: [embed] });
      return;
    }
    if (sub === 'prochain') {
      const session = await col('sessions').findOne({ guildId }) || {};
      if (!session.reunionId) { await interaction.reply({ content: '❌ Aucune réunion active.', ephemeral: true }); return; }
      const subjects = await col('subjects').find({ guildId, reunionId: session.reunionId }).sort({ votes: -1 }).toArray();
      const nextIdx = (session.subjectIndex || 0) + 1;
      const next = subjects[nextIdx];
      if (!next) { await interaction.reply({ content: '✅ Tous les sujets traités !', ephemeral: true }); return; }
      await col('sessions').updateOne({ guildId }, { $set: { currentSubject: next.texte, subjectIndex: nextIdx } });
      const embed = new EmbedBuilder().setTitle(`🎙️ Sujet ${nextIdx+1}/${subjects.length}`).setColor(0xFEE75C).setDescription(`**${next.texte}**`);
      await interaction.reply({ embeds: [embed] });
      return;
    }
    if (sub === 'terminer') {
      await col('sessions').deleteOne({ guildId });
      const embed = new EmbedBuilder().setTitle('✅ Réunion terminée').setColor(0x57F287).setDescription('Merci à tous !').setTimestamp();
      await interaction.reply({ embeds: [embed] });
      return;
    }
  }
}

async function handleButton(interaction) {
  const { customId, user, guildId } = interaction;
  if (customId.startsWith('vote_')) {
    const subjectId = customId.replace('vote_', '');
    const subject = await col('subjects').findOne({ id: subjectId, guildId });
    if (!subject) { await interaction.reply({ content: '❌ Sujet introuvable.', ephemeral: true }); return; }
    if (subject.votedBy.includes(user.id)) {
      await col('subjects').updateOne({ id: subjectId }, { $inc: { votes: -1 }, $pull: { votedBy: user.id } });
      await interaction.reply({ content: `❌ Vote retiré pour **${subject.texte}**`, ephemeral: true });
    } else {
      await col('subjects').updateOne({ id: subjectId }, { $inc: { votes: 1 }, $push: { votedBy: user.id } });
      const updated = await col('subjects').findOne({ id: subjectId });
      await interaction.reply({ content: `✅ Vote enregistré ! (${updated.votes} votes)`, ephemeral: true });
    }
    return;
  }
  if (customId.startsWith('propose_subject_')) {
    const reunionId = customId.replace('propose_subject_', '');
    const modal = new ModalBuilder().setCustomId(`modal_subject_${reunionId}`).setTitle('Proposer un sujet');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject_text').setLabel('Votre sujet').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
    await interaction.showModal(modal);
    return;
  }
  if (customId.startsWith('view_subjects_')) {
    const reunionId = customId.replace('view_subjects_', '');
    const subjects = await col('subjects').find({ guildId, reunionId }).sort({ votes: -1 }).toArray();
    if (!subjects.length) { await interaction.reply({ content: '📋 Aucun sujet.', ephemeral: true }); return; }
    const embed = new EmbedBuilder().setTitle('📋 Sujets').setColor(0x5865F2)
      .setDescription(subjects.map((s, i) => `${['🥇','🥈','🥉'][i]||`${i+1}.`} **${s.texte}** · 👍 ${s.votes}`).join('\n'));
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
}

async function handleModal(interaction) {
  const { customId, user, guildId } = interaction;
  if (customId.startsWith('modal_subject_')) {
    const reunionId = customId.replace('modal_subject_', '');
    const texte = interaction.fields.getTextInputValue('subject_text');
    const subject = { id: uuidv4().slice(0, 8), guildId, texte, proposePar: user.id, proposeAt: new Date().toISOString(), reunionId, votes: 0, votedBy: [] };
    await col('subjects').insertOne(subject);
    await col('meetings').updateOne({ guildId, id: reunionId }, { $push: { subjects: subject.id } });
    const embed = new EmbedBuilder().setTitle('💬 Sujet proposé').setColor(0x57F287).addFields({ name: '📝 Sujet', value: texte }, { name: '👤 Par', value: `<@${user.id}>`, inline: true });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_${subject.id}`).setLabel('👍 Voter').setStyle(ButtonStyle.Success));
    await interaction.reply({ embeds: [embed], components: [row] });
  }
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

app.post('/api/auth/register', async (req, res) => {
  const { username, password, guildId } = req.body;
  if (!username || !password || !guildId) return res.status(400).json({ error: 'Champs manquants' });
  const existing = await col('users').findOne({ guildId, username });
  if (existing) return res.status(409).json({ error: 'Utilisateur déjà existant' });
  const count = await col('users').countDocuments({ guildId });
  const hashedPwd = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, password: hashedPwd, guildId, role: count === 0 ? 'admin' : 'staff', niveau: count === 0 ? 4 : 1, createdAt: new Date().toISOString() };
  await col('users').insertOne(user);
  const token = jwt.sign({ id: user.id, username, guildId, role: user.role, niveau: user.niveau }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, role: user.role, niveau: user.niveau } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, guildId } = req.body;
  const user = await col('users').findOne({ guildId, username });
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Identifiants incorrects' });
  const token = jwt.sign({ id: user.id, username, guildId, role: user.role, niveau: user.niveau || 1 }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, role: user.role, niveau: user.niveau || 1 } });
});

app.get('/api/meetings', authMiddleware, async (req, res) => { res.json(await col('meetings').find({ guildId: req.user.guildId }).sort({ date: 1 }).toArray()); });

app.post('/api/meetings', authMiddleware, async (req, res) => {
  const { guildId, username } = req.user;
  const { titre, description, date } = req.body;
  const meeting = { id: uuidv4().slice(0, 8), guildId, titre, description, date, createdBy: username, createdAt: new Date().toISOString(), status: 'planifiee', subjects: [] };
  await col('meetings').insertOne(meeting);
  const config = await col('configs').findOne({ guildId }) || {};
  if (config.meetingChannel) {
    const guild = discordClient.guilds.cache.find(g => g.id === guildId);
    if (guild) {
      const ch = guild.channels.cache.get(config.meetingChannel);
      if (ch) {
        const embed = new EmbedBuilder().setTitle('📅 Nouvelle réunion !').setColor(0x57F287)
          .addFields({ name: '📌 Titre', value: titre }, { name: '🗓️ Date', value: `<t:${Math.floor(new Date(date).getTime()/1000)}:F>`, inline: true }, { name: '🆔 ID', value: `\`${meeting.id}\``, inline: true })
          .setFooter({ text: `Via panel — ${username}` }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`propose_subject_${meeting.id}`).setLabel('📢 Proposer un sujet').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`view_subjects_${meeting.id}`).setLabel('📋 Voir les sujets').setStyle(ButtonStyle.Secondary)
        );
        await ch.send({ embeds: [embed], components: [row] });
      }
    }
  }
  res.json(meeting);
});

app.patch('/api/meetings/:id', authMiddleware, async (req, res) => {
  await col('meetings').updateOne({ guildId: req.user.guildId, id: req.params.id }, { $set: req.body });
  res.json({ success: true });
});

app.delete('/api/meetings/:id', authMiddleware, async (req, res) => {
  const result = await col('meetings').updateOne({ guildId: req.user.guildId, id: req.params.id }, { $set: { status: 'annulee' } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'Introuvable' });
  res.json({ success: true });
});

app.get('/api/subjects', authMiddleware, async (req, res) => { res.json(await col('subjects').find({ guildId: req.user.guildId }).sort({ votes: -1 }).toArray()); });

app.post('/api/subjects', authMiddleware, async (req, res) => {
  const { guildId, username } = req.user;
  const { texte, reunionId } = req.body;
  const subject = { id: uuidv4().slice(0, 8), guildId, texte, reunionId: reunionId || null, proposePar: username, proposeAt: new Date().toISOString(), votes: 0, votedBy: [] };
  await col('subjects').insertOne(subject);
  if (reunionId) await col('meetings').updateOne({ guildId, id: reunionId }, { $push: { subjects: subject.id } });
  res.json(subject);
});

app.delete('/api/subjects/:id', authMiddleware, async (req, res) => {
  await col('subjects').deleteOne({ guildId: req.user.guildId, id: req.params.id });
  res.json({ success: true });
});

app.get('/api/staff', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  const users = await col('users').find({ guildId: req.user.guildId }).toArray();
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, niveau: u.niveau || 1, discordId: u.discordId, discordTag: u.discordTag, createdAt: u.createdAt })));
});

app.post('/api/staff', authMiddleware, async (req, res) => {
  if (req.user.niveau < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  const { guildId } = req.user;
  const { username, niveau, discordId } = req.body;
  const existing = await col('users').findOne({ guildId, username });
  if (existing) return res.status(409).json({ error: 'Nom déjà pris' });
  const password = genPassword();
  const hashedPwd = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, password: hashedPwd, discordId: discordId || null, guildId, role: 'staff', niveau: niveau || 1, createdAt: new Date().toISOString() };
  await col('users').insertOne(user);
  if (discordId) {
    try {
      const du = await discordClient.users.fetch(discordId);
      const embed = new EmbedBuilder().setTitle('🖥️ Accès Panel — Réunions').setColor(0x5865F2)
        .addFields({ name: '👤 Identifiant', value: `\`${username}\``, inline: true }, { name: '🔑 Mot de passe', value: `\`${password}\``, inline: true }, { name: '🔗 Panel', value: `${PANEL_URL}/?guild=${guildId}` })
        .setFooter({ text: '⚠️ Ne partagez jamais vos identifiants.' });
      await du.send({ embeds: [embed] });
    } catch {}
  }
  res.json({ id: user.id, username, role: user.role, niveau, password });
});

app.patch('/api/staff/:id/niveau', authMiddleware, async (req, res) => {
  if (req.user.niveau < 4) return res.status(403).json({ error: 'Niveau insuffisant' });
  await col('users').updateOne({ id: req.params.id, guildId: req.user.guildId }, { $set: { niveau: req.body.niveau } });
  res.json({ success: true });
});

app.get('/api/guild/:guildId', async (req, res) => {
  const guild = discordClient.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable' });
  res.json({ id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount });
});

// Catch-all pour le panel
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await connectDB();
  app.listen(PORT, () => console.log(`🌐 Panel: http://localhost:${PORT}`));
  discordClient.login(BOT_TOKEN);
}
start();
