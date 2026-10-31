import { onConsentChange, setConsent, shouldAskConsent } from './client';
import './consent.css';

/*
 * First-launch analytics notice on the main menu: a small non-blocking card in the
 * bottom-right corner (the menu stays fully usable around it). Shown until the player
 * answers; Settings → Privacy changes the choice later.
 */
export function showConsentNotice(parent: HTMLElement): (() => void) | null {
  if (!shouldAskConsent()) return null;
  const el = document.createElement('div');
  el.className = 'ph-consent ph-no-capture';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Analytics');
  el.innerHTML = `
    <svg class="ph-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5h16"/><path d="M7 16v-4M12 16V7M17 16v-6"/></svg>
    <p class="ph-txt"><b>Help improve Iron Front</b><span>Send anonymous gameplay &amp; performance data.<i class="ph-more"> No account, no personal info.</i></span></p>
    <div class="ph-btns">
      <button type="button" class="ph-btn ph-yes" data-c="granted">Allow</button>
      <button type="button" class="ph-btn" data-c="denied">No thanks</button>
    </div>`;
  let off = () => {};
  const close = () => {
    off();
    el.classList.add('ph-out');
    setTimeout(() => el.remove(), 220);
  };
  // answered in Settings meanwhile
  off = onConsentChange(close);
  el.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setConsent(b.dataset.c === 'granted' ? 'granted' : 'denied');
      close(); // (no-op if the change listener already closed it)
    }),
  );
  parent.appendChild(el);
  return () => {
    off();
    el.remove();
  };
}
