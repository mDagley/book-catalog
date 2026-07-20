import { ScanAddForm } from "./ScanAddForm";

export default function ScanAddPage() {
  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 font-display text-2xl font-semibold text-foreground-strong">Scan a Book</h1>
      <ScanAddForm />
    </main>
  );
}
