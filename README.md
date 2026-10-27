# Request Tracker

A system for managing requests from organizations. Handlers find requests among 100,000+ records by searching,
filtering, sorting and paging; change a request's status safely when several users work at the same time; update up
to 100 requests at once; read each request's change history; and see cached statistics.

- Work plan (features, user stories, tasks, dependencies, estimates): [docs/PLAN.md](docs/PLAN.md)
- Performance analysis on 100,000 rows: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- AI usage: [docs/AI_USAGE.md](docs/AI_USAGE.md)
- Architecture conventions: [CLAUDE.md](CLAUDE.md) and [docs/code-patterns.md](docs/code-patterns.md)

## Technologies

| Area | Technology | Version |
|---|---|---|
| API | .NET, ASP.NET Core controllers, C# (nullable enabled) | .NET 10 |
| Data access | EF Core, `Microsoft.EntityFrameworkCore.SqlServer` | 10.0 |
| Database | SQL Server Developer, in Docker (`mcr.microsoft.com/mssql/server:2022-latest`) | 2022 |
| Validation | FluentValidation | 12.2 |
| Cache | `HybridCache` (`Microsoft.Extensions.Caching.Hybrid`) | 10.11 |
| API docs | ASP.NET Core OpenAPI + Swagger UI | 10.0 |
| UI | Angular (standalone components, Signals + RxJS), Angular Material, TypeScript | 22.2, 22.2, 6.0 |
| Tests | xUnit, `WebApplicationFactory`, Testcontainers for SQL Server | 2.9, 10.0, 4.16 |

## Run the solution

### Prerequisites

- Git
- .NET 10 SDK
- Node.js (an LTS version supported by Angular 22) and npm
- Docker Desktop, running, with about 2 GB of memory for SQL Server. Port 1433 must be free.

### Steps

1. Clone the main repository with its submodules:

   ```bash
   git clone --recurse-submodules https://github.com/TzivyaSternbuch/request-tracker.git
   ```

   If you already cloned without `--recurse-submodules`, run `git submodule update --init` inside the folder.

2. Start SQL Server. Run from the `request-tracker` folder:

   ```bash
   docker compose -f backend/compose.yaml up -d
   ```

   Wait until `docker compose -f backend/compose.yaml ps` shows the `sqlserver` service as `healthy`.

3. Start the API:

   ```bash
   dotnet run --project backend/src/RequestTracker.Api
   ```

   On the first start the API applies the migrations and, because the database is empty, seeds 100,000 requests (about
   15 seconds). Later starts keep the data. Swagger UI: http://localhost:5100/swagger.

4. In a second terminal, start the UI:

   ```bash
   cd frontend
   npm ci
   npm start
   ```

   Open http://localhost:4200. The dev server forwards `/api` to the API on port 5100 (`frontend/proxy.conf.json`).

To recreate the test data (deterministic, the same 100,000 requests every time), stop the API and run:

```bash
dotnet run --project backend/src/RequestTracker.Api -- seed
```

The command drops and recreates the database, then exits. It runs only in the Development environment.

### Tests

Docker must be running: the integration tests start their own SQL Server container and don't touch the local database.

```bash
dotnet test backend/RequestTracker.sln
```

```bash
cd frontend
npm test
```

<!-- Test summary: filled in by task 18 (test coverage and quality gate). -->

The SQL Server password in `backend/compose.yaml` and `appsettings.Development.json` is for local development only.

## Solution structure

Three GitHub repositories. Reviewers clone the main one; it includes the other two as Git submodules that track
`main`, and a workflow moves the submodule pointers after every merge.

| Repository | Folder | Content |
|---|---|---|
| [request-tracker](https://github.com/TzivyaSternbuch/request-tracker) | `/` | README, `CLAUDE.md`, `docs/` (plan, performance, AI usage) |
| [request-tracker-server](https://github.com/TzivyaSternbuch/request-tracker-server) | `backend/` | .NET solution, Docker compose for SQL Server |
| [request-tracker-client](https://github.com/TzivyaSternbuch/request-tracker-client) | `frontend/` | Angular app |

### Server layers

Dependencies point inward: `Api → Core ← Infrastructure`. Api references Infrastructure only to register it in DI.

| Project | Responsibility |
|---|---|
| `RequestTracker.Api` | Controllers (bind input, call a service, return the response), the global exception handler that maps errors to ProblemDetails, `Program.cs` |
| `RequestTracker.Core` | Entities, DTOs, service interfaces and services (business rules, validation, status transitions, cache invalidation), validators, domain exceptions, `StatusTransitions` |
| `RequestTracker.Infrastructure` | EF Core `DbContext` and configuration, migrations, repositories, data seeder |
| `tests/RequestTracker.UnitTests` | Services, validators and status transitions, with hand-written fakes |
| `tests/RequestTracker.IntegrationTests` | The real API (`WebApplicationFactory`) against a real SQL Server (Testcontainers) |

Reads project to DTOs inside the SQL query (`Core/Mapping/`), so the API never returns entities and never loads
columns it doesn't send.

### Client layers

`core/api/` holds the API services, the only place that uses `HttpClient`; `features/requests/` holds a signals store
and the components. Search text is debounced (300 ms), other controls request immediately, and a newer query cancels
the pending one (`switchMap`).

The API contract (endpoints, parameters, ProblemDetails error statuses) is in
[CLAUDE.md → API contract](CLAUDE.md#api-contract) and in Swagger UI.

## Database and indexes

**SQL Server 2022**, chosen for:

- a native `rowversion` column, which the database changes on every update, so no code path can forget to bump the
  concurrency token;
- plain transactions, so the audit row is written in the same transaction as the status change;
- first-class execution plans and I/O statistics for the performance analysis.

Enums are stored as `int`, so sorting by priority is semantic and runs in the database. Strings have explicit maximum
lengths so they can be index keys. The default case-insensitive collation lets filters stay sargable without
`ToLower()`.

| Index | Serves |
|---|---|
| PK clustered `Requests(Id)` | Get by id; the `Id` tiebreaker in every sort |
| `(CreatedAt)` | Default sort `createdAt desc` and paging without a sort step |
| `(Status, CreatedAt)`, `(Priority, CreatedAt)`, `(AssignedTo, CreatedAt)` | Each filter with the default sort; counts by status for the statistics |
| `(OrganizationName)` | Organization prefix filter (`LIKE 'x%'`, a seek) |
| `RequestStatusHistory(RequestId, ChangedAt DESC)` | History, newest first |

Filtering, counting, sorting and paging all run in SQL Server; only the requested page (at most 100 rows) reaches the
API. [docs/PERFORMANCE.md](docs/PERFORMANCE.md) has the execution plans and logical reads on 100,000 rows, the reason
for each index, the indexes measured and rejected (`Title`, `UpdatedAt`), and five bottlenecks with proposed
improvements.

## Concurrency, status transitions and bulk update

### Optimistic concurrency

A status change sends the `version` (the row's `rowversion`) the client read, and the update runs as
`UPDATE ... WHERE Id = @id AND Version = @version`, so the database decides: of two users with the same `version`,
exactly one succeeds and the other gets 409 (404 if the request doesn't exist). The audit row is inserted in the same
transaction, and `UpdatedAt` and `Version` change in the same statement. Integration tests prove this against the
real database for a stale version and for two overlapping requests. On 409 the UI says someone else changed the
request and reloads it.

### Status transitions

The allowed transitions are defined in one place (`Core/Domain/StatusTransitions.cs`); a disallowed one returns 422.

| From \ To | New | InProgress | Waiting | Completed |
|---|---|---|---|---|
| **New** | — | Yes | No | No |
| **InProgress** | No | — | Yes | Yes |
| **Waiting** | No | Yes | — | Yes |
| **Completed** | No | Yes (reopen) | No | — |

The reasons are in [docs/PLAN.md → Status transitions](docs/PLAN.md#status-transitions). The API returns
`allowedStatuses` with every request, so the UI offers only valid next statuses and never copies the matrix.

### Bulk update: Partial Success

`PATCH api/requests/bulk-status` takes 1–100 items, each `{ id, version }`, plus the new status and `changedBy`. A
request that is invalid as a whole (more than 100 items, duplicate ids, a missing `version`) is rejected with 400 before
anything is written. Otherwise each item goes through the same conditional update as a single change, in its own
transaction, and the response lists:

```json
{ "succeeded": [12, 15], "failed": [{ "id": 13, "reason": "Conflict" }, { "id": 99999, "reason": "NotFound" }] }
```

Reasons are `NotFound`, `Conflict` and `InvalidTransition`.

**Why Partial Success and not All-or-Nothing.** The items are independent requests, typically selected from a list
that other users are changing at the same time. With All-or-Nothing, one item that someone else touched would roll back
the other 99, and with many concurrent users a large selection would rarely succeed. Partial Success applies every item
that is still valid and tells the user exactly which ones need a reload. Each item keeps the same guarantees as a
single update: version check, audit row in the same transaction. The UI shows the per-item result and refreshes the
list.

## Cache

**What is cached and why.** Only the statistics (`GET api/requests/stats`). They aggregate the whole table (counts by
status, open request age, top assignees), so they are the most expensive read per call, every user loads them with the
list, and they are global (not filtered), so one entry serves everyone. Lists and single requests are not cached: they
have countless filter combinations, are cheap with the indexes, and must show the current `version`, or the next
update would fail with 409.

**Expiration.** 5 minutes. This bounds how old the open-request age buckets can get, since those change with time and
not only with writes.

**Invalidation.** Every successful status change, single or bulk, removes the entry by tag after the write commits.
Removing it before the commit would let a concurrent read cache the old values again. The response carries `asOf`, so
the UI shows how fresh the numbers are.

**With several server instances.** `HybridCache` here uses only its in-memory level, which is local to each process.
With several instances, an update on instance A would invalidate only A's entry; B would keep serving old statistics
for up to five minutes. The change is configuration, not code: register a distributed cache (for example Redis) as
`HybridCache`'s second level, so a miss on one instance can be filled from the shared entry. Invalidation must also
reach every instance's in-memory level, which removing the shared entry does not do: each instance needs a short local
expiration, or a Redis pub/sub message that every instance subscribes to and answers by removing its own entry.
## Technical decisions and alternatives

### 1. Concurrency token maintained by the database (`rowversion`)

- **Chosen:** a `rowversion` column, compared in the `UPDATE ... WHERE` and changed by SQL Server on every update.
- **Alternative: an `int` version incremented by the code.** Portable to any database and readable in the API, but
  every write path must remember to increment it; a forgotten path silently allows lost updates.
- **Alternative: compare `UpdatedAt`.** Needs no extra column, but two updates within the timestamp precision look the
  same, and the value depends on the clocks of the application servers.

### 2. Offset paging with an exact total count

- **Chosen:** `page` and `pageSize` (max 100), `OFFSET ... FETCH`, a separate `COUNT(*)`, and every sort ending with
  `Id` so pages never repeat or skip rows.
- **Alternative: keyset (cursor) paging**, seeking to the last row seen. Every page costs the same, while offset paging
  reads and discards the skipped rows (measured in PERFORMANCE.md, A8). But the UI can't jump to an arbitrary page or
  show "page 3 of 5,000", and a multi-field sort makes the cursor complex. The common case — the first pages of a
  filtered list — is cheap with offset paging, so the simpler contract won.
- **Alternative: no total count** ("next page" only). Saves the count query, the second-largest cost of a list call,
  but users lose the result count, which is the main feedback when combining filters.

## Known limitation and possible improvement

**Limitation: text search scans the table.** `search` matches a substring (`LIKE '%x%'`), which can't use an index.
Every search counts with a full scan (about 2,600 logical reads, independent of the text), and a rare text can read
most of the table to fill one page (89,408 reads in the measurement). At 100,000 rows this stays usable; it grows
linearly with the table.

**Improvement: SQL Server Full-Text Search** with `CONTAINS`, which uses an inverted index. It is not in the default
Docker image, the index is filled asynchronously (search can lag behind writes), and it matches words or prefixes
rather than any substring, which changes what `search` returns. The other measured bottlenecks and their improvements
(count cost, deep pages, estimate errors, unindexed sorts) are in
[docs/PERFORMANCE.md → Bottlenecks](docs/PERFORMANCE.md#bottlenecks-and-proposed-improvements).

Other limitations by design: there is no authentication (`changedBy` is the name the user types as "acting as"), and
other users' changes appear only on reload or as a 409. If a bulk item fails with an unexpected error, the call returns
500 while earlier items stay committed. See [docs/PLAN.md → Out of scope](docs/PLAN.md#out-of-scope).
