const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_CLIENT_ID_HERE';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-change-in-prod';
const PORT = process.env.PORT || 3000;

// ─── Database (JSON-based, replace with real DB in production) ────────────────
const DB_PATH = './data';
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

function loadDB(file) {
  const p = path.join(DB_PATH, `${file}.json`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveDB(file, data) {
  fs.writeFileSync(path.join(DB_PATH, `${file}.json`), JSON.stringify(data, null, 2));
}

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ]
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('reunion')
    .setDescription('Gérer les réunions')
    .addSubcommand(sub => sub
      .setName('creer')
      .setDescription('Créer une nouvelle réunion')
      .addStringOption(o => o.setName('titre').setDescription('Titre de la réunion').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('Date (JJ/MM/AAAA HH:MM)').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Description').setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('liste')
      .setDescription('Voir le calendrier des réunions')
    )
    .addSubcommand(sub => sub
      .setName('annuler')
      .setDescription('Annuler une réunion')
      .addStringOption(o => o.setName('id').setDescription('ID de la réunion').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('sujet')
    .setDescription('Gérer les sujets de réunion')
    .addSubcommand(sub => sub
      .setName('proposer')
      .setDescription('Proposer un sujet')
      .addStringOption(o => o.setName('sujet').setDescription('Votre sujet').setRequired(true))
      .addStringOption(o => o.setName('reunion_id').setDescription('ID de la réunion (optionnel)').setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('liste')
      .setDescription('Voir les sujets proposés')
      .addStringOption(o => o.setName('reunion_id').setDescription('ID de la réunion').setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('vote')
      .setDescription('Lancer un vote sur les sujets')
      .addStringOption(o => o.setName('reunion_id').setDescription('ID de la réunion').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('voc')
    .setDescription('Commandes pour le chef de vocal')
    .addSubcommand(sub => sub
      .setName('sujet')
      .setDescription('Définir le sujet actuel en vocal')
      .addStringOption(o => o.setName('sujet').setDescription('Sujet en cours').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('prochain')
      .setDescription('Passer au sujet suivant')
    )
    .addSubcommand(sub => sub
      .setName('terminer')
      .setDescription('Terminer la réunion')
    ),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Obtenir le lien du panel web'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configurer le bot pour ce serveur')
    .addChannelOption(o => o.setName('canal_reunions').setDescription('Canal pour les annonces de réunions').setRequired(true))
    .addRoleOption(o => o.setName('role_chef').setDescription('Rôle du chef de vocal').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─── Register commands ────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('📡 Enregistrement des commandes slash...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commandes enregistrées !');
  } catch (error) {
    console.error('❌ Erreur enregistrement:', error);
  }
}

// ─── Bot Events ───────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 Bot connecté : ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    if (interaction.isButton()) await handleButton(interaction);
    if (interaction.isStringSelectMenu()) await handleSelect(interaction);
    if (interaction.isModalSubmit()) await handleModal(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const reply = { content: '❌ Une erreur est survenue.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// ─── Command Handler ──────────────────────────────────────────────────────────
async function handleCommand(interaction) {
  const { commandName, options, guildId, user } = interaction;
  const meetings = loadDB('meetings');
  const subjects = loadDB('subjects');
  const configs = loadDB('configs');
  const guildMeetings = meetings[guildId] || [];
  const guildSubjects = subjects[guildId] || [];
  const guildConfig = configs[guildId] || {};

  if (commandName === 'setup') {
    const channel = options.getChannel('canal_reunions');
    const role = options.getRole('role_chef');
    configs[guildId] = {
      meetingChannel: channel.id,
      chefRole: role?.id || null,
      setupBy: user.id,
      setupAt: new Date().toISOString()
    };
    saveDB('configs', configs);

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Configuration enregistrée')
      .setColor(0x5865F2)
      .addFields(
        { name: '📢 Canal réunions', value: `<#${channel.id}>`, inline: true },
        { name: '👑 Rôle chef', value: role ? `<@&${role.id}>` : 'Non défini', inline: true }
      )
      .setFooter({ text: 'Panel web disponible avec /panel' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (commandName === 'panel') {
    const panelUrl = `http://localhost:${PORT}/panel?guild=${guildId}`;
    const embed = new EmbedBuilder()
      .setTitle('🖥️ Panel de gestion des réunions')
      .setColor(0x57F287)
      .setDescription(`Accédez au panel web pour gérer vos réunions.\n\n🔗 **[Ouvrir le panel](${panelUrl})**`)
      .addFields({ name: '🔑 Connexion', value: 'Créez votre compte staff depuis le panel.' })
      .setFooter({ text: `Serveur: ${interaction.guild.name}` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (commandName === 'reunion') {
    const sub = options.getSubcommand();

    if (sub === 'creer') {
      const titre = options.getString('titre');
      const dateStr = options.getString('date');
      const description = options.getString('description') || '';

      // Parse date
      const [datePart, timePart] = dateStr.split(' ');
      const [day, month, year] = datePart.split('/');
      const [hour, min] = (timePart || '00:00').split(':');
      const meetingDate = new Date(year, month - 1, day, hour, min);

      if (isNaN(meetingDate)) {
        await interaction.reply({ content: '❌ Format de date invalide. Utilisez JJ/MM/AAAA HH:MM', ephemeral: true });
        return;
      }

      const meeting = {
        id: uuidv4().slice(0, 8),
        titre,
        description,
        date: meetingDate.toISOString(),
        createdBy: user.id,
        createdAt: new Date().toISOString(),
        status: 'planifiee',
        subjects: []
      };

      meetings[guildId] = [...guildMeetings, meeting];
      saveDB('meetings', meetings);

      const embed = new EmbedBuilder()
        .setTitle('📅 Nouvelle réunion planifiée !')
        .setColor(0x57F287)
        .addFields(
          { name: '📌 Titre', value: titre },
          { name: '🗓️ Date', value: `<t:${Math.floor(meetingDate.getTime() / 1000)}:F>`, inline: true },
          { name: '🆔 ID', value: `\`${meeting.id}\``, inline: true },
          { name: '📝 Description', value: description || '*Aucune description*' }
        )
        .setFooter({ text: `Créée par ${user.username}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`propose_subject_${meeting.id}`).setLabel('📢 Proposer un sujet').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`view_subjects_${meeting.id}`).setLabel('📋 Voir les sujets').setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ embeds: [embed], components: [row] });

      // Announce in meeting channel if configured
      if (guildConfig.meetingChannel) {
        const channel = interaction.guild.channels.cache.get(guildConfig.meetingChannel);
        if (channel) await channel.send({ embeds: [embed], components: [row] });
      }
      return;
    }

    if (sub === 'liste') {
      const upcoming = guildMeetings
        .filter(m => m.status !== 'terminee' && new Date(m.date) >= new Date())
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      if (!upcoming.length) {
        await interaction.reply({ content: '📅 Aucune réunion planifiée.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📅 Calendrier des réunions')
        .setColor(0x5865F2)
        .setDescription(upcoming.map((m, i) => {
          const ts = Math.floor(new Date(m.date).getTime() / 1000);
          return `**${i + 1}. ${m.titre}**\n📅 <t:${ts}:F> · 🆔 \`${m.id}\` · ${m.subjects.length} sujet(s)`;
        }).join('\n\n'))
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'annuler') {
      const id = options.getString('id');
      const idx = guildMeetings.findIndex(m => m.id === id);
      if (idx === -1) {
        await interaction.reply({ content: '❌ Réunion introuvable.', ephemeral: true });
        return;
      }
      meetings[guildId][idx].status = 'annulee';
      saveDB('meetings', meetings);
      await interaction.reply({ content: `✅ Réunion \`${id}\` annulée.`, ephemeral: true });
      return;
    }
  }

  if (commandName === 'sujet') {
    const sub = options.getSubcommand();

    if (sub === 'proposer') {
      const sujet = options.getString('sujet');
      const reunionId = options.getString('reunion_id');

      const subject = {
        id: uuidv4().slice(0, 8),
        texte: sujet,
        proposePar: user.id,
        proposeAt: new Date().toISOString(),
        reunionId: reunionId || null,
        votes: 0,
        votedBy: []
      };

      subjects[guildId] = [...guildSubjects, subject];

      if (reunionId) {
        const mIdx = guildMeetings.findIndex(m => m.id === reunionId);
        if (mIdx !== -1) {
          meetings[guildId][mIdx].subjects.push(subject.id);
          saveDB('meetings', meetings);
        }
      }

      saveDB('subjects', subjects);

      const embed = new EmbedBuilder()
        .setTitle('💬 Sujet proposé')
        .setColor(0xFEE75C)
        .addFields(
          { name: '📝 Sujet', value: sujet },
          { name: '🆔 ID', value: `\`${subject.id}\``, inline: true },
          { name: '👤 Proposé par', value: `<@${user.id}>`, inline: true },
          { name: '📅 Réunion', value: reunionId ? `\`${reunionId}\`` : 'Générique', inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote_${subject.id}`).setLabel('👍 Voter').setStyle(ButtonStyle.Success)
      );

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }

    if (sub === 'liste') {
      const reunionId = options.getString('reunion_id');
      let filtered = reunionId
        ? guildSubjects.filter(s => s.reunionId === reunionId)
        : guildSubjects.filter(s => !s.reunionId);

      filtered = filtered.sort((a, b) => b.votes - a.votes);

      if (!filtered.length) {
        await interaction.reply({ content: '📋 Aucun sujet pour cette réunion.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 Sujets proposés')
        .setColor(0xEB459E)
        .setDescription(filtered.map((s, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          return `${medal} **${s.texte}**\n   👍 ${s.votes} vote(s) · 👤 <@${s.proposePar}>`;
        }).join('\n\n'));

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'vote') {
      const reunionId = options.getString('reunion_id');
      const meeting = guildMeetings.find(m => m.id === reunionId);
      if (!meeting) {
        await interaction.reply({ content: '❌ Réunion introuvable.', ephemeral: true });
        return;
      }

      const meetingSubjects = guildSubjects.filter(s => s.reunionId === reunionId);
      if (!meetingSubjects.length) {
        await interaction.reply({ content: '📋 Aucun sujet pour cette réunion.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🗳️ Vote des sujets - ${meeting.titre}`)
        .setColor(0xED4245)
        .setDescription('Cliquez sur **Voter** pour soutenir un sujet !')
        .addFields(meetingSubjects.map(s => ({
          name: `📌 ${s.texte}`,
          value: `👍 ${s.votes} vote(s) · ID: \`${s.id}\``
        })));

      const buttons = meetingSubjects.slice(0, 5).map(s =>
        new ButtonBuilder()
          .setCustomId(`vote_${s.id}`)
          .setLabel(`Voter: ${s.texte.slice(0, 40)}`)
          .setStyle(ButtonStyle.Primary)
      );

      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
      }

      await interaction.reply({ embeds: [embed], components: rows });
      return;
    }
  }

  if (commandName === 'voc') {
    const sub = options.getSubcommand();
    const sessions = loadDB('sessions');
    const guildSession = sessions[guildId] || {};

    if (sub === 'sujet') {
      const sujet = options.getString('sujet');
      sessions[guildId] = { ...guildSession, currentSubject: sujet, startedAt: new Date().toISOString(), hostId: user.id };
      saveDB('sessions', sessions);

      const embed = new EmbedBuilder()
        .setTitle('🎙️ Sujet en cours')
        .setColor(0xED4245)
        .setDescription(`**${sujet}**`)
        .setFooter({ text: `Chef de vocal: ${user.username}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'prochain') {
      const { reunionId, subjectIndex = 0 } = guildSession;
      if (!reunionId) {
        await interaction.reply({ content: '❌ Aucune réunion active.', ephemeral: true });
        return;
      }
      const meetingSubjects = (subjects[guildId] || [])
        .filter(s => s.reunionId === reunionId)
        .sort((a, b) => b.votes - a.votes);

      const nextIdx = subjectIndex + 1;
      const next = meetingSubjects[nextIdx];

      if (!next) {
        await interaction.reply({ content: '✅ Tous les sujets ont été traités !', ephemeral: true });
        return;
      }

      sessions[guildId] = { ...guildSession, currentSubject: next.texte, subjectIndex: nextIdx };
      saveDB('sessions', sessions);

      const embed = new EmbedBuilder()
        .setTitle(`🎙️ Sujet ${nextIdx + 1}/${meetingSubjects.length}`)
        .setColor(0xFEE75C)
        .setDescription(`**${next.texte}**`)
        .setFooter({ text: `Chef de vocal: ${user.username}` });

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'terminer') {
      sessions[guildId] = {};
      saveDB('sessions', sessions);

      const embed = new EmbedBuilder()
        .setTitle('✅ Réunion terminée')
        .setColor(0x57F287)
        .setDescription('La réunion a été clôturée. Merci à tous !')
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }
  }
}

// ─── Button Handler ───────────────────────────────────────────────────────────
async function handleButton(interaction) {
  const { customId, user, guildId } = interaction;

  if (customId.startsWith('vote_')) {
    const subjectId = customId.replace('vote_', '');
    const subjects = loadDB('subjects');
    const guildSubjects = subjects[guildId] || [];
    const idx = guildSubjects.findIndex(s => s.id === subjectId);

    if (idx === -1) {
      await interaction.reply({ content: '❌ Sujet introuvable.', ephemeral: true });
      return;
    }

    const subject = guildSubjects[idx];
    if (subject.votedBy.includes(user.id)) {
      // Remove vote
      subjects[guildId][idx].votes -= 1;
      subjects[guildId][idx].votedBy = subject.votedBy.filter(id => id !== user.id);
      saveDB('subjects', subjects);
      await interaction.reply({ content: `❌ Vote retiré pour **${subject.texte}**`, ephemeral: true });
    } else {
      // Add vote
      subjects[guildId][idx].votes += 1;
      subjects[guildId][idx].votedBy.push(user.id);
      saveDB('subjects', subjects);
      await interaction.reply({ content: `✅ Vote enregistré pour **${subject.texte}** ! (${subjects[guildId][idx].votes} votes)`, ephemeral: true });
    }
    return;
  }

  if (customId.startsWith('propose_subject_')) {
    const reunionId = customId.replace('propose_subject_', '');
    const modal = new ModalBuilder()
      .setCustomId(`modal_subject_${reunionId}`)
      .setTitle('Proposer un sujet');

    const input = new TextInputBuilder()
      .setCustomId('subject_text')
      .setLabel('Votre sujet')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (customId.startsWith('view_subjects_')) {
    const reunionId = customId.replace('view_subjects_', '');
    const subjects = loadDB('subjects');
    const guildSubjects = (subjects[guildId] || []).filter(s => s.reunionId === reunionId);

    if (!guildSubjects.length) {
      await interaction.reply({ content: '📋 Aucun sujet proposé pour cette réunion.', ephemeral: true });
      return;
    }

    const sorted = guildSubjects.sort((a, b) => b.votes - a.votes);
    const embed = new EmbedBuilder()
      .setTitle('📋 Sujets de la réunion')
      .setColor(0x5865F2)
      .setDescription(sorted.map((s, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medal} **${s.texte}** · 👍 ${s.votes}`;
      }).join('\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
}

// ─── Modal Handler ────────────────────────────────────────────────────────────
async function handleModal(interaction) {
  const { customId, user, guildId } = interaction;

  if (customId.startsWith('modal_subject_')) {
    const reunionId = customId.replace('modal_subject_', '');
    const texte = interaction.fields.getTextInputValue('subject_text');
    const subjects = loadDB('subjects');
    const meetings = loadDB('meetings');

    const subject = {
      id: uuidv4().slice(0, 8),
      texte,
      proposePar: user.id,
      proposeAt: new Date().toISOString(),
      reunionId,
      votes: 0,
      votedBy: []
    };

    subjects[guildId] = [...(subjects[guildId] || []), subject];

    const mIdx = (meetings[guildId] || []).findIndex(m => m.id === reunionId);
    if (mIdx !== -1) {
      meetings[guildId][mIdx].subjects.push(subject.id);
      saveDB('meetings', meetings);
    }

    saveDB('subjects', subjects);

    const embed = new EmbedBuilder()
      .setTitle('💬 Sujet proposé')
      .setColor(0x57F287)
      .addFields(
        { name: '📝 Sujet', value: texte },
        { name: '👤 Proposé par', value: `<@${user.id}>`, inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vote_${subject.id}`).setLabel('👍 Voter').setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }
}

async function handleSelect(interaction) {
  // Reserved for future use
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password, guildId, discordId } = req.body;
  if (!username || !password || !guildId) return res.status(400).json({ error: 'Champs manquants' });

  const users = loadDB('users');
  const guildUsers = users[guildId] || [];

  if (guildUsers.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Utilisateur déjà existant' });
  }

  const hashedPwd = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    password: hashedPwd,
    discordId: discordId || null,
    role: guildUsers.length === 0 ? 'admin' : 'staff',
    createdAt: new Date().toISOString()
  };

  users[guildId] = [...guildUsers, user];
  saveDB('users', users);

  const token = jwt.sign({ id: user.id, username: user.username, guildId, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, guildId } = req.body;
  const users = loadDB('users');
  const guildUsers = users[guildId] || [];
  const user = guildUsers.find(u => u.username === username);

  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, guildId, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// ─── Meetings Routes ──────────────────────────────────────────────────────────
app.get('/api/meetings', authMiddleware, (req, res) => {
  const { guildId } = req.user;
  const meetings = loadDB('meetings');
  res.json(meetings[guildId] || []);
});

app.post('/api/meetings', authMiddleware, (req, res) => {
  const { guildId, username } = req.user;
  const { titre, description, date } = req.body;
  const meetings = loadDB('meetings');

  const meeting = {
    id: uuidv4().slice(0, 8),
    titre, description, date,
    createdBy: username,
    createdAt: new Date().toISOString(),
    status: 'planifiee',
    subjects: []
  };

  meetings[guildId] = [...(meetings[guildId] || []), meeting];
  saveDB('meetings', meetings);
  res.json(meeting);
});

app.delete('/api/meetings/:id', authMiddleware, (req, res) => {
  const { guildId } = req.user;
  const meetings = loadDB('meetings');
  const idx = (meetings[guildId] || []).findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Réunion introuvable' });
  meetings[guildId][idx].status = 'annulee';
  saveDB('meetings', meetings);
  res.json({ success: true });
});

// ─── Subjects Routes ──────────────────────────────────────────────────────────
app.get('/api/subjects', authMiddleware, (req, res) => {
  const { guildId } = req.user;
  const subjects = loadDB('subjects');
  res.json(subjects[guildId] || []);
});

app.post('/api/subjects', authMiddleware, (req, res) => {
  const { guildId, username } = req.user;
  const { texte, reunionId } = req.body;
  const subjects = loadDB('subjects');

  const subject = {
    id: uuidv4().slice(0, 8),
    texte, reunionId: reunionId || null,
    proposePar: username,
    proposeAt: new Date().toISOString(),
    votes: 0, votedBy: []
  };

  subjects[guildId] = [...(subjects[guildId] || []), subject];
  saveDB('subjects', subjects);
  res.json(subject);
});

// ─── Staff Routes ─────────────────────────────────────────────────────────────
app.get('/api/staff', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  const { guildId } = req.user;
  const users = loadDB('users');
  const guildUsers = (users[guildId] || []).map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt }));
  res.json(guildUsers);
});

app.patch('/api/staff/:id/role', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  const { guildId } = req.user;
  const users = loadDB('users');
  const idx = (users[guildId] || []).findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Utilisateur introuvable' });
  users[guildId][idx].role = req.body.role;
  saveDB('users', users);
  res.json({ success: true });
});

// ─── Guild Info ───────────────────────────────────────────────────────────────
app.get('/api/guild/:guildId', async (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable' });
  res.json({ id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🌐 Panel web: http://localhost:${PORT}`));
client.login(BOT_TOKEN);
