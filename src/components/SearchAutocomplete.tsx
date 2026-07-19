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
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set true right before setValue() in selectSuggestion, so the effect
  // below (which runs after React commits the new value to the DOM) submits
  // the form once the input's real DOM value actually matches the selection
  // -- calling requestSubmit() synchronously in the same handler as setValue
  // would race React's batched state update and could submit the OLD value.
  const submitPendingRef = useRef(false);
  // Bumped on every keystroke; a debounced fetch response only applies if
  // its id still matches the latest one when it resolves, so a slow response
  // to an earlier keystroke can never clobber a newer one that resolved first.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setIsOpen(false);
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
    if (submitPendingRef.current) {
      submitPendingRef.current = false;
      inputRef.current?.form?.requestSubmit();
    }
  }, [value]);

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
    submitPendingRef.current = true;
    setValue(suggestion.title);
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
      setHighlightedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
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
        onChange={(e) => setValue(e.target.value)}
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
