# Trading Journal Automation

This service receives Vantage summary emails from Gmail Apps Script, parses them with Claude, and writes trades/summaries into Supabase using the service role key.

## Files

- `server.js`: Hetzner VPS webhook server.
- `gmail-apps-script.js`: Gmail polling script that posts matching emails to the VPS.
- `.env.example`: environment variables for the VPS.

## Supabase

Run `supabase-automation.sql` once in Supabase SQL Editor.

It adds:

- `source`
- `source_id`
- `exit_date` for overnight trades
- unique indexes for idempotent imports
- `automation_import_events` log table

## VPS Setup

```bash
cd /opt
git clone https://github.com/yuhang0627/trading-journal.git
cd trading-journal/automation
npm install
cp .env.example .env
nano .env
npm start
```

Required `.env` values:

```env
PORT=8787
WEBHOOK_SECRET=make-this-long-and-random
SUPABASE_URL=https://sdjxruurjbnpxvsdcdwm.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JOURNAL_USER_ID=80cd75f6-eb63-495f-a0fc-a900ea1db826
ANTHROPIC_API_KEY=your-claude-api-key
CLAUDE_MODEL=claude-sonnet-4-20250514
ALLOWED_SENDERS=
SOURCE_TIMEZONE_OFFSET=+03:00
TARGET_TIMEZONE_OFFSET=+08:00
```

Keep `.env` only on the VPS. Never commit it.

`SOURCE_TIMEZONE_OFFSET` is the timezone used inside the broker email body. `TARGET_TIMEZONE_OFFSET` is the timezone you want stored in Supabase.

## systemd

Create `/etc/systemd/system/trading-journal-automation.service`:

```ini
[Unit]
Description=Trading Journal Automation
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/trading-journal/automation
EnvironmentFile=/opt/trading-journal/automation/.env
ExecStart=/usr/bin/node /opt/trading-journal/automation/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable trading-journal-automation
sudo systemctl start trading-journal-automation
sudo systemctl status trading-journal-automation
```

## Gmail Apps Script

1. Open `https://script.google.com/`.
2. Create a project.
3. Paste `gmail-apps-script.js`.
4. Set:
   - `WEBHOOK_URL`
   - `WEBHOOK_SECRET`
   - `GMAIL_QUERY`
   - `START_AFTER_ISO`
5. Optional: run `markOldSummariesImported()` once to label old Daily Confirmation emails.
6. Run `setupTimeTrigger()` once.
7. Run `processVantageSummaries()` manually once to test.

The script labels imported threads with `trading-journal-imported`.

## Remove Accidental Old Imports

Only delete rows imported by automation. This leaves manual journal rows alone.

```sql
delete from public.trades
where source = 'vantage_email'
and trade_date < 'YYYY-MM-DD';

delete from public.summaries
where source = 'vantage_email'
and summary_date < 'YYYY-MM-DD';

delete from public.notes
where source = 'vantage_email'
and note_date < 'YYYY-MM-DD';
```

## Test

```bash
curl http://YOUR_VPS_IP:8787/health
```

Expected:

```json
{"ok":true,"service":"trading-journal-automation"}
```

Webhook smoke test:

```bash
curl -X POST http://YOUR_VPS_IP:8787/vantage/email-summary \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: YOUR_SECRET' \
  -d '{
    "messageId":"manual-test-1",
    "from":"test@example.com",
    "subject":"Vantage Daily Summary",
    "date":"2026-04-23T05:00:00.000Z",
    "plainBody":"No trades today."
  }'
```
