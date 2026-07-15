export const CHINA_TIME_ZONE = 'Asia/Shanghai';

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHINA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function chinaTimeParts(value) {
  const parts = formatter.formatToParts(new Date(value));
  return Object.fromEntries(parts
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
}

export function formatChinaClock(value) {
  const { hour, minute } = chinaTimeParts(value);
  return `${hour}:${minute}`;
}

export function formatChinaDate(value) {
  const { year, month, day } = chinaTimeParts(value);
  return `${year}-${month}-${day}`;
}

export function formatChinaDateTime(value) {
  const { year, month, day, hour, minute, second } = chinaTimeParts(value);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function formatChinaMonqueryDateTime(value) {
  const { year, month, day, hour, minute, second } = chinaTimeParts(value);
  return `${year}${month}${day}${hour}${minute}${second}`;
}

export function formatChinaDatetimeLocal(value) {
  return formatChinaDateTime(value).replace(' ', 'T');
}

export function parseChinaDatetimeLocal(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return new Date(Number.NaN);
  const [, year, month, day, hour, minute, second = '00'] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - CST_OFFSET_MS);
}

export function startOfChinaDay(value = Date.now()) {
  const timestamp = new Date(value).getTime();
  return new Date(Math.floor((timestamp + CST_OFFSET_MS) / DAY_MS) * DAY_MS - CST_OFFSET_MS);
}

export function chinaSlotIndex(value = Date.now()) {
  const seconds = Math.floor(new Date(value).getTime() / 1000);
  return Math.floor(((seconds + 8 * 60 * 60) % (24 * 60 * 60)) / 300);
}

export function isSameChinaDay(first, second) {
  return formatChinaDate(first) === formatChinaDate(second);
}
