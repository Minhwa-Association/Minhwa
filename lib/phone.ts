/** Normalise a Swedish phone number to E.164. "070-123 45 67" → "+46701234567". */
export function normalisePhone(raw: string): string {
  let s = raw.replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("0")) s = "+46" + s.slice(1);
  if (!s.startsWith("+")) s = "+" + s;
  return s;
}
