import { useEffect, useRef, useState } from "react";

type CopyNote = "copied" | "failed" | null;

/**
 * Copy text to the clipboard and say briefly how it went; a failure is also
 * logged with what was being copied. Returns the note to show and the copier.
 */
export function useCopyNote(): [CopyNote, (text: string, what: string) => void] {
  const [note, setNote] = useState<CopyNote>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const show = (n: CopyNote) => {
    setNote(n);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 1600);
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => show("copied"),
      (err: unknown) => {
        console.error(`[mockingbird] copying ${what} failed`, err);
        show("failed");
      }
    );
  return [note, copy];
}

/** The note from useCopyNote, as a toast in the corner of the nearest positioned box. */
export function CopyToast({ note, failed }: { note: CopyNote; failed: string }) {
  if (note === "copied") return <span className="copy-toast">Copied ✓</span>;
  if (note === "failed") return <span className="copy-toast failed">{failed}</span>;
  return null;
}
