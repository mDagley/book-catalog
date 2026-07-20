interface PandaStampProps {
  className?: string;
  title?: string;
}

// The app's one signature illustration (see the design spec's
// signature-element section): a minimal ink-stamp panda mark built from
// just three shape types -- a stamp-ring circle, two ear circles, two eye
// ovals -- so it stays legible at the 20-40px sizes it's actually used at
// (the masthead, and a small "Read" marker on cards). `src/app/icon.svg`
// is a hand-kept static copy of the same shapes for the browser favicon,
// since a standalone icon file can't use `currentColor`.
export function PandaStamp({ className, title }: PandaStampProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <circle cx="16" cy="17" r="13" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="4.5" fill="currentColor" />
      <circle cx="25" cy="7" r="4.5" fill="currentColor" />
      <ellipse cx="11" cy="17" rx="3" ry="4.5" fill="currentColor" />
      <ellipse cx="21" cy="17" rx="3" ry="4.5" fill="currentColor" />
    </svg>
  );
}
