export function CoverThumbnail({ coverImagePath }: { coverImagePath: string | null }) {
  if (!coverImagePath) {
    return (
      <div
        className="mb-2 flex h-32 w-24 items-center justify-center rounded border border-dashed border-perforation bg-surface text-3xl text-foreground/40"
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
      className="mb-2 h-32 w-24 rounded object-cover"
    />
  );
}
