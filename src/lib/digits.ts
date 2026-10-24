// Arabic keyboards (the Windows touch keyboard, phones, some desk layouts)
// type Arabic-Indic digits (٠١٢...). An <input type="number"> silently
// drops them and a text field hands them to parseFloat, which reads 0 -- so
// an owner typing a price on the AI menu screen saw nothing happen (confirmed
// live on the real app: "٧٥٠٠" left the field at 0, "7500" worked). The app
// shows Latin digits everywhere, so every digit typed or pasted into a field
// is converted to Latin before the field sees it.
const NON_LATIN_DIGIT = /[٠-٩۰-۹٫]/;

export function toLatinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".");
}

function isField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

// insertText goes through the browser's own editing path, so the caret,
// a selection being replaced, and React's onChange all behave exactly as if
// the Latin digit had been typed.
function insertLatin(doc: Document, text: string): void {
  doc.execCommand("insertText", false, toLatinDigits(text));
}

export function installLatinDigitInput(doc: Document = document): void {
  doc.addEventListener(
    "beforeinput",
    (e) => {
      if (!isField(e.target) || !e.data || !NON_LATIN_DIGIT.test(e.data)) return;
      e.preventDefault();
      insertLatin(doc, e.data);
    },
    true,
  );
  doc.addEventListener(
    "paste",
    (e) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!isField(e.target) || !text || !NON_LATIN_DIGIT.test(text)) return;
      e.preventDefault();
      insertLatin(doc, text);
    },
    true,
  );
}
