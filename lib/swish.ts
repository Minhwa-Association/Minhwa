/**
 * Swish deep link: opens the Swish app with payee, amount and message pre-filled.
 * Works on a phone that has Swish installed. On desktop the link does nothing —
 * the pay page shows the number and message to type manually instead.
 */
export function swishUrl(opts: { payee: string; amountSek: number; message: string }) {
  const payee = opts.payee.replace(/[^0-9]/g, "");
  const data = {
    version: 1,
    payee: { value: payee, editable: false },
    amount: { value: opts.amountSek, editable: false },
    message: { value: opts.message.slice(0, 50), editable: false },
  };
  return `swish://payment?data=${encodeURIComponent(JSON.stringify(data))}`;
}

/** "1231968098" → "123 196 80 98" */
export function formatSwishNumber(n: string) {
  const d = n.replace(/[^0-9]/g, "");
  if (d.length === 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`;
  return n;
}
