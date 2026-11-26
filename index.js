const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const path = require('path');

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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // مثال: !play https://example.com/audio.mp3 أو !play (إذا حاط ملف song.mp3)
  if (command === 'play') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('ادخل روم صوتي أولاً يا غالي 🎧');
    }

    const source = args[0] || path.join(__dirname, 'song.mp3');

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      const resource = createAudioResource(source);
      connection.subscribe(player);
      player.play(resource);

      message.reply(`🎶 بدأ التشغيل في **${voiceChannel.name}**`);
    } catch (error) {
      console.error(error);
      message.reply('❌ تعذّر تشغيل الصوت، تأكد من الرابط أو وجود ملف song.mp3');
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

const token = process.env.DISCORD_TOKEN || '‏MTU3NTQxNzAxNTExMDIxMzcwMg.GuErXD.FVKB2d8yY_O5RLBCIF1XLsv2iT4SV0jyRshHiw';
client.login(token);
