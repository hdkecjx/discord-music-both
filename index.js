const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const youtubedl = require('yt-dlp-exec');

const ffmpegPath = require('ffmpeg-static');
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const prefix = '!';
const player = createAudioPlayer();

client.on('clientReady', () => {
  console.log(`✅ البوت شغال الآن باسم: ${client.user.tag}`);
});

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

async function createStreamFromQuery(query) {
  const localFile = path.join(__dirname, 'song.mp3');

  if (!query && fs.existsSync(localFile)) {
    return createAudioResource(localFile);
  }

  if (!query) {
    throw new Error('لم يتم إدخال رابط أو بحث');
  }

  // إذا كان رابط ملف صوتي مباشر مثل mp3 / ogg / wav
  if (isUrl(query) && /\.(mp3|ogg|wav|m4a|flac)(\?.*)?$/i.test(query)) {
    return createAudioResource(query);
  }

  // استخراج البث الصوتي عبر yt-dlp لـ SoundCloud و YouTube أو البحث النصي
  const target = isUrl(query) ? query : `ytsearch1:${query}`;
  const ytdlpBinary = youtubedl.exec ? undefined : undefined;

  const stream = await youtubedl.raw(target, {
    format: 'bestaudio/best',
    output: '-',
    quiet: true,
    noWarnings: true,
    noPlaylist: true,
  });

  if (!stream.stdout) {
    throw new Error('تعذّر الحصول على بث صوتي');
  }

  return createAudioResource(stream.stdout);
}

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

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      const resource = await createStreamFromQuery(query);
      connection.subscribe(player);
      player.play(resource);

      message.reply(`🎶 بدأ التشغيل في **${voiceChannel.name}**`);
    } catch (error) {
      console.error('Playback error:', error);
      message.reply('❌ تعذّر تشغيل الصوت من هذا الرابط، جرّب رابط آخر أو تأكد من صلاحية المقطع');
    }
  }

  if (command === 'stop') {
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
