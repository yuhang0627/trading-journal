import crypto from 'node:crypto';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));

const {
  PORT = '8787',
  WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  JOURNAL_USER_ID,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-20250514',
  ALLOWED_SENDERS = '',
  SOURCE_TIMEZONE_OFFSET = '+03:00',
  TARGET_TIMEZONE_OFFSET = '+08:00'
} = process.env;

const requiredEnv = {
  WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  JOURNAL_USER_ID,
  ANTHROPIC_API_KEY
};

for (const [key, value] of Object.entries(requiredEnv)) {
  if (!value) {
    console.warn(`[config] Missing ${key}`);
  }
}

const allowedSenders = ALLOWED_SENDERS.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const sourceTimezoneMinutes = parseUtcOffsetToMinutes(SOURCE_TIMEZONE_OFFSET);
const targetTimezoneMinutes = parseUtcOffsetToMinutes(TARGET_TIMEZONE_OFFSET);
const brokerToJournalMinutes = targetTimezoneMinutes - sourceTimezoneMinutes;

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'trading-journal-automation' });
});

app.post('/vantage/email-summary', async (req, res) => {
  try {
    requireSecret(req);
    requireAllowedSender(req.body.from || '');

    const email = normalizeEmailPayload(req.body);
    const sourceId = `gmail:${email.messageId || sha256(email.subject + email.date + email.body).slice(0, 24)}`;

    const existing = await supabaseSelect(
      `automation_import_events?select=id,status&source_id=eq.${encodeURIComponent(sourceId)}&limit=1`
    );

    if (existing.length && existing[0].status === 'completed') {
      return res.json({ ok: true, skipped: true, reason: 'already_imported', source_id: sourceId });
    }

    await logImportEvent(sourceId, 'processing', email, null);

    const parsed = await parseEmailWithClaude(email);
    const normalized = normalizeParsedPayload(parsed, sourceId);

    if (!normalized.trades.length && !normalized.summaries.length && !normalized.notes.length) {
      await logImportEvent(sourceId, 'ignored', email, { reason: 'no_records', parsed });
      return res.json({ ok: true, skipped: true, reason: 'no_records', source_id: sourceId });
    }

    const result = {
      trades: normalized.trades.length ? await upsertRows('trades', normalized.trades, 'user_id,source_id') : [],
      summaries: normalized.summaries.length ? await upsertRows('summaries', normalized.summaries, 'user_id,summary_date') : [],
      notes: normalized.notes.length ? await upsertRows('notes', normalized.notes, 'user_id,source_id') : []
    };

    await logImportEvent(sourceId, 'completed', email, {
      counts: {
        trades: normalized.trades.length,
        summaries: normalized.summaries.length,
        notes: normalized.notes.length
      }
    });

    res.json({ ok: true, source_id: sourceId, counts: resultCounts(result) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal error' });
  }
});

function requireSecret(req) {
  const got = req.header('x-webhook-secret') || req.body.secret;
  if (!WEBHOOK_SECRET || got !== WEBHOOK_SECRET) {
    const err = new Error('Unauthorized webhook');
    err.status = 401;
    throw err;
  }
}

function requireAllowedSender(from) {
  if (!allowedSenders.length) return;
  const lower = from.toLowerCase();
  if (!allowedSenders.some((sender) => lower.includes(sender))) {
    const err = new Error(`Sender not allowed: ${from}`);
    err.status = 403;
    throw err;
  }
}

function normalizeEmailPayload(body) {
  const email = {
    messageId: String(body.messageId || body.message_id || '').trim(),
    threadId: String(body.threadId || body.thread_id || '').trim(),
    from: String(body.from || '').trim(),
    subject: String(body.subject || '').trim(),
    date: String(body.date || new Date().toISOString()).trim(),
    body: String(body.plainBody || body.body || '').trim()
  };

  if (!email.body) {
    const err = new Error('Missing email body');
    err.status = 400;
    throw err;
  }

  return email;
}

async function parseEmailWithClaude(email) {
  const prompt = `You parse Vantage broker daily summary emails into strict JSON for a trading journal.

Return JSON only. No markdown. No commentary.

Schema:
{
  "trades": [
    {
      "trade_date": "YYYY-MM-DD",
      "pair": "XAUUSD",
      "direction": "Buy or Sell",
      "exit_type": "TP, SL, or Manual",
      "entry": 0,
      "exit": 0,
      "pnl": 0,
      "lots": 0,
      "fees": 0,
      "trade_time": "HH:MM or null",
      "exit_time": "HH:MM or null",
      "exit_date": "YYYY-MM-DD or null",
      "balance_after": null,
      "pct_gain": null,
      "strategy": null,
      "source_id": null
    }
  ],
  "summaries": [
    {
      "summary_date": "YYYY-MM-DD",
      "type": "positive, negative, mixed, or note",
      "text": "short human readable summary"
    }
  ],
  "notes": []
}

Rules:
- Use numbers, not strings, for money, prices, lots, fees, percentages.
- Use negative pnl for losses.
- If the email has an order/deal/ticket id, put it in trade.source_id.
- If a field is unknown, use null except required trade fields.
- Do not invent trades.
- Prefer the broker's exact P&L and lot values over calculations.
- Times in the email body are broker local time (${SOURCE_TIMEZONE_OFFSET}).
- Extract times exactly as written in the email. Do not convert timezones yourself.
- If an overnight close date is visible, include exit_date as YYYY-MM-DD.

Email metadata:
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}

Email body:
${email.body}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Claude parse failed: ${JSON.stringify(data)}`);
  }

  const text = (data.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();

  try {
    return JSON.parse(stripJsonFence(text));
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

function normalizeParsedPayload(parsed, sourceId) {
  const trades = Array.isArray(parsed.trades) ? parsed.trades : [];
  const summaries = Array.isArray(parsed.summaries) ? parsed.summaries : [];
  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];

  return {
    trades: trades
      .map((trade, index) => normalizeTrade(trade, sourceId, index))
      .filter(Boolean),
    summaries: summaries
      .map((summary, index) => normalizeSummary(summary, sourceId, index))
      .filter(Boolean),
    notes: notes
      .map((note, index) => normalizeNote(note, sourceId, index))
      .filter(Boolean)
  };
}

function normalizeTrade(trade, sourceId, index) {
  const normalizedDateTime = normalizeTradeDateTimes(trade);
  const tradeDate = normalizedDateTime.trade_date || cleanDate(trade.trade_date || trade.date);
  const pair = cleanText(trade.pair || trade.symbol || '').toUpperCase();
  const pnl = numberOrZero(trade.pnl);

  if (!tradeDate || !pair) return null;

  const rawSource = cleanText(trade.source_id || trade.ticket || trade.order_id || trade.deal_id || '');
  const sourceKey = rawSource || sha256(JSON.stringify({
    trade_date: tradeDate,
    pair,
    direction: trade.direction,
    entry: trade.entry,
    exit: trade.exit,
    lots: trade.lots,
    pnl,
    index
  })).slice(0, 16);

  return {
    user_id: JOURNAL_USER_ID,
    source: 'vantage_email',
    source_id: `${sourceId}:trade:${sourceKey}`,
    trade_date: tradeDate,
    pair,
    direction: normalizeDirection(trade.direction),
    exit_type: normalizeExitType(trade.exit_type),
    entry: numberOrZero(trade.entry),
    exit: numberOrZero(trade.exit),
    pnl,
    lots: numberOrDefault(trade.lots, 0.01),
    fees: numberOrZero(trade.fees),
    trade_time: normalizedDateTime.trade_time,
    exit_date: normalizedDateTime.exit_date,
    exit_time: normalizedDateTime.exit_time,
    balance_after: numberOrNull(trade.balance_after),
    pct_gain: numberOrNull(trade.pct_gain),
    strategy: cleanTextOrNull(trade.strategy),
    mood: cleanTextOrNull(trade.mood),
    emotional: cleanTextOrNull(trade.emotional),
    execution_rating: cleanTextOrNull(trade.execution_rating)
  };
}

function normalizeSummary(summary, sourceId, index) {
  const summaryDate = cleanDate(summary.summary_date || summary.date);
  if (!summaryDate) return null;

  return {
    user_id: JOURNAL_USER_ID,
    source: 'vantage_email',
    source_id: `${sourceId}:summary:${index + 1}`,
    summary_date: summaryDate,
    type: normalizeSummaryType(summary.type),
    text: cleanText(summary.text || summary.summary || 'Imported Vantage summary.')
  };
}

function normalizeNote(note, sourceId, index) {
  const noteDate = cleanDate(note.note_date || note.date);
  if (!noteDate) return null;

  return {
    user_id: JOURNAL_USER_ID,
    source: 'vantage_email',
    source_id: `${sourceId}:note:${index + 1}`,
    note_date: noteDate,
    type: cleanText(note.type || 'note'),
    note_time: cleanTime(note.note_time),
    text: cleanText(note.text || ''),
    outcome: cleanTextOrNull(note.outcome)
  };
}

async function supabaseSelect(path) {
  const response = await supabaseRequest(path, { method: 'GET' });
  return response.json();
}

async function upsertRows(table, rows, onConflict) {
  const response = await supabaseRequest(`${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  });
  return response.json();
}

async function logImportEvent(sourceId, status, email, details) {
  const row = {
    source_id: sourceId,
    source: 'gmail',
    status,
    email_from: email.from,
    email_subject: email.subject,
    email_date: email.date,
    details,
    updated_at: new Date().toISOString()
  };

  await supabaseRequest('automation_import_events?on_conflict=source_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
}

async function supabaseRequest(path, opts) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(opts.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${opts.method || 'GET'} ${path} failed: ${response.status} ${text}`);
  }

  return response;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanTextOrNull(value) {
  const text = cleanText(value);
  return text || null;
}

function cleanDate(value) {
  const text = cleanText(value);
  const flexible = parseFlexibleDateTime(text);
  if (flexible?.date) return flexible.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return '';
}

function cleanTime(value) {
  const text = cleanText(value);
  const flexible = parseFlexibleDateTime(text);
  if (flexible?.time) return flexible.time;
  const match = text.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function normalizeTradeDateTimes(trade) {
  const rawTradeDate = trade.trade_date || trade.date || trade.open_date || '';
  const rawTradeTime = trade.trade_time || trade.open_time || trade.entry_time || '';
  const rawExitDate = trade.exit_date || trade.close_date || '';
  const rawExitTime = trade.exit_time || trade.close_time || '';

  const entry = convertBrokerDateTime(rawTradeDate, rawTradeTime);
  const tradeDate = entry.date || cleanDate(rawTradeDate);
  const tradeTime = entry.time || cleanTime(rawTradeTime);

  const exit = convertBrokerDateTime(rawExitDate || tradeDate, rawExitTime, tradeDate);
  let exitDate = exit.date || cleanDate(rawExitDate);
  const exitTime = exit.time || cleanTime(rawExitTime);

  if (!exitDate && exitTime && tradeDate && tradeTime && exitTime < tradeTime) {
    exitDate = addDays(tradeDate, 1);
  }

  return {
    trade_date: tradeDate,
    trade_time: tradeTime,
    exit_date: exitDate && exitDate !== tradeDate ? exitDate : null,
    exit_time: exitTime
  };
}

function convertBrokerDateTime(dateValue, timeValue, fallbackDate = '') {
  const parsedTime = parseFlexibleDateTime(timeValue);
  if (parsedTime?.date && parsedTime.time) {
    return shiftDateTimeParts(parsedTime.date, parsedTime.time, brokerToJournalMinutes);
  }

  const parsedDate = parseFlexibleDateTime(dateValue);
  if (parsedDate?.date && parsedDate.time) {
    return shiftDateTimeParts(parsedDate.date, parsedDate.time, brokerToJournalMinutes);
  }

  const date = parsedDate?.date || cleanDate(dateValue) || fallbackDate;
  const time = parsedTime?.time || parsedDate?.time || cleanTime(timeValue);

  if (!date || !time) {
    return { date, time: time || null };
  }

  return shiftDateTimeParts(date, time, brokerToJournalMinutes);
}

function parseFlexibleDateTime(value) {
  const text = cleanText(value).replace(/\//g, '-').replace(/\s+/g, ' ');
  if (!text) return null;

  const match = text.match(/^(\d{2}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/);
  if (match) {
    const year = normalizeYear(match[1]);
    return {
      date: `${year}-${match[2]}-${match[3]}`,
      time: match[4] !== undefined ? `${match[4].padStart(2, '0')}:${match[5]}` : null
    };
  }

  const timeOnly = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    return {
      date: '',
      time: `${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}`
    };
  }

  return null;
}

function normalizeYear(year) {
  if (year.length === 4) return year;
  const numericYear = Number(year);
  return String(numericYear >= 70 ? 1900 + numericYear : 2000 + numericYear);
}

function shiftDateTimeParts(date, time, deltaMinutes) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute) + deltaMinutes * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16)
  };
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function parseUtcOffsetToMinutes(offset) {
  const match = String(offset || '').trim().match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function normalizeDirection(value) {
  const text = cleanText(value).toLowerCase();
  return text.startsWith('s') ? 'Sell' : 'Buy';
}

function normalizeExitType(value) {
  const text = cleanText(value).toLowerCase();
  if (text === 'tp' || text.includes('take')) return 'TP';
  if (text === 'sl' || text.includes('stop')) return 'SL';
  return 'Manual';
}

function normalizeSummaryType(value) {
  const text = cleanText(value).toLowerCase();
  if (['positive', 'negative', 'mixed', 'note'].includes(text)) return text;
  return 'note';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value) {
  return numberOrNull(value) ?? 0;
}

function numberOrDefault(value, fallback) {
  return numberOrNull(value) ?? fallback;
}

function stripJsonFence(text) {
  return text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function resultCounts(result) {
  return Object.fromEntries(
    Object.entries(result).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : 0])
  );
}

app.listen(Number(PORT), () => {
  console.log(`Trading journal automation listening on :${PORT}`);
});
