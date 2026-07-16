export const READ_STATUS_OPTIONS = [
  { value: "TO_READ", label: "To Read" },
  { value: "READING", label: "Reading" },
  { value: "READ", label: "Read" },
] as const;

export const READ_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  READ_STATUS_OPTIONS.map((opt) => [opt.value, opt.label]),
);

export const STATUS_FILTER_OPTIONS = [
  { value: "to_read", label: "To Read" },
  { value: "reading", label: "Reading" },
  { value: "read", label: "Read" },
  { value: "unrated", label: "Unrated" },
] as const;

export const RATING_OPTIONS = [1, 2, 3, 4, 5] as const;

export function ratingStars(rating: number): string {
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}
