# Request Tracker — Project Conventions

Full-stack exam project: a system for managing requests from organizations (100k+ records, multiple concurrent users).
Many tasks run in parallel sessions, so code must stay consistent across sessions. The goal is consistent, maintainable
code with sound engineering decisions — not mechanical adherence to a template.

Grading reminders (they shape every decision):
- No filtering, sorting or paging on the client. Ever.
- Concurrency must be enforced on the server/DB, not only in the UI.
- Every cache entry has an invalidation strategy.
- Over-engineering is penalized. Simple, correct, justified beats clever.

## How to use this file

- **Mandatory constraints** (next section) are architectural rules. Do not bypass them. If correctness requires
  changing one, stop and flag the conflict (in the session and in the PR description) instead of working around it.
- **Everything else in this file is a default.** Follow it unless the specific use case needs something else; then
  adapt it and briefly explain why (PR description, or a short comment where the code would otherwise surprise a reader).
- **Reference implementations** (below) show how the conventions look in real code. Read the relevant one before
  implementing or modifying a layer.
- If this file, a reference file and existing code disagree, do not silently treat any of them as correct. Flag the
  conflict and resolve it explicitly — fix the code or update this file, in a dedicated change.
- Implementation notes that explain non-obvious choices in the reference code: @docs/code-patterns.md
- **Tasks are referred to by number.** "Task 10", "do 10" or "10" means task 10 in `docs/PLAN.md`. Before starting,
  read its task board row (dependencies, track), its task section and its user story's acceptance criteria; don't ask
  for the requirements to be pasted. If its dependencies aren't merged yet, say so before starting.

## Mandatory constraints

1. **Layering**: Api → Core ← Infrastructure (Api also references Infrastructure for DI only). Controllers contain no
   business logic or data access. Services contain no HTTP types. Repositories contain no business rules, caching or HTTP concerns.
2. **Server-side data operations**: filtering, sorting, paging and aggregation run in the database. Never load a full
   set into memory or send it to the client for that purpose. Page size is always limited.
3. **DTOs at the boundary**: the API never returns DB entities.
4. **Async I/O**: all I/O is async end to end and accepts and propagates a `CancellationToken`.
5. **Concurrency**: status updates are conditional on the client's `version`, enforced by the database, so lost updates
   are impossible. `UpdatedAt` and `Version` change together on every successful update.
6. **Audit**: every status change writes an audit row in the same transaction as the change.
7. **Cache consistency**: any write that affects cached data invalidates that cache entry.
8. **Error contract**: every error response is ProblemDetails with the status semantics in "Error responses" below.
9. **Status transitions** are defined in exactly one place (`Core/Domain/StatusTransitions.cs`), implementing the
   matrix in `docs/PLAN.md` → Status transitions.
10. **Logging**: no sensitive data (request bodies, `changedBy` values, full DTOs) in logs.

## Reference implementations

**Status: none registered yet.** The paths below are where the first slice (`GET api/requests`) is expected to put
them. Each row becomes a reference only after review (see "Registering" below). Until then, follow the rules in this file.

| Layer | Reference file | Reviewed |
|---|---|---|
| Controller | `backend/src/RequestTracker.Api/Controllers/RequestsController.cs` | pending |
| Service | `backend/src/RequestTracker.Core/Services/RequestService.cs` | pending |
| Repository | `backend/src/RequestTracker.Infrastructure/Repositories/RequestRepository.cs` | pending |
| Angular API service | `frontend/src/app/core/api/requests-api.service.ts` | pending |
| Angular store | `frontend/src/app/features/requests/requests.store.ts` | pending |
| Angular component | `frontend/src/app/features/requests/requests-list/requests-list.component.ts` | pending |
| Integration test | first integration test class (path set when registered) | pending |

**Registering.** Prefer files from the same feature so the references show one complete flow. A file is registered
only after it has been reviewed: `/code-review` passed and the developer reviewed it. Then put its actual path in the
table and replace `pending` with the commit hash.

**What to follow from a reference:** naming, separation of responsibilities between layers, how errors and outcomes
are signaled, async/cancellation handling, DI style, DTO mapping, and file placement.

**What not to copy:** feature-specific logic — filters, sort fields, validation rules, business rules — into unrelated
features. A reference is guidance, not a rigid template: correctness and the requirements of the use case come first.
When its pattern doesn't fit, adapt it and explain why.

**Keeping references current.** Renaming or moving a reference file updates this table in the same change. Changing a
convention updates the reference file and this file together. A reference that conflicts with the rules here is
flagged and resolved explicitly, never silently followed or silently ignored.

## Stack

- Backend: .NET 10, ASP.NET Core **controllers** (not minimal APIs), C# with nullable enabled.
- Frontend: Angular 22, standalone components, Signals + RxJS interop, Angular Material.
- Database: SQL Server 2022 (Developer, in Docker) via EF Core 10 — details in "Database" below.
- Tests: xUnit, `WebApplicationFactory` for integration tests.

`dotnet-ef` is a local tool (`.config/dotnet-tools.json`), not a package.
**Not allowed:** AutoMapper, MediatR, FluentAssertions, NgRx, any repository/unit-of-work generic base classes.

## Repository layout

Three repositories: this main repository includes `request-tracker-server` and `request-tracker-client` as submodules
that track `main`. A workflow keeps both pointers at their latest `main` (see `docs/PLAN.md` → Repositories). Paths in
this file are relative to the main repository.

```
backend/                            submodule → request-tracker-server
  RequestTracker.sln
  src/
    RequestTracker.Api/             controllers, middleware, Program.cs, DI composition
    RequestTracker.Core/            entities, enums, DTOs, service interfaces + services, validators, exceptions
    RequestTracker.Infrastructure/  DB context/config, repositories, data seeder
  tests/
    RequestTracker.UnitTests/
    RequestTracker.IntegrationTests/
frontend/                           submodule → request-tracker-client: Angular app
docs/
  code-patterns.md implementation notes for the reference code
  PLAN.md          work plan: features → tasks, dependencies, estimates (exam section 9)
  board.html       task board that reads and updates PLAN.md; serve it from the main folder: `node docs/board-server.mjs`
  plan/            per-task implementation plans (e.g. from superpowers:writing-plans), <task-id>-<short-name>.md
  PERFORMANCE.md   query plans, indexes, bottlenecks (exam section 6)
  AI_USAGE.md      where AI was used and what was checked/changed manually (exam section 11)
README.md          run instructions, decisions, alternatives, limitations (exam section 11)
```

When a task needs an implementation plan (`docs/PLAN.md` says which ones do), it is saved to `docs/plan/` — including
`superpowers:writing-plans` output — named after the task (`docs/plan/03-status-concurrency.md`), not to the skill's
default `docs/superpowers/plans/`. Smaller tasks are described in their PR.

## Backend conventions

### Code style
- File-scoped namespaces matching folder path. One public type per file, file named after the type.
- Primary constructors for DI in services, controllers and repositories.
- DTOs and request/response models are `record`s. Entities are classes.
- No `#region`. Comments explain *why*, not *what*.

### Naming
| Kind | Pattern | Example |
|---|---|---|
| Entity | singular noun | `Request`, `RequestStatusHistory` |
| Response DTO | `<Name>Dto` | `RequestDto`, `StatusHistoryDto`, `RequestStatsDto` |
| Input model | `<Action><Name>Request` | `UpdateStatusRequest`, `BulkUpdateStatusRequest` |
| Query params | `<Name>QueryParameters` | `RequestQueryParameters` |
| Service | `I<Name>Service` / `<Name>Service` | `IRequestService` |
| Repository | `I<Entity>Repository` / `<Entity>Repository` | `IRequestRepository` |
| Validator | `<Model>Validator` | `UpdateStatusRequestValidator` |
| Async method | suffix `Async` | `GetPagedAsync` |
| Controller action | verb + noun, no `Async` suffix | `GetPaged`, `UpdateStatus` |

### Layer responsibilities
- **Controller**: binds input, calls the service, and returns the HTTP response defined in "API contract". By default
  errors surface as exceptions handled globally, so actions need no try/catch.
- **Service (Core)**: business rules, validation, status transitions, audit, cache invalidation; depends on interfaces
  only. Method steps follow the use case — there is no fixed sequence — but these invariants hold: input is validated
  before any write, and cache invalidation happens only after a successful write.
- **Repository (Infrastructure)**: one repository per aggregate, interface in `Core/Abstractions/`, methods named for
  the use case (`GetPagedAsync`, `TryUpdateStatusAsync`) rather than generic CRUD. Reads return DTOs; a missing single
  item is `null`. Write outcomes that callers must branch on (e.g. updated / not found / conflict) are return values.
- Each project exposes one DI extension: `AddCore()`, `AddInfrastructure(IConfiguration)`. `Program.cs` calls these.

### DI lifetimes
- DB context, services, repositories, validators: **Scoped**.
- `HybridCache`, `TimeProvider`: **Singleton** (`TimeProvider.System`). Never inject a scoped service into a singleton.

### Time
- Inject `TimeProvider`; don't call `DateTime.Now`/`UtcNow` directly. All timestamps are UTC (`DateTimeOffset`).

### DTOs & mapping
- Mapping is manual: one `<Entity>Mapping` static class per entity in `Core/Mapping/`, exposing an
  `Expression<Func<TEntity, TDto>>` used inside queries, so reads project to DTOs in the database.

### Validation
- Default: FluentValidation, one validator per input model in `Core/Validation/`, invoked by the service
  (`ValidateAndThrowAsync`) before any write.

### Error responses
All error responses are ProblemDetails (`AddProblemDetails()`) with these semantics (mandatory):

| Situation | Status |
|---|---|
| Invalid input | 400, with `errors` dictionary |
| Resource not found | 404 |
| Version conflict | 409 |
| Status transition not allowed | 422 |
| Unexpected error | 500, logged as Error, no internals in the response |

Default mechanism: in single-resource operations, services throw the domain exceptions in `Core/Exceptions/`
(`NotFoundException`, `ConcurrencyConflictException`, `InvalidStatusTransitionException`) or FluentValidation's
`ValidationException`, and one global `IExceptionHandler` maps them. Expected per-item outcomes — bulk results,
repository write outcomes — are return values, not exceptions; don't use exceptions for control flow inside loops.

### API contract
- Base route `api/requests`. JSON is camelCase; enums serialize as strings (`JsonStringEnumConverter`).

| Endpoint | Success response |
|---|---|
| `GET api/requests` — query: `page` (1-based, default 1), `pageSize` (default 20, max 100), `status`, `priority`, `organizationName`, `assignedTo`, `createdFrom`, `createdTo`, `search` (Title + OrganizationName), `sortBy` (`createdAt`, `updatedAt`, `priority`, `title`), `sortDirection` (`asc`/`desc`, default `desc`) | 200 `PagedResult<RequestDto>` = `{ items, page, pageSize, totalCount }` |
| `GET api/requests/{id}` | 200 `RequestDto` |
| `PATCH api/requests/{id}/status` — body `{ status, version, changedBy }` | 200 updated `RequestDto` (the client needs the new `version`) |
| `PATCH api/requests/status` — bulk, body `{ items: [{ id, version }], status, changedBy }`, 1–100 items, distinct ids, every item with a valid `id` and `version` | 200 with per-item results (see Concurrency); an invalid request as a whole (e.g. >100 items, a missing `version`) is 400 |
| `GET api/requests/{id}/history` — query: `page`, `pageSize` (same rules as the list) | 200 `PagedResult<StatusHistoryDto>`, newest first; 404 if the request doesn't exist |
| `GET api/requests/stats` | 200 `RequestStatsDto` (cached) |

New endpoints choose status codes by HTTP semantics (e.g. 201 + `Location` for creation, 204 when there is no
meaningful body) and are added to this table.

### Concurrency & audit
- The conditional update affects zero rows → 409, or 404 if the row doesn't exist.
- Audit row fields: `RequestId, PreviousStatus, NewStatus, ChangedAt, ChangedBy`.
- Bulk update: **Partial Success**. Each item is processed independently, with its own `version` check and
  transaction; the response lists
  `{ succeeded: [ids], failed: [{ id, reason: "NotFound" | "Conflict" | "InvalidTransition" }] }`.
  (A change to this decision is made here first.)

### Cache
- `HybridCache` directly, with no extra abstraction. Keys and tags are constants in `Core/Caching/CacheKeys.cs`.
- Cached: `stats` (expiration 5 minutes). Invalidated by tag on every successful status change, single or bulk.

### Logging
- `ILogger<T>` with message templates (`"Updated {RequestId}"`), not string interpolation.
- Log concurrency conflicts (Warning), bulk summaries (Information), unhandled exceptions (Error, in the handler only).

### Seeding
- `DataSeeder` in Infrastructure, deterministic (fixed random seed), idempotent: drops and recreates test data.
- Run with `dotnet run --project backend/src/RequestTracker.Api -- seed`. Inserts in batches, not row by row.

## Database — SQL Server

Chosen over PostgreSQL (comparable; considered alternative in README) and MongoDB (audit-in-transaction needs a replica
set; weaker EF Core support): native `rowversion`, plain transactions for audit, first-class execution plans.

### Provider and types
- SQL Server 2022, EF Core 10, provider `Microsoft.EntityFrameworkCore.SqlServer`.
- Default collation `SQL_Latin1_General_CP1_CI_AS` is case-insensitive: filters and search never call `ToLower()`
  (it makes predicates non-sargable).
- `Id` is `int` identity. Strings are `nvarchar(n)` with explicit max lengths (`nvarchar(max)` can't be an index key).
  Timestamps are `datetimeoffset`, always UTC.
- Enums are stored as `int`, so sorting by `priority` is semantic (Low < Medium < High) and runs in the DB.

### Concurrency token
- `Version` is a `rowversion` column (`byte[]`, `IsRowVersion()`). The DB changes it on every update, so no code path
  can forget to bump it.
- In DTOs it is `byte[]`, serialized as a base64 string. The frontend types it as `version: string` and treats it as opaque.

### Conditional update
`TryUpdateStatusAsync` in the repository, inside one explicit transaction (`BeginTransactionAsync`):
1. `Where(r => r.Id == id && r.Version == expectedVersion).ExecuteUpdateAsync(...)` sets `Status` and `UpdatedAt`;
   `Version` changes in the same statement.
2. 0 rows affected → `AnyAsync` on `Id` decides `NotFound` vs `Conflict`; nothing is written.
3. 1 row affected → insert the `RequestStatusHistory` row, commit, return `Updated`.

The service re-reads the DTO to return the new `version`. Bulk calls the same method per item, one transaction per item
(Partial Success).

### Migrations
- EF Core migrations live in Infrastructure; the startup project is Api.
- The `seed` command and Development startup run `Database.MigrateAsync()`, so running the app needs no manual
  `dotnet ef` step. Integration tests migrate the container DB the same way.

### Indexes
Initial set; validated or adjusted in the performance task, with results in `docs/PERFORMANCE.md`.

| Index | Serves |
|---|---|
| PK clustered `Requests(Id)` | get by id; `Id` tiebreaker |
| `IX_Requests_CreatedAt (CreatedAt)` | default sort `createdAt desc` + paging without a sort step (the clustered key `Id` is implicitly in the index = tiebreaker order) |
| `IX_Requests_Status_CreatedAt (Status, CreatedAt)` | `status` filter + default sort; stats `GROUP BY Status` |
| `IX_Requests_Priority_CreatedAt (Priority, CreatedAt)` | `priority` filter + default sort; stats `GROUP BY Priority` |
| `IX_Requests_AssignedTo_CreatedAt (AssignedTo, CreatedAt)` | `assignedTo` filter + default sort |
| `IX_Requests_OrganizationName (OrganizationName)` | `organizationName` filter — a **prefix** match (`StartsWith` → `LIKE 'x%'`, sargable) |
| `IX_RequestStatusHistory_RequestId_ChangedAt (RequestId, ChangedAt DESC)` | history endpoint, newest first |

Deliberately not indexed:
- `search` (`Contains` → `LIKE '%x%'`) can't seek and scans. This is the documented bottleneck; the proposed
  improvement is Full-Text Search (not included in the default Docker image).
- `UpdatedAt` and `Title` sorts sort the filtered set; add an index only if measurement shows a need. Leaving
  `UpdatedAt` unindexed also keeps status updates from maintaining an extra index.

### Tests and local run
- Testcontainers image: `mcr.microsoft.com/mssql/server:2022-latest` (needs Docker, about 2 GB RAM).
- Local run: SQL Server in Docker, connection string in `appsettings.Development.json` (dev-only password). How the
  container is started (e.g. a compose file) is decided in the run-setup task.

## Frontend conventions

### Structure
```
src/app/
  core/
    models/        *.model.ts — interfaces mirroring backend DTOs; enums as string union types
    api/           *-api.service.ts — the only place HttpClient is used
  features/
    requests/      list, details, history, stats components + requests.store.ts
  shared/          reusable presentational components and pipes
```

### Rules
- Standalone components, `ChangeDetectionStrategy.OnPush`, built-in control flow (`@if`, `@for`), `inject()`.
- Signal APIs: `input()`, `output()`, `computed()`. No `any`. Strict TypeScript.
- Components don't inject `HttpClient`. API services return `Observable`s and hold no state.
- Feature state lives in a store service using signals, provided at the feature route/component level.
- Search (spec requirement: debounce and cancel stale requests). Debounce only the free-text search (300 ms); filter,
  sort and page changes request immediately. Default pipeline: debounced search text combined with the other query
  values → `distinctUntilChanged` → `switchMap(api call)` → state signals, so a newer query cancels the pending one.
- Every data view handles loading, empty and error states (spec requirement). Default model: one
  `status: 'idle' | 'loading' | 'success' | 'error'` signal.
- 409 on status update: tell the user the request was modified by someone else and reload it.
- Subscriptions use `takeUntilDestroyed()`; prefer `toSignal`/async pipe over manual subscribe.

## Tests
- Naming: `MethodName_Scenario_ExpectedResult`. Arrange / Act / Assert separated by a blank line.
- Unit tests: services and `StatusTransitions`, with hand-written fakes.
- Integration tests: real API via `WebApplicationFactory` + real DB via Testcontainers.
- Required minimum: valid query/update, invalid input, concurrency conflict, one integration test.

## Branches & commits
- **No direct commits of code to `main`**, in any repository. Code reaches `main` only through a PR from a task branch.
  Exceptions, in the main repository only: documentation-only changes (`CLAUDE.md`, `docs/`, `README.md`) made by the
  coordinating session, and submodule pointer updates, which only the update workflow makes. Task PRs never change a
  submodule pointer.
- Branch in the repository the task changes (`docs/PLAN.md` → task board, Repo column). Sessions work in a checkout of
  the main repository: run `git submodule update --init`, then, inside the submodule, create the task branch from its
  latest `main` (`git fetch origin`, `git switch -c <branch> origin/main`) before changing anything. Never commit on
  the submodule's detached `HEAD`. Push the branch and open the PR in that repository. A task that changes two
  repositories uses the same branch name in both and links the PRs.
- One branch per task, created from the latest `main`, named `feature/<task-id>-<short-name>` using the task ID from
  `docs/PLAN.md` (e.g. `feature/03-status-concurrency`). Small, closely related tasks may share one branch and PR when
  together they form one coherent, reviewable change; the branch is named after the first task. Work outside a planned
  task: `fix/<short-name>`.
- Each task runs in its own worktree on its own branch; `main` stays checked out only in the main folder.
- PR title starts with the task ID or IDs (e.g. `03: Status update with optimistic concurrency`). The description lists what
  was done, deviations from defaults and why, and any shared files touched.
- Convention changes committed to `main` reach a running task only when it syncs with `main` (merge step 1 below),
  so sync before continuing after such a change.

## Working in parallel
- Build the first vertical slice (`GET api/requests` end to end: entity → query → service → controller → Angular list)
  **before** splitting work, as one user story whose tasks run sequentially (API, then UI). Once reviewed, register its
  files as reference implementations. Foundation tasks that share no files with other running tasks and set no code
  patterns (e.g. the Angular scaffold) may run in parallel before the slice.
- Each parallel task touches only its own feature files. Shared files (`Program.cs`, DB context, DI extensions,
  `CLAUDE.md`, shared models) are changed in a separate, sequential task — or the change is listed in the task's
  summary so the merge is deliberate.
- After the slice, work runs in tracks that own their files and merge in a fixed order — see `docs/PLAN.md` →
  Coordinating parallel work.
- A new library, project or top-level folder needs approval first. A default that doesn't fit the use case can be
  adapted inside the task, with the reason in the PR description.
- **Before merging a branch into `main`**:
  1. Bring the branch up to date with the latest `main` of its repository. Inside a submodule: `git fetch origin` and
     `git merge origin/main`. In the main repository, in a Claude desktop worktree session, use the
     sync-with-base-branch tool; otherwise `git merge main`. Resolve conflicts.
  2. Compare new code with the reference implementations and with existing code in `main` that does similar things.
  3. Align with the established conventions. Deliberate deviations are explained in the PR description. If `main` or a
     reference itself looks wrong or conflicts with this file, flag it and resolve it explicitly in a separate change.
  4. Build, run all tests, and run `/code-review`. Only then merge.
  5. After the merge, wait for the update workflow to move the submodule pointer. Then, on the main repository's
     `main`, pull with submodules, build and run all tests (plus a UI smoke run after a frontend or API-contract change)
     before the next branch merges. A failure is fixed first, in a `fix/` branch.
- After finishing a task, append a short entry to `docs/AI_USAGE.md`: what AI generated, what was verified or changed manually.
