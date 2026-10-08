"use client";

import { useEffect, useState } from "react";
import { claimPayment } from "@/app/actions";

/**
 * The Swish step of the pay page.
 *
 * Swish's pre-filled deep link cannot tell the app that the payment went through (that needs the merchant
 * API), so the member confirms with one tap. To make that tap hard to miss: the moment "Open Swish" is
 * tapped, "I have paid" becomes the big primary button — it is what the member sees when they come back
 * from Swish, and it is remembered for this payment (localStorage) in case the page is opened again.
 * "I have paid" sends the member back to where they came from (the seat or My seats).
 */
export function SwishPay({ link, amount, paymentId, back, backLabel, claimed, primary }: {
  link: string;
  amount: number;
  paymentId: string;
  back: string;
  backLabel: string;
  claimed: boolean;
  primary: boolean;          // false when "Pay with credits" is the main button above
}) {
  const key = `swish-opened:${paymentId}`;
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    try {
      if (claimed) localStorage.removeItem(key);
      else if (localStorage.getItem(key)) setOpened(true);
    } catch {
      // private mode etc. — the page works without remembering
    }
  }, [key, claimed]);

  const markOpened = () => {
    setOpened(true);
    try { localStorage.setItem(key, String(Date.now())); } catch { /* ignore */ }
  };

  if (claimed) {
    return (
      <>
        <a href={link} onClick={markOpened} className="btn line">Open Swish again · {amount} kr</a>
        <div className="muted small" style={{ textAlign: "center" }}>You show as awaiting confirmation until the treasurer sees the payment in the bank.</div>
      </>
    );
  }

  if (opened) {
    return (
      <>
        <form action={claimPayment}>
          <input type="hidden" name="payment_id" value={paymentId} />
          <input type="hidden" name="back" value={back} />
          <button className={`btn ${primary ? "red" : "ink"}`}>I have paid {amount} kr</button>
        </form>
        <a href={link} onClick={markOpened} className="btn line">Open Swish again</a>
        <div className="muted small" style={{ textAlign: "center" }}>Back from Swish? Tap &ldquo;I have paid&rdquo; — that is the last step. You go back to {backLabel}.</div>
      </>
    );
  }

  return (
    <>
      <a href={link} onClick={markOpened} className={`btn ${primary ? "ink" : "line"}`}>Open Swish and pay {amount} kr</a>
      <form action={claimPayment}>
        <input type="hidden" name="payment_id" value={paymentId} />
        <input type="hidden" name="back" value={back} />
        <button className="btn line">I have paid already</button>
      </form>
      <div className="muted small" style={{ textAlign: "center" }}>After paying in Swish, come back here and tap &ldquo;I have paid&rdquo; — you then go back to {backLabel}, shown as awaiting confirmation until the treasurer sees it in the bank.</div>
    </>
  );
}
