# Implementation Notes

Reasons behind non-obvious choices in the reference implementations, and pitfalls they avoid. The rules live in
CLAUDE.md and the code lives in the reference files listed there — this file does not repeat either. Add a note here
only when it explains something the code and CLAUDE.md don't.

## Controller
- Query input binds to a `record` with `init` properties and defaults, not a positional record: positional records
  require every constructor argument, which breaks optional query-string parameters.
- Declare a `[ProducesResponseType]` per outcome so the OpenAPI document shows the real contract.

## Service
- Reading the current row before a status update serves only to validate the transition and fill `PreviousStatus`.
  It does **not** protect against lost updates — the row can change between the read and the write. The conditional
  update on `version` in the database is what does.
- Invalidate the cache after the write has committed. Invalidating before it lets a concurrent read re-cache old data.

## Repository
- Order of a paged query: filter → count → sort → page → project, all translated to SQL. Materializing (`ToList`)
  any earlier loads the whole filtered set into memory.
- Sorting always ends with a unique tiebreaker (`Id`). Without it, rows with equal sort values can repeat across pages
  or disappear between them.
- Blank filter strings mean "no filter"; otherwise an empty text box filters for empty values.
- The `COUNT` over 100k filtered rows is the likely bottleneck of the list endpoint — measure it for PERFORMANCE.md.

## Angular
- `catchError` goes inside the `switchMap` inner observable. In the outer pipe, the first failed request completes
  the stream and search stops working until the page is reloaded.
- Any filter or sort change resets to page 1; otherwise the user can land on a page past the end of the new results.
- Query params drop `null`/empty values before sending, so they don't arrive as the string `"null"`.

## Tests
- The concurrency test must hit the real database (integration test): send two updates with the same `version` and
  assert exactly one 200 and one 409. A fake repository can't prove the database enforces it.
