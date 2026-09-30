'use strict';

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// CSV quoted fields can contain commas, escaped quotes and newlines.
function csvRecords(text, delimiter = ',') {
  const records = [];
  let fields = [], field = '', quoted = false, closed = false, line = 1, start = 1;
  for (let i = 0; i <= text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === undefined) throw invalid('CSV contains an unclosed quoted field');
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') { quoted = false; closed = true; }
      else { field += c; if (c === '\n') line += 1; }
      continue;
    }
    if (c === delimiter || c === '\n' || c === '\r' || c === undefined) {
      fields.push(field); field = ''; closed = false;
      if (c !== delimiter) {
        records.push({ line: start, fields }); fields = [];
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        line += 1; start = line;
      }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || c === '"') throw invalid('Invalid CSV quoting');
      field += c;
    }
  }
  return records;
}

const EMAIL_HEADERS = ['email', 'e-mail', 'address', 'email address', 'mail', 'username', 'account', '邮箱', '邮箱地址', '邮件地址', '主邮箱', '账号', '账户'];
const PASSWORD_HEADERS = ['password', 'pass', 'pwd', 'email password', '邮箱密码', '密码'];
function headerKind(value) {
  const key = value.trim().toLowerCase().replace(/_/g, ' ');
  return EMAIL_HEADERS.includes(key) ? 'email' : PASSWORD_HEADERS.includes(key) ? 'password' : key === 'data' ? 'data' : '';
}

function parseCsv(text) {
  const first = text.split(/\r\n|\n|\r/).find((line) => line.trim()) || '';
  const separator = first.match(/^sep=([,;\t])$/i);
  if (separator) {
    const prefix = text.indexOf(first) + first.length;
    const rest = text.slice(prefix).replace(/^(\r\n|\n|\r)/, '');
    return readCsv(rest, separator[1], text.slice(0, prefix).split(/\r\n|\n|\r/).length);
  }
  for (const delimiter of [',', ';', '\t']) {
    let fields;
    try { fields = csvRecords(first, delimiter)[0].fields; } catch { continue; }
    const hasHeader = fields.some((v) => headerKind(v));
    const startsWithEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[0].trim());
    if (fields.length > 1 && (hasHeader || startsWithEmail)) return readCsv(text, delimiter);
  }
  return null;
}

function readCsv(text, delimiter, offset = 0) {
  const rows = csvRecords(text, delimiter).filter(({ fields }) => fields.some((v) => v.trim() !== ''));
  let emailIndex = 0, passwordIndex = 1, width = 2;
  const header = rows[0]?.fields.map(headerKind) || [];
  if (header.includes('data') && !header.includes('email') && !header.includes('password')) {
    if (header.filter((v) => v === 'data').length !== 1) throw invalid('CSV data 列不能重复');
    const index = header.indexOf('data');
    width = rows.shift().fields.length;
    return rows.map(({ line, fields }) => {
      const entry = parseTextRecord(fields[index] || '', line + offset);
      return { ...entry, malformed: entry.malformed || fields.length !== width };
    });
  }
  if (header.some(Boolean)) {
    if (header.filter((v) => v === 'email').length !== 1 || header.filter((v) => v === 'password').length !== 1) {
      throw invalid('CSV 表头必须包含唯一的邮箱列和密码列');
    }
    width = rows.shift().fields.length;
    emailIndex = header.indexOf('email'); passwordIndex = header.indexOf('password');
  }
  return rows.map(({ line, fields }) => ({ line: line + offset, email: fields[emailIndex], password: fields[passwordIndex], malformed: fields.length !== width }));
}

function parseTextRecord(value, line) {
  const match = value.match(/^\s*([^\s@,:;|]+@[^\s@,:;|]+?)(----|\t|:|\|)([\s\S]*)$/);
  return { line, email: match?.[1], password: match?.[3], malformed: !match };
}

function parseMailboxImport(input) {
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '');
    if (/^\s*[\[{]/.test(text)) {
      try { input = JSON.parse(text); }
      catch { throw invalid('Invalid JSON'); }
    } else {
      const csv = parseCsv(text);
      if (csv) return csv;
      return text.split(/\r\n|\n|\r/).flatMap((value, index) => {
        if (!value.trim()) return [];
        return [parseTextRecord(value, index + 1)];
      });
    }
  }
  if (input && !Array.isArray(input) && typeof input === 'object') input = input.mailboxes ?? [input];
  if (!Array.isArray(input)) throw invalid('Expected mailbox text or a JSON array');
  return input.map((item, index) => ({
    line: index + 1, email: item?.email ?? item?.address, password: item?.password ?? item?.pass,
  }));
}

module.exports = { parseMailboxImport };
