"use client";
import { useFormStatus } from "react-dom";

/**
 * A submit button that locks itself while its form is being sent — so a second tap (slow connection, no
 * visible reaction) can't create the same thing twice. Use it on every form that creates something.
 * 2026-10-14: one member got three identical Store orders from three taps within six seconds.
 */
export function SubmitButton({ children, pendingText = "One moment…", className, style, title }: {
  children: React.ReactNode; pendingText?: string; className?: string; style?: React.CSSProperties; title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} style={style} title={title} disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}
