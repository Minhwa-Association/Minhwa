import Link from "next/link";

/** The Inbox's own row of pills: Overview · Messages · Tasks · Settings. */
export function InboxNav({ current, counts }: { current: "overview" | "messages" | "tasks" | "settings"; counts?: { unread?: number; suggested?: number } }) {
  const pill = (key: typeof current) => `pill ${current === key ? "active" : ""}`;
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
      <Link href="/inbox" className={pill("overview")}>Overview</Link>
      <Link href="/inbox/messages" className={pill("messages")}>Messages{counts?.unread ? <span className="count"> {counts.unread}</span> : null}</Link>
      <Link href="/inbox/tasks" className={pill("tasks")}>Tasks{counts?.suggested ? <span className="count"> {counts.suggested}</span> : null}</Link>
      <Link href="/inbox/settings" className={pill("settings")}>Settings</Link>
    </div>
  );
}

export function ChannelTag({ channel }: { channel: "instagram" | "email" }) {
  return <span className={`tag ch-${channel}`} title={channel === "instagram" ? "Instagram DM" : "E-mail"}>{channel === "instagram" ? "IG" : "Mail"}</span>;
}
