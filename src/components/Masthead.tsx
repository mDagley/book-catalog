import { PandaStamp } from "@/components/PandaStamp";

// Slim shared app-identity bar rendered once, above every page's own
// heading (see layout.tsx). Deliberately carries no nav links of its own
// -- every page keeps its existing links/back-buttons exactly as before.
// This is the one explicit exception to "no IA redesign" called out in the
// design spec: additive chrome only, giving the panda stamp a consistent
// home since no page previously had an app-level header at all.
export function Masthead() {
  return (
    <div className="border-b border-dashed border-perforation px-4 py-2">
      <div className="mx-auto flex max-w-2xl items-center gap-2">
        <PandaStamp className="h-5 w-5 text-foreground-strong" />
        <span className="font-display text-sm font-semibold tracking-wide text-foreground-strong">
          Book Catalog
        </span>
      </div>
    </div>
  );
}
