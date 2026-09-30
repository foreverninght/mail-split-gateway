'use strict';

function decodeHtmlAttribute(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const radix = entity[1].toLowerCase() === 'x' ? 16 : 10;
    const raw = entity.slice(radix === 16 ? 2 : 1);
    const point = Number.parseInt(raw, radix);
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : match;
  });
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  let index = 0;
  while (index < source.length) {
    while (/\s|\//.test(source[index] || '')) index += 1;
    if (index >= source.length) break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!name) throw new Error('malformed HTML attribute');
    while (/\s/.test(source[index] || '')) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] || '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : '';
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1;
        if (index >= source.length) throw new Error('unterminated HTML attribute');
        value = source.slice(valueStart, index);
        index += 1;
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    if (Object.hasOwn(attributes, name)) throw new Error(`duplicate HTML attribute: ${name}`);
    attributes[name] = decodeHtmlAttribute(value);
  }
  return attributes;
}

function findTagEnd(html, start) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function readNamedMeta(html, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = new Map();
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;
    const end = findTagEnd(html, open + 1);
    if (end < 0) throw new Error('unterminated HTML tag');
    const tag = html.slice(open + 1, end).trim();
    const nameEnd = tag.search(/[\s/>]/);
    const tagName = (nameEnd < 0 ? tag : tag.slice(0, nameEnd)).toLowerCase();
    if (tagName === 'meta') {
      const attributes = parseAttributes(nameEnd < 0 ? '' : tag.slice(nameEnd));
      const metaName = String(attributes.name || '').toLowerCase();
      if (wanted.has(metaName)) {
        if (found.has(metaName)) throw new Error(`duplicate meta field: ${metaName}`);
        if (!Object.hasOwn(attributes, 'content')) throw new Error(`meta field has no content: ${metaName}`);
        found.set(metaName, attributes.content);
      }
    }
    index = end + 1;
  }
  return found;
}

module.exports = { decodeHtmlAttribute, parseAttributes, readNamedMeta };
