/**
 * Quick tooltips for icon buttons: any element with `data-tip` shows its text
 * after a short hover, in a floating box that panels and scroll areas can't
 * clip (the system's title tooltips take a second or more, and are easy to miss).
 * Once one has shown, the next within half a second shows at once, without the fade.
 */
let installed = false;

export function installTooltips(): void {
  if (installed) return;
  installed = true;
  const tip = document.createElement("div");
  tip.className = "mb-tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: HTMLElement | null = null;
  // when a shown tip last went away: moving straight on to the next is "warm"
  let shownUntil = -Infinity;
  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    current = null;
    if (tip.classList.contains("on")) shownUntil = performance.now();
    tip.classList.remove("on");
  };
  const show = (el: HTMLElement) => {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.classList.add("on");
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // below the element, centred on it, kept inside the window; above it when there's no room below
    const left = Math.min(window.innerWidth - w - 6, Math.max(6, r.left + r.width / 2 - w / 2));
    const top = r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    const warm = performance.now() - shownUntil < 500;
    tip.classList.toggle("warm", warm);
    timer = setTimeout(() => show(el), warm ? 0 : 350);
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
