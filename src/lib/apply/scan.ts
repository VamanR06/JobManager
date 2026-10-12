/**
 * Reads an application form into a neutral field list. The in-page part is a
 * raw string: code passed to page.evaluate must be plain browser JavaScript
 * (the TS transpiler would otherwise inject helpers that don't exist there,
 * and escapes like \s would be mangled in a normal template literal).
 *
 * Labels come from semantic markup, in order: the ATS's question container
 * heading, <label for>, aria-labelledby, aria-label, a wrapping <label>,
 * then placeholder. Page text is untrusted data — it's matched against, never
 * executed or sent to a model as instructions.
 */

/** "buttons" = a question answered by clicking one of several buttons (Ashby's Yes/No toggles). */
export type FieldKind = "text" | "textarea" | "select" | "combobox" | "radio" | "checkbox" | "buttons" | "file";

export interface FieldOption {
  label: string;
  /** Selector for the option's own input (radio/checkbox), if any. */
  selector: string | null;
  value: string | null;
}

export interface ScannedField {
  /** Stable within a page: id or name based. */
  key: string;
  kind: FieldKind;
  /** e.g. "email", "tel", "number" for text inputs. */
  inputType: string;
  label: string;
  required: boolean;
  options: FieldOption[];
  /** Selector for the field (radio/checkbox groups: the first option). */
  selector: string;
  /** What the page currently shows for this field. */
  value: string;
  /** The input's maxlength, when the page sets one. */
  maxLength?: number | null;
}

export interface ScanResult {
  fields: ScannedField[];
  /** Visible CAPTCHA challenge, login wall, etc. */
  blockers: string[];
  /** Page has an "Apply" button to reveal the form and no fields yet. */
  hasApplyButton: boolean;
}

export const SCAN_SCRIPT = String.raw`(() => {
  const clean = (t) => (t || "").replace(/\s+/g, " ").replace(/[*✱]/g, "").trim();
  const isRequiredText = (t) => /[*✱]\s*$/.test((t || "").trim()) || /\(required\)/i.test(t || "");
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && st.visibility !== "hidden" && st.display !== "none";
  };
  const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  // A private marker for elements with no id/name (React forms). Stays on the node for the page's life.
  const mark = (el) => {
    if (!el.getAttribute("data-jm-key")) {
      window.__jmSeq = (window.__jmSeq || 0) + 1;
      el.setAttribute("data-jm-key", "k" + window.__jmSeq);
    }
    return "[data-jm-key=" + q(el.getAttribute("data-jm-key")) + "]";
  };
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
  const sel = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    if (el.name && (el.type === "radio" || el.type === "checkbox") && el.value && el.value !== "on") {
      const s = tag + "[name=" + q(el.name) + "][value=" + q(el.value) + "]";
      if (unique(s)) return s;
    }
    if (el.name && unique(tag + "[name=" + q(el.name) + "]")) return tag + "[name=" + q(el.name) + "]";
    // Ashby tags each question with data-field-path; its input is usually the only one of its kind there.
    const fp = el.closest("[data-field-path]");
    if (fp) {
      const s = "[data-field-path=" + q(fp.getAttribute("data-field-path")) + "] " + tag + (el.getAttribute("role") ? "[role=" + q(el.getAttribute("role")) + "]" : "");
      if (unique(s)) return s;
    }
    return mark(el);
  };
  const entryOf = (el) => el.closest("[class*='fieldEntry'], fieldset, .field-wrapper, .application-question, .form-group");
  // Required markers that live in CSS classes rather than text (Ashby: <label class="… _required …">).
  const requiredByClass = (el) => {
    const c = entryOf(el);
    return !!(c && c.querySelector("label[class*='required'], legend[class*='required'], [class*='question-title'][class*='required']"));
  };
  const containerOf = (el) => el.closest(".application-question, [class*='fieldEntry'], [class*='_field_'], .field-wrapper, .select__container, fieldset, [role=radiogroup], [role=group], .field, .form-group");
  const headingOf = (container, exclude) => {
    if (!container) return { text: "", raw: "" };
    const cands = container.querySelectorAll(".application-label, legend, label, [class*='heading'], [class*='question-title'], [class*='label']");
    for (const c of cands) {
      if (exclude && c.getAttribute("for") && exclude.has(c.getAttribute("for"))) continue;
      if (exclude && c.querySelector("input[type=radio], input[type=checkbox]")) continue;
      const raw = c.textContent || "";
      if (clean(raw)) return { text: clean(raw), raw };
    }
    return { text: "", raw: "" };
  };
  const labelOf = (el) => {
    const lever = el.closest(".application-question");
    if (lever) {
      const l = lever.querySelector(".application-label");
      if (l && clean(l.textContent)) return { text: clean(l.textContent), raw: l.textContent };
    }
    if (el.id) {
      const l = document.querySelector("label[for=" + q(el.id) + "]");
      if (l && clean(l.textContent)) return { text: clean(l.textContent), raw: l.textContent };
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const raw = lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || "").join(" ");
      if (clean(raw)) return { text: clean(raw), raw };
    }
    if (el.getAttribute("aria-label")) return { text: clean(el.getAttribute("aria-label")), raw: el.getAttribute("aria-label") };
    const wrap = el.closest("label");
    if (wrap && clean(wrap.textContent)) return { text: clean(wrap.textContent), raw: wrap.textContent };
    const h = headingOf(containerOf(el));
    if (h.text) return h;
    const ph = el.getAttribute("placeholder");
    return { text: clean(ph), raw: ph || "" };
  };
  const optionLabel = (el) => {
    if (el.id) {
      const l = document.querySelector("label[for=" + q(el.id) + "]");
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    return clean(el.value);
  };
  // The chosen value lives in a sibling "single-value" element of the select's control box.
  // Look for that box specifically: the nearest "*select*" ancestor is often just the input's
  // own wrapper (Greenhouse's "select__input-container"), which never holds the value.
  const comboValue = (el) => {
    const box = el.closest(".select__control") || el.closest("[class*='control']") || el.closest(".select__container") || el.closest("[class*='container']") || el.parentElement;
    const values = box ? Array.from(box.querySelectorAll("[class*='single-value'], [class*='singleValue'], [class*='multi-value__label'], [class*='multiValue'] [class*='label']")) : [];
    return values.length ? values.map((v) => clean(v.textContent)).filter(Boolean).join("; ") : clean(el.value);
  };

  const fields = [];
  const seenGroups = new Set();
  const handled = new Set();
  const all = document.querySelectorAll("input, textarea, select");
  for (const el of all) {
    if (handled.has(el)) continue;
    if (el.closest("[class*='yesno']")) continue; // the hidden checkbox behind Yes/No buttons; the buttons are read below
    const type = (el.getAttribute("type") || (el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : "text")).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "search"].includes(type)) continue;
    if (el.name === "g-recaptcha-response" || el.name === "h-captcha-response") continue;
    if (el.closest("[aria-hidden=true]")) continue;
    if (type === "file") {
      const s = sel(el);
      if (!s) continue;
      let lab = labelOf(el);
      // Upload widgets often label the input with the button text ("Attach");
      // the real question is on the surrounding group (Greenhouse: role=group + aria-labelledby).
      const group = el.closest("[role=group][aria-labelledby]");
      if (group && (!lab.text || /^(attach|upload|browse|choose( a)? file|select( a)? file|add file)$/i.test(lab.text))) {
        const raw = group.getAttribute("aria-labelledby").split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || "").join(" ");
        if (clean(raw)) lab = { text: clean(raw), raw };
      }
      const groupRequired = !!group && group.getAttribute("aria-required") === "true";
      const shown = el.files && el.files.length ? el.files[0].name : "";
      fields.push({ key: s, kind: "file", inputType: "file", label: lab.text, required: el.required || groupRequired || requiredByClass(el) || el.getAttribute("aria-required") === "true" || isRequiredText(lab.raw), options: [], selector: s, value: shown });
      continue;
    }
    if (!visible(el)) continue;
    if (type === "radio" || type === "checkbox") {
      // A fieldset (or checkbox-group) with its own heading is one question, even when each
      // checkbox has a different name (Ashby names them after the option text).
      // (Ashby wraps each checkbox in a "…checkbox-group-option-checkbox" span; that's an option, not the group.)
      const box = type === "checkbox"
        ? el.closest("fieldset, [role=group]") || Array.from(document.querySelectorAll("[class*='checkbox-group']")).find((g) => g.contains(el) && !/option/i.test(String(g.className))) || null
        : null;
      let members;
      let groupKey;
      if (box) {
        members = Array.from(box.querySelectorAll("input[type=checkbox]"));
        const heading = headingOf(box, new Set(members.map((m) => m.id).filter(Boolean)));
        if (!heading.text) members = null;
        else {
          const h = box.querySelector("label[for], legend");
          groupKey = "group:" + ((h && h.getAttribute("for")) || sel(box));
        }
      }
      if (!members) {
        const group = el.name || el.id;
        if (!group) continue;
        members = el.name ? Array.from(document.querySelectorAll("input[name=" + q(el.name) + "]")) : [el];
        groupKey = "group:" + group;
      }
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      members.forEach((m) => handled.add(m));
      const ids = new Set(members.map((m) => m.id).filter(Boolean));
      let lab;
      if (box && members.length >= 1) lab = headingOf(box, ids);
      else if (members.length === 1 && type === "checkbox") lab = labelOf(el);
      else {
        const cont = el.closest("fieldset, [role=radiogroup], [role=group], .application-question, [class*='fieldEntry'], [class*='_field_'], .field-wrapper, .field, .form-group");
        lab = headingOf(cont, ids);
        if (!lab.text) lab = labelOf(el);
      }
      const options = members.map((m) => ({ label: optionLabel(m), selector: sel(m), value: m.value || null }));
      const checked = members.filter((m) => m.checked).map((m) => optionLabel(m));
      fields.push({
        key: groupKey, kind: type, inputType: type, label: lab.text,
        required: members.some((m) => m.required || m.getAttribute("aria-required") === "true") || requiredByClass(el) || isRequiredText(lab.raw),
        options, selector: sel(el), value: checked.join("; "),
      });
      continue;
    }
    const s = sel(el);
    const lab = labelOf(el);
    if (!lab.text || (el.getAttribute("tabindex") === "-1" && !el.id && !el.name)) continue; // unlabeled helper inputs (e.g. react-select's hidden required input)
    const required = el.required || el.getAttribute("aria-required") === "true" || requiredByClass(el) || isRequiredText(lab.raw);
    if (el.tagName === "SELECT") {
      const options = Array.from(el.options)
        .filter((o) => o.value !== "" && !/^select\b|^choose\b|^--/i.test(clean(o.textContent)))
        .map((o) => ({ label: clean(o.textContent), selector: null, value: o.value }));
      const cur = el.selectedIndex >= 0 && el.options[el.selectedIndex].value !== "" ? clean(el.options[el.selectedIndex].textContent) : "";
      fields.push({ key: s, kind: "select", inputType: "select", label: lab.text, required, options, selector: s, value: cur });
    } else if (el.getAttribute("role") === "combobox") {
      fields.push({ key: s, kind: "combobox", inputType: "combobox", label: lab.text, required, options: [], selector: s, value: comboValue(el) });
    } else {
      const isDate = type === "date" || /date/i.test(String(el.className)) || /pick date|mm\/dd|dd\/mm/i.test(el.getAttribute("placeholder") || "");
      fields.push({ key: s, kind: el.tagName === "TEXTAREA" ? "textarea" : "text", inputType: isDate ? "date" : type, label: lab.text, required, options: [], selector: s, value: el.value || "", maxLength: el.maxLength > 0 ? el.maxLength : null });
    }
  }

  // Questions answered with buttons (Ashby's Yes/No toggles), which have no input of their own.
  for (const box of document.querySelectorAll("[class*='yesno'], [role=radiogroup]")) {
    if (box.querySelector("input[type=radio]")) continue; // real radios were read above
    const btns = Array.from(box.querySelectorAll("button")).filter(visible);
    if (btns.length < 2 || btns.length > 8) continue;
    const entry = entryOf(box) || box.parentElement;
    const lab = headingOf(entry);
    if (!lab.text) continue;
    const fp = box.closest("[data-field-path]");
    const pressed = btns.filter((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /(selected|active|checked)/i.test(String(b.className)));
    fields.push({
      key: "buttons:" + (fp ? fp.getAttribute("data-field-path") : sel(box)), kind: "buttons", inputType: "buttons", label: lab.text,
      required: requiredByClass(box) || isRequiredText(lab.raw),
      options: btns.map((b) => ({ label: clean(b.textContent), selector: sel(b), value: b.getAttribute("data-option") })),
      selector: sel(btns[0]), value: pressed.map((b) => clean(b.textContent)).join("; "),
    });
  }

  const blockers = [];
  for (const f of document.querySelectorAll("iframe")) {
    const src = f.getAttribute("src") || "";
    if (/recaptcha\/api2\/bframe|hcaptcha\.com.*challenge|challenges\.cloudflare/.test(src) && visible(f)) blockers.push("A CAPTCHA challenge is showing");
  }
  if (Array.from(document.querySelectorAll("input[type=password]")).some(visible)) blockers.push("The page is asking you to sign in");
  const applyBtn = Array.from(document.querySelectorAll("a, button")).find((b) => /^apply( for this job| now| to this job)?$/i.test(clean(b.textContent)) && visible(b) && b.getAttribute("type") !== "submit");
  return { fields, blockers, hasApplyButton: !!applyBtn && fields.length < 3 };
})()`;

/** Opens a combobox and lists its options without choosing one (Escape closes it). */
export const COMBO_OPTIONS_SCRIPT = String.raw`(() => {
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  return Array.from(document.querySelectorAll("[role=option]"))
    .filter((o) => o.getBoundingClientRect().height > 0)
    .map((o) => clean(o.textContent))
    .filter(Boolean)
    .slice(0, 400);
})()`;

/**
 * Blocks native form submission while the automation is typing (e.g. an Enter
 * key event in a native form). Lifted again when filling ends, so the person
 * can still submit the form themselves.
 */
export const SUBMIT_GUARD_ON = String.raw`(() => {
  window.__jmFilling = true;
  if (!window.__jmGuard) {
    window.__jmGuard = true;
    document.addEventListener("submit", (e) => { if (window.__jmFilling) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }
})()`;
export const SUBMIT_GUARD_OFF = "window.__jmFilling = false";
