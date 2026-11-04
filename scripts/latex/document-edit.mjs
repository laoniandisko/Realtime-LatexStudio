// rtex edit ranges are UTF-8 bytes; Monaco documents are UTF-16 strings.
export function documentEdit(before, after) {
  if (before === after) return null;
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  if (start && /[\uDC00-\uDFFF]/.test(before[start] || after[start] || '')) start--;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (/[\uDC00-\uDFFF]/.test(before[oldEnd] || after[newEnd] || '')) { oldEnd++; newEnd++; }
  return { start: Buffer.byteLength(before.slice(0, start)), end: Buffer.byteLength(before.slice(0, oldEnd)), text: after.slice(start, newEnd) };
}
