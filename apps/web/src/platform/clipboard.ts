/**
 * Copy text to the clipboard. Resolves true when it worked.
 *
 * The asynchronous clipboard API only exists in secure contexts; a Studio
 * reached over plain http on a LAN address is not one, so there is a fallback
 * that works there too.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the older way */
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.append(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus({ preventScroll: true });
  }
}
