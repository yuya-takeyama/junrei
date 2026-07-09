import { useEffect, useRef, useState } from "react";

/** How long the "copied ✓" confirmation stays up — per 2s: "chip flashes 'copied' 800ms". */
const COPY_FLASH_MS = 800;

/** Shared clipboard-copy-with-flash-confirmation behavior for `.cp` affordances. */
export function useCopyFlash(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), COPY_FLASH_MS);
      })
      .catch(() => undefined);
  };

  return [copied, copy];
}

interface CopyButtonProps {
  /** Computed lazily so large payloads aren't stringified until the user actually clicks copy. */
  getText: () => string;
  label?: string;
}

/** The `.cp` "copy ⧉" → "copied ✓" pill used next to Input/Result/Prompt/Returned sections. */
export function CopyButton({ getText, label = "copy" }: CopyButtonProps) {
  const [copied, copy] = useCopyFlash();
  return (
    <button type="button" className="cp" onClick={() => copy(getText())}>
      {copied ? "copied ✓" : `${label} ⧉`}
    </button>
  );
}

interface InlineCopyValueProps {
  /** Full value copied to the clipboard (e.g. the untruncated tool_use_id). */
  value: string;
  /** Shortened value shown on screen. */
  display: string;
}

/** Inline copyable value — used for `tool_use_id` in the metadata grid (mono text + `⧉` glyph). */
export function InlineCopyValue({ value, display }: InlineCopyValueProps) {
  const [copied, copy] = useCopyFlash();
  return (
    <button type="button" className="mono fs11 cp-inline" onClick={() => copy(value)}>
      {display} <span className="mut">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}
