'use strict';

function mailsFromMailListJson(json) {
  const elements = Array.isArray(json?.mailListElements) ? json.mailListElements : [];
  return elements
    .filter((entry) => entry?.type === 'mail' && entry.rawData)
    .map((entry) => {
      const header = entry.rawData.mailHeader || {};
      return {
        id: entry.rawData.attribute?.mailIdentifier || entry.rawData.mailURI || null,
        uri: entry.rawData.mailURI || null,
        removalUri: entry.rawData.removalUri || null,
        subject: header.subject || '',
        sender: header.from || '',
        to: Array.isArray(header.to) ? header.to : [],
        cc: Array.isArray(header.cc) ? header.cc : [],
        bcc: Array.isArray(header.bcc) ? header.bcc : [],
        text: [
          header.subject || '',
          header.from || '',
          entry.rawData.preview || '',
          entry.rawData.snippet || '',
        ].filter(Boolean).join('\n'),
        receivedAt: header.date ? new Date(header.date).toISOString() : null,
      };
    });
}

module.exports = { mailsFromMailListJson };
