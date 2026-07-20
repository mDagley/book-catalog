import type { HTMLAttributes } from "react";

interface TicketCardProps extends HTMLAttributes<HTMLElement> {
  as?: "li" | "div";
}

// The "library ticket" card treatment used for book/copy listings (see the
// design spec's layout-language section and wireframe): a surface matching
// the page background in light mode, a distinct Card Dusk surface in dark
// mode, and a dashed border evoking a perforated card edge. Renders as an
// <li> by default since every current caller sits inside a <ul>/<ol>; pass
// `as="div"` for call sites that don't (e.g. the edit page's per-section
// blocks). Deliberately carries no padding of its own -- every caller
// supplies it via `className` (e.g. `className="p-3"`), so there's no risk
// of a caller's padding override silently losing to this component's own.
export function TicketCard({ as = "li", className = "", children, ...props }: TicketCardProps) {
  const Tag = as;
  return (
    <Tag
      {...props}
      className={`rounded-xl border border-dashed border-perforation bg-surface ${className}`}
    >
      {children}
    </Tag>
  );
}

// The dashed divider separating a card's title/author block from its
// metadata block, per the wireframe in the design spec.
export function TicketDivider() {
  return <hr className="my-2 border-t border-dashed border-perforation" />;
}
