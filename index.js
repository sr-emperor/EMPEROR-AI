const { makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Express app for Render (keeps the app alive by exposing a port)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Group-specific settings
const GROUP_JID = '120363XXXXXXXXX@g.us'; // REPLACE WITH YOUR ACTUAL GROUP JID (e.g., from !id command)
const OFFENSIVE_WORDS = ['stupid', 'idiot', 'fuck']; // Add more as needed
const GROUP_RULES = `
📜 GROUP RULES:
1. Respect everyone, no insults or hate.
2. No spam, ads, or illegal content.
3. Introduce yourself when joining.
4. Follow admin instructions.
5. Do NOT mention the group in your WhatsApp status. Failure to do so results in auto-removal.
`;

// Phone number for pairing (hardcoded as provided; use env var for security)
const PHONE_NUMBER = '237678540775';

// In-memory storage (resets on restart; use a DB for persistence)
let warnings = {}; // { userJid: count }
let sock; // WhatsApp socket
let pairingRequested = false; // Flag to prevent multiple pairing requests
let pairingAttempts = 0; // Track pairing attempts to detect corruption
let reconnectTimeout; // To manage delayed reconnects
let stabilizationTimeout; // For 120-second delay after 'open'

// Function to clear corrupted session (for "Wrong Number" issues)
function clearSession() {
  const authPath = './auth_info';
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true, force: true });
    console.log('🗑️ Cleared corrupted session data. Restart the bot to re-pair.');
  }
}

// Function to start the bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info'); // Session persistence

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, {}),
    },
    browser: ['Blind FLAME Bot', 'Chrome', '1.0.0'], // Custom browser info
  });

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    console.log(`🔄 Connection update: ${connection}`); // Debug log

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('❌ Connection closed. Reason:', lastDisconnect?.error?.message || 'Unknown');
      console.log('⏳ Reconnecting in 10 seconds to prevent loops...');
      
      // Clear any existing timeouts
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (stabilizationTimeout) clearTimeout(stabilizationTimeout);
      
      // 10-second cool-down before reconnect
      reconnectTimeout = setTimeout(() => {
        pairingRequested = false; // Reset flags
        pairingAttempts = 0;
        startBot();
      }, 10000); // 10 seconds
    } else if (connection === 'connecting') {
      console.log('🔗 Connecting to WhatsApp...');
      // Request pairing only here if not registered, not already requested, and attempts < 3
      if (!sock.authState.creds.registered && !pairingRequested && pairingAttempts < 3) {
        pairingRequested = true;
        pairingAttempts++;
        try {
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log(`🔢 Pairing code for ${PHONE_NUMBER}: ${code}`);
          console.log('📱 Enter this 6-digit code in WhatsApp > Linked Devices > Link a Device. Expires in ~1-2 minutes.');
        } catch (error) {
          console.error('❌ Pairing error:', error.message);
          if (error.output?.statusCode === 428 || error.message.includes('Wrong Number')) {
            console.log('⚠️ Precondition Required (428) or Wrong Number detected. Clearing session and retrying...');
            clearSession();
            pairingRequested = false; // Allow retry after clear
          }
          if (pairingAttempts >= 3) {
            console.log('🚫 Max pairing attempts reached. Clear session manually and restart.');
          }
        }
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp! Stabilizing for 120 seconds...');
      pairingRequested = false; // Reset for future use
      pairingAttempts = 0;

      // Clear any existing stabilization timeout
      if (stabilizationTimeout) clearTimeout(stabilizationTimeout);
      
      // 120-second delay after 'open' to ensure full stabilization
      stabilizationTimeout = setTimeout(() => {
        console.log('🚀 Bot fully stabilized. Ready for operations.');
        // Bot operations (e.g., message handling) can proceed here if needed
      }, 120000); // 120 seconds
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Handle group participant updates (for welcome) - Only after stabilization if needed, but kept as-is for now
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    if (id !== GROUP_JID || action !== 'add') return; // Only for joins in our group

    try {
      const groupMetadata = await sock.groupMetadata(id);
      const newMembers = participants.map(p => `@${p.split('@')[0]}`).join(' ');

      const welcomeMessage = `
Welcome ${newMembers} to Blind FLAME! 🎉

Please introduce yourself with:
- Picture
- Age
- Location
- Occupation
- Kids (yes/no)
- Relationship status
- Fun fact

${GROUP_RULES}
      `;

      await sock.sendMessage(id, { text: welcomeMessage, mentions: participants });
    } catch (error) {
      console.error('Error sending welcome:', error);
    }
  });

  // Handle messages - Only after stabilization if needed, but kept as-is for now
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return; // Ignore own messages

    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const sender = msg.key.participant || msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    // Group restriction: Only respond in Blind FLAME group
    if (isGroup && chatId !== GROUP_JID) return;
    if (!isGroup) return; // Ignore private chats

    try {
      // Status rule enforcement (workaround: Check for group name in messages)
      if (text.toLowerCase().includes('blind flame')) {
        const groupMetadata = await sock.groupMetadata(chatId);
        const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
        const adminTags = admins.map(a => `@${a.split('@')[0]}`).join(' ');
        await sock.sendMessage(chatId, {
          text: `⚠️ Possible status violation detected from @${sender.split('@')[0]}. Admins, please check and remove if necessary. ${adminTags}`,
          mentions: [sender, ...admins]
        });
        console.log(`Status violation logged for ${sender}`);
      }

      // Moderation: Check for offensive words
      const lowerText = text.toLowerCase();
      const hasOffensive = OFFENSIVE_WORDS.some(word => lowerText.includes(word));
      if (hasOffensive) {
        // Delete message (if possible)
        await sock.sendMessage(chatId, { delete: msg.key });

        // Send warning
        warnings[sender] = (warnings[sender] || 0) + 1;
        const warnCount = warnings[sender];
        await sock.sendMessage(chatId, {
          text: `⚠️ @${sender.split('@')[0]}, your message contained offensive content. Warning ${warnCount}/3.`,
          mentions: [sender]
        });

        // Remove after 3 warnings
        if (warnCount >= 3) {
          await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
          await sock.sendMessage(chatId, { text: `@${sender.split('@')[0]} has been removed for repeated violations.`, mentions: [sender] });
          delete warnings[sender];
        }
      }

      // Commands
      if (text.startsWith('!')) {
        const command = text.slice(1).trim().toLowerCase();

        if (command === 'rules') {
          await sock.sendMessage(chatId, { text: GROUP_RULES });
        } else if (command.startsWith('all ')) {
          const message = text.slice(4).trim();
          const groupMetadata = await sock.groupMetadata(chatId);
          const allMembers = groupMetadata.participants.map(p => p.id);
          const tags = allMembers.map(m => `@${m.split('@')[0]}`).join(' ');
          await sock.sendMessage(chatId, { text: `${message}\n${tags}`, mentions: allMembers });
        } else if (command === 'admin') {
          const groupMetadata = await sock.groupMetadata(chatId);
          const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
          const adminTags = admins.map(a => `@${a.split('@')[0]}`).join(' ');
          await sock.sendMessage(chatId, { text: `Admins: ${adminTags}`, mentions: admins });
        } else if (command === 'id') {
          await sock.sendMessage(chatId, { text: `Group ID: ${chatId}` });
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
}

// Start the bot
startBot().catch(console.error);
