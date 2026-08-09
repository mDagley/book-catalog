// A <select>/<input> field always submits as a string, but FormData.get()'s
// return type is `FormDataEntryValue | null` (string | File | null) --
// `as string` would silently keep a `File` instance if this field somehow
// arrived as one (e.g. a hand-crafted multipart request), and `?.toString()`
// isn't a safe substitute either: File/Blob inherit Object.prototype's
// Symbol.toStringTag-aware toString(), so `file.toString()` returns the real
// string `"[object File]"` -- not undefined, not a crash. That string is
// non-empty, passes `.trim()`/required-field checks downstream, and would
// get persisted as real data. Checking the real runtime type instead means
// a tampered request's field is coerced to "" and rejected by validation,
// rather than a File silently propagating in as garbage.
export function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Same guarantee as stringField, for fields where "absent" (undefined) is a
// meaningful, distinct state from "present but empty" -- coerces a File (or
// anything else non-string) to undefined rather than "".
export function optionalStringField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}
