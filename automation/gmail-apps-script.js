/**
 * Gmail -> Hetzner webhook bridge for Vantage daily summaries.
 *
 * Setup:
 * 1. Open https://script.google.com/
 * 2. Create a new Apps Script project.
 * 3. Paste this file.
 * 4. Set WEBHOOK_URL, WEBHOOK_SECRET, GMAIL_QUERY, and START_AFTER_ISO.
 * 5. Optional: run markOldSummariesImported() once to skip old emails.
 * 6. Run setupTimeTrigger() once.
 */

const WEBHOOK_URL = 'https://YOUR_DOMAIN_OR_IP/vantage/email-summary';
const WEBHOOK_SECRET = 'replace-with-the-same-secret-as-vps-env';

// Keep this narrow so promo emails do not spend Claude credits.
const GMAIL_QUERY = 'newer_than:7d from:support@vantagemarkets.com subject:"Daily Confirmation" -label:trading-journal-imported';
const IMPORTED_LABEL = 'trading-journal-imported';

// Only import emails after this moment. Set this to the first date/time you
// want automation to handle, then old emails will be skipped.
const START_AFTER_ISO = '2026-04-23T00:00:00+08:00';

function processVantageSummaries() {
  const label = getOrCreateLabel_(IMPORTED_LABEL);
  const threads = GmailApp.search(GMAIL_QUERY, 0, 10);
  const startAfter = new Date(START_AFTER_ISO);

  threads.forEach((thread) => {
    const messages = thread.getMessages();
    let importedAny = false;

    messages.forEach((message) => {
      if (message.getDate() <= startAfter) return;

      const payload = {
        messageId: message.getId(),
        threadId: thread.getId(),
        from: message.getFrom(),
        subject: message.getSubject(),
        date: message.getDate().toISOString(),
        plainBody: message.getPlainBody()
      };

      const response = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-webhook-secret': WEBHOOK_SECRET
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const status = response.getResponseCode();
      if (status < 200 || status >= 300) {
        throw new Error('Webhook failed: ' + status + ' ' + response.getContentText());
      }

      importedAny = true;
    });

    if (importedAny) thread.addLabel(label);
  });
}

function markOldSummariesImported() {
  const label = getOrCreateLabel_(IMPORTED_LABEL);
  const threads = GmailApp.search('newer_than:30d from:support@vantagemarkets.com subject:"Daily Confirmation"', 0, 50);
  const startAfter = new Date(START_AFTER_ISO);

  threads.forEach((thread) => {
    const hasOnlyOldMessages = thread.getMessages().every((message) => message.getDate() <= startAfter);
    if (hasOnlyOldMessages) thread.addLabel(label);
  });
}

function setupTimeTrigger() {
  ScriptApp.newTrigger('processVantageSummaries')
    .timeBased()
    .everyHours(1)
    .create();
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
