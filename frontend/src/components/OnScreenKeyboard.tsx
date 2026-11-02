"use client";

/**
 * A keyboard you can click.
 *
 * Exists because of a real morning in the clinic: the PC there runs this app
 * full screen with a mouse and no keyboard attached, and the kiosk browser
 * keeps its own fresh profile -- so the first thing that machine ever shows
 * is a login form that nobody in the room can type into. A real keyboard is
 * still the better answer; this is the answer when there is not one.
 *
 * Deliberately NOT a general-purpose on-screen keyboard. It types into
 * whichever of this form's fields is focused by calling that field's own
 * setter -- no synthetic events, no reaching into the DOM to fake React's
 * onChange, which is the usual way these quietly stop working on controlled
 * inputs. The caller says which field is live.
 */

import { useState } from "react";

const ROWS_LOWER = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const ROWS_UPPER = ["!@#$%^&*()", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
/** The punctuation that actually turns up in accounts and passwords here. */
const SYMBOLS = "._-@+!?#/:";

export default function OnScreenKeyboard({
  onKey,
  onBackspace,
  onClear,
  onClose,
  label,
}: {
  onKey: (ch: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onClose: () => void;
  /** Which field the keys are going into, so it is never a guess. */
  label: string;
}) {
  const [shift, setShift] = useState(false);
  const rows = shift ? ROWS_UPPER : ROWS_LOWER;

  // Big targets on purpose: this is driven by a mouse, by someone standing up,
  // possibly mid-list. Small keys would be worse than no keyboard at all.
  const key =
    "min-w-[2.5rem] h-12 px-2 rounded-lg border border-gray-700 bg-gray-800 " +
    "text-white text-base hover:bg-gray-700 active:bg-gray-600 transition-colors select-none";
  const wide = key + " px-4";

  const press = (ch: string) => {
    onKey(ch);
    // Behaves like a phone keyboard: one capital, then back to lower case.
    if (shift) setShift(false);
  };

  return (
    <div className="mt-4 rounded-xl border border-gray-700 bg-gray-900/70 p-3 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">{label}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 rounded-md border border-gray-700 text-gray-400 hover:text-gray-200"
        >
          &#10005;
        </button>
      </div>

      {rows.map((row, i) => (
        <div key={i} className="flex gap-1 justify-center flex-wrap" dir="ltr">
          {row.split("").map((ch) => (
            <button key={ch} type="button" className={key} onClick={() => press(ch)}>{ch}</button>
          ))}
        </div>
      ))}

      <div className="flex gap-1 justify-center flex-wrap" dir="ltr">
        {SYMBOLS.split("").map((ch) => (
          <button key={ch} type="button" className={key} onClick={() => press(ch)}>{ch}</button>
        ))}
      </div>

      <div className="flex gap-1 justify-center flex-wrap pt-1" dir="ltr">
        <button
          type="button"
          onClick={() => setShift((v) => !v)}
          className={wide + (shift ? " !bg-blue-600 !border-blue-500" : "")}
        >
          Shift
        </button>
        <button type="button" className={wide} onClick={() => press(" ")}>Space</button>
        <button type="button" className={wide} onClick={onBackspace}>Back</button>
        <button type="button" className={wide} onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}
