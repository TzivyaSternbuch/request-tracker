# 04 Backend Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Never run `git commit` without the developer's explicit permission in the session.** Each "Commit" step means:
> stop, show what would be committed, and ask.

**Goal:** A layered .NET 10 solution in `request-tracker-server` with the cross-cutting behavior every later backend
task relies on (JSON, ProblemDetails errors, DI, time, cache, OpenAPI + Swagger UI), and SQL Server 2022 starting
locally with one command.

**Architecture:** Api → Core ← Infrastructure, enforced by project references (Api also references Infrastructure for
DI only). One global `IExceptionHandler` maps domain exceptions to ProblemDetails; status-code pages turn body-less
errors (unknown route, 405) into ProblemDetails too. No schema, entities or DbContext yet — that is task 05.

**Tech Stack:** .NET 10 (SDK 10.0.302), ASP.NET Core controllers, FluentValidation, Microsoft.Extensions.Caching.Hybrid,
Microsoft.AspNetCore.OpenApi, Swashbuckle.AspNetCore.SwaggerUI, xUnit, Microsoft.AspNetCore.Mvc.Testing, Docker Compose.

**Spec:** `docs/PLAN.md` → task 04 and US-1.1; `CLAUDE.md` (Stack, Layer responsibilities, DI lifetimes, Error
responses, Cache, Database → Tests and local run). The design agreed for this task is the next section.

## Design (agreed with the developer)

**Delivers** (branch `feature/04-backend-skeleton` in `request-tracker-server`, i.e. inside `backend/`):

- Projects Api, Core, Infrastructure, UnitTests, IntegrationTests; references enforce the layering.
- camelCase JSON, enums as strings; one global exception handler → ProblemDetails 400/404/409/422/500, a 500 logged as
  Error with no internals in the body; `AddCore()` / `AddInfrastructure(IConfiguration)`; `TimeProvider.System` and
  `HybridCache` registered; `CacheKeys` constants.
- Manual checks: the built-in OpenAPI document plus the Swagger UI page, Development only. **No `.http` file**
  (developer's decision: one manual-check tool is enough; Swagger UI is familiar to reviewers).
- Local run: `compose.yaml` for SQL Server 2022, the dev connection string, `dotnet-ef` as a local tool, and a
  "Run locally" section in the server repo's README.

**Not in this task (developer's decision):** applying the schema on startup (`MigrateAsync`). Task 05 owns the whole
"schema is applied automatically" criterion, because there is no schema yet. `AddInfrastructure` is created empty;
task 05 registers the DbContext in it.

**How it is checked:**

- Integration tests through `WebApplicationFactory`, **no database and no Docker needed**: a test-only controller in
  the test assembly throws each exception type and returns an enum, so the real pipeline (handler registration,
  middleware order, JSON options) is what's tested. *My call:* the playback said "unit tests on the handler"; testing
  through the host instead also proves registration and ordering, at the same cost. One unit test remains for the one
  path the host can't reach reliably (client-aborted request).
- Testcontainers is not added until task 05, when there is something to put in the database.
- Manual: `docker compose up -d` → container healthy; run the API → `/swagger` shows the UI; `GET /api/nope` → 404
  ProblemDetails.

**Calls made while planning (check these):**

- API port `http://localhost:5100` (5080 is taken on the dev machine; task 07's dev proxy targets 5100).
- SQL Server on host port 1433, dev-only SA password committed in `compose.yaml` and `appsettings.Development.json`
  (`CLAUDE.md` allows a dev-only password).
- Integers are rejected for enums (`allowIntegerValues: false`), so `"status": 99` can't bind to an undefined value.
- Validation `errors` keys are camelCase, both from model binding and from FluentValidation, to match the JSON body.
- Solution file stays `RequestTracker.sln` (`.slnx` is the .NET 10 default; `CLAUDE.md` names `.sln`).
- Validators: no validators exist yet, so no registration mechanism is added here. The first task with a validator
  decides between registering it by hand in `AddCore()` and `FluentValidation.DependencyInjectionExtensions`.

## Global Constraints

- No packages from the `CLAUDE.md` "Not allowed" list. Swagger UI is `Swashbuckle.AspNetCore.SwaggerUI` only — never
  `Swashbuckle.AspNetCore` (its generator duplicates Microsoft.AspNetCore.OpenApi).
- `net10.0`, nullable enabled, implicit usings, file-scoped namespaces matching the folder, one public type per file.
- Primary constructors for DI. Comments explain why, not what.
- Error statuses exactly: invalid input 400 with `errors`; not found 404; version conflict 409; transition not allowed
  422; unexpected 500, logged as Error, no internals in the response.
- No request bodies or full DTOs in logs.
- Tests named `MethodName_Scenario_ExpectedResult`, Arrange / Act / Assert separated by a blank line, no mocking
  library, no FluentAssertions.
- Work happens inside `backend/`: `git fetch origin`, `git switch -c feature/04-backend-skeleton origin/main` before
  any change. Never commit on the detached `HEAD`. No submodule pointer change in the main repo.

## Review Focus

1. **Unhandled exception while running in Development** — `WebApplication` adds the developer exception page in
   Development; the response must still be a bare 500 ProblemDetails with no message or stack trace.
   → Task 3, `Throw_UnexpectedException_Returns500WithoutInternals` (the test host runs as Development).
2. **Errors that aren't exceptions** — unknown route, wrong HTTP method, malformed JSON body must be ProblemDetails,
   not empty bodies or plain text. → Task 3, `UnknownRoute_…`, `WrongMethod_…`, `MalformedJson_…`.
3. **Client disconnects mid-request** — an `OperationCanceledException` from an aborted request must not be logged as
   an Error 500. → Task 3, `TryHandleAsync_RequestAborted_DoesNotLogError` (unit test).
4. **Validation error keys** — the client reads `errors.status`, not `errors.Status`. → Task 3,
   `Throw_ValidationException_Returns400WithCamelCaseErrors`, and Task 4, `MissingRequiredField_…`.
5. **Enum sent as a number** — `{"kind": 1}` must be a 400, not silently accepted. → Task 4,
   `Post_EnumAsNumber_Returns400`.

---

### Task 1: Solution, projects, DI composition

**Files** (all paths relative to `backend/`):
- Create: `RequestTracker.sln`, `Directory.Build.props`
- Create: `src/RequestTracker.Api/RequestTracker.Api.csproj`, `Program.cs`, `Properties/launchSettings.json`,
  `appsettings.json`, `appsettings.Development.json`
- Create: `src/RequestTracker.Core/RequestTracker.Core.csproj`, `DependencyInjection.cs`, `Caching/CacheKeys.cs`
- Create: `src/RequestTracker.Infrastructure/RequestTracker.Infrastructure.csproj`, `DependencyInjection.cs`
- Create: `tests/RequestTracker.UnitTests/RequestTracker.UnitTests.csproj`,
  `tests/RequestTracker.IntegrationTests/RequestTracker.IntegrationTests.csproj`
- Create: `.gitignore` (`dotnet new gitignore`)

**Interfaces:**
- Produces: `RequestTracker.Core.DependencyInjection.AddCore(this IServiceCollection) : IServiceCollection` — registers
  `TimeProvider.System` (singleton) and `AddHybridCache()`.
- Produces: `RequestTracker.Infrastructure.DependencyInjection.AddInfrastructure(this IServiceCollection, IConfiguration)
  : IServiceCollection` — no registrations yet; a one-line comment says task 05 adds the DbContext.
- Produces: `RequestTracker.Core.Caching.CacheKeys` — `public const string Stats = "stats";`
  `public const string StatsTag = "stats";`
- Produces: a `Program` type visible to `WebApplicationFactory<Program>` (ASP.NET Core 10 generates it public; add
  `public partial class Program;` only if the build says otherwise).

- [ ] **Step 1: Create the branch** inside `backend/` (see Global Constraints).
- [ ] **Step 2: Create the solution and projects.** `dotnet new sln -n RequestTracker --format sln`; `webapi
  --use-controllers` for Api (delete the WeatherForecast sample); `classlib` for Core and Infrastructure (delete
  `Class1.cs`); `xunit` for both test projects (delete `UnitTest1.cs`). Add all five to the solution.
- [ ] **Step 3: `Directory.Build.props`** sets `TargetFramework` `net10.0`, `Nullable` `enable`, `ImplicitUsings`
  `enable`; remove those three from the individual `.csproj` files.
- [ ] **Step 4: References.** Api → Core, Infrastructure. Infrastructure → Core. Core → nothing. UnitTests → Core, Api.
  IntegrationTests → Api. Packages: Core gets `FluentValidation` and `Microsoft.Extensions.Caching.Hybrid`; Api gets
  `Microsoft.AspNetCore.OpenApi` (already in the template) and `Swashbuckle.AspNetCore.SwaggerUI`; IntegrationTests
  gets `Microsoft.AspNetCore.Mvc.Testing`.
- [ ] **Step 5: Implement `AddCore`, `AddInfrastructure`, `CacheKeys`** as in Interfaces. `Program.cs` calls
  `AddCore()`, `AddInfrastructure(builder.Configuration)` and `AddControllers()`, maps controllers. `launchSettings.json`
  keeps one `http` profile on `http://localhost:5100`, `launchUrl` `swagger`, `ASPNETCORE_ENVIRONMENT=Development`.
- [ ] **Step 6: Verify the layering.**
  Run: `dotnet build RequestTracker.sln` → `Build succeeded`, 0 warnings.
  Run: `dotnet list src/RequestTracker.Core reference` → `There are no Project to Project references`.
- [ ] **Step 7: Commit** — stop, show `git status` / the diff summary, ask. Proposed message:
  `04: Add solution with layered projects and DI composition`

### Task 2: Local run setup

**Files:**
- Create: `compose.yaml`, `.config/dotnet-tools.json`
- Modify: `src/RequestTracker.Api/appsettings.Development.json`, `README.md`

**Interfaces:**
- Produces: connection string name `ConnectionStrings:RequestTracker` (task 05 reads it in `AddInfrastructure`).

- [ ] **Step 1: `compose.yaml`** — one service `sqlserver`, image `mcr.microsoft.com/mssql/server:2022-latest`,
  `ACCEPT_EULA=Y`, `MSSQL_SA_PASSWORD=RequestTracker_Dev1!` (dev-only, say so in a comment), port `1433:1433`, named
  volume `sqlserver-data` on `/var/opt/mssql`, healthcheck
  `/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$$MSSQL_SA_PASSWORD" -Q "SELECT 1"`.
- [ ] **Step 2: Connection string** in `appsettings.Development.json`:
  `Server=localhost,1433;Database=RequestTracker;User Id=sa;Password=RequestTracker_Dev1!;TrustServerCertificate=True`.
  `appsettings.json` has no connection string.
- [ ] **Step 3: Local tool.** `dotnet new tool-manifest`, `dotnet tool install dotnet-ef` at the latest 10.0.x.
- [ ] **Step 4: Verify.**
  Run: `docker compose up -d` then `docker compose ps` → `sqlserver` shows `healthy` (allow ~30 s).
  Run: `dotnet tool restore` then `dotnet ef --version` → `10.0.x`.
- [ ] **Step 5: README "Run locally"** in `backend/README.md`, keeping the existing pointer line: prerequisites (.NET 10
  SDK, Docker Desktop running, ~2 GB RAM for SQL Server), `docker compose up -d`, `dotnet tool restore`,
  `dotnet run --project src/RequestTracker.Api`, Swagger UI at `http://localhost:5100/swagger`, `dotnet test`
  (no Docker needed yet). One line: the schema is applied on startup from task 05 on.
- [ ] **Step 6: Commit** — stop, show, ask. Proposed: `04: Add SQL Server compose file and local run instructions`

### Task 3: Error contract

**Files:**
- Create: `src/RequestTracker.Core/Exceptions/NotFoundException.cs`, `ConcurrencyConflictException.cs`,
  `InvalidStatusTransitionException.cs`
- Create: `src/RequestTracker.Api/ErrorHandling/GlobalExceptionHandler.cs`
- Modify: `src/RequestTracker.Api/Program.cs`
- Create: `tests/RequestTracker.IntegrationTests/TestHost/ApiFactory.cs`, `TestHost/TestController.cs`,
  `ErrorHandlingTests.cs`
- Create: `tests/RequestTracker.UnitTests/ErrorHandling/GlobalExceptionHandlerTests.cs`,
  `ErrorHandling/FakeLogger.cs`

**Interfaces:**
- Produces: the three exceptions, each `sealed`, deriving from `Exception`, constructor `(string message)`. Later tasks
  may add constructors (e.g. task 10 adds from/to statuses).
- Produces: `GlobalExceptionHandler(IProblemDetailsService problemDetails, ILogger<GlobalExceptionHandler> logger) :
  IExceptionHandler`.
- Produces: `ApiFactory : WebApplicationFactory<Program>` — adds the test assembly as an MVC application part in
  `ConfigureTestServices`; later integration tests reuse it (task 05 adds the Testcontainers DB to it).
- Produces: `TestController` (`[ApiController]`, route `test`) — `GET throw/{kind}` throws by kind (`notfound`,
  `conflict`, `transition`, `validation`, `unexpected`); `GET json` and `POST json` used by Task 4.

Mapping inside `TryHandleAsync`, in this order:

| Exception | Status | `detail` | Extra |
|---|---|---|---|
| `OperationCanceledException` and `RequestAborted` cancelled | none written; return `true` | — | log at Information at most, never Error |
| `ValidationException` (FluentValidation) | 400 | — | `errors`: `PropertyName` camelCased (`JsonNamingPolicy.CamelCase`) → messages |
| `NotFoundException` | 404 | exception message | |
| `ConcurrencyConflictException` | 409 | exception message | |
| `InvalidStatusTransitionException` | 422 | exception message | |
| anything else | 500 | none | log Error with the exception, message template only |

Write the response through `problemDetails.TryWriteAsync` so `type`, `title` and `traceId` come from the framework.

- [ ] **Step 1: Write the failing integration tests** in `ErrorHandlingTests` (`IClassFixture<ApiFactory>`):

```csharp
[Theory]
[InlineData("notfound", 404)]
[InlineData("conflict", 409)]
[InlineData("transition", 422)]
public async Task Throw_DomainException_ReturnsMappedProblemDetails(string kind, int expected)
// assert StatusCode == expected, Content-Type media type "application/problem+json",
// body.status == expected, body.detail == the message TestController used

[Fact] Throw_ValidationException_Returns400WithCamelCaseErrors
// TestController throws ValidationException([new ValidationFailure("Status", "Status is required.")])
// assert 400, problem+json, errors["status"] == ["Status is required."], no "Status" key

[Fact] Throw_UnexpectedException_Returns500WithoutInternals
// TestController throws new InvalidOperationException("secret-internal-detail")
// assert 500, problem+json, raw body does not contain "secret-internal-detail",
// "InvalidOperationException" or "   at "; body has no "detail"

[Fact] UnknownRoute_Get_Returns404ProblemDetails          // GET /api/nope → 404, problem+json
[Fact] WrongMethod_DeleteOnGetEndpoint_Returns405ProblemDetails // DELETE /test/json → 405, problem+json
[Fact] MalformedJson_Post_Returns400ProblemDetails         // POST /test/json body "{" → 400, problem+json, has "errors"
```

- [ ] **Step 2: Run** `dotnet test tests/RequestTracker.IntegrationTests` → the new tests fail (exceptions and handler
  don't exist yet / 500s are HTML or empty).
- [ ] **Step 3: Implement** the exceptions and `GlobalExceptionHandler` per the table. In `Program.cs`:
  `AddProblemDetails()`, `AddExceptionHandler<GlobalExceptionHandler>()`; pipeline starts with
  `UseExceptionHandler()` then `UseStatusCodePages()`. In `AddControllers`, add
  `options.ModelMetadataDetailsProviders.Add(new SystemTextJsonValidationMetadataProvider())` so binding errors use the
  JSON (camelCase) names.
- [ ] **Step 4: Run** the integration tests → all pass.
- [ ] **Step 5: Write the unit test** `GlobalExceptionHandlerTests.TryHandleAsync_RequestAborted_DoesNotLogError`:
  `DefaultHttpContext` with `RequestAborted` from a cancelled `CancellationTokenSource`, exception
  `new OperationCanceledException()`; hand-written `FakeLogger<T>` records log levels; a fake `IProblemDetailsService`
  records calls. Assert: returns `true`, no `LogLevel.Error` entry, problem details service not called.
- [ ] **Step 6: Run** `dotnet test` → all pass.
- [ ] **Step 7: Manual check** — `dotnet run --project src/RequestTracker.Api`, `GET http://localhost:5100/api/nope`
  → 404 `application/problem+json` with `traceId`.
- [ ] **Step 8: Commit** — stop, show, ask. Proposed: `04: Map errors to ProblemDetails with a global handler`

### Task 4: JSON contract, OpenAPI and Swagger UI

**Files:**
- Modify: `src/RequestTracker.Api/Program.cs`
- Modify: `tests/RequestTracker.IntegrationTests/TestHost/TestController.cs`
- Create: `tests/RequestTracker.IntegrationTests/JsonContractTests.cs`, `OpenApiTests.cs`

**Interfaces:**
- Consumes: `ApiFactory`, `TestController` from Task 3.
- `TestController`: `GET json` returns `new TestPayload("Value", TestKind.Medium)`; `POST json` binds a `TestPayload`
  and echoes it. `TestPayload(string SomeValue, TestKind Kind)` record and `enum TestKind { Low, Medium, High }` live in
  the test assembly, with `SomeValue` marked `[Required]`.

- [ ] **Step 1: Write the failing tests:**

```csharp
// JsonContractTests
[Fact] Get_Payload_UsesCamelCaseAndStringEnums
// raw body == {"someValue":"Value","kind":"Medium"}

[Fact] Post_EnumAsString_Binds          // {"someValue":"x","kind":"High"} → 200, echoed kind "High"
[Fact] Post_EnumAsNumber_Returns400     // {"someValue":"x","kind":1} → 400, problem+json
[Fact] Post_MissingRequiredField_Returns400WithCamelCaseKey // {"kind":"Low"} → 400, errors has "someValue"

// OpenApiTests
[Fact] Get_OpenApiDocument_Returns200   // GET /openapi/v1.json → 200, body contains "\"openapi\""
[Fact] Get_SwaggerUi_Returns200         // GET /swagger/index.html → 200, text/html
```

- [ ] **Step 2: Run** → enum/number and OpenAPI/Swagger tests fail.
- [ ] **Step 3: Implement.** `AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(new
  JsonStringEnumConverter(allowIntegerValues: false)))` (camelCase is the web default). `AddOpenApi()`. In Development
  only: `MapOpenApi()` and `UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"))`.
- [ ] **Step 4: Run** `dotnet test` → all pass.
- [ ] **Step 5: Manual check** — run the API, open `http://localhost:5100/swagger`: the page loads the v1 document.
  Check the test controller does **not** appear (it lives only in the test assembly).
- [ ] **Step 6: Commit** — stop, show, ask. Proposed: `04: Add JSON contract, OpenAPI document and Swagger UI`

### Task 5: Wrap-up

**Files:**
- Modify (main repo, coordinating session or with the PR): `docs/AI_USAGE.md` — task 04 entry.

- [ ] **Step 1: Full check** in `backend/`: `dotnet build` (0 warnings), `dotnet test` (all green), `docker compose up
  -d` healthy, API starts and serves `/swagger`.
- [ ] **Step 2: `/code-review`** on the branch; fix findings.
- [ ] **Step 3: Ask before** pushing and opening the PR in `request-tracker-server`, titled
  `04: Backend skeleton, cross-cutting concerns and local run setup`. The description lists: the deviations above
  ("Calls made while planning", integration tests instead of handler unit tests), that `AddInfrastructure` is empty
  until 05, and that the schema-on-startup criterion moved to 05.
- [ ] **Step 4: AI_USAGE entry** — what was generated, what was checked by hand (error mapping, no internals in 500,
  port and password choices).
