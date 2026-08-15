const SIZE_CLASSES = {
  default: "h-32 w-24 rounded",
  compact: "h-16 w-12 rounded",
  poster: "aspect-[2/3] w-full",
} as const;

interface CoverThumbnailProps {
  coverImagePath: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
  alt?: string;
}

export function CoverThumbnail({
  coverImagePath,
  size = "default",
  className = "",
  alt = "Cover",
}: CoverThumbnailProps) {
  const sizeClass = SIZE_CLASSES[size];

  if (!coverImagePath) {
    return (
      <div
        className={`flex ${sizeClass} shrink-0 items-center justify-center border border-dashed border-perforation bg-surface text-3xl text-foreground/40 ${className}`}
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
      alt={alt}
      className={`${sizeClass} shrink-0 object-cover ${className}`}
    />
  );
}
