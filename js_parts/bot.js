import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let whatsAppSocket = null;
let isReady = false;
let latestQR = null;
let connectionState = 'starting';
let lastConnectedAt = null;

const app = express();
const port = Number(process.env.PORT) || 3000;
const requestWindowMs = 60 * 1000;
const requestLimit = 25;
const requestTimestamps = new Map();

app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
    const now = Date.now();
    const timestamps = (requestTimestamps.get(req.ip) || [])
        .filter((timestamp) => now - timestamp < requestWindowMs);

    if (timestamps.length >= requestLimit) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }

    timestamps.push(now);
    requestTimestamps.set(req.ip, timestamps);
    next();
});

function normalizeKenyanNumber(input) {
    if (input === undefined || input === null) return null;
    let digits = String(input).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('254')) {
    } else if (digits.startsWith('0')) {
        digits = '254' + digits.slice(1);
    } else if (digits.length === 9) {
        digits = '254' + digits;
    } else {
        return null;
    }
    if (!/^254(7|1)\d{8}$/.test(digits)) return null;
    return digits;
}

app.get('/test', (req, res) => {
    res.json({
        status: 'ok',
        whatsappReady: isReady,
        connectionState,
        lastConnectedAt,
    });
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', whatsappReady: isReady });
});

app.get('/qr', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'views', 'qr.html'));
});

app.get('/qr-data', async (req, res) => {
    res.set('Cache-Control', 'no-store');

    if (isReady) {
        return res.json({ ready: true, connectedAt: lastConnectedAt });
    }

    if (!latestQR) {
        return res.json({ ready: false, state: connectionState });
    }

    try {
        const dataUrl = await QRCode.toDataURL(latestQR, {
            width: 360,
            margin: 2,
            color: { dark: '#000', light: '#f0ec0d' },
        });
        return res.json({ ready: false, qr: dataUrl, state: connectionState });
    } catch (err) {
        console.error('Failed to render QR:', err);
        return res.status(500).json({ error: 'Failed to render QR' });
    }
});

app.post('/send_message', async (req, res) => {
    const { phone_number, message } = req.body || {};

    const body = message === undefined || message === null
        ? ''
        : String(message);

    if (!body.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }

    const recipient = normalizeKenyanNumber(phone_number);

    if (!recipient) {
        return res.status(400).json({
            error: 'phone_number must be a valid Kenyan number (0…, 254…, or +254…)',
        });
    }

    if (!isReady || !whatsAppSocket) {
        return res.status(503).json({ error: 'WhatsApp is not connected' });
    }

    try {
        const jid = `${recipient}@s.whatsapp.net`;

        const [onWa] = await whatsAppSocket.onWhatsApp(jid);
        if (!onWa?.exists) {
            return res.status(400).json({ error: 'Number is not registered on WhatsApp' });
        }

        const targetJid = onWa.jid || jid;

        const sent = await whatsAppSocket.sendMessage(targetJid, { text: body });

        return res.json({
            sent: true,
            messageId: sent?.key?.id ?? null,
            to: targetJid,
        });
    } catch (error) {
        console.error('Failed to send message:', error?.message ?? error);
        return res.status(502).json({ error: 'Unable to send the message' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${port}`);
});

async function notifyConnect(socket) {
    lastConnectedAt = new Date().toISOString();

    try {
        const selfJid = socket.user?.id;
        if (selfJid) {
            await socket.sendMessage(selfJid, {
                text: `*Bot connected successfully*\n\nTime: ${lastConnectedAt}`,
            });
            console.log('Self-notification sent to', selfJid);
        }
    } catch (err) {
        console.error('Self-notify failed:', err?.message ?? err);
    }

    const url = process.env.CONNECT_WEBHOOK_URL;
    if (url) {
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: `*WhatsApp bot connected*\n\nTime: ${lastConnectedAt}`,
                }),
            });
            console.log('Webhook notification sent');
        } catch (err) {
            console.error('Webhook notify failed:', err?.message ?? err);
        }
    }
}

export async function loginBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('csk-bot-auth');
        const { version } = await fetchLatestBaileysVersion();

        const socket = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            browser: ['csk-bot', 'Chrome', '14.4.0'],
            shouldSyncHistoryMessages: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: 'retry' }),
        });

        whatsAppSocket = socket;

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQR = qr;
                connectionState = 'qr';
                console.log('New QR generated — open /qr to scan');
            }

            if (connection === 'connecting') {
                connectionState = 'connecting';
            }

            if (connection === 'close') {
                isReady = false;
                whatsAppSocket = null;
                connectionState = 'closed';

                const disconnectError = lastDisconnect?.error;
                const statusCode = disconnectError?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed:', statusCode, '| reconnecting:', shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(() => loginBot(), 3000);
                }
            } else if (connection === 'open') {
                console.log('Connected to WhatsApp');
                isReady = true;
                latestQR = null;
                connectionState = 'open';
                await notifyConnect(socket);
            }
        });

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('messages.update', (updates) => {
            for (const { key, update } of updates) {
                if (update.status === 3) {
                    console.log(`Delivered: ${key.id} -> ${key.remoteJid}`);
                } else if (update.status === 4) {
                    console.log(`Read: ${key.id} -> ${key.remoteJid}`);
                }
            }
        });

        socket.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                if (chatUpdate.type !== 'notify') return;

                for (const m of chatUpdate.messages) {
                    if (m.key.fromMe) continue;
                    if (!m.message) continue;

                    await socket.readMessages([m.key]);

                    const remoteJid = m.key.remoteJid;

                    const textMessage = m.message.conversation
                        || m.message.extendedTextMessage?.text
                        || m.message.imageMessage?.caption
                        || m.message.videoMessage?.caption;

                    console.log(`Received message from ${remoteJid}: ${textMessage}`);

                    const text = textMessage?.toLowerCase();

                    if (text === 'namastee') {
                        await socket.sendMessage(remoteJid, { text: 'toka hapa vibe coder😂😂😂🫵' });
                    } else if (text === 'hehaa' || text === 'heha') {
                        await socket.sendMessage(remoteJid, { text: 'Wahioo!!😂😂😂' });
                    }
                }
            } catch (error) {
                console.error('Error handling incoming message:', error);
            }
        });
    } catch (error) {
        connectionState = 'error';
        console.log('Bot error:', error);
        setTimeout(() => loginBot(), 5000);
    }
}

loginBot();