import { redirect } from "next/navigation";
import { currentMember } from "@/lib/supabase/server";
import { saveName } from "@/app/actions";

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error } = await searchParams;
  return (
    <main className="page">
      <div style={{ padding: "48px 0 24px" }}>
        <h1>Welcome</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>What should we call you on the roster?</p>
      </div>
      <form action={saveName} className="stack">
        <div>
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" defaultValue={me.name === "New member" ? "" : me.name} required autoFocus />
        </div>
        {error && <div className="notice err">{error}</div>}
        <button className="btn ink">Save</button>
      </form>
    </main>
  );
}
