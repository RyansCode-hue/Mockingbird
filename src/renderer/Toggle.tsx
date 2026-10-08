/** An on/off switch, as Settings rows use. */
export function Toggle({ on, onChange, label, disabled, title }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; title?: string }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} title={title} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}
