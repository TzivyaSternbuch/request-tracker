# 10 Status Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Never run `git commit` without the developer's explicit permission in the session.** Each "Commit" step means:
> stop, show what would be committed, and ask.

**Goal:** `GET api/requests/{id}` and `PATCH api/requests/{id}/status` with optimistic concurrency enforced by the
database, an audit row in the same transaction, and statistics-cache invalidation after the commit.

**Architecture:** `RequestsController` binds the route `id` and the body and calls `IRequestService`. The service
validates the input, reads the current row, checks the version and the transition (`StatusTransitions`), then calls
`IRequestRepository.TryUpdateStatusAsync`, which runs the conditional update, the audit insert and the read-back in
one transaction and returns the outcome. The service maps the outcome to the domain exceptions and invalidates the
`stats` tag after a successful commit.

**Tech Stack:** .NET 10, ASP.NET Core controllers, EF Core 10 (SQL Server), FluentValidation, `HybridCache`, xUnit,
`WebApplicationFactory` + Testcontainers (harness from task 08). No new packages.

**Spec:** `docs/PLAN.md` → task 10, US-3.1 and Status transitions; `CLAUDE.md` (Concurrency & audit, Conditional
update, Error responses, Cache, Logging); `docs/code-patterns.md` → Service, Repository, Tests.

## Design (agreed with the developer)

**Dependencies:** task 08 is merged (`backend` main `c446dc4`). **Starts before M1 (developer's decision):** task 09
isn't merged and no files are registered as references yet. Task 10 is backend-only and needs only 08's code, so it
follows 08's `RequestsController`, `RequestService` and `RequestRepository` as the de-facto references. The PR notes
the early start; if the M1 review changes those files, task 10 aligns when it syncs with `main`.

**Delivers** (branch `feature/10-status-concurrency` in `request-tracker-server`, i.e. inside `backend/`):

- `GET api/requests/{id:int}` → 200 `RequestDto`, 404 ProblemDetails.
- `PATCH api/requests/{id:int}/status`, body `{ status, version, changedBy }` → 200 updated `RequestDto`; 400, 404,
  409, 422 as ProblemDetails.
- `Core/Domain/StatusTransitions.cs`: the only definition of the matrix in `docs/PLAN.md` → Status transitions.
- Not in this task: bulk (11), history endpoint (12), stats endpoint (13). The invalidation of the `stats` tag is
  added here even though nothing reads that tag yet.

**Route.** `{id:int}` constraint on both routes (*my call*): without it `GET api/requests/{id}` would also match the
literal `api/requests/stats` added in task 13. A non-integer id then gets 404 from routing (ProblemDetails via
`UseStatusCodePages`). A non-positive integer id is simply not found → 404.

**Input model** `Core/Models/UpdateStatusRequest` (`record` with `init` properties, like `RequestQueryParameters`):

- `RequestStatus? Status`, `byte[]? Version`, `string? ChangedBy` — all nullable so a missing field is a 400 from the
  validator, not a default. In particular a non-nullable `Status` would silently bind a missing value to `New` (0)
  and answer 422 instead of 400 (*my call*).
- `UpdateStatusRequestValidator` (*my calls* for the exact rules):
  - `status`: not null. Undefined names and numbers are already rejected by JSON binding
    (`JsonStringEnumConverter(allowIntegerValues: false)`) with a 400 keyed `status`.
  - `version`: not null, exactly 8 bytes (a `rowversion`). Malformed base64 is a JSON binding 400.
  - `changedBy`: not blank, at most `RequestStatusHistory.ChangedByMaxLength` (100) after trimming. The service stores
    the trimmed value.
- Errors are keyed by JSON name (`status`, `version`, `changedBy`), as the existing handlers already do.

**Service** `RequestService` gains `GetByIdAsync(id)` and `UpdateStatusAsync(id, request)`; it now also takes
`IValidator<UpdateStatusRequest>`, `HybridCache`, `TimeProvider` and `ILogger<RequestService>`.

`UpdateStatusAsync` steps:

1. Validate (`ValidateAndThrowAsync`) → 400.
2. `repository.GetByIdAsync(id)`; `null` → `NotFoundException` → 404.
3. **Version before transition (developer's decision):** if the current `Version` differs from the client's →
   `ConcurrencyConflictException` → 409. The client's data is stale, so judging its requested transition against a
   status it hasn't seen would give a misleading 422. This check is an early exit only; the database's conditional
   update is still what prevents lost updates.
4. `StatusTransitions.IsAllowed(current.Status, request.Status)`; not allowed (including the same status) →
   `InvalidStatusTransitionException` → 422, message like `Cannot change status from New to Completed.`
5. `repository.TryUpdateStatusAsync(id, version, previousStatus: current.Status, newStatus, changedBy, now)` with
   `now = timeProvider.GetUtcNow()` (the same value for `UpdatedAt` and `ChangedAt`).
6. Outcome `NotFound` → 404 (deleted in between); `Conflict` → log Warning `"Status update conflict for {RequestId}"`
   (no `changedBy`, no body) → 409; `Updated` → `cache.RemoveByTagAsync(CacheKeys.StatsTag)` after the commit, then
   return the DTO from the outcome. Step 3's early 409 logs the same Warning.

`PreviousStatus` is correct by construction: the audit row is written only if the row still has the version that was
read in step 2, and that version had exactly the status read in step 2.

**Repository** `IRequestRepository` gains:

- `Task<RequestDto?> GetByIdAsync(int id, CancellationToken)` — `AsNoTracking`, projected with `RequestMapping.ToDto`.
- `Task<UpdateStatusResult> TryUpdateStatusAsync(int id, byte[] expectedVersion, RequestStatus previousStatus,
  RequestStatus newStatus, string changedBy, DateTimeOffset changedAt, CancellationToken)`.
  `UpdateStatusResult(UpdateStatusOutcome Outcome, RequestDto? Request)` and `enum UpdateStatusOutcome { Updated,
  NotFound, Conflict }` live in `Core/Models/` (names are *my call*). The repository applies no rules: it receives
  the previous status and the timestamp.

`TryUpdateStatusAsync`, in one transaction (`BeginTransactionAsync`):

1. `Where(r => r.Id == id && r.Version == expectedVersion).ExecuteUpdateAsync(set Status, UpdatedAt)`; the
   `rowversion` changes in the same statement.
2. 0 rows → `AnyAsync(r => r.Id == id)` → `NotFound` or `Conflict`; roll back (nothing was written).
3. 1 row → insert the `RequestStatusHistory` row, **read the row back as `RequestDto` before committing**, commit,
   return `Updated` with it.

**Read-back inside the transaction (developer's decision; deviates from `CLAUDE.md`).** The row is still locked by the
update, so the response carries exactly the state and version this update produced. A re-read after the commit could
return another user's later change as if it were the result of this one, and the client would keep that newer version
without seeing a conflict. `CLAUDE.md` → Conditional update is updated in the same docs change as this plan.

Isolation stays the default READ COMMITTED: the `UPDATE` takes an exclusive lock on the row, so an overlapping update
waits, then finds the version changed and affects 0 rows.

**Controller** (`RequestsController`, no try/catch):

- `GetById(int id)` → `Ok(dto)`; `[ProducesResponseType]` 200 `RequestDto`, 404 `ProblemDetails`.
- `UpdateStatus(int id, [FromBody] UpdateStatusRequest request)` → `Ok(dto)`; declares 200 `RequestDto`, 400
  `ValidationProblemDetails`, 404, 409, 422 `ProblemDetails`, all `application/problem+json`.

**DI:** register `IValidator<UpdateStatusRequest>` in `AddCore()`. `HybridCache` and `TimeProvider` are already
registered.

**Tests:**

- Unit (`RequestTracker.UnitTests`, hand-written fakes for the repository and `HybridCache`, a fixed `TimeProvider`):
  - `StatusTransitions`: a theory over all 16 cells of the matrix.
  - `UpdateStatusRequestValidator`: missing status, missing / wrong-length version, blank / too-long `changedBy`.
  - Service: not found → `NotFoundException`; stale version (step 3) → `ConcurrencyConflictException`; invalid
    transition → `InvalidStatusTransitionException`; repository `Conflict` / `NotFound` outcomes → the matching
    exception; the cache tag is removed only after `Updated` and never on failures; the repository receives the
    trimmed `changedBy`, the previous status and the `TimeProvider` time.
- Integration (`Requests/RequestStatusUpdateTests`, using `TestRequests` helpers; each test inserts its own rows):
  - success: 200, `status` and `updatedAt` change, `version` changes and matches the DB; exactly one audit row with
    every field;
  - stale version: update, then update again with the old version → 409, still one audit row;
  - overlapping updates: two PATCHes with the same version via `Task.WhenAll` → exactly one 200 and one 409 (asserts
    outcomes, not which one wins), exactly one audit row;
  - 404 unknown id (GET and PATCH); 400 with `errors` for a missing `version`; 422 for a disallowed transition, with no
    audit row and the version unchanged;
  - GET by id returns the DTO.
- The stats-cache integration test (counts change after an update) belongs to task 13, which adds the endpoint.

**Left to the builder:** exact exception messages, fake shapes, test-helper additions in `TestRequests`, and whether
the 409 detail mentions reloading (the frontend shows its own message, task 14).

**Shared files touched:** `Core/DependencyInjection.cs` (one validator registration). No schema or migration change.
The API contract table in `CLAUDE.md` already lists both endpoints, so it doesn't change.

## Global Constraints

- No packages from the `CLAUDE.md` "Not allowed" list, and no new packages at all (no mocking library, no
  `Microsoft.Extensions.TimeProvider.Testing`: fakes are hand-written).
- File-scoped namespaces matching the folder, one public type per file, primary constructors for DI, DTOs and input
  models are `record`s. Comments explain why, not what.
- Layering: the controller has no logic or data access; the service has no HTTP types; the repository has no rules,
  caching or validation. Every I/O call takes and passes on the `CancellationToken`.
- Status transitions are defined only in `Core/Domain/StatusTransitions.cs`, exactly the matrix in `docs/PLAN.md`.
- `Status`, `UpdatedAt` and `Version` change in one statement; the audit row is in the same transaction; the cache is
  invalidated only after the commit.
- Logs never contain `changedBy`, the request body or full DTOs.
- Tests named `MethodName_Scenario_ExpectedResult`, Arrange / Act / Assert separated by a blank line, no
  FluentAssertions.
- Work inside `backend/`: `git fetch origin`, `git switch -c feature/10-status-concurrency origin/main` before any
  change. Never commit on the detached `HEAD`. No submodule pointer change in the main repository.

## Review Focus

1. **A field left out of the body** — `{ "version": "…", "changedBy": "a" }` without `status` must be 400 keyed
   `status`, not a 422 for "→ New". → Task 2 `Validate_MissingField_HasFieldError`, Task 5
   `UpdateStatus_MissingField_Returns400WithFieldError`.
2. **A version that isn't one** — malformed base64 or a valid base64 string of the wrong length is 400 keyed `version`,
   never 409 or 500. → Task 5 `UpdateStatus_MalformedVersion_Returns400WithVersionError`.
3. **Two users at the same moment** — exactly one wins, the other gets 409, one audit row; no 500 from a deadlock or a
   unique-key race. → Task 5 `UpdateStatus_OverlappingUpdates_ExactlyOneSucceeds`.
4. **A rejected update leaves no trace** — 409 / 422 / 404 change neither the row's `version` nor the history. → Task 5
   `UpdateStatus_DisallowedTransition_Returns422AndChangesNothing` and the stale-version test.
5. **`changedBy` with surrounding spaces or only spaces** — `"  alice  "` is stored as `alice`; `"   "` is 400. →
   Task 2 `Validate_BlankChangedBy_HasChangedByError`, Task 4
   `UpdateStatusAsync_Success_PassesTrimmedChangedByStatusAndTime`.

---

### Task 1: Status transition matrix

**Files** (all paths relative to `backend/`):
- Create: `src/RequestTracker.Core/Domain/StatusTransitions.cs`
- Test: `tests/RequestTracker.UnitTests/Domain/StatusTransitionsTests.cs`

**Interfaces:**
- Produces: `public static class StatusTransitions` with `public static bool IsAllowed(RequestStatus from,
  RequestStatus to)`.

- [ ] **Step 1: Create the branch** inside `backend/` (see Global Constraints).
- [ ] **Step 2: Write the failing test** `IsAllowed_EveryPair_MatchesMatrix` — a theory with all 16 `(from, to,
  expected)` rows. `true` exactly for: New→InProgress, InProgress→Waiting, InProgress→Completed, Waiting→InProgress,
  Waiting→Completed, Completed→InProgress. Every other pair, including each status to itself, is `false`.
- [ ] **Step 3: Run** `dotnet test tests/RequestTracker.UnitTests` → fails to compile.
- [ ] **Step 4: Implement** `IsAllowed` as a `switch` expression over `(from, to)` listing the six allowed pairs, `_ =>
  false`. A comment points to `docs/PLAN.md` → Status transitions as the source of the rule.
- [ ] **Step 5: Run** `dotnet test tests/RequestTracker.UnitTests` → all pass.
- [ ] **Step 6: Commit** — stop, show, ask. Proposed: `10: Add the status transition matrix`

### Task 2: Update input model and validator

**Files:**
- Create: `src/RequestTracker.Core/Models/UpdateStatusRequest.cs`
- Create: `src/RequestTracker.Core/Validation/UpdateStatusRequestValidator.cs`
- Modify: `src/RequestTracker.Core/DependencyInjection.cs`
- Test: `tests/RequestTracker.UnitTests/Validation/UpdateStatusRequestValidatorTests.cs`

**Interfaces:**
- Produces: `public record UpdateStatusRequest` with `init` properties `RequestStatus? Status`, `byte[]? Version`,
  `string? ChangedBy`, and `public const int VersionLength = 8`.
- Produces: `UpdateStatusRequestValidator : AbstractValidator<UpdateStatusRequest>`, registered in `AddCore()` as
  `IValidator<UpdateStatusRequest>`, scoped.

- [ ] **Step 1: Write the failing tests** (a valid request: `Status = InProgress`, `Version = new byte[8]`,
  `ChangedBy = "alice"`):
  - `Validate_ValidRequest_IsValid`.
  - `Validate_MissingField_HasFieldError` — theory: `Status = null` → error on `Status`; `Version = null` → on
    `Version`; `ChangedBy = null` → on `ChangedBy`.
  - `Validate_UndefinedStatus_HasStatusError` — `(RequestStatus)99`.
  - `Validate_VersionWrongLength_HasVersionError` — theory: 0, 7, 9 bytes.
  - `Validate_BlankChangedBy_HasChangedByError` — theory: `""`, `"   "`.
  - `Validate_ChangedByTooLong_HasChangedByError` — `RequestStatusHistory.ChangedByMaxLength + 1` letters.
  - `Validate_ChangedByAtMaxLengthWithSurroundingSpaces_IsValid` — `" " + 100 letters + " "` (the limit applies to the
    trimmed value).
- [ ] **Step 2: Run** `dotnet test tests/RequestTracker.UnitTests` → fails to compile.
- [ ] **Step 3: Implement** the record and validator: `Status` `NotNull` + `IsInEnum`; `Version` `NotNull` + length
  exactly `VersionLength`; `ChangedBy` `NotEmpty` on the trimmed value and max length on the trimmed value. Register in
  `AddCore()`.
- [ ] **Step 4: Run** `dotnet test tests/RequestTracker.UnitTests` → all pass.
- [ ] **Step 5: Commit** — stop, show, ask. Proposed: `10: Add the status update input model and validator`

### Task 3: GET api/requests/{id}

**Files:**
- Modify: `src/RequestTracker.Core/Abstractions/IRequestRepository.cs`,
  `src/RequestTracker.Infrastructure/Repositories/RequestRepository.cs`
- Modify: `src/RequestTracker.Core/Services/IRequestService.cs`, `src/RequestTracker.Core/Services/RequestService.cs`
- Modify: `src/RequestTracker.Api/Controllers/RequestsController.cs`
- Test: `tests/RequestTracker.IntegrationTests/Requests/RequestDetailsTests.cs`

**Interfaces:**
- Produces: `IRequestRepository.GetByIdAsync(int id, CancellationToken cancellationToken) : Task<RequestDto?>`.
- Produces: `IRequestService.GetByIdAsync(int id, CancellationToken cancellationToken) : Task<RequestDto>` — throws
  `NotFoundException($"Request {id} was not found.")` on `null`.
- Produces: `RequestsController.GetById(int id, CancellationToken cancellationToken)` on `[HttpGet("{id:int}")]`,
  `[ProducesResponseType]` 200 `RequestDto` and 404 `ProblemDetails` (`application/problem+json`).

- [ ] **Step 1: Write the failing integration tests** in `RequestDetailsTests` (`[Collection(ApiCollection.Name)]`):
  - `GetById_Existing_ReturnsRequest` — insert one row with `TestRequests.New`, read its `Id` from the entity after
    `InsertAsync` → 200, every field equal to the inserted values, `version` decodes to 8 bytes.
  - `GetById_Unknown_Returns404Problem` — `int.MaxValue` → `ProblemAssert.IsProblemAsync(…, NotFound)`.
  - `GetById_NonInteger_Returns404` — `/api/requests/abc` → 404 (routing, not 400 or 405).
- [ ] **Step 2: Run** `dotnet test tests/RequestTracker.IntegrationTests --filter RequestDetailsTests` → fails.
- [ ] **Step 3: Implement** the repository method (`AsNoTracking`, `Where(Id)`, `Select(RequestMapping.ToDto)`,
  `FirstOrDefaultAsync`), the service method and the action. The constructor of `RequestService` doesn't change yet.
- [ ] **Step 4: Run** `dotnet test` → all pass (including `OpenApiTests`).
- [ ] **Step 5: Commit** — stop, show, ask. Proposed: `10: Add GET api/requests/{id}`

### Task 4: Service status update

**Files:**
- Create: `src/RequestTracker.Core/Models/UpdateStatusOutcome.cs`, `src/RequestTracker.Core/Models/UpdateStatusResult.cs`
- Modify: `src/RequestTracker.Core/Abstractions/IRequestRepository.cs`
- Modify: `src/RequestTracker.Core/Services/IRequestService.cs`, `src/RequestTracker.Core/Services/RequestService.cs`
- Modify: `src/RequestTracker.Infrastructure/Repositories/RequestRepository.cs` (stub only, so the solution builds)
- Test: `tests/RequestTracker.UnitTests/Services/RequestServiceUpdateStatusTests.cs`, fakes in
  `tests/RequestTracker.UnitTests/Fakes/` (`FakeRequestRepository`, `FakeHybridCache`, `FixedTimeProvider`,
  `CapturingLogger<T>`)

**Interfaces:**
- Consumes: `StatusTransitions.IsAllowed` (Task 1), `UpdateStatusRequest`, `IValidator<UpdateStatusRequest>` (Task 2),
  `IRequestRepository.GetByIdAsync` (Task 3).
- Produces: `enum UpdateStatusOutcome { Updated = 0, NotFound = 1, Conflict = 2 }`;
  `record UpdateStatusResult(UpdateStatusOutcome Outcome, RequestDto? Request)`.
- Produces: `IRequestRepository.TryUpdateStatusAsync(int id, byte[] expectedVersion, RequestStatus previousStatus,
  RequestStatus newStatus, string changedBy, DateTimeOffset changedAt, CancellationToken cancellationToken)
  : Task<UpdateStatusResult>`.
- Produces: `IRequestService.UpdateStatusAsync(int id, UpdateStatusRequest request, CancellationToken
  cancellationToken) : Task<RequestDto>`.
- Produces: `RequestService(IRequestRepository repository, IValidator<RequestQueryParameters> queryValidator,
  IValidator<UpdateStatusRequest> updateStatusValidator, HybridCache cache, TimeProvider timeProvider,
  ILogger<RequestService> logger)`.

- [ ] **Step 1: Write the fakes.** `FakeRequestRepository`: a settable `RequestDto? Current` returned by
  `GetByIdAsync`, a settable `UpdateStatusResult NextResult`, and the recorded arguments of the last
  `TryUpdateStatusAsync` call (`null` if never called); `GetPagedAsync` throws `NotSupportedException`.
  `FakeHybridCache : HybridCache`: records tags passed to `RemoveByTagAsync`; the other abstract members throw
  `NotSupportedException`. `FixedTimeProvider : TimeProvider` overrides `GetUtcNow()`. `CapturingLogger<T> :
  ILogger<T>` records `(LogLevel, string message)`. Fakes and the repository share one `List<string> Calls` so a test
  can assert that the cache was invalidated after `TryUpdateStatusAsync`.
- [ ] **Step 2: Write the failing tests** (current row: `Status = New`, `Version = [1..8]`; request: `InProgress`, the
  same version, `ChangedBy = "  alice  "`; `FixedTimeProvider` at `2026-03-01T10:00:00Z`):
  - `UpdateStatusAsync_InvalidInput_ThrowsValidationExceptionAndWritesNothing` — `Status = null` → `ValidationException`;
    no repository update, no cache call.
  - `UpdateStatusAsync_UnknownId_ThrowsNotFound` — `Current = null`.
  - `UpdateStatusAsync_StaleVersion_ThrowsConflictBeforeTransitionCheck` — request version differs and the
    transition (New→Completed) is also disallowed → `ConcurrencyConflictException`, no update call.
  - `UpdateStatusAsync_DisallowedTransition_ThrowsInvalidTransition` — New→Completed with the current version; message
    contains `New` and `Completed`; no update call.
  - `UpdateStatusAsync_SameStatus_ThrowsInvalidTransition` — New→New.
  - `UpdateStatusAsync_RepositoryConflict_ThrowsConflictAndLogsWarningWithoutChangedBy` — `NextResult = Conflict` →
    `ConcurrencyConflictException`; exactly one Warning; no log message contains `alice`; no cache call.
  - `UpdateStatusAsync_RepositoryNotFound_ThrowsNotFound` — `NextResult = NotFound`; no cache call.
  - `UpdateStatusAsync_Success_ReturnsUpdatedDtoAndInvalidatesStatsAfterWrite` — `NextResult = Updated` with a DTO →
    returns that DTO; `Calls` is `["TryUpdateStatus", "RemoveByTag:stats"]`.
  - `UpdateStatusAsync_Success_PassesTrimmedChangedByStatusAndTime` — recorded arguments: `changedBy = "alice"`,
    `previousStatus = New`, `newStatus = InProgress`, `expectedVersion` = the request's version, `changedAt` = the fixed
    time.
- [ ] **Step 3: Run** `dotnet test tests/RequestTracker.UnitTests` → fails to compile.
- [ ] **Step 4: Implement** the outcome types, the interface methods and `UpdateStatusAsync` in the order of the Design
  (validate → read → version → transition → update → outcome). Versions compare with `SequenceEqual`. Both 409 paths
  log `LogWarning("Status update conflict for {RequestId}", id)`. Exception messages: `Request {id} was not found.`,
  `Request {id} was modified by someone else.`, `Cannot change status from {from} to {to}.` In `RequestRepository`,
  `TryUpdateStatusAsync` throws `NotImplementedException` until Task 5.
- [ ] **Step 5: Run** `dotnet test tests/RequestTracker.UnitTests` → all pass; `dotnet build` → 0 warnings.
- [ ] **Step 6: Commit** — stop, show, ask. Proposed: `10: Add the status update use case to the service`

### Task 5: Conditional update, audit and PATCH endpoint

**Files:**
- Modify: `src/RequestTracker.Infrastructure/Repositories/RequestRepository.cs`
- Modify: `src/RequestTracker.Api/Controllers/RequestsController.cs`
- Modify (only if Step 5 needs it): `src/RequestTracker.Api/ErrorHandling/ErrorKeys.cs`
- Test: `tests/RequestTracker.IntegrationTests/Requests/RequestStatusUpdateTests.cs`,
  `Requests/RequestRepositoryUpdateTests.cs`; helpers added to `Requests/TestRequests.cs`

**Interfaces:**
- Consumes: `IRequestRepository.TryUpdateStatusAsync`, `UpdateStatusResult` (Task 4), `IRequestService.UpdateStatusAsync`
  (Task 4).
- Produces: `RequestsController.UpdateStatus(int id, UpdateStatusRequest request, CancellationToken
  cancellationToken)` on `[HttpPatch("{id:int}/status")]`, `[ProducesResponseType]` 200 `RequestDto`, 400
  `ValidationProblemDetails`, 404 / 409 / 422 `ProblemDetails` (all `application/problem+json`).
- Produces (tests): `TestRequests.PatchStatusAsync(HttpClient client, int id, object body) : Task<HttpResponseMessage>`
  and `TestRequests.GetHistoryAsync(ApiFactory factory, int requestId) : Task<List<RequestStatusHistory>>` (reads the
  table directly; task 12 adds the endpoint).

- [ ] **Step 1: Write the failing integration tests** in `RequestStatusUpdateTests`. Each inserts its own row
  (`Status = New` unless stated) and sends `{ status, version, changedBy }` with `version` from a prior GET:
  - `UpdateStatus_ValidTransition_UpdatesRowAndWritesOneAuditRow` — New→InProgress by `alice` → 200; body `status =
    InProgress`, `updatedAt` later than the inserted value, `version` differs from the old one and equals a fresh GET's;
    exactly one history row with `RequestId`, `PreviousStatus = New`, `NewStatus = InProgress`, `ChangedBy = alice`,
    `ChangedAt == body.updatedAt`.
  - `UpdateStatus_StaleVersion_Returns409AndWritesNoSecondAuditRow` — update New→InProgress, then send
    InProgress→Waiting with the **old** version → 409 problem; one history row; the row's version is the first
    update's.
  - `UpdateStatus_OverlappingUpdates_ExactlyOneSucceeds` — two New→InProgress PATCHes with the same version from two
    clients via `Task.WhenAll` → status codes sorted are `[200, 409]`; exactly one history row.

  The service's early version check can answer either 409 above before the database is reached, so these HTTP tests
  don't prove on their own that the database enforces the version. Add `RequestRepositoryUpdateTests` (same folder,
  resolving `IRequestRepository` from a scope of `factory.Services`) that calls `TryUpdateStatusAsync` directly:
  - `TryUpdateStatusAsync_StaleVersion_ReturnsConflictAndWritesNothing` — update once through the repository, call
    again with the old version → `Conflict`, `Request` is `null`, one history row, status still the first update's.
  - `TryUpdateStatusAsync_UnknownId_ReturnsNotFound` — `int.MaxValue`.
  - `TryUpdateStatusAsync_CurrentVersion_ReturnsUpdatedWithNewVersion` — `Request.Version` differs from the old one and
    equals the row's version read afterwards.
  - `UpdateStatus_UnknownId_Returns404` — `int.MaxValue`, a valid body.
  - `UpdateStatus_MissingField_Returns400WithFieldError` — theory: body without `status` → key `status`; without
    `version` → `version`; without `changedBy` → `changedBy`.
  - `UpdateStatus_MalformedVersion_Returns400WithVersionError` — theory: `"not-base64!"`, `"AAAA"` (3 bytes) → 400,
    key `version`.
  - `UpdateStatus_DisallowedTransition_Returns422AndChangesNothing` — New→Completed → 422 problem whose `detail`
    mentions both statuses; no history row; version unchanged.
- [ ] **Step 2: Run** `dotnet test tests/RequestTracker.IntegrationTests --filter "RequestStatusUpdateTests|RequestRepositoryUpdateTests"`
  → fails.
- [ ] **Step 3: Implement `TryUpdateStatusAsync`** exactly as the Design's three steps, in `await using var transaction =
  await db.Database.BeginTransactionAsync(cancellationToken)`. The audit row is added with `db.RequestStatusHistory.Add`
  + `SaveChangesAsync`; the read-back reuses `GetByIdAsync`'s query. No commit on the 0-row path (disposal rolls
  back).
- [ ] **Step 4: Implement the action** — calls `service.UpdateStatusAsync` and returns `Ok`.
- [ ] **Step 5: Run the tests** → all pass. If the malformed-version case comes back keyed `$.version` (JSON binding
  errors use a JSON path), make `ErrorKeys.ToJsonPath` drop a leading `$.` and run `ErrorHandlingTests` and
  `JsonContractTests` too; list `ErrorKeys.cs` as a shared file in the PR.
- [ ] **Step 6: Run** `dotnet test` (whole solution) → all pass; `dotnet build` → 0 warnings.
- [ ] **Step 7: Commit** — stop, show, ask. Proposed: `10: Add PATCH api/requests/{id}/status with a conditional
  update and audit`

### Task 6: Verification and PR

Sync first: `git fetch origin`, `git merge origin/main`.

- [ ] **Step 1: Check the SQL.** Run the API on the seeded database (`docker compose up -d`, `dotnet run --project
  src/RequestTracker.Api`) and PATCH one request through Swagger UI. The EF Core command log shows, in one
  transaction: `UPDATE … SET Status, UpdatedAt … WHERE Id = @id AND Version = @version`, the `INSERT` into
  `RequestStatusHistory`, then the `SELECT` read-back, then the commit. Send the same body again → 409, and the log
  shows only the read, no `UPDATE`: the service's version check exits first.
- [ ] **Step 2: Verify** `dotnet build` (0 warnings) and `dotnet test` (all pass), then run `/code-review`.
- [ ] **Step 3: Push and open the PR** in `request-tracker-server`, after the developer approves the commits. Title
  `10: Status update with optimistic concurrency and audit`. Description: what was done; deviations (read-back inside
  the transaction, 409 before 422, started before M1); shared files touched (`AddCore`, `ErrorKeys.cs` if changed);
  note for task 13 that the `stats` tag is already invalidated on every successful update.
