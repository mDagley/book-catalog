// src/components/SearchAutocomplete.tsx
"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface Suggestion {
  title: string;
  author: string | null;
}

interface SearchAutocompleteProps {
  scope: "home" | "books" | "tbr";
  name: string;
  defaultValue: string;
  placeholder: string;
}

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

export function SearchAutocomplete({
  scope,
  name,
  defaultValue,
  placeholder,
}: SearchAutocompleteProps) {
  const [value, setValue] = useState(defaultValue);
  // Tracks the defaultValue this component last synced `value` from, so the
  // render-time check below (React's documented "adjusting state when a
  // prop changes" pattern -- see https://react.dev/learn/you-might-not-need-an-effect)
  // can detect when defaultValue itself changes on a re-render without a
  // full remount (e.g. a future client-side navigation swapping ?q= while
  // staying on the same page -- not something this app's current native-GET
  // -form navigation does today, but a cheap guard against future
  // staleness). Deliberately not a useEffect: calling setState directly in
  // the render body here is the pattern React recommends for this exact
  // case, and it avoids both an extra render pass and a
  // react-hooks/set-state-in-effect lint violation.
  const [syncedDefaultValue, setSyncedDefaultValue] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  if (defaultValue !== syncedDefaultValue) {
    setSyncedDefaultValue(defaultValue);
    setValue(defaultValue);
    // Also clear any dropdown state left over from the OLD query -- without
    // this, stale suggestions could stay visible/open after defaultValue
    // changes out from under the component. All conditioned on the same
    // single `if`, not on each other, so this doesn't change the "fires
    // once, terminates on next render" safety of the branch above.
    setSuggestions([]);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }
  // Bumped (never reset) on every suggestion selection, unconditionally --
  // unlike gating a submit-effect on `value` itself, this fires even when
  // the selected suggestion's title is character-for-character identical to
  // what's already typed (a common case: user typed the full title before
  // the dropdown could offer anything else), where setValue would otherwise
  // be a no-op React bails out of and the effect below would never re-run.
  const [submitTrigger, setSubmitTrigger] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped on every keystroke; a debounced fetch response only applies if
  // its id still matches the latest one when it resolves, so a slow response
  // to an earlier keystroke can never clobber a newer one that resolved first.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = value.trim();
    // The sub-threshold reset itself lives in onChange (a direct response to
    // the user's keystroke, not something needing effect-based
    // synchronization) -- calling setState synchronously here would trip
    // react-hooks/set-state-in-effect. This guard just keeps a too-short
    // query from scheduling a fetch at all. Bumping requestIdRef here too
    // (even though no new fetch is scheduled) is required: without it, a
    // fetch already in flight from a prior valid-length keystroke keeps its
    // captured requestId equal to requestIdRef.current, so the staleness
    // check in that fetch's .then() below wouldn't catch it -- it would
    // resolve later and silently repopulate/reopen the dropdown for text
    // that's no longer even in the input.
    if (trimmed.length < MIN_QUERY_LENGTH) {
      requestIdRef.current++;
      return;
    }

    const requestId = ++requestIdRef.current;
    const timeoutId = setTimeout(() => {
      fetch(`/api/autocomplete?scope=${scope}&q=${encodeURIComponent(trimmed)}`)
        .then((response) => (response.ok ? response.json() : []))
        .then((data: Suggestion[]) => {
          if (requestId !== requestIdRef.current) return;
          setSuggestions(data);
          setIsOpen(data.length > 0);
          setHighlightedIndex(-1);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setSuggestions([]);
          setIsOpen(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [value, scope]);

  useEffect(() => {
    // Skip the initial mount (submitTrigger starts at 0) -- only fire on an
    // actual selection. setValue/setSubmitTrigger are called together in
    // selectSuggestion, so React batches them into the same commit; by the
    // time this effect runs, the input's real DOM value already reflects
    // the selection, so requestSubmit() can't race an unflushed update.
    if (submitTrigger === 0) return;
    inputRef.current?.form?.requestSubmit();
  }, [submitTrigger]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function selectSuggestion(suggestion: Suggestion) {
    setValue(suggestion.title);
    setSubmitTrigger((n) => n + 1);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      // Not simple modulo decrement -- (i - 1 + length) % length gives the
      // wrong answer at the i === -1 "nothing highlighted" sentinel (it
      // lands one short of the last index instead of on it), so i <= 0
      // (nothing highlighted, or already at the first item) is special-cased
      // to wrap straight to the last index.
      setHighlightedIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      // Only intercept Enter when a suggestion is actually highlighted --
      // otherwise let the keypress fall through to the browser's native
      // "Enter submits the enclosing form" behavior (matches the spec).
      if (highlightedIndex >= 0) {
        event.preventDefault();
        selectSuggestion(suggestions[highlightedIndex]);
      }
    } else if (event.key === "Escape") {
      setIsOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        name={name}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (next.trim().length < MIN_QUERY_LENGTH) {
            setSuggestions([]);
            setIsOpen(false);
          }
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsOpen(suggestions.length > 0)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded border p-2"
      />
      {isOpen && (
        <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow-lg">
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.title}-${suggestion.author ?? ""}-${index}`}>
              <button
                type="button"
                onClick={() => selectSuggestion(suggestion)}
                className={`block w-full px-3 py-2 text-left text-sm ${
                  index === highlightedIndex ? "bg-gray-100" : ""
                }`}
              >
                <span className="font-medium">{suggestion.title}</span>
                {suggestion.author && (
                  <span className="ml-1 text-gray-500">— {suggestion.author}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
