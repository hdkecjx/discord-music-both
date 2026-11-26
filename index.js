const { Client, GatewayIntentBits } = require('discord.js');
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const prefix = '!';
const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause,
  },
});

const loopStates = new Map();
const lastQueries = new Map();

client.on('clientReady', () => {
  console.log(`✅ البوت شغال الآن باسم: ${client.user.tag}`);
});

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
    return { source: localFile, title: 'song.mp3' };
  }

  if (!query) {
    throw new Error('لم يتم إدخال رابط أو اسم مقطع');
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
    await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
  } catch (err) {
    console.warn('Retrying voice connection after timeout/abort:', err?.name || err);
    connection = await createFreshConnection(voiceChannel, guild);
    await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (command === 'play') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('ادخل روم صوتي أولاً يا غالي 🎧');
    }

    const query = args.join(' ').trim();
    let step = 'استخراج الرابط';

    try {
      const { source, title } = await getDirectAudioUrl(query);

      step = 'الاتصال بالروم الصوتي';
      await ensureVoiceConnection(voiceChannel, message.guild);

      step = 'تشغيل البث الصوتي';
      const resource = createFfmpegStream(source);
      player.play(resource);

      lastQueries.set(message.guild.id, query);
      message.reply(`🎶 جاري التشغيل الآن: **${title}** في **${voiceChannel.name}**`);
    } catch (error) {
      console.error(`Playback error at [${step}]:`, error);
      message.reply(`❌ تعذّر تشغيل الصوت أثناء (**${step}**)، جرّب رابط آخر أو تأكد من صلاحية المقطع`);
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
});

const token = process.env.DISCORD_TOKEN;
client.login(token);
