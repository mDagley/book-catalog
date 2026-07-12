# Phase 3 Manual QA Checklist (real device required)

Run through this on both an iOS Safari device and an Android Chrome device.
Agents implementing this plan cannot complete this checklist themselves — it
requires real camera hardware.

- [ ] Open `/books/scan` on the phone. Camera permission prompt appears;
      grant it. Live camera feed shows in the page.
- [ ] Point the camera at a real book's barcode (EAN-13, the one under the
      regular UPC barcode on most books). Confirm it decodes within a few
      seconds without needing to hold unnaturally still.
- [ ] Confirm a photo of your actual book cover was captured (shown as one
      of the two cover choices) and it's not blank/black/blurry-unusable.
- [ ] Confirm the Open Library cover (if that ISBN has one) appears as the
      second choice, and you can toggle between the two.
- [ ] Confirm title/author/publisher/year are pre-filled correctly for a
      well-known book.
- [ ] Scan a book Open Library has no data for (try a small-press or very
      old book) — confirm the form still opens with just the ISBN and your
      captured photo, fields blank, no crash/error dialog.
- [ ] Deny camera permission (or test on a device/browser without camera
      access) — confirm the page shows a clear error and the "enter
      manually instead" link still works.
- [ ] Scan a book you already own (same ISBN as one already in the
      catalog) — confirm it adds a second copy to the existing book entry
      rather than creating a duplicate book.
- [ ] Use "Save & Scan Another" after saving — confirm it returns straight
      to the camera view without extra navigation taps.
- [ ] Confirm the whole flow is usable one-handed while holding a stack of
      books (this was the original motivating use case) — not a pass/fail
      check, just a feel/usability note.
- [ ] After scanning and saving a book, confirm the captured/chosen cover
      image actually appears on the book's detail page and looks right on
      an actual photo (not just the tiny placeholder image used during
      automated verification).
