# 08 List API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Never run `git commit` without the developer's explicit permission in the session.** Each "Commit" step means:
> stop, show what would be committed, and ask.

**Goal:** `GET api/requests` end to end (controller → service → repository → SQL Server): combined filters, text
search, stable sorting and server-side paging. These are the first-slice files that become reference implementations.

**Architecture:** `RequestsController.GetPaged` binds `RequestQueryParameters` from the query string and calls
`IRequestService.GetPagedAsync`. The service validates the parameters with FluentValidation and calls
`IRequestRepository.GetPagedAsync`, which builds one `IQueryable`: filter → count → sort → page → project to
`RequestDto`, all translated to SQL.

**Tech Stack:** .NET 10, ASP.NET Core controllers, EF Core 10 (SQL Server), FluentValidation, xUnit,
`WebApplicationFactory` + Testcontainers (existing host from tasks 04–05). No new packages.

**Spec:** `docs/PLAN.md` → task 08 and US-2.1; `CLAUDE.md` (API contract, Layer responsibilities, DTOs & mapping,
Validation, Database → Indexes); `docs/code-patterns.md` → Controller, Repository. The design agreed for this task is
the next section.

## Design (agreed with the developer)

> **Changed after Tasks 1–3 were implemented (developer's decision):** selection filters take several values, and
> sorting takes several fields over every field (`sort=field:dir`, replacing `sortBy` / `sortDirection`). This section
> describes the current design; the task steps below record the first version as it was built, and the code and
> tests follow this section.

**Dependencies:** task 05 is merged. Task 06 (seeder) is needed only for Task 4 (the manual SQL check on 100,000 rows)
and must be merged before this PR merges. Tasks 1–3 run on an empty database.

**Delivers** (branch `feature/08-list-api` in `request-tracker-server`, i.e. inside `backend/`):

- `GET api/requests` exactly as in the `CLAUDE.md` API contract. Response `PagedResult<RequestDto>` =
  `{ items, page, pageSize, totalCount }`. `RequestDto` has every entity field, including `version` (base64), because
  bulk update (task 11) sends `{ id, version }` for rows picked from this list.
- Not in this task: `GET api/requests/{id}` (task 10), any schema change (task 17).

**Parameters and validation:**

- Defaults: `page=1`, `pageSize=20`, sort `createdAt:desc`.
- Invalid values return 400 with `errors`, never silently corrected: `page` outside 1–21,474,836 (keeps the row
  offset within `int`), `pageSize` outside 1–100, `createdFrom > createdTo`, `createdTo = 9999-12-31`, text filters
  longer than their column, undefined enum values, more than 50 values in one selection filter (*my call*: each value
  is one SQL parameter), an invalid or repeated sort field.
- **Enums use ASP.NET's default query binding (developer's decision).** Names are accepted case-insensitively, and so
  are numbers that match a defined value (`status=3` = `Completed`). Undefined values (`status=99`) are 400. No custom
  model binder. The PR notes the difference from the JSON body, which rejects numbers. Sort fields are names only.
- **Dates are plain dates in UTC, both ends included (developer's decision).** `createdFrom` / `createdTo` are
  `DateOnly`. The filter is `CreatedAt >= createdFrom 00:00Z` and `CreatedAt < (createdTo + 1 day) 00:00Z`, so the
  whole last day counts. No time-zone handling; the PR records it as a known limitation for the README (task 19).

**Query rules:**

- Every filter is optional and independent: a filter that isn't sent doesn't filter, and the ones sent combine with
  AND.
- **Selection filters take several values (developer's decision):** `status`, `priority` and `assignedTo` accept a
  repeated key (`status=New&status=InProgress`). Values of one filter combine with OR (SQL `IN`). `assignedTo` is an
  exact match on each value (served by its index; *my call*, the docs don't say).
- `organizationName`: prefix match (`StartsWith`, sargable). `search`: substring match on `Title` or
  `OrganizationName` only (developer's decision: `AssignedTo` is a selection filter, not searched). Blank or
  whitespace strings mean "no filter".
- `%`, `_` and `[` in `search` / `organizationName` match literally (*my call*). EF Core 10 escapes them in the LIKE
  parameter (`LIKE … ESCAPE N'\'`); a test proves it.
- **Sorting by several fields, by every field (developer's decision):** a repeated `sort` key, each value
  `field[:asc|desc]`, applied in order: `sort=priority:desc&sort=createdAt:asc` → `ORDER BY Priority DESC,
  CreatedAt ASC, Id ASC`. Fields: `id`, `title`, `organizationName`, `status`, `priority`, `assignedTo`, `createdAt`,
  `updatedAt`, case-insensitive. The direction defaults to `asc` (*my call*). No limit on the number of fields
  (developer's decision); a field may appear only once. This replaces the contract's `sortBy` / `sortDirection`.
- Every order ends with `Id` (unless `id` is already a sort field), in the last field's direction, so equal values
  keep one order across pages and a single descending sort reads its index backward without a sort step (*my call*).
- When the last sort field is `status`, `priority` or `assignedTo` and `createdAt` isn't a sort field, ties are
  ordered by `createdAt` before `Id`, in the same direction (*my call*). Their indexes are `(Field, CreatedAt)`, so
  `sort=status` then reads `IX_Requests_Status_CreatedAt` in order; ordering by `(Field, Id)` scanned the table and
  sorted it (measured on the seeded data).
- Single sorts on `createdAt`, `status`, `priority`, `assignedTo`, `organizationName` or `id` read their index in
  order. `title`, `updatedAt`, mixed directions and most multi-field combinations get a Sort step, still in SQL.

- Order filter → count → sort → page → project. This isn't only convention: the count must see the filters and not
  the paging, and `OFFSET … FETCH` needs an `ORDER BY`. Considered and rejected: `COUNT(*) OVER()` in one query (still
  counts the whole filtered set, and a page past the end returns no count) and keyset paging (the contract uses page
  numbers, and the paginator jumps to any page). The deep-page cost of `OFFSET` is a measurement point for task 17.
- A page past the end returns 200 with empty `items` and the real `totalCount` (*my call*).
- The count and the page are separate statements, so an update committed between them can make `totalCount` differ
  from the rows (developer's decision: known limitation). A consistent read needs snapshot isolation, a database
  setting and so a migration; it is left to task 17. Stricter isolation would block writers, and `COUNT(*) OVER()`
  reads every filtered row.

**How it is checked:**

- Unit tests for the validator.
- Integration tests on the existing Testcontainers host. All test classes share one database, so each test inserts its
  rows under its own `organizationName` prefix (a fresh GUID) and filters on it. That keeps `totalCount` exact and
  exercises the prefix filter in every test.
- **SQL proof is a manual check recorded in the PR (developer's decision),** not a test on SQL text: on the seeded
  database, the logged SQL and the actual query plan of a few typical queries. EF Core throws on anything it can't
  translate, so nothing can silently run in memory.

**Calls made while planning (check these):**

- File placement in Core: response DTOs in `Dtos/`, input models and their enums in `Models/`, validator in
  `Validation/`, repository interface in `Abstractions/`, service and its interface in `Services/`.
- Validator registration: by hand in `AddCore()` (one line), not the `FluentValidation.DependencyInjectionExtensions`
  package. Task 04 left this decision to the first task with a validator.
- No service unit test: the service only validates and delegates; the validator unit tests and the integration tests
  cover both paths.

## Global Constraints

- No packages from the `CLAUDE.md` "Not allowed" list, and no new packages at all.
- File-scoped namespaces matching the folder, one public type per file, primary constructors for DI, DTOs and input
  models are `record`s. Comments explain why, not what.
- Layering: the controller has no logic or data access; the service has no HTTP types; the repository has no
  validation. Every I/O call takes and passes on the `CancellationToken`.
- `pageSize` maximum is exactly 100, default 20; `page` default 1. Sort values: `createdAt`, `updatedAt`, `priority`,
  `title`; directions `asc`, `desc` (default `desc`).
- No filtering, sorting, paging or counting in memory: no `ToList`/`AsEnumerable` before `Skip`/`Take`.
- Tests named `MethodName_Scenario_ExpectedResult`, Arrange / Act / Assert separated by a blank line, no mocking
  library, no FluentAssertions.
- Work inside `backend/`: `git fetch origin`, `git switch -c feature/08-list-api origin/main` before any change. Never
  commit on the detached `HEAD`. No submodule pointer change in the main repository.

## Review Focus

1. **Error keys for query parameters** — the client reads `errors.pageSize` and `errors.sortBy`, whether the error comes
   from the validator or from model binding (`sortBy=banana` fails in binding, before the validator runs). The two
   sources must produce the same camelCase key. → Task 2, `GetPaged_InvalidParameter_Returns400WithFieldError`.
2. **Many rows with the same sort value** — paging through them must return every row exactly once.
   → Task 3, `GetPaged_EqualSortValues_EveryRowAppearsOnExactlyOnePage`.
3. **Wildcard characters typed by the user** — `search=50%` must not match `500`. → Task 2,
   `GetPaged_SearchWithWildcardCharacter_MatchesLiterally`.
4. **The last day of a date range** — a request created at 23:59 on `createdTo` is included. → Task 2,
   `GetPaged_CreatedTo_IncludesWholeLastDay`.
5. **Blank filter values** — `assignedTo=` or `search=%20` from an emptied text box means no filter, not "equals
   empty". → Task 2, `GetPaged_BlankTextFilters_AreIgnored`.

---

### Task 1: Query parameters and validator

**Files** (all paths relative to `backend/`):
- Create: `src/RequestTracker.Core/Models/RequestQueryParameters.cs`, `Models/RequestSortField.cs`,
  `Models/SortDirection.cs`
- Create: `src/RequestTracker.Core/Validation/RequestQueryParametersValidator.cs`
- Modify: `src/RequestTracker.Core/DependencyInjection.cs`
- Test: `tests/RequestTracker.UnitTests/Validation/RequestQueryParametersValidatorTests.cs`

**Interfaces:**
- Produces: `enum RequestSortField { CreatedAt = 0, UpdatedAt = 1, Priority = 2, Title = 3 }` and
  `enum SortDirection { Asc = 0, Desc = 1 }` (explicit values, like the domain enums).
- Produces: `record RequestQueryParameters` with `init` properties and defaults (not positional — see
  `docs/code-patterns.md` → Controller): `int Page = 1`, `int PageSize = 20`, `RequestStatus? Status`,
  `RequestPriority? Priority`, `string? OrganizationName`, `string? AssignedTo`, `DateOnly? CreatedFrom`,
  `DateOnly? CreatedTo`, `string? Search`, `RequestSortField SortBy = CreatedAt`, `SortDirection SortDirection = Desc`.
  Constants `DefaultPageSize = 20`, `MaxPageSize = 100`.
- Produces: `RequestQueryParametersValidator : AbstractValidator<RequestQueryParameters>`, registered in `AddCore()` as
  `IValidator<RequestQueryParameters>`, scoped.

- [ ] **Step 1: Create the branch** inside `backend/` (see Global Constraints).
- [ ] **Step 2: Write the failing tests** in `RequestQueryParametersValidatorTests`:
  - `Validate_Defaults_IsValid` — `new RequestQueryParameters()` has no errors.
  - `Validate_PageBelowOne_HasPageError` — `Page = 0` → error on `Page`.
  - `Validate_PageSizeOutOfRange_HasPageSizeError` — theory `0`, `101` → error on `PageSize`.
  - `Validate_PageSizeAtMaximum_IsValid` — `PageSize = 100`.
  - `Validate_CreatedFromAfterCreatedTo_HasCreatedFromError` — `2026-02-01` / `2026-01-31` → error on `CreatedFrom`.
  - `Validate_CreatedFromEqualsCreatedTo_IsValid` — the same day.
  - `Validate_UndefinedEnumValue_HasError` — `(RequestStatus)99`, `(RequestPriority)99`, `(RequestSortField)99`,
    `(SortDirection)99`, each → error on its property.
  - `Validate_TextOverColumnLength_HasError` — `OrganizationName` and `Search` of `Request.OrganizationNameMaxLength + 1`
    characters, `AssignedTo` of `Request.AssignedToMaxLength + 1` → error on that property.
- [ ] **Step 3: Run** `dotnet test tests/RequestTracker.UnitTests` → fails to compile (types don't exist).
- [ ] **Step 4: Implement** the enums, the record and the validator. Length limits reuse the constants on `Request`
  (`Search` uses `Request.OrganizationNameMaxLength`, the longer of its two columns, which equals
  `TitleMaxLength`). Date rule: `CreatedFrom <= CreatedTo` when both are set, error on `CreatedFrom`. Register in
  `AddCore()`.
- [ ] **Step 5: Run** `dotnet test tests/RequestTracker.UnitTests` → all pass.
- [ ] **Step 6: Commit** — stop, show, ask. Proposed: `08: Add list query parameters and their validator`

### Task 2: List endpoint with filters, search and paging

**Files:**
- Create: `src/RequestTracker.Core/Dtos/RequestDto.cs`, `Dtos/PagedResult.cs`
- Create: `src/RequestTracker.Core/Mapping/RequestMapping.cs`
- Create: `src/RequestTracker.Core/Abstractions/IRequestRepository.cs`
- Create: `src/RequestTracker.Core/Services/IRequestService.cs`, `Services/RequestService.cs`
- Create: `src/RequestTracker.Infrastructure/Repositories/RequestRepository.cs`
- Create: `src/RequestTracker.Api/Controllers/RequestsController.cs`
- Modify: `src/RequestTracker.Core/DependencyInjection.cs`, `src/RequestTracker.Infrastructure/DependencyInjection.cs`
- Test: `tests/RequestTracker.IntegrationTests/Requests/RequestsListTests.cs`,
  `tests/RequestTracker.IntegrationTests/Requests/TestRequests.cs`

**Interfaces:**
- Consumes: `RequestQueryParameters`, `IValidator<RequestQueryParameters>` (Task 1).
- Produces: `record RequestDto(int Id, string Title, string OrganizationName, RequestStatus Status,
  RequestPriority Priority, string AssignedTo, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, byte[] Version)`.
- Produces: `record PagedResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int TotalCount)`.
- Produces: `static class RequestMapping` with `static readonly Expression<Func<Request, RequestDto>> ToDto`.
- Produces: `IRequestRepository.GetPagedAsync(RequestQueryParameters parameters, CancellationToken cancellationToken)
  : Task<PagedResult<RequestDto>>`, implemented by `RequestRepository(RequestTrackerDbContext db)`, scoped.
- Produces: `IRequestService.GetPagedAsync(RequestQueryParameters parameters, CancellationToken cancellationToken)
  : Task<PagedResult<RequestDto>>`, implemented by
  `RequestService(IRequestRepository repository, IValidator<RequestQueryParameters> validator)`, scoped.
- Produces: `RequestsController(IRequestService service)`, `[ApiController]`, `[Route("api/requests")]`; action
  `GetPaged([FromQuery] RequestQueryParameters parameters, CancellationToken cancellationToken)` → 200, with
  `[ProducesResponseType]` for 200 (`PagedResult<RequestDto>`) and 400 (`ValidationProblemDetails`).
- Produces (tests): `TestRequests.InsertAsync(ApiFactory factory, params Request[] requests)` and
  `TestRequests.New(string organizationName, ...)` with optional overrides for every field; tests use
  `var prefix = Guid.NewGuid().ToString("N")` and organization names starting with it.

- [ ] **Step 1: Write the failing integration tests** in `RequestsListTests` (`[Collection(ApiCollection.Name)]`).
  Each test inserts its own rows under `prefix` and always sends `organizationName={prefix}`:
  - `GetPaged_NoFilters_ReturnsDefaultPageNewestFirst` — 25 rows → `page=1`, `pageSize=20`, `totalCount=25`, 20 items
    in `createdAt` descending order; every item's `version` is a non-empty base64 string.
  - `GetPaged_CombinedFiltersAndPaging_ReturnsMatchingPageAndTotalCount` — rows mixing statuses, priorities, assignees
    and dates; `status`, `priority`, `assignedTo`, `createdFrom`, `createdTo`, `page=2`, `pageSize=2` → `totalCount`
    equals the number of matching rows, items are exactly the expected 3rd and 4th matches.
  - `GetPaged_OrganizationName_MatchesPrefixOnly` — rows `{prefix}-a` and `x{prefix}` → only the first.
  - `GetPaged_Search_MatchesTitleOrOrganizationName` — the search term in one row's title and inside another row's
    organization name (after the prefix) → both, and not a third row.
  - `GetPaged_SearchWithWildcardCharacter_MatchesLiterally` — titles `50% done` and `500 done`, `search=50%` → only
    the first.
  - `GetPaged_CreatedTo_IncludesWholeLastDay` — rows at `2026-01-31T23:59:00Z` and `2026-02-01T00:00:00Z`,
    `createdTo=2026-01-31` → only the first.
  - `GetPaged_BlankTextFilters_AreIgnored` — `assignedTo=` and `search=%20` → all of the test's rows.
  - `GetPaged_PageBeyondEnd_ReturnsEmptyItemsWithTotalCount` — 3 rows, `page=5` → 200, empty `items`, `totalCount=3`.
  - `GetPaged_InvalidParameter_Returns400WithFieldError` — theory, each through `ProblemAssert.IsProblemAsync(…, 400)`
    and asserting the camelCase key in `errors`: `page=0` → `page`; `pageSize=101` → `pageSize`; `status=99` →
    `status`; `sortBy=banana` → `sortBy`; `createdFrom=2026-02-01&createdTo=2026-01-31` → `createdFrom`.
- [ ] **Step 2: Run** `dotnet test tests/RequestTracker.IntegrationTests --filter RequestsListTests` → fails (404 or
  compile errors).
- [ ] **Step 3: Implement the DTOs, `RequestMapping`, interfaces, service and controller** as in Interfaces. The service
  calls `validator.ValidateAndThrowAsync(parameters, cancellationToken)` and then the repository. Register the service
  in `AddCore()` and the repository in `AddInfrastructure()`.
- [ ] **Step 4: Implement `RequestRepository.GetPagedAsync`** with `AsNoTracking()` and filters per the Design. Order:
  filters → `CountAsync` → sort (the `createdAt` row of the Design table for now; Task 3 adds the rest) → `Skip`/`Take`
  → `Select(RequestMapping.ToDto)` → `ToListAsync`. Dates: `createdFrom` →
  `new DateTimeOffset(createdFrom.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero)`, `createdTo` → the same of
  `createdTo.AddDays(1)` with `<`.
- [ ] **Step 5: Run the tests** → all pass. If the wildcard test fails, escape `%`, `_`, `[` in the repository and
  use `EF.Functions.Like(…, …, "\\")`. If a 400 test fails only on the key spelling, align the model-binding key with
  the validator's (camelCase) in the controller or `Program.cs`, and say which in the PR.
- [ ] **Step 6: Run** `dotnet test` (whole solution) → all pass.
- [ ] **Step 7: Commit** — stop, show, ask. Proposed: `08: Add GET api/requests with filters, search and paging`

### Task 3: Sorting with a stable order

**Files:**
- Modify: `src/RequestTracker.Infrastructure/Repositories/RequestRepository.cs`
- Test: `tests/RequestTracker.IntegrationTests/Requests/RequestsListTests.cs`

**Interfaces:**
- Consumes: `RequestRepository.GetPagedAsync` (Task 2), `RequestSortField`, `SortDirection` (Task 1).

- [ ] **Step 1: Write the failing tests:**
  - `GetPaged_SortByEachField_OrdersByThatField` — theory over `createdAt`, `updatedAt`, `priority`, `title` × `asc`,
    `desc`; rows with distinct values → items in the expected order.
  - `GetPaged_SortByPriority_OrdersByCreatedAtWithinPriority` — several rows of the same priority with different
    `createdAt`, `sortBy=priority&sortDirection=desc` → within the priority, newest first.
  - `GetPaged_EqualSortValues_EveryRowAppearsOnExactlyOnePage` — 7 rows with identical `createdAt` and `title`,
    `pageSize=3`, pages 1–3 for both `sortBy=createdAt` and `sortBy=title` → the union of the ids is all 7, with no
    duplicates.
- [ ] **Step 2: Run** the tests → the sort-field cases fail (everything still sorts by `createdAt`).
- [ ] **Step 3: Implement** the sort `switch` per the Design table: the first key with `OrderBy`/`OrderByDescending`,
  the tiebreakers with `ThenBy`/`ThenByDescending` in the same direction. One private method, so the paging code
  doesn't change.
- [ ] **Step 4: Run** `dotnet test` → all pass.
- [ ] **Step 5: Commit** — stop, show, ask. Proposed: `08: Sort the request list by any contract field with a stable
  order`

### Task 4: SQL check on the seeded database and PR

Needs task 06 merged. Sync first: `git fetch origin`, `git merge origin/main`.

- [ ] **Step 1: Seed and run.** `docker compose up -d`, `dotnet run --project src/RequestTracker.Api -- seed`, then
  `dotnet run --project src/RequestTracker.Api`. EF Core logs every executed command at Information
  (`Microsoft.EntityFrameworkCore.Database.Command`).
- [ ] **Step 2: Run these queries through Swagger UI** and copy the logged SQL of each: default list; `status=New`;
  `sortBy=priority&sortDirection=desc`; `search=<common word>`; `organizationName=<prefix>`; `page=4000`.
  Expected for each: a `COUNT` with the filters and no paging, and a page query with the filters, the full
  `ORDER BY … Id`, and `OFFSET … FETCH`.
- [ ] **Step 3: Get the actual plan** of each page query (SSMS "Include Actual Execution Plan", or `SET STATISTICS XML
  ON` in `sqlcmd`). Note per query: seek or scan, which index, whether a Sort operator appears, and elapsed time.
  Expected: the default list and `status` / `priority` queries use their `…_CreatedAt` index without a Sort; `search`
  scans (the documented bottleneck).
- [ ] **Step 4: Verify** `dotnet build` (0 warnings) and `dotnet test` (all pass), then run `/code-review`.
- [ ] **Step 5: Push and open the PR** in `request-tracker-server`, after the developer approves the commits. Title
  `08: List API with paging, filters, search and sort`. Description: what was done; the SQL and plan notes from
  Steps 2–3 (input for task 17); deviations; known limitations for the README (UTC dates, query enums accept matching
  numbers, `search` scans); shared files touched (`AddCore`, `AddInfrastructure`, and `Program.cs` if Task 2 Step 5
  needed it).
