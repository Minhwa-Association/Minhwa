"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalisePhone } from "@/lib/phone";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const p = normalisePhone(phone);
    const { error } = await supabase.auth.signInWithOtp({ phone: p });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setPhone(p);
    setStep("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await supabase.auth.verifyOtp({ phone, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) { setError("That code didn't work. Check the digits or request a new one."); return; }
    router.push("/");
    router.refresh();
  }

  return (
    <main className="page">
      <div style={{ padding: "48px 0 24px" }}>
        <h1>Minhwa Association</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>Seat booking</p>
      </div>

      {step === "phone" ? (
        <form onSubmit={sendCode} className="stack">
          <div>
            <label htmlFor="phone">Your mobile number</label>
            <input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="070 123 45 67"
              value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
          <p className="muted small" style={{ margin: 0 }}>We text you a 6-digit code. No password needed.</p>
          {error && <div className="notice err">{error}</div>}
          <button className="btn ink" disabled={busy}>{busy ? "Sending…" : "Send code"}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="stack">
          <div>
            <label htmlFor="code">Code sent to {phone}</label>
            <input id="code" className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </div>
          {error && <div className="notice err">{error}</div>}
          <button className="btn ink" disabled={busy}>{busy ? "Checking…" : "Log in"}</button>
          <button type="button" className="btn quiet" onClick={() => { setStep("phone"); setCode(""); }}>Use another number</button>
        </form>
      )}
    </main>
  );
}
