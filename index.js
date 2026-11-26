const {
  Client,
  GatewayIntentBits,
  ActivityType,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const youtubedl = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  prefix: '!',
  presence: {
    status: 'idle',
    afk: true,
    text: 'TOP Life 🍷',
  },
  autoReplies: {},
  aliases: {},
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      prefix: typeof parsed.prefix === 'string' && parsed.prefix.trim() ? parsed.prefix.trim() : '!',
      presence: {
        status: ['online', 'idle', 'dnd', 'invisible'].includes(parsed?.presence?.status)
          ? parsed.presence.status
          : 'idle',
        afk: typeof parsed?.presence?.afk === 'boolean' ? parsed.presence.afk : true,
        text: typeof parsed?.presence?.text === 'string' ? parsed.presence.text : 'TOP Life 🍷',
      },
      autoReplies: parsed?.autoReplies && typeof parsed.autoReplies === 'object' ? parsed.autoReplies : {},
      aliases: parsed?.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
    };
  } catch (err) {
    console.error('Config load error, using defaults:', err);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

let botConfig = loadConfig();

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(botConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Config save error:', err);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause,
  },
});

const loopStates = new Map();
const lastQueries = new Map();

function applyBotPresence() {
  if (!client.user) return;
  const activities = [];
  if (botConfig.presence.text && botConfig.presence.text.trim()) {
    activities.push({
      name: botConfig.presence.text.trim(),
      type: ActivityType.Custom,
    });
  }

  client.user.setPresence({
    status: botConfig.presence.status || 'idle',
    afk: botConfig.presence.afk !== false,
    activities,
  });
}

const slashCommands = [
  new SlashCommandBuilder().setName('ping').setDescription('يعرض البنق الحالي للبوت'),
  new SlashCommandBuilder().setName('panel').setDescription('يعرض لوحة تحكم البوت والأوامر'),
  new SlashCommandBuilder().setName('info').setDescription('يعرض معلومات البوت والأوامر'),
  new SlashCommandBuilder().setName('voicetest').setDescription('اختبار اتصال الروم الصوتي وحالة جاهزية الصوت'),
  new SlashCommandBuilder()
    .setName('addreply')
    .setDescription('إضافة رد تلقائي (للأدمن)')
    .addStringOption((opt) =>
      opt.setName('word').setDescription('الكلمة التي يرد عليها البوت').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('reply').setDescription('الرد المطلوب من البوت').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('delreply')
    .setDescription('حذف رد تلقائي (للأدمن)')
    .addStringOption((opt) =>
      opt.setName('word').setDescription('الكلمة المراد حذف ردها').setRequired(true)
    ),
  new SlashCommandBuilder().setName('listreplies').setDescription('عرض جميع الردود التلقائية'),
  new SlashCommandBuilder()
    .setName('addalias')
    .setDescription('إضافة اختصار لأمر (للأدمن)')
    .addStringOption((opt) =>
      opt.setName('alias').setDescription('اسم الاختصار').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('command').setDescription('الأمر الأصلي (مثل play أو stop)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('delalias')
    .setDescription('حذف اختصار أمر (للأدمن)')
    .addStringOption((opt) =>
      opt.setName('alias').setDescription('اسم الاختصار المراد حذفه').setRequired(true)
    ),
  new SlashCommandBuilder().setName('listaliases').setDescription('عرض جميع الاختصارات المفعّلة'),
  new SlashCommandBuilder()
    .setName('setstatus')
    .setDescription('تغيير حالة البوت ونص الحالة (للأدمن)')
    .addStringOption((opt) =>
      opt
        .setName('status')
        .setDescription('حالة الاتصال')
        .setRequired(true)
        .addChoices(
          { name: 'خامل (idle)', value: 'idle' },
          { name: 'متصل (online)', value: 'online' },
          { name: 'مشغول (dnd)', value: 'dnd' },
          { name: 'مخفي (invisible)', value: 'invisible' }
        )
    )
    .addStringOption((opt) =>
      opt.setName('text').setDescription('نص الحالة المخصص').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('تشغيل مقطع صوتي في الروم الصوتي')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('رابط أو اسم مقطع (اختياري لملف song.mp3)').setRequired(false)
    ),
  new SlashCommandBuilder().setName('loop').setDescription('تفعيل أو إيقاف تكرار المقطع الحالي'),
  new SlashCommandBuilder().setName('skip').setDescription('تخطي المقطع الحالي'),
  new SlashCommandBuilder().setName('stop').setDescription('إيقاف الصوت والخروج من الروم الصوتي'),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands() {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !client.user) return;

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('✅ تم تسجيل أوامر السلاش (/) بنجاح');
  } catch (err) {
    console.error('Slash commands registration error:', err);
  }
}

client.on('clientReady', async () => {
  console.log(`✅ البوت شغال الآن باسم: ${client.user.tag}`);
  applyBotPresence();
  setTimeout(() => {
    applyBotPresence();
  }, 3000);
  await registerSlashCommands();
});

client.on('error', (err) => {
  console.error('Discord Client Error:', err);
});

function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionsBitField.Flags.Administrator));
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function extractUrlFromInfo(info) {
  if (!info) return null;
  if (typeof info.url === 'string' && info.url.startsWith('http')) {
    return info.url;
  }

  if (Array.isArray(info.formats) && info.formats.length > 0) {
    const audioOnly = info.formats
      .filter((f) => typeof f?.url === 'string' && f.url.startsWith('http') && f.acodec && f.acodec !== 'none')
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

    if (audioOnly[0]?.url) {
      return audioOnly[0].url;
    }

    const anyWithUrl = [...info.formats]
      .reverse()
      .find((f) => typeof f?.url === 'string' && f.url.startsWith('http'));

    if (anyWithUrl?.url) {
      return anyWithUrl.url;
    }
  }

  return null;
}

async function getDirectAudioUrl(query) {
  const localFile = path.join(__dirname, 'song.mp3');

  if (!query && fs.existsSync(localFile)) {
    return { source: localFile, title: 'song.mp3 (ملف محلي)' };
  }

  if (!query) {
    throw new Error('لم يتم إدخال رابط أو اسم مقطع ولا يوجد ملف song.mp3');
  }

  if (isUrl(query) && /\.(mp3|ogg|wav|m4a|flac)(\?.*)?$/i.test(query)) {
    return { source: query, title: 'ملف صوتي مباشر' };
  }

  const target = isUrl(query) ? query : `ytsearch1:${query}`;
  let title = 'مقطع صوتي';
  let streamUrl = null;

  try {
    const info = await youtubedl(target, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      format: 'bestaudio/best',
      extractorArgs: 'youtube:player_client=android,web',
    });

    if (info?.title) {
      title = info.title;
    }
    streamUrl = extractUrlFromInfo(info);
  } catch (err) {
    console.warn('JSON extract fallback triggered:', err?.shortMessage || err?.message || err);
  }

  if (!streamUrl) {
    const rawUrl = await youtubedl(target, {
      getUrl: true,
      noWarnings: true,
      noPlaylist: true,
      format: 'bestaudio/best',
      extractorArgs: 'youtube:player_client=android,web',
    });

    const firstLine = String(rawUrl || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.startsWith('http'));

    streamUrl = firstLine || null;
  }

  if (!streamUrl) {
    throw new Error('تعذّر استخراج رابط البث الصوتي');
  }

  return {
    source: streamUrl,
    title,
  };
}

function createFfmpegStream(source) {
  if (typeof source === 'string' && !isUrl(source) && fs.existsSync(source)) {
    return createAudioResource(source);
  }

  if (!ffmpegPath) {
    return createAudioResource(source);
  }

  const ff = spawn(ffmpegPath, [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', source,
    '-analyzeduration', '0',
    '-loglevel', '0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  ff.on('error', (err) => {
    console.error('FFmpeg process error:', err);
  });

  return createAudioResource(ff.stdout);
}

async function createFreshConnection(voiceChannel, guild) {
  const existing = getVoiceConnection(guild.id);
  if (existing) {
    try {
      existing.destroy();
    } catch {}
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`[VoiceState] ${oldState.status} -> ${newState.status}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      try {
        connection.destroy();
      } catch {}
    }
  });

  return connection;
}

async function ensureVoiceConnection(voiceChannel, guild) {
  let connection = getVoiceConnection(guild.id);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = await createFreshConnection(voiceChannel, guild);
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.warn('Retrying voice connection:', err?.name || err);
    connection = await createFreshConnection(voiceChannel, guild);
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  }

  connection.subscribe(player);
  return connection;
}

async function playTrack(query) {
  const { source, title } = await getDirectAudioUrl(query);
  const resource = createFfmpegStream(source);
  player.play(resource);
  return title;
}

player.on(AudioPlayerStatus.Idle, async () => {
  for (const [guildId, isLooping] of loopStates.entries()) {
    if (!isLooping) continue;
    const prev = lastQueries.get(guildId);
    if (!prev) continue;

    try {
      await playTrack(prev);
    } catch (err) {
      console.error('Loop replay error:', err);
    }
  }
});

player.on('error', (error) => {
  console.error('Audio player error:', error);
});

async function executeUnifiedCommand({ command, args, member, guild, botName, replyFn, updateFn }) {
  const aliasTarget = botConfig.aliases[command.toLowerCase()];
  const resolvedCommand = (aliasTarget || command).toLowerCase();

  if (resolvedCommand === 'ping') {
    return replyFn(`🏓 البنق الحالي: **${Math.round(client.ws.ping)}ms**`);
  }

  if (resolvedCommand === 'info' || resolvedCommand === 'panel') {
    return replyFn(
      `🎛️ **لوحة تحكم ${botName}**\n` +
      `• الصوت: \`/play\`، \`/loop\`، \`/skip\`، \`/stop\`، \`/voicetest\`\n` +
      `• الردود: \`/addreply\`، \`/delreply\`، \`/listreplies\`\n` +
      `• الاختصارات: \`/addalias\`، \`/delalias\`، \`/listaliases\`\n` +
      `• الحالة: \`/setstatus\`\n` +
      `• خدمات: \`/ping\`، \`/panel\``
    );
  }

  if (resolvedCommand === 'voicetest') {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return replyFn('ادخل روم صوتي أولاً يا غالي 🎧');
    }

    await replyFn(`🔍 جاري اختبار الاتصال بالروم **${voiceChannel.name}**...`);
    const hasLocalSong = fs.existsSync(path.join(__dirname, 'song.mp3'));

    try {
      await ensureVoiceConnection(voiceChannel, guild);
      return updateFn(
        `✅ **نتيجة اختبار الصوت:**\n` +
        `• حالة الاتصال: **Ready (متصل وجاهز)**\n` +
        `• ملف \`song.mp3\` المحلي: **${hasLocalSong ? 'موجود' : 'غير موجود'}**`
      );
    } catch (err) {
      return updateFn(
        `❌ **فشل اختبار اتصال الصوت:**\n` +
        `• السبب: \`${err?.name || 'Error'}\` - ${err?.message || 'تعذّر إتمام حالة Ready'}\n` +
        `• ملف \`song.mp3\` المحلي: **${hasLocalSong ? 'موجود' : 'غير موجود'}**`
      );
    }
  }

  if (resolvedCommand === 'addreply') {
    if (!isAdmin(member)) {
      return replyFn('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const trigger = (args.word ?? args[0] ?? '').toString().trim().toLowerCase();
    const replyText = (args.reply ?? (Array.isArray(args) ? args.slice(1).join(' ') : '')).toString().trim();

    if (!trigger || !replyText) {
      return replyFn('الاستخدام الصحيح: `/addreply word:الكلمة reply:الرد` أو `!addreply الكلمة | الرد`');
    }

    botConfig.autoReplies[trigger] = replyText;
    saveConfig();
    return replyFn(`✅ تم حفظ الرد التلقائي للكلمة: **${trigger}**`);
  }

  if (resolvedCommand === 'delreply') {
    if (!isAdmin(member)) {
      return replyFn('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const trigger = (args.word ?? (Array.isArray(args) ? args.join(' ') : '')).toString().trim().toLowerCase();
    if (!trigger || !Object.prototype.hasOwnProperty.call(botConfig.autoReplies, trigger)) {
      return replyFn('❌ لم يتم العثور على رد تلقائي بهذه الكلمة.');
    }

    delete botConfig.autoReplies[trigger];
    saveConfig();
    return replyFn(`🗑️ تم حذف الرد التلقائي للكلمة: **${trigger}**`);
  }

  if (resolvedCommand === 'listreplies') {
    const keys = Object.keys(botConfig.autoReplies);
    if (keys.length === 0) {
      return replyFn('📭 لا توجد ردود تلقائية مضافة حالياً.');
    }
    const lines = keys.map((k) => `• **${k}** ← ${botConfig.autoReplies[k]}`);
    return replyFn(`💬 **الردود التلقائية:**\n${lines.join('\n')}`);
  }

  if (resolvedCommand === 'addalias') {
    if (!isAdmin(member)) {
      return replyFn('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const alias = (args.alias ?? args[0] ?? '').toString().trim().toLowerCase();
    const targetCmd = (args.command ?? args[1] ?? '').toString().trim().toLowerCase();

    if (!alias || !targetCmd) {
      return replyFn('الاستخدام الصحيح: `/addalias alias:وقف command:stop` أو `!addalias وقف | stop`');
    }

    botConfig.aliases[alias] = targetCmd;
    saveConfig();
    return replyFn(`⚡ تم حفظ الاختصار: **/${alias}** ← **/${targetCmd}**`);
  }

  if (resolvedCommand === 'delalias') {
    if (!isAdmin(member)) {
      return replyFn('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const alias = (args.alias ?? (Array.isArray(args) ? args.join(' ') : '')).toString().trim().toLowerCase();
    if (!alias || !Object.prototype.hasOwnProperty.call(botConfig.aliases, alias)) {
      return replyFn('❌ لم يتم العثور على هذا الاختصار.');
    }

    delete botConfig.aliases[alias];
    saveConfig();
    return replyFn(`🗑️ تم حذف الاختصار: **/${alias}**`);
  }

  if (resolvedCommand === 'listaliases') {
    const keys = Object.keys(botConfig.aliases);
    if (keys.length === 0) {
      return replyFn('📭 لا توجد اختصارات مضافة حالياً.');
    }
    const lines = keys.map((k) => `• **/${k}** ← **/${botConfig.aliases[k]}**`);
    return replyFn(`⚡ **الاختصارات المفعّلة:**\n${lines.join('\n')}`);
  }

  if (resolvedCommand === 'setstatus') {
    if (!isAdmin(member)) {
      return replyFn('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const status = (args.status ?? args[0] ?? '').toString().trim().toLowerCase();
    const validStatuses = ['online', 'idle', 'dnd', 'invisible'];

    if (!validStatuses.includes(status)) {
      return replyFn('الحالات المتاحة: `idle` ، `online` ، `dnd` ، `invisible`');
    }

    const customText =
      args.text !== undefined
        ? String(args.text).trim()
        : Array.isArray(args) && args.length > 1
          ? args.slice(1).join(' ').trim()
          : botConfig.presence.text;

    botConfig.presence.status = status;
    botConfig.presence.afk = status === 'idle';
    botConfig.presence.text = customText;
    saveConfig();
    applyBotPresence();
    return replyFn(`🔄 تم تحديث الحالة إلى **${status}** والنص إلى **${customText}**`);
  }

  if (resolvedCommand === 'play') {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return replyFn('ادخل روم صوتي أولاً يا غالي 🎧');
    }

    const query = (args.query ?? (Array.isArray(args) ? args.join(' ') : '')).toString().trim();
    await replyFn('⏳ جاري التحضير والاتصال بالروم...');
    let step = 'استخراج الرابط';

    try {
      const { source, title } = await getDirectAudioUrl(query);

      step = 'الاتصال بالروم الصوتي';
      await ensureVoiceConnection(voiceChannel, guild);

      step = 'تشغيل البث الصوتي';
      const resource = createFfmpegStream(source);
      player.play(resource);

      lastQueries.set(guild.id, query);
      await updateFn(`🎶 جاري التشغيل الآن: **${title}** في **${voiceChannel.name}**`);
    } catch (error) {
      console.error(`Playback error at [${step}]:`, error);
      await updateFn(`❌ تعذّر تشغيل الصوت أثناء (**${step}**)، جرّب رابط آخر أو تأكد من صلاحية المقطع`);
    }
  }

  if (resolvedCommand === 'loop') {
    const current = loopStates.get(guild.id) || false;
    const next = !current;
    loopStates.set(guild.id, next);
    return replyFn(next ? '🔁 تم **تفعيل** تكرار المقطع الحالي' : '➡️ تم **إيقاف** تكرار المقطع');
  }

  if (resolvedCommand === 'skip') {
    loopStates.set(guild.id, false);
    player.stop();
    return replyFn('⏭️ تم تخطي المقطع الحالي');
  }

  if (resolvedCommand === 'stop') {
    loopStates.set(guild.id, false);
    lastQueries.delete(guild.id);
    player.stop();
    const connection = getVoiceConnection(guild.id);
    if (connection) {
      connection.destroy();
    }
    return replyFn('⏹️ تم الإيقاف والخروج من الروم');
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const argsObj = {
    word: interaction.options.getString('word'),
    reply: interaction.options.getString('reply'),
    alias: interaction.options.getString('alias'),
    command: interaction.options.getString('command'),
    status: interaction.options.getString('status'),
    text: interaction.options.getString('text'),
    query: interaction.options.getString('query'),
  };

  let replied = false;

  await executeUnifiedCommand({
    command: interaction.commandName,
    args: argsObj,
    member: interaction.member,
    guild: interaction.guild,
    botName: client.user?.username || 'TOP BOT',
    replyFn: async (content) => {
      replied = true;
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply(content);
      }
      return interaction.followUp(content);
    },
    updateFn: async (content) => {
      if (replied) {
        return interaction.editReply(content);
      }
      replied = true;
      return interaction.reply(content);
    },
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const currentPrefix = botConfig.prefix || '!';
  const trimmed = message.content.trim();

  if (trimmed.startsWith(currentPrefix)) {
    const parts = trimmed.slice(currentPrefix.length).trim().split(/\s+/);
    const rawCommand = parts.shift();
    if (!rawCommand) return;

    let statusMessage = null;
    await executeUnifiedCommand({
      command: rawCommand,
      args: parts,
      member: message.member,
      guild: message.guild,
      botName: client.user?.username || 'TOP BOT',
      replyFn: async (content) => {
        statusMessage = await message.reply(content);
        return statusMessage;
      },
      updateFn: async (content) => {
        if (statusMessage) {
          return statusMessage.edit(content);
        }
        statusMessage = await message.reply(content);
        return statusMessage;
      },
    });
    return;
  }

  const matchedReply = botConfig.autoReplies[trimmed.toLowerCase()];
  if (matchedReply) {
    await message.reply(matchedReply);
  }
});

const token = process.env.DISCORD_TOKEN;
client.login(token);
