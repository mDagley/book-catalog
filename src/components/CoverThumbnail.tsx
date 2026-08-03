const SIZE_CLASSES = {
  default: "h-32 w-24",
  compact: "h-16 w-12",
} as const;

interface CoverThumbnailProps {
  coverImagePath: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}

export function CoverThumbnail({
  coverImagePath,
  size = "default",
  className = "",
}: CoverThumbnailProps) {
  const sizeClass = SIZE_CLASSES[size];

  if (!coverImagePath) {
    return (
      <div
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded border border-dashed border-perforation bg-surface text-3xl text-foreground/40 ${className}`}
        aria-hidden="true"
      >
        📖
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/covers/${encodeURIComponent(coverImagePath)}`}
      alt="Cover"
      className={`${sizeClass} shrink-0 rounded object-cover ${className}`}
    />
  );
}
