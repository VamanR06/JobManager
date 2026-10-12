/**
 * Recognising that a person submitted an application in the automation
 * browser. A click or a 200 isn't proof: we need the site's own confirmation
 * text AND the application form gone from the page.
 */

export interface ConfirmationCheck {
  confirmed: boolean;
  /** Short text around the confirmation (or the warning), for the event log. */
  snippet: string | null;
  /** The site refused or flagged the submission (spam/VPN checks, errors). */
  warning: string | null;
}

export const CONFIRM_SCRIPT = String.raw`(() => {
  const text = (document.body && document.body.innerText) || "";
  const around = (m) => text.slice(Math.max(0, m.index - 60), m.index + 180).replace(/\s+/g, " ").trim();
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const formStillThere = Array.from(document.querySelectorAll("input[type=email], input[type=file], textarea")).some(shown);
  const ok = text.match(/thank(s| you) for (applying|your application|submitting|your interest in)|application (was |has been )?(successfully )?(submitted|received)|we('ve| have) received your application|your application (is|has been) (complete|submitted|received)/i);
  const bad = text.match(/(vpn|proxy|spam|suspicious activity|unusual activity|flagged|could not be submitted|failed to submit|something went wrong|please try again)/i);
  return {
    confirmed: !!ok && !formStillThere,
    snippet: ok ? around(ok) : null,
    warning: bad && formStillThere ? around(bad) : null,
  };
})()`;
