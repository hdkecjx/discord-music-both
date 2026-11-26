const { Client, GatewayIntentBits, ActivityType, PermissionsBitField } = require('discord.js');
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

client.on('clientReady', () => {
  console.log(`✅ البوت شغال الآن باسم: ${client.user.tag}`);
  applyBotPresence();
  setTimeout(() => {
    applyBotPresence();
  }, 3000);
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

async function handleCommand(message, rawCommand, args) {
  const aliasTarget = botConfig.aliases[rawCommand.toLowerCase()];
  const command = (aliasTarget || rawCommand).toLowerCase();

  if (command === 'ping') {
    return message.reply(`🏓 البنق الحالي: **${Math.round(client.ws.ping)}ms**`);
  }

  if (command === 'info' || command === 'panel') {
    return message.reply(
      `🎛️ **لوحة تحكم ${client.user.username}**\n` +
      `• الصوت: \`!play [رابط/بحث/ملف]\`، \`!loop\`، \`!skip\`، \`!stop\`\n` +
      `• الردود: \`!addreply كلمة | الرد\`، \`!delreply كلمة\`، \`!listreplies\`\n` +
      `• الاختصارات: \`!addalias اختصار | أمر\`، \`!delalias اختصار\`، \`!listaliases\`\n` +
      `• الحالة: \`!setstatus idle | TOP Life 🍷\`\n` +
      `• خدمات: \`!ping\`، \`!info\``
    );
  }

  // أوامر إدارة الردود التلقائية
  if (command === 'addreply') {
    if (!isAdmin(message.member)) {
      return message.reply('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const content = args.join(' ');
    const [triggerRaw, ...replyParts] = content.split('|');
    const trigger = (triggerRaw || '').trim().toLowerCase();
    const replyText = replyParts.join('|').trim();

    if (!trigger || !replyText) {
      return message.reply('الاستخدام الصحيح: `!addreply الكلمة | الرد المطلوب`');
    }

    botConfig.autoReplies[trigger] = replyText;
    saveConfig();
    return message.reply(`✅ تم حفظ الرد التلقائي للكلمة: **${trigger}**`);
  }

  if (command === 'delreply') {
    if (!isAdmin(message.member)) {
      return message.reply('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const trigger = args.join(' ').trim().toLowerCase();
    if (!trigger || !Object.prototype.hasOwnProperty.call(botConfig.autoReplies, trigger)) {
      return message.reply('❌ لم يتم العثور على رد تلقائي بهذه الكلمة.');
    }

    delete botConfig.autoReplies[trigger];
    saveConfig();
    return message.reply(`🗑️ تم حذف الرد التلقائي للكلمة: **${trigger}**`);
  }

  if (command === 'listreplies') {
    const keys = Object.keys(botConfig.autoReplies);
    if (keys.length === 0) {
      return message.reply('📭 لا توجد ردود تلقائية مضافة حالياً.');
    }
    const lines = keys.map((k) => `• **${k}** ← ${botConfig.autoReplies[k]}`);
    return message.reply(`💬 **الردود التلقائية:**\n${lines.join('\n')}`);
  }

  // أوامر إدارة الاختصارات
  if (command === 'addalias') {
    if (!isAdmin(message.member)) {
      return message.reply('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const content = args.join(' ');
    const [aliasRaw, targetRaw] = content.split('|');
    const alias = (aliasRaw || '').trim().toLowerCase();
    const targetCmd = (targetRaw || '').trim().toLowerCase();

    if (!alias || !targetCmd) {
      return message.reply('الاستخدام الصحيح: `!addalias الاختصار | الأمر الأصلي` (مثال: `!addalias وقف | stop`)');
    }

    botConfig.aliases[alias] = targetCmd;
    saveConfig();
    return message.reply(`⚡ تم حفظ الاختصار: **!${alias}** ← **!${targetCmd}**`);
  }

  if (command === 'delalias') {
    if (!isAdmin(message.member)) {
      return message.reply('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const alias = args.join(' ').trim().toLowerCase();
    if (!alias || !Object.prototype.hasOwnProperty.call(botConfig.aliases, alias)) {
      return message.reply('❌ لم يتم العثور على هذا الاختصار.');
    }

    delete botConfig.aliases[alias];
    saveConfig();
    return message.reply(`🗑️ تم حذف الاختصار: **!${alias}**`);
  }

  if (command === 'listaliases') {
    const keys = Object.keys(botConfig.aliases);
    if (keys.length === 0) {
      return message.reply('📭 لا توجد اختصارات مضافة حالياً.');
    }
    const lines = keys.map((k) => `• **!${k}** ← **!${botConfig.aliases[k]}**`);
    return message.reply(`⚡ **الاختصارات المفعّلة:**\n${lines.join('\n')}`);
  }

  // تغيير الحالة والنص مباشرة
  if (command === 'setstatus') {
    if (!isAdmin(message.member)) {
      return message.reply('⛔ هذا الأمر متاح للأدمن فقط.');
    }
    const content = args.join(' ');
    const [statusRaw, ...textParts] = content.split('|');
    const status = (statusRaw || '').trim().toLowerCase();
    const validStatuses = ['online', 'idle', 'dnd', 'invisible'];

    if (!validStatuses.includes(status)) {
      return message.reply('الاستخدام الصحيح: `!setstatus idle | TOP Life 🍷` (الحالات: `online` / `idle` / `dnd` / `invisible`)');
    }

    const customText = textParts.length > 0 ? textParts.join('|').trim() : botConfig.presence.text;
    botConfig.presence.status = status;
    botConfig.presence.afk = status === 'idle';
    botConfig.presence.text = customText;
    saveConfig();
    applyBotPresence();
    return message.reply(`🔄 تم تحديث الحالة إلى **${status}** والنص إلى **${customText}**`);
  }

  // أوامر الصوت
  if (command === 'play') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('ادخل روم صوتي أولاً يا غالي 🎧');
    }

    const query = args.join(' ').trim();
    const statusMsg = await message.reply('⏳ جاري التحضير والاتصال بالروم...');
    let step = 'استخراج الرابط';

    try {
      const { source, title } = await getDirectAudioUrl(query);

      step = 'الاتصال بالروم الصوتي';
      await ensureVoiceConnection(voiceChannel, message.guild);

      step = 'تشغيل البث الصوتي';
      const resource = createFfmpegStream(source);
      player.play(resource);

      lastQueries.set(message.guild.id, query);
      await statusMsg.edit(`🎶 جاري التشغيل الآن: **${title}** في **${voiceChannel.name}**`);
    } catch (error) {
      console.error(`Playback error at [${step}]:`, error);
      await statusMsg.edit(`❌ تعذّر تشغيل الصوت أثناء (**${step}**)، جرّب رابط آخر أو تأكد من صلاحية المقطع`);
    }
  }

  if (command === 'loop') {
    const current = loopStates.get(message.guild.id) || false;
    const next = !current;
    loopStates.set(message.guild.id, next);
    message.reply(next ? '🔁 تم **تفعيل** تكرار المقطع الحالي' : '➡️ تم **إيقاف** تكرار المقطع');
  }

  if (command === 'skip') {
    loopStates.set(message.guild.id, false);
    player.stop();
    message.reply('⏭️ تم تخطي المقطع الحالي');
  }

  if (command === 'stop') {
    loopStates.set(message.guild.id, false);
    lastQueries.delete(message.guild.id);
    player.stop();
    const connection = getVoiceConnection(message.guild.id);
    if (connection) {
      connection.destroy();
    }
    message.reply('⏹️ تم الإيقاف والخروج من الروم');
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const currentPrefix = botConfig.prefix || '!';
  const trimmed = message.content.trim();

  if (trimmed.startsWith(currentPrefix)) {
    const args = trimmed.slice(currentPrefix.length).trim().split(/\s+/);
    const rawCommand = args.shift();
    if (!rawCommand) return;
    await handleCommand(message, rawCommand, args);
    return;
  }

  const matchedReply = botConfig.autoReplies[trimmed.toLowerCase()];
  if (matchedReply) {
    await message.reply(matchedReply);
  }
});

const token = process.env.DISCORD_TOKEN;
client.login(token);
