/**
 * Gmail -> Hetzner webhook bridge for Vantage daily summaries.
 *
 * Setup:
 * 1. Open https://script.google.com/
 * 2. Create a new Apps Script project.
 * 3. Paste this file.
 * 4. Set WEBHOOK_URL, WEBHOOK_SECRET, and GMAIL_QUERY.
 * 5. Run setupTimeTrigger() once.
 */

const WEBHOOK_URL = 'https://YOUR_DOMAIN_OR_IP/vantage/email-summary';
const WEBHOOK_SECRET = 'replace-with-the-same-secret-as-vps-env';

// Tune this after you see the exact Vantage sender/subject.
const GMAIL_QUERY = 'newer_than:2d (from:vantage OR subject:Vantage) -label:trading-journal-imported';
const IMPORTED_LABEL = 'trading-journal-imported';

function processVantageSummaries() {
  const label = getOrCreateLabel_(IMPORTED_LABEL);
  const threads = GmailApp.search(GMAIL_QUERY, 0, 10);

  threads.forEach((thread) => {
    const messages = thread.getMessages();

    messages.forEach((message) => {
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
    });

    thread.addLabel(label);
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
