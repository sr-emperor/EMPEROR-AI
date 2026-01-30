const { makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Hardcoded values (replace as needed)
const GROUP_ID = 'YOUR_GROUP_ID_HERE'; // Replace with actual group ID (e.g., '120363XXXXXX@g.us'). Run the bot once and log it.
const PHONE_NUMBER = '237678540775@c.us'; // Your phone number in WhatsApp format
const proxyUrl = "socks5://123.123.123.123:1080";

// In-memory storage (resets on restart)
let warnings = {}; // { userId: count }
const OFFENSIVE_WORDS = ['stupid', 'idiot', 'fuck']; // Add more as needed

// Group rules
const GROUP_RULES = `📜 GROUP RULES:
1. Respect everyone, no insults or hate.
2. No spam, ads, or illegal content.
3. Introduce yourself when joining.
4. Follow admin instructions.
5. Do NOT mention the group in your WhatsApp status. Failure to do so results in auto-removal.`;

// Welcome message template
const WELCOME_MESSAGE = (newMembers) => {
  const tags = newMembers.map(m => `@${m.split('@')[0]}`).join(' ');
  return `Welcome ${tags}! 🎉

Please introduce yourself with:
- Picture
- Age
- Location
- Occupation
- Kids (yes/no)
- Relationship status
- Fun fact

${GROUP_RULES}`;
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, {}),
    },
    printQRInTerminal: true,
    browser: ['Blind FLAME Bot', 'Chrome', '1.0.0'],
    agent: SOCKS5_PROXY ? new SocksProxyAgent(SOCKS5_PROXY) : undefined, // SOCKS5 proxy support
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Connected!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Group participants update (for welcome)
  sock.ev.on('group-participants.update', async (update) => {
    if (update.id !== GROUP_ID) return; // Only for Blind FLAME
    if (update.action === 'add') {
      const newMembers = update.participants;
      await sock.sendMessage(GROUP_ID, { text: WELCOME_MESSAGE(newMembers), mentions: newMembers });
    }
  });

  // Messages (for commands, moderation, status check)
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const chatId = msg.key.remoteJid;
    if (chatId !== GROUP_ID) return; // Only in Blind FLAME

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const sender = msg.key.participant || msg.key.remoteJid;
    const isAdmin = (await sock.groupMetadata(GROUP_ID)).participants.find(p => p.id === sender)?.admin;

    // Moderation: Check for offensive words
    const hasOffensive = OFFENSIVE_WORDS.some(word => text.toLowerCase().includes(word));
    if (hasOffensive) {
      await sock.sendMessage(GROUP_ID, { delete: msg.key }); // Delete message
      warnings[sender] = (warnings[sender] || 0) + 1;
      await sock.sendMessage(GROUP_ID, { text: `@${sender.split('@')[0]}, warning ${warnings[sender]}/3 for offensive language.`, mentions: [sender] });
      if (warnings[sender] >= 3) {
        await sock.groupParticipantsUpdate(GROUP_ID, [sender], 'remove');
        delete warnings[sender];
      }
      return;
    }

    // Status rule: Check for group mentions (approximation)
    if (text.toLowerCase().includes('blind flame') || text.toLowerCase().includes(GROUP_ID.split('@')[0])) {
      await sock.groupParticipantsUpdate(GROUP_ID, [sender], 'remove');
      const admins = (await sock.groupMetadata(GROUP_ID)).participants.filter(p => p.admin).map(p => p.id);
      await sock.sendMessage(GROUP_ID, { text: `Removed @${sender.split('@')[0]} for mentioning the group (status rule violation). Notified admins.`, mentions: [sender, ...admins] });
      return;
    }

    // Commands
    if (text.startsWith('!')) {
      const command = text.slice(1).split(' ')[0];
      const args = text.slice(1).split(' ').slice(1).join(' ');

      switch (command) {
        case 'rules':
          await sock.sendMessage(GROUP_ID, { text: GROUP_RULES });
          break;
        case 'all':
          if (!isAdmin) return;
          const members = (await sock.groupMetadata(GROUP_ID)).participants.map(p => p.id);
          await sock.sendMessage(GROUP_ID, { text: args || 'Tagging all!', mentions: members });
          break;
        case 'admin':
          const admins = (await sock.groupMetadata(GROUP_ID)).participants.filter(p => p.admin).map(p => p.id);
          await sock.sendMessage(GROUP_ID, { text: 'Tagging admins!', mentions: admins });
          break;
        case 'id':
          await sock.sendMessage(GROUP_ID, { text: `Group ID: ${GROUP_ID}` });
          break;
      }
    }
  });

  // Error handling
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

startBot();
