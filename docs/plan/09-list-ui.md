# 09 List UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Never run `git commit` without the developer's explicit permission in the session.** Each "Commit" step means:
> stop, show what would be committed, and ask.

**Goal:** the request list in Angular: a filter bar, a table with multi-column sorting and a paginator, all driven by
`GET api/requests`. Filtering, sorting and paging run on the server only. These are the first-slice frontend files that
become reference implementations.

**Architecture:** the URL query string is the single source of truth. `RequestsStore` turns UI actions into a
navigation, reads the query back from the route, and runs one `distinctUntilChanged` → `switchMap` pipeline to
`RequestsApiService`. The filter bar and table are presentational; the list component provides the store and shows the
loading, empty and error states.

**Tech Stack:** Angular 22 (standalone, signals, RxJS interop), Angular Material and CDK, Vitest (existing setup from
task 07). New packages can be added if needed, with the developer's approval.

**Spec:** `docs/PLAN.md` → task 09 and US-2.1; `CLAUDE.md` → API contract (`GET api/requests`), Frontend conventions;
`docs/code-patterns.md` → Angular; `docs/plan/08-list-api.md` → Design (the server side of this contract).

## Design

**Delivers** (branch `feature/09-list-ui` in `request-tracker-client`, i.e. inside `frontend/`):

- The `requests` route shows the list: filter bar → active-sort row → table → paginator.
- Not in this task: opening a request (task 14; rows aren't clickable yet), status changes, bulk selection (task 11 has no
  UI task), history and statistics.

### Contract consumed

- `GET api/requests` with query `page`, `pageSize` (1–100, default 20), repeated `status`, `priority` and `assignedTo`
  (OR within a filter, AND across filters; `assignedTo` exact match; at most 50 values per filter), `organizationName`
  (prefix), `createdFrom` / `createdTo` (`yyyy-MM-dd`, UTC days, both included), `search` (Title + OrganizationName),
  repeated `sort=field[:asc|desc]` (fields `id`, `title`, `organizationName`, `status`, `priority`, `assignedTo`,
  `createdAt`, `updatedAt`, each at most once; server default `createdAt:desc`). Checked in the merged 08 code
  (`RequestQueryParameters.ParseSort`, `RequestSort.Default`): no `sort` param, or only blank values, gives
  `createdAt:desc`. Ties always end with `Id` in the last level's direction; when the last level is `status`,
  `priority` or `assignedTo` and no level is `createdAt`, the server adds `createdAt` before `Id` (same direction).
  These hidden tiebreaks aren't shown in the headers. `page` goes up to 21,474,836.
- Response `PagedResult<RequestDto>` = `{ items, page, pageSize, totalCount }`. `RequestDto` =
  `{ id, title, organizationName, status, priority, assignedTo, createdAt, updatedAt, version }`. Enums are strings
  (`New | InProgress | Waiting | Completed`, `Low | Medium | High`); timestamps are ISO strings with offset; `version` is
  an opaque base64 string, kept in the model (tasks 11 and 14 need it) and never shown.
- Errors are ProblemDetails; 400 carries an `errors` dictionary.

### Filters

- **Status and priority:** multi-select (`mat-select multiple`), options from the enum string unions.
- **Assignee:** chips with a text input (`mat-chip-grid`). Enter or comma adds a trimmed, non-empty, not-yet-added name;
  each chip has a remove button. There is no endpoint that lists assignees, so names are typed. At most 50 chips
  (the server's limit); input `maxlength` 100 (column length).
- **Organization:** text input, prefix match, `maxlength` 200.
- **Created date range:** `mat-date-range-input` with `provideNativeDateAdapter()` at component level (no change to
  `app.config.ts`). Sent as `yyyy-MM-dd` from the picked calendar day, labeled "Created (UTC)".
- **Search:** text input over Title and Organization, `maxlength` 200.
- **Debounce (developer's decision):** search **and** organization are debounced 300 ms; `CLAUDE.md` says only search.
  Without it, every keystroke in the organization box sends a request. The PR records the deviation. Selects, chips,
  dates, sort and paging request immediately.
- **Enter in search or organization (developer's decision)** cancels the pending debounce and sends right away. If the
  query hasn't changed, Enter reloads it (the same trigger as Retry), so a user who wants fresh data for the same
  filters gets it (*my call*).
- **Same query again:** when typing settles on the query that is already shown (`acme` → `acm` → `acme` within
  300 ms), no request is sent: the rows on screen are already its result. `distinctUntilChanged` compares with the
  last query only, so going back to an earlier, different query (A → B → A) requests it again.
- A "Clear filters" button resets every filter (not sorting or page size).
- Blank text means no filter (trimmed before sending).

### Multi-column sorting (developer's decision)

Material's `matSort` supports a single column, so the table uses its own header buttons instead (*my call*: no `matSort`
at all, rather than fighting its single-sort state).

- Sortable columns: every visible column.
- Clicking an unsorted column adds it as the **last** sort level, ascending.
- Clicking it again switches it to descending. Changing a column's direction keeps its sort priority.
- A third click removes it from the sort. The remaining levels renumber (1, 2, 3 … with no gaps).
- Each sorted header shows an arrow and a small priority number. The number is hidden when only one column is sorted.
- A small "Reset sorting" button clears all levels; it is disabled when no level is set.
- No levels = the server default (`createdAt:desc`). No `sort` param is sent, and no header shows an arrow; a muted
  "Default order: newest first" note sits next to the reset button (*my call*).
- The levels map one to one, in order, to repeated `sort=field:dir` params.
- Headers are `<button>`s with `aria-sort` on the `th` for the first level and an `aria-label` that states the level
  and direction (*my call*).
- The sort logic (click → next levels) is one pure function, unit-tested apart from the component.

### Table and paging

- Columns: Id, Title, Organization, Status, Priority, Assignee, Created, Updated (developer's decision). Id is first
  and sortable like the others. No `version`.
- Timestamps shown in UTC (`date: 'yyyy-MM-dd HH:mm' : 'UTC'`, header "(UTC)"), so they match the date filter, which is
  in UTC days (*my call*).
- `mat-paginator` with `length = totalCount`, page sizes 10 / 20 / 50 / 100, default 20, first/last buttons.
- A page past the end (e.g. a stale link) shows the empty state with the real total, and the paginator stays usable. Exception (PrimeNG paginator behavior, accepted in Revision 1): a page exactly one past the end is moved to the last page by the paginator itself, which updates the URL like a page click; further past shows the empty state.

### State in the URL (developer's decision)

The query string holds the whole query, so refresh, back from details (task 14) and shared links keep the view.

- **The URL is the single source of truth.** UI actions call the store, which computes the next query and navigates
  (`router.navigate([], { queryParams, replaceUrl: true })`). The store's data pipeline reads the route's query params,
  so a UI change, a refresh and a pasted link all go through one path.
- `replaceUrl: true` for every change (*my call*): typing and paging don't fill the history, and back still returns
  from another page to the list as it was.
- Serialization: only non-default values are written (`page` 1, `pageSize` 20, empty filters and empty sort are left
  out). Arrays as repeated keys, dates as `yyyy-MM-dd`, sort as `field:dir`.
- Parsing is tolerant: an invalid value (`page=abc`, `pageSize=500`, `status=Foo`, an unknown sort field, a repeated
  sort field, a bad date, `createdFrom` after `createdTo`) is dropped and its default used, and the URL is rewritten to
  the normalized query (`replaceUrl`) (*my call*: a broken link still opens a working list rather than a 400).
- Serialize and parse are pure functions in their own file, unit-tested both ways (round trip).
- Any filter or sort change resets `page` to 1. A page-size change also resets to page 1 (*my call*).

### Data flow and states

- Pipeline in the store: route query params → parse → `distinctUntilChanged` (on the serialized query) →
  `switchMap(api call, with catchError inside)` → state signals. A newer query cancels the pending request; a failed
  request doesn't stop later ones (`docs/code-patterns.md` → Angular).
- Debounce happens in the store before navigating, on the text inputs only, so the URL and the request see the settled
  text.
- **Text drafts (*my call*):** the store keeps the untrimmed text the user typed in search and organization as draft
  signals, and the filter bar's text boxes show those drafts, not the URL value. That way the URL round trip never
  overwrites what the user is typing: a trailing space isn't eaten, and a slow response can't bring an older value back.
  The drafts are reset from the URL only on an outside navigation: refresh, a pasted link, back/forward, or a URL that
  differs from the one the store last wrote. "Clear filters" clears the drafts directly.
- **Pending text goes with the next immediate action (*my call*):** a status, sort, page or other immediate change
  within the 300 ms window cancels the pending debounce and navigates with the current drafts. One request, not a
  stale one followed by another.
- One `status` signal: `'idle' | 'loading' | 'success' | 'error'`, plus `items`, `totalCount` and `errorMessage`.
- **Loading:** a `mat-progress-bar` above the table; the previous rows stay visible but dimmed, so the table doesn't
  jump on each change (*my call*).
- **Empty:** "No requests match these filters" with a "Clear filters" button.
- **Error:** the ProblemDetails `title`/`detail` (or a generic message for a network error) with a "Retry" button that
  reruns the same query. A retry signal is part of the pipeline, so retrying doesn't depend on the query changing.
- `takeUntilDestroyed()` / `toSignal` only; no manual unsubscribe.

### Files (in `frontend/src/app/`)

| File | Responsibility |
|---|---|
| `core/models/request.model.ts` | `RequestDto`, `RequestStatus`, `RequestPriority` (string unions + option lists) |
| `core/models/paged-result.model.ts` | `PagedResult<T>` |
| `core/models/request-query.model.ts` | `RequestQuery`, `SortLevel`, `RequestSortField`, `SortDirection`, defaults |
| `core/models/problem-details.model.ts` | `ProblemDetails` (RFC 9457 fields the client reads) |
| `core/api/requests-api.service.ts` | `getPaged(query): Observable<PagedResult<RequestDto>>`; builds `HttpParams`, dropping empty values; no state |
| `core/api/problem-message.ts` | `problemMessage(error)`: a user-facing message from an HTTP error (reused by task 14) |
| `shared/iso-date.ts` | `toIsoDate(date)` / `fromIsoDate(text)`: calendar day ↔ `yyyy-MM-dd` |
| `features/requests/request-query-url.ts` | `toQueryParams(query)` / `fromQueryParams(params)` |
| `features/requests/sort-levels.ts` | `toggleSortLevel(levels, field)` |
| `features/requests/requests.store.ts` | state signals, the pipeline, actions (`setFilters`, `toggleSort`, `resetSort`, `setPage`, `clearFilters`, `retry`); provided by the list component |
| `features/requests/requests-list/requests-list.component.ts` | container: provides the store, lays out the parts, shows the states |
| `features/requests/requests-filter-bar/requests-filter-bar.component.ts` | presentational: filter inputs in, changes out (`input()` / `output()`) |
| `features/requests/requests-table/requests-table.component.ts` | presentational: rows, sort headers and the sort row |

`RequestDto` keeps the backend name (*my call*): it mirrors the DTO and avoids a clash with the DOM's `Request` type.
Shared files touched: none outside `features/requests/` and `core/` (the route already exists from task 07).

### How it is checked

- **Vitest unit tests:**
  - `request-query-url`: round trip, defaults omitted, every invalid-value case falls back.
  - `sort-levels`: add as last ascending, asc → desc keeps priority, third click removes and renumbers.
  - `requests-api.service` (`HttpTestingController`): repeated keys, `sort=field:dir`, empty values dropped.
  - `requests.store` (fake timers): search and organization debounced 300 ms, other changes immediate and carrying the
    pending text; Enter sends at once and reloads an unchanged query; a trailing space in a draft survives the URL round trip; an outside navigation resets the drafts; a newer query
    cancels the pending request; an error then a new query recovers; retry reruns; filter/sort change resets page 1.
  - Components: a render test each for loading, empty and error states, and that header clicks call the store.
- **Manual check on the seeded database** (08 is merged), recorded in the PR: the network panel shows one request
  after typing stops, immediate requests for page, sort and filter changes, cancelled stale requests, and repeated
  `sort` params in the order of the header numbers; refresh and a pasted link restore the view.
- `ng build`, `ng lint`, `ng test` and `prettier --check` pass.

### Left to the builder

Layout and spacing of the filter bar (it should wrap on narrow screens), exact wording of messages, test file split.

## Global Constraints

- Standalone components, `ChangeDetectionStrategy.OnPush`, `@if`/`@for`, `inject()`, `input()`/`output()`/`computed()`.
  No `any`. Strict TypeScript. No NgRx. Components never inject `HttpClient`.
- No filtering, sorting or paging in the browser: every change becomes a `GET api/requests` call.
- Debounce 300 ms, only for search and organization. Page size options `[10, 20, 50, 100]`, default 20, max 100.
  At most 50 values per selection filter. `maxlength`: assignee 100, organization 200, search 200. Max `page`
  21,474,836.
- Server default order `createdAt:desc` = no `sort` param.
- Subscriptions use `takeUntilDestroyed()` or `toSignal`. `catchError` inside the `switchMap` inner observable.
- Tests: Vitest (globals), names `methodName_Scenario_ExpectedResult` (as in `app.component.spec.ts`),
  Arrange / Act / Assert separated by a blank line, hand-written fakes (`vi.fn` at most).
- Work inside `frontend/` on `feature/09-list-ui` (already created from `origin/main`). No submodule pointer change in
  the main repository. A new package needs the developer's approval first.
- Run `npm ci` once inside `frontend/` before the first test run.

## Review Focus

1. **Typing while results arrive** — the box keeps exactly what the user typed (including a trailing space) while the
   URL and responses change. → Task 4, `setSearchDraft_ResponseArrivesWhileTyping_DraftUnchanged`.
2. **A hand-edited or stale link** — `?page=abc&status=Foo&sort=title:sideways` opens a working list and the URL is
   rewritten to the valid part. → Task 1, `fromQueryParams_InvalidValues_DropsThemAndMarksInvalid`, and Task 3,
   `init_InvalidUrl_RewritesToNormalizedUrl`.
3. **The server is down, then back** — the error state shows, and both Retry and the next filter change load data
   again. → Task 3, `retry_AfterError_ReloadsSameQuery` and `setFilters_AfterError_LoadsNewQuery`.
4. **Paging past the end** — a link to `page=999` with 3 results shows the empty state with the total, and the
   paginator still works. → Task 6, `render_PageBeyondEnd_ShowsEmptyStateAndPaginator`.
5. **Back/forward between list views** — the drafts and table follow the URL, not the last typed text.
   → Task 4, `outsideNavigation_UrlChanges_ResetsDrafts`.

---

### Task 1: Models, URL query serialization and sort levels

**Files** (paths relative to `frontend/src/app/`):
- Create: `core/models/request.model.ts`, `core/models/paged-result.model.ts`, `core/models/request-query.model.ts`,
  `core/models/problem-details.model.ts`
- Create: `features/requests/request-query-url.ts`, `features/requests/sort-levels.ts`
- Test: `features/requests/request-query-url.spec.ts`, `features/requests/sort-levels.spec.ts`

**Interfaces — Produces:**
- `type RequestStatus = 'New' | 'InProgress' | 'Waiting' | 'Completed'`, `REQUEST_STATUSES: readonly RequestStatus[]`
  (that order); `type RequestPriority = 'Low' | 'Medium' | 'High'`, `REQUEST_PRIORITIES` (that order).
- `interface RequestDto { id: number; title: string; organizationName: string; status: RequestStatus;
  priority: RequestPriority; assignedTo: string; createdAt: string; updatedAt: string; version: string }`.
- `interface PagedResult<T> { items: T[]; page: number; pageSize: number; totalCount: number }`.
- `interface ProblemDetails { type?: string; title?: string; status?: number; detail?: string;
  errors?: Record<string, string[]> }`.
- `type RequestSortField = 'id' | 'title' | 'organizationName' | 'status' | 'priority' | 'assignedTo' | 'createdAt' |
  'updatedAt'`, `REQUEST_SORT_FIELDS`; `type SortDirection = 'asc' | 'desc'`;
  `interface SortLevel { field: RequestSortField; direction: SortDirection }`.
- `interface RequestFilters { status: RequestStatus[]; priority: RequestPriority[]; assignedTo: string[];
  organizationName: string; search: string; createdFrom: string | null; createdTo: string | null }` (dates
  `yyyy-MM-dd`; text already trimmed).
- `interface RequestQuery extends RequestFilters { page: number; pageSize: number; sort: SortLevel[] }`.
- Constants: `DEFAULT_PAGE_SIZE = 20`, `MAX_PAGE_SIZE = 100`, `PAGE_SIZE_OPTIONS = [10, 20, 50, 100]`,
  `MAX_PAGE = 21_474_836`, `MAX_FILTER_VALUES = 50`, `ASSIGNED_TO_MAX_LENGTH = 100`, `TEXT_FILTER_MAX_LENGTH = 200`,
  `EMPTY_FILTERS: RequestFilters`, `DEFAULT_QUERY: RequestQuery` (page 1, size 20, empty sort).
- `toQueryParams(query: RequestQuery): Params` (`Params` from `@angular/router`): non-default values only; arrays as
  arrays (repeated keys); sort as `field:dir` strings in level order.
- `fromQueryParams(params: ParamMap): { query: RequestQuery; invalid: boolean }`: `invalid` is true when any known
  key held a value that was dropped.
- `queryKey(query: RequestQuery): string`: a stable string (`JSON.stringify(toQueryParams(query))`) for
  `distinctUntilChanged` and the draft-reset check.
- `toggleSortLevel(levels: readonly SortLevel[], field: RequestSortField): SortLevel[]`: a new array, never mutates.

- [ ] **Step 1: Write the failing tests.** `request-query-url.spec.ts` (build `ParamMap`s with `convertToParamMap`):
  - `toQueryParams_DefaultQuery_ReturnsEmpty` → `{}`.
  - `toQueryParams_FullQuery_WritesRepeatedKeysAndSortPairs` → `status: ['New', 'Waiting']`,
    `assignedTo: ['ann', 'bob']`, `sort: ['priority:desc', 'createdAt:asc']`, `page: '3'`, `pageSize: '50'`,
    `createdFrom: '2026-01-01'`.
  - `fromQueryParams_RoundTrip_ReturnsSameQuery`: full query → `toQueryParams` → `fromQueryParams` deep-equals it,
    `invalid` false.
  - `fromQueryParams_InvalidValues_DropsThemAndMarksInvalid`: `page=abc`, `pageSize=500`, `status=Foo&status=New`,
    `sort=title:sideways&sort=priority`, `createdFrom=2026-02-30` → page 1, size 20, status `['New']`,
    sort `[{ field: 'priority', direction: 'asc' }]`, `createdFrom` null, `invalid` true.
  - `fromQueryParams_RepeatedSortField_KeepsFirst`: `sort=title:desc&sort=title` → `[title:desc]`, invalid.
  - `fromQueryParams_FromAfterTo_DropsBothDates` → both null, invalid.
  - `fromQueryParams_TextFilters_TrimsAndDropsTooLong`: `search=%20acme%20` → `'acme'`; a 201-character organization
    → `''`, invalid; blank or 101-character assignee values dropped; 51 assignees → the first 50, invalid.
  - `fromQueryParams_PageAboveMax_FallsBackToOne`: `page=21474837` → 1, invalid.

  `sort-levels.spec.ts`:
  - `toggleSortLevel_UnsortedField_AddsLastAscending`: `[title:asc]` + `priority` → `[title:asc, priority:asc]`.
  - `toggleSortLevel_AscendingField_SwitchesToDescendingKeepingPosition`: `[title:asc, priority:asc]` + `title` →
    `[title:desc, priority:asc]`.
  - `toggleSortLevel_DescendingField_RemovesIt`: `[title:desc, priority:asc]` + `title` → `[priority:asc]`.
  - `toggleSortLevel_Always_DoesNotMutateInput`.
- [ ] **Step 2: Run** `npx ng test --watch=false` → fails to compile (the modules don't exist).
- [ ] **Step 3: Implement** the models, constants and functions per Interfaces and the Design's parsing rules. Dates
  are valid only as real calendar days in `yyyy-MM-dd` (`2026-02-30` is rejected). Duplicate status and priority
  values are deduplicated silently (not invalid).
- [ ] **Step 4: Run** `npx ng test --watch=false` → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `09: Add list models, URL query serialization and sort levels`

### Task 2: API service and error messages

**Files:**
- Create: `core/api/requests-api.service.ts`, `core/api/problem-message.ts`
- Test: `core/api/requests-api.service.spec.ts`, `core/api/problem-message.spec.ts`

**Interfaces:**
- Consumes: `RequestQuery`, `RequestDto`, `PagedResult`, `ProblemDetails` (Task 1).
- Produces: `@Injectable({ providedIn: 'root' }) class RequestsApiService` with
  `getPaged(query: RequestQuery): Observable<PagedResult<RequestDto>>` → `GET /api/requests`.
- Produces: `problemMessage(error: unknown): string`.

- [ ] **Step 1: Write the failing tests** (`provideHttpClient()`, `provideHttpClientTesting()`, `HttpTestingController`):
  - `getPaged_DefaultQuery_SendsPageAndPageSizeOnly`: params exactly `page=1&pageSize=20`.
  - `getPaged_FullQuery_SendsRepeatedKeysAndSortPairs`: `params.getAll('status')` = `['New', 'Waiting']`,
    `getAll('sort')` = `['priority:desc', 'createdAt:asc']`, `createdTo=2026-01-31`, `search=acme`.
  - `getPaged_BlankAndNullValues_AreNotSent`: `search: ''`, `createdFrom: null`, `assignedTo: []` → keys absent.
  - `getPaged_Response_ReturnsBody`.
  - `problemMessage_ProblemDetailsWithDetail_ReturnsDetail`; `problemMessage_TitleOnly_ReturnsTitle`;
    `problemMessage_StatusZero_ReturnsCannotReachServer`
    (`"Can't reach the server. Check your connection and try again."`);
    `problemMessage_OtherError_ReturnsGenericMessage` (`"Something went wrong. Try again."`).
- [ ] **Step 2: Run** `npx ng test --watch=false` → the new specs fail.
- [ ] **Step 3: Implement.** The service always sends `page` and `pageSize`, and other values only when non-empty. It
  builds `HttpParams` itself, because the URL format in Task 1 is a UI concern. `problemMessage` reads an
  `HttpErrorResponse` whose `error` is a `ProblemDetails`: `detail`, else `title`.
- [ ] **Step 4: Run** `npx ng test --watch=false` → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `09: Add the requests API service and problem messages`

### Task 3: Store: URL sync, pipeline and states

**Files:**
- Create: `features/requests/requests.store.ts`
- Test: `features/requests/requests.store.spec.ts`

**Interfaces:**
- Consumes: Task 1 functions and types; `RequestsApiService`, `problemMessage` (Task 2).
- Produces: `@Injectable() class RequestsStore` (no `providedIn`; provided by the list component). It injects `Router`,
  `ActivatedRoute` and `RequestsApiService`.
  - `type LoadStatus = 'idle' | 'loading' | 'success' | 'error'` (exported).
  - Signals: `query: Signal<RequestQuery>`, `status: Signal<LoadStatus>`, `items: Signal<RequestDto[]>`,
    `totalCount: Signal<number>`, `errorMessage: Signal<string | null>`.
  - Actions: `setFilters(patch: Partial<Pick<RequestFilters, 'status' | 'priority' | 'assignedTo' | 'createdFrom' |
    'createdTo'>>): void`, `clearFilters(): void`, `toggleSort(field: RequestSortField): void`, `resetSort(): void`,
    `setPage(page: number, pageSize: number): void`, `retry(): void`.
  - Navigation: `router.navigate([], { relativeTo: route, queryParams: toQueryParams(next), replaceUrl: true })`.

- [ ] **Step 1: Write the failing tests.** Arrange with `provideRouter([])`, `RequestsStore` in `providers`, and a
  hand-written `FakeRequestsApi` that records each `getPaged` query and returns a `Subject` the test emits on or
  errors. Navigate with `router.navigateByUrl(...)` and `await TestBed.inject(ApplicationRef).whenStable()`.
  - `init_NoParams_LoadsDefaultQuery`: one call with `DEFAULT_QUERY`; `status()` is `'loading'`, then `'success'`
    with the items and total.
  - `init_InvalidUrl_RewritesToNormalizedUrl`: `/?page=abc&status=New` → `router.url` becomes `/?status=New`, one call.
  - `setFilters_StatusChange_NavigatesWithPageOneAndLoads`: from `page=3`, `setFilters({ status: ['New'] })` → URL
    `?status=New`, query page 1.
  - `toggleSort_Field_WritesSortParamAndResetsPage`; `resetSort_AfterSorting_RemovesSortParam`.
  - `setPage_PageSizeChanged_ResetsToPageOne`: `setPage(4, 50)` from size 20 → page 1, size 50; `setPage(4, 20)` →
    page 4.
  - `newQuery_WhilePending_CancelsPreviousRequest`: the first `Subject` has no observers after the second query.
  - `retry_AfterError_ReloadsSameQuery`: an error → `status()` `'error'`, `errorMessage()` set; `retry()` → a second
    call with the same query.
  - `setFilters_AfterError_LoadsNewQuery`.
  - `sameQuery_NavigatedAgain_DoesNotReload`: navigating to the same URL makes no new call.
- [ ] **Step 2: Run** `npx ng test --watch=false` → fails (the store doesn't exist).
- [ ] **Step 3: Implement.** Pipeline per the Design: `route.queryParamMap` → `fromQueryParams` (rewrite the URL when
  `invalid`) → `distinctUntilChanged` on `queryKey`, merged with a retry subject that re-emits the current query →
  `switchMap` to the API with `catchError` inside → state signals. Every action computes the next query from
  `query()` and navigates; filter and sort changes set page 1.
- [ ] **Step 4: Run** `npx ng test --watch=false` → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `09: Add the requests store with URL state`

### Task 4: Store: text drafts, debounce and Enter

**Files:**
- Modify: `features/requests/requests.store.ts`
- Test: `features/requests/requests.store.spec.ts`

**Interfaces:**
- Consumes: `RequestsStore` (Task 3).
- Produces on `RequestsStore`: signals `searchDraft: Signal<string>`, `organizationDraft: Signal<string>`; actions
  `setSearchDraft(text: string): void`, `setOrganizationDraft(text: string): void`, `submitText(): void`.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`, `await vi.advanceTimersByTimeAsync(ms)`):
  - `setSearchDraft_Typing_NavigatesOnceAfter300ms`: three drafts 100 ms apart; no navigation at 299 ms after the
    last; one call with `search: 'acm'` at 300 ms.
  - `setOrganizationDraft_Typing_IsDebounced`: the same for organization.
  - `setFilters_DuringDebounce_SendsPendingTextOnce`: draft `'ac'`, then `setFilters({ status: ['New'] })` at 100 ms
    → exactly one new call, with `search: 'ac'` and `status: ['New']`; nothing more at 400 ms.
  - `submitText_PendingDraft_SendsImmediately`: no wait for 300 ms.
  - `submitText_UnchangedQuery_Reloads`: a second call with the same query.
  - `setSearchDraft_TrailingSpace_DraftKeepsSpaceAndQueryTrims`: draft `'acme '` → after 300 ms `searchDraft()` is
    `'acme '` and `query().search` is `'acme'`.
  - `setSearchDraft_ResponseArrivesWhileTyping_DraftUnchanged`: a response and a URL update land between keystrokes;
    `searchDraft()` stays what was typed.
  - `outsideNavigation_UrlChanges_ResetsDrafts`: `router.navigateByUrl('/?search=beta')` → `searchDraft()` is `'beta'`.
  - `clearFilters_WithDrafts_ClearsDraftsAndFilters`: sort and page size are kept, page 1.
- [ ] **Step 2: Run** `npx ng test --watch=false` → the new tests fail.
- [ ] **Step 3: Implement.** Drafts are writable signals. Text changes feed a subject → `timer(300)` inside a
  `switchMap` that immediate actions and `submitText` cancel; the navigation uses the trimmed drafts. Keep the key of
  the URL the store last wrote; when the route's query key differs from it, set the drafts from the URL.
- [ ] **Step 4: Run** `npx ng test --watch=false` → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `09: Debounce text filters with drafts and Enter`

### Task 5: Table with multi-column sort headers

**Files:**
- Create: `features/requests/requests-table/requests-table.component.ts` (inline template and styles, like
  `app.component.ts`)
- Test: `features/requests/requests-table/requests-table.component.spec.ts`

**Interfaces:**
- Consumes: `RequestDto`, `SortLevel`, `RequestSortField` (Task 1).
- Produces: `RequestsTableComponent`, selector `app-requests-table`; inputs `items: RequestDto[]` (required),
  `sort: SortLevel[]` (required), `loading: boolean` (default false); outputs `sortToggle: RequestSortField`,
  `sortReset: void`.

- [ ] **Step 1: Write the failing tests** (`fixture.componentRef.setInput`):
  - `render_Items_ShowsColumnsInOrder`: headers Id, Title, Organization, Status, Priority, Assignee, Created (UTC),
    Updated (UTC); a row's date shows `2026-01-31 23:59` for `2026-01-31T23:59:00+00:00`.
  - `render_TwoSortLevels_ShowsArrowsAndNumbers`: `[priority:desc, title:asc]` → the Priority header has ↓ and `1`,
    Title has ↑ and `2`; `aria-sort="descending"` on the Priority `th`.
  - `render_OneSortLevel_HidesNumber`.
  - `render_NoSort_ShowsDefaultNoteAndDisablesReset`: "Default order: newest first"; Reset sorting is disabled.
  - `headerClick_Column_EmitsSortToggleWithField`; `resetClick_EmitsSortReset`.
  - `render_Loading_DimsRows`: a `loading` class on the table.
- [ ] **Step 2: Run** `npx ng test --watch=false` → fails.
- [ ] **Step 3: Implement** with `mat-table` (`MatTableModule`), header `<button>`s (no `matSort`), `DatePipe` with
  `'yyyy-MM-dd HH:mm'` and `'UTC'`, and an `aria-label` per header such as `"Priority, sorted descending, level 1"`.
- [ ] **Step 4: Run** `npx ng test --watch=false` → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `09: Add the requests table with multi-column sorting`

### Task 6: Filter bar and list page

**Files:**
- Create: `shared/iso-date.ts`, `features/requests/requests-filter-bar/requests-filter-bar.component.ts`
- Modify: `features/requests/requests-list/requests-list.component.ts` (replaces the task 07 placeholder)
- Test: `shared/iso-date.spec.ts`, `features/requests/requests-filter-bar/requests-filter-bar.component.spec.ts`,
  `features/requests/requests-list/requests-list.component.spec.ts`

**Interfaces:**
- Consumes: `RequestsStore` (Tasks 3–4), `RequestsTableComponent` (Task 5), Task 1 constants.
- Produces: `toIsoDate(date: Date): string` (local calendar fields → `yyyy-MM-dd`) and
  `fromIsoDate(text: string | null): Date | null`.
- Produces: `RequestsFilterBarComponent`, selector `app-requests-filter-bar`, `providers: [provideNativeDateAdapter()]`;
  inputs `filters: RequestFilters`, `searchDraft: string`, `organizationDraft: string` (all required); outputs
  `searchDraftChange: string`, `organizationDraftChange: string`, `textSubmit: void`,
  `filtersChange: Partial<Pick<RequestFilters, 'status' | 'priority' | 'assignedTo' | 'createdFrom' | 'createdTo'>>`,
  `clear: void`.
- Produces: `RequestsListComponent` (`providers: [RequestsStore]`): filter bar → table → `mat-paginator`
  (`pageIndex = page - 1`, `length = totalCount`, `PAGE_SIZE_OPTIONS`, `showFirstLastButtons`), and the states.

- [ ] **Step 1: Write the failing tests.**
  - `toIsoDate_LocalDate_FormatsCalendarDay` (`new Date(2026, 0, 5)` → `'2026-01-05'`);
    `fromIsoDate_Text_ReturnsLocalDate`; `fromIsoDate_Null_ReturnsNull`.
  - Filter bar: `searchInput_Typing_EmitsDraftChange`; `searchInput_Enter_EmitsTextSubmit` (and the same for
    organization); `assigneeInput_Enter_AddsTrimmedChipOnce` (blank and duplicate names ignored; emits `assignedTo`);
    `assigneeChip_Remove_EmitsListWithoutIt`; `statusSelect_Change_EmitsStatus`; `clearButton_Click_EmitsClear`;
    `render_Drafts_ShowsDraftText` (`'acme '` stays `'acme '` in the input).
  - List, with a hand-written fake store provided through `TestBed.overrideComponent(..., { set: { providers } })`:
    `render_Loading_ShowsProgressBar`; `render_SuccessEmpty_ShowsEmptyStateWithClearFilters`;
    `render_Error_ShowsMessageAndRetryCallsStore`; `render_PageBeyondEnd_ShowsEmptyStateAndPaginator` (page 999,
    total 3, no items → the empty state and a paginator with length 3); `paginatorPage_CallsSetPage`.
- [ ] **Step 2: Run** `npx ng test --watch=false` → fails.
- [ ] **Step 3: Implement.** Filter bar: `mat-form-field`s with `mat-select multiple` (status, priority),
  `mat-chip-grid` (assignee; separator keys Enter and comma; at most `MAX_FILTER_VALUES` chips), organization and
  search inputs bound to the drafts (`[value]`, `(input)`, `(keydown.enter)`), `mat-date-range-input` labeled
  "Created (UTC)", and a "Clear filters" button; the bar wraps on narrow screens. The list component wires the store
  signals to inputs and the outputs to store actions. Empty-state copy: "No requests match these filters".
- [ ] **Step 4: Run** `npx ng test --watch=false`, `npx ng lint`, `npx ng build`, `npx prettier --check .` → all pass,
  0 warnings.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `09: Add the filter bar and the requests list page`

### Task 7: Manual check on the seeded database and PR

- [ ] **Step 1: Sync** inside `frontend/`: `git fetch origin`, `git merge origin/main`.
- [ ] **Step 2: Run the stack.** In `backend/`: `docker compose up -d`,
  `dotnet run --project src/RequestTracker.Api -- seed`, `dotnet run --project src/RequestTracker.Api`. In
  `frontend/`: `npx ng serve` (it proxies `/api` to `localhost:5100`).
- [ ] **Step 3: Check in the browser's network panel** and note each result for the PR: one request after typing stops,
  in search and in organization; Enter sends at once; status, chips, dates, sort and page request immediately; a
  pending request shows as cancelled when a newer query starts; `sort` params repeat in header-number order; refresh
  and a pasted link restore the view; a hand-edited invalid URL is rewritten; stopping the API shows the error state,
  and Retry recovers after it restarts.
- [ ] **Step 4: Verify** `npx ng test --watch=false`, `npx ng lint`, `npx ng build`, `npx prettier --check .`, then run
  `/code-review`.
- [ ] **Step 5: Push and open the PR** in `request-tracker-client`, after the developer approves the commits. Title
  `09: List UI with search, filters, multi-column sort and paging`. Description: what was done; the Step 3 results;
  deviations (organization is debounced too; the URL holds the state; a broken link is normalized rather than an
  error); the files ready to register as reference implementations; shared files touched (none expected).

---

## Revision 1: PrimeNG and an assignee checklist

Requested after the manual check (developer's decisions): the UI moves from Angular Material to **PrimeNG**, everywhere,
for a modern look; the assignee filter becomes a **checklist** fed by a new endpoint. Everything in the Design above
still holds unless this section changes it.

### Design changes

**UI library (developer's decision).** PrimeNG `22.1.x` with the Aura theme (`@primeuix/themes`) and `primeicons`,
configured once in `app.config.ts` with `providePrimeNG({ theme: { preset: Aura } })` and `provideAnimationsAsync()`
if PrimeNG needs it. `@angular/material` is removed from `package.json`; `@angular/cdk` stays (PrimeNG peer). `styles.scss`
drops the Material theme. CLAUDE.md's stack line becomes "PrimeNG (Aura theme)", and later tasks (14–16) use PrimeNG.

| Part | Material today | PrimeNG |
|---|---|---|
| App header | `mat-toolbar` | `p-toolbar` with the app name |
| Text filters | `matInput` | `pInputText` inside `p-iconfield` (search icon on Search) |
| Status, priority | `mat-select multiple` | `p-multiselect`, checkboxes, `display="chip"` |
| Assignees | `mat-chip-grid` (typed names) | `p-multiselect` checklist with a filter box, options from the API |
| Created range | `mat-date-range-input` | `p-datepicker selectionMode="range"`, `dateFormat="yy-mm-dd"`, `showIcon`, `showButtonBar` |
| Buttons | `mat-button` | `p-button` (Clear filters: outlined; Reset sorting: text, small) |
| Table | `mat-table` | `p-table` (striped, small size, sticky header) with the **existing** custom sort header buttons; PrimeNG's own sort is not used, because its multi-sort needs Ctrl-click and doesn't match the agreed click cycle |
| Status / priority cells | text | `p-tag` with a severity per value (*my call*: New info, InProgress warn, Waiting secondary, Completed success; High danger, Medium warn, Low secondary) |
| Paginator | `mat-paginator` | `p-paginator` (`rows`, `first = (page - 1) * pageSize`, `totalRecords`, rows-per-page options 10/20/50/100, `showCurrentPageReport`) |
| Loading | `mat-progress-bar` | `p-progressbar mode="indeterminate"`, 4 px slot |
| Empty / error | text + buttons | `p-message` (info / error) with the same buttons |

Behavior stays as agreed (URL state, debounce, drafts, multi-sort cycle, page reset, states). The paginator's displayed
page is still driven from the store (finding 1 of the final review). The design's "Assignee chips" rules are replaced:

**Assignee checklist (developer's decision).** A `p-multiselect` lists the names from `GET api/requests/assignees`, with
checkboxes, a filter box and "select all" hidden (the 50-value cap). Checking or unchecking emits the full selection,
which the store applies with `setFilters({ assignedTo })` like status and priority; `addAssignee` / `removeAssignee`
and the chip intents are removed (the multiselect owns its selection, so the lag the intents fixed doesn't arise). A
URL name that isn't in the list still filters and shows as selected (*my call*: the option list is the API's names plus
any selected ones). If the names fail to load, the checklist shows an empty "Couldn't load assignees" state; the list
itself still works.

**Assignees endpoint (developer's decision).** `GET api/requests/assignees` → 200 `string[]`: the distinct `AssignedTo`
values, sorted ascending, computed in the database (`Select(r => r.AssignedTo).Distinct().OrderBy(...)`; the
`IX_Requests_AssignedTo_CreatedAt` index serves it). Not paged: the set is small by nature (40 in the seed), and
*my call* is to cap it at 1,000 names as a safety limit. Not cached (no invalidation strategy needed). Controller
action `GetAssignees`, service `GetAssigneesAsync`, repository `GetAssigneesAsync`, all with a `CancellationToken`.
The API contract table in CLAUDE.md gets a row. The store loads the names once when it starts.

**Repositories.** The endpoint lives in `request-tracker-server` on branch `feature/09-list-ui` (same name as the
client branch, PRs linked); the client PR merges after the server PR.

### Task R1: Assignees endpoint (server) — written by the developer

The developer implements this task in `request-tracker-server`. The client tasks code against the contract above
(`GET api/requests/assignees` → 200 `string[]`, distinct, sorted) with fake HTTP in tests, and the manual check (R5)
runs once the server branch is available. The notes below are guidance only.

**Files** (relative to `backend/`): modify `Core/Abstractions/IRequestRepository.cs`, `Core/Services/IRequestService.cs`,
`Core/Services/RequestService.cs`, `Infrastructure/Repositories/RequestRepository.cs`, `Api/Controllers/RequestsController.cs`;
test `tests/RequestTracker.IntegrationTests/Requests/RequestsAssigneesTests.cs`.

- Produces: `Task<IReadOnlyList<string>> GetAssigneesAsync(CancellationToken cancellationToken)` on the repository and
  the service; `RequestsController.GetAssignees(CancellationToken)` → 200 `IReadOnlyList<string>`, route `assignees`,
  declared before `{id}` routes. Constant `MaxAssignees = 1000`.
- Tests: `GetAssignees_RowsWithRepeatedNames_ReturnsDistinctSortedNames` (insert rows under a GUID prefix with assignees
  named after it; assert the response contains them once each, in order — the shared test DB has other rows, so assert
  on the subset); `GetAssignees_Always_Returns200Json`.
- Branch in `backend/`: `git fetch origin`, `git switch -c feature/09-list-ui origin/main`. Commit: stop, show, ask.

### Task R2: PrimeNG setup and app shell (client)

- `npm install primeng@22 @primeuix/themes primeicons`, `npm uninstall @angular/material`. Configure `app.config.ts`,
  `styles.scss` (primeicons CSS, Aura, base font, page background), `app.component.ts` → `p-toolbar`.
- Models/API: `RequestsApiService.getAssignees(): Observable<string[]>` (`GET /api/requests/assignees`) with a test.
- Update `app.component.spec.ts`. `ng build`, `ng test`, `ng lint` green (other components may still fail to compile
  until R3/R4 — do R2–R4 on one working tree and run the suite at the end of R4).

### Task R3: Table and list page in PrimeNG (client)

- `requests-table`: `p-table` + existing sort header buttons (same outputs, same aria labels), `p-tag` cells.
- `requests-list`: `p-progressbar`, `p-message` empty/error, `p-paginator` driven from the store
  (`paginatorPage_CallsSetPage`, `paginatorNext_DuringPendingDraft_ShowsFirstPage` keep their meaning).
- Rewrite the specs' Material-harness queries to DOM/PrimeNG queries; keep every test name and assertion meaning.

### Task R4: Filter bar in PrimeNG with the assignee checklist (client)

- Store: `assignees: Signal<string[]>` and `assigneesError: Signal<boolean>` loaded once on init; remove
  `addAssignee` / `removeAssignee` (and their tests); `setFilters` accepts `assignedTo` again (`ImmediateFilters`
  includes it).
- Filter bar: `p-multiselect` for status, priority and assignees (checklist, filter, no select-all, `selectionLimit`
  50), `p-datepicker` range (emit `createdFrom`/`createdTo` only when the range is complete or cleared — this also
  fixes deferred finding 5), `pInputText` drafts with Enter, `p-button` Clear filters. New input `assignees: string[]`.
- Tests: `assigneeChecklist_Check_EmitsFullSelection`, `assigneeChecklist_UrlNameNotInList_ShowsAsSelected`,
  `dateRange_CompleteRange_EmitsBothDatesOnce`, store `init_LoadsAssigneesOnce`, `init_AssigneesFail_ListStillLoads`.

### Task R5: Docs, manual check and PRs

- CLAUDE.md: stack line → PrimeNG; API contract row for `GET api/requests/assignees` (200 `string[]`).
- Manual check again on the seeded database (same table as before, plus the checklist and the date range), screenshots
  for the PR, once the developer's server branch is available. Server PR (developer's) first, then the client PR
  linking it.

## Revision 2: Design A in Angular Material (replaces Revision 1's UI)

The developer dropped PrimeNG (the licence needs a key that a public repository can't carry) and chose design "A"
from the design options, built in **Angular Material**. Revision 1 still holds for the assignee checklist and the
`GET api/requests/assignees` endpoint (merged on the server); its PrimeNG table and parts are void. Everything in the
Design above still holds unless this section changes it: URL state, debounce and drafts, the multi-sort cycle, page
reset, and the loading, empty and error states.

**Starting point.** A new branch `feature/09-material-ui` from client `main` (`d3e7924`, the Material list). The
PrimeNG branch `feature/09-primeng-ui` is not merged.

### Design A

Visual target: `.superpowers/sdd/09-list-ui/design-mockup.html`, section A only. M2–M4 compare a screenshot of the
real app against it in the browser pane.

- **One white card** (rounded, thin border, on a light gray page). The header has "Requests" with "N total" beneath it
  on the left, and the search box with a search icon on the right.
- **Filter chips row** below the header:
  - An active filter is a highlighted chip with a ✕ that clears that filter: "Status: New, Waiting ✕",
    "Assignee: 3 selected ✕", "Created: 2026-10-01 – 2026-10-26 ✕".
  - An inactive filter is an outlined "+ Status", "+ Priority", "+ Assignee", "+ Organization" or "+ Created" chip.
  - Clicking a chip opens a `mat-menu`:
    - status, priority and assignee: a checklist; the assignee checklist has a filter box and is capped at 50
    - created: a date-range picker
    - organization: a text box, debounced with Enter, as today (*my call*: the organization filter is required, and
      design A doesn't show it)
  - "Clear all" is a link at the right end. It appears only when a filter is active.
- **Table**:
  - Columns: ID (muted), Title (medium weight), Organization, Assignee (an initials circle and the name), Status,
    Priority, Created, Updated. *My call*: Updated stays, because it is a sort field in the contract.
  - Sorting uses our own sort header buttons, with the arrow and level number. "Reset sorting" is a small text button
    above the table on the right.
- **Pills**: a small shared presentational component `app-status-pill` in `shared/`, with a soft background and coloured
  text:

  | Value | Colour |
  |---|---|
  | New | blue |
  | InProgress | amber, label "In progress" |
  | Waiting | gray (*my call*: design A has no colour for Waiting) |
  | Completed | green |
  | High | red |
  | Medium | amber |
  | Low | gray |

- **Paginator**: `mat-paginator` at the bottom of the card, still driven from the store.
- **Stats slot**: a marked place above the table for the stats KPI cards. It renders nothing until the stats task adds
  them, with no placeholder.
- **Styling** uses Material 3 token overrides in `styles.scss`: `mat.table-overrides`, `mat.chips-overrides`, density,
  and the paginator and menu where needed. No `::ng-deep`. Component `.scss` files hold layout only.

### Task M1: Branch, assignees and store

- Branch: `git fetch origin`, `git switch -c feature/09-material-ui origin/main`.
- API: `RequestsApiService.getAssignees(): Observable<string[]>` with its test, the same as R2's.
- Store: R4's store changes:
  - `assignees` and `assigneesError` signals, loaded once on init
  - `setFilters` accepts `assignedTo`
  - remove `addAssignee` and `removeAssignee`
- Tests: `init_LoadsAssigneesOnce`, `init_AssigneesFail_ListStillLoads`.

### Task M2: Theme, card and table

- The `styles.scss` token overrides, the page background and the card.
- `app-status-pill`, with a test per value: `render_EachValue_ShowsLabelAndColourClass`.
- Table: assignee initials, pills, muted ID. `requests-list`: the header with the total, the stats slot, and the
  paginator inside the card. All existing table and list tests keep their names and meaning.

### Task M3: Filter chips

- Rewrite the filter bar as the chip row with menus. The outputs stay the same, except that assignees emit the full
  selection.
- Tests:
  - `assigneeChecklist_Check_EmitsFullSelection`
  - `assigneeChecklist_UrlNameNotInList_ShowsAsSelected`
  - `dateRange_CompleteRange_EmitsBothDatesOnce`
  - `activeChip_Remove_ClearsThatFilter`
  - `clearAll_NoActiveFilter_IsHidden`
- The existing draft, Enter and debounce tests keep their meaning.

### Task M4: Docs, manual check and PR

- Screenshot of the real app (seeded DB) before moving on.
- Manual check table again, plus the checklist, the date range and chip removal.
- The client PR from `feature/09-material-ui`. Ask before pushing.
