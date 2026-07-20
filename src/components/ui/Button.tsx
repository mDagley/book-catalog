import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// The app's two button treatments (see the design spec's layout-language
// section): a solid accent fill reserved for the one primary action per
// screen, and an outlined dashed-border treatment for everything else --
// secondary actions AND destructive ones like Delete. There's no third
// "destructive" variant: the design spec doesn't define a danger color, so
// Delete-style actions use `secondary` like any other non-primary action.
// Exported separately from the component (not just used internally) so the
// few places that render a `<Link>` styled as a button -- which this
// component can't do, since it only ever renders a real <button> -- can
// reuse the exact same class strings instead of hand-copying them.
export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground",
  secondary: "border border-dashed border-perforation bg-transparent text-foreground",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${BUTTON_VARIANT_CLASSES[variant]} ${className}`}
    />
  );
}
