# 14 Request Details and Status Update UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Never run `git commit` without the developer's explicit permission in the session.** Each "Commit" step means:
> stop, show what would be committed, and ask.

**Goal:** a details view opened from the list, showing every field of a request, and a status change with the server's
concurrency and transition rules surfaced to the user (409, 400, 422). `changedBy` is typed per change, starting from an
"acting as" name in the toolbar.

**Architecture:** the details view is a Material dialog opened by a child route `requests/:id` of the list, so the list
stays rendered behind it with its query string intact. A `RequestDetailsStore` (provided by the dialog) loads the
request and runs the status update; `RequestsApiService` gains `getById` and `updateStatus`. An app-wide
`ActingAsService` holds the toolbar name. The list reloads after a successful update.

**Tech Stack:** Angular 22 (standalone, signals, RxJS interop), Angular Material (dialog, menu, form field, select),
Vitest. No new packages.

**Spec:** `docs/PLAN.md` → task 14, US-3.1 and Status transitions; `CLAUDE.md` → Frontend conventions, Error responses,
API contract; `docs/code-patterns.md` → Angular; `docs/plan/09-list-ui.md` (the list this view opens from);
`docs/plan/10-status-concurrency.md` (the endpoints consumed).

## Design

**Dependencies:** task 10 (server) and task 09 (list, merged: client `main` `3fe3a87`). Branch
`feature/14-details-status-ui` in `request-tracker-client`, i.e. inside `frontend/`. The server's `GET api/requests/{id}`
and `PATCH api/requests/{id}/status` must be on `main` for the manual check; unit tests use fake HTTP.

**Visual target:** the developer's mockup (details modal over the list; header with request number, title, status pill
and a pencil; a "Change status" popover; the toolbar with the acting-as name). The history table on its right is
task 15: this task leaves that column empty and renders nothing for it (no placeholder).

**Delivers:**

- Rows in the list open the details view (the title is a link, and the row is clickable).
- The details dialog: loading, error (with Retry) and not-found states, every field, the status pill and the pencil.
- The status change popover with the outcomes below.
- The toolbar "Acting as" name.
- Not in this task: the history (15), the statistics refresh (16 adds the call; the list reloads here), bulk (11).

### Contract consumed

- `GET api/requests/{id}` → 200 `RequestDto`; 404 ProblemDetails.
- `PATCH api/requests/{id}/status`, body `{ status, version, changedBy }` → 200 the updated `RequestDto` (new `version`);
  400 (`errors` keyed `status`, `version`, `changedBy`), 404, 409, 422 as ProblemDetails.
- `changedBy` is trimmed by the server and must be non-blank, at most 100 characters.

### Route and dialog (my call)

- `app.routes.ts`: `requests` gets `children: [{ path: ':id', component: RequestDetailsRouteComponent }]`, and the list
  component renders a `<router-outlet />`. A non-numeric id redirects to `requests` (it can't be a request).
- `RequestDetailsRouteComponent` renders nothing itself. It opens `MatDialog` with `RequestDetailsComponent` and the id,
  and when the dialog closes (✕, Esc, backdrop) it navigates back to `requests` with `queryParamsHandling: 'preserve'`.
  Browser Back also closes the dialog, because the route leaves with it.
- The list, its store and its query string are untouched by opening and closing. Rows link with
  `queryParamsHandling: 'preserve'`, so the list state survives a refresh on `requests/1042?status=New`.
- The details content component is a separate class from the route host so it can be rendered in tests without a router.

### State and states

- `RequestDetailsStore` (`@Injectable()`, provided by `RequestDetailsComponent`) holds signals:
  `loadState: 'loading' | 'success' | 'error' | 'notFound'`, `request: RequestDto | null`, `errorMessage`, and for the
  update `saveState: 'idle' | 'saving'`, `saveError: string | null`, `conflict: boolean`.
- `load(id)` is `switchMap` with `catchError` inside; 404 → `notFound`, other errors → `error` with `problemMessage`.
  Retry reruns it. A reload keeps the current content visible and dimmed instead of blanking it (as the list does).
- **Not found** says "This request doesn't exist or was removed" with a Close button. **Error** shows the message and a
  Retry button.

### Status change

- The pencil opens a menu panel with a form: a "New status" select, a "Changed by" text input and Cancel / Save changes.
  Clicks inside the form don't close the panel (the builder may use a CDK overlay if `mat-menu` fights the form).
- **No preselected status** (my call: the current status isn't a valid target, and choosing nothing by default avoids
  one-click mistakes). Save is disabled until a status is chosen and `changedBy` is non-blank after trimming.
- **The select offers all four statuses.** The UI doesn't repeat the transition matrix (constraint 9); a disallowed
  target, including the current status, gets the server's 422 message in the panel.
- **`changedBy` starts from the toolbar name every time the panel opens** and is editable for that one change
  (developer's decision: a new change gets a new `changedBy`). Editing it doesn't change the toolbar name. `maxlength` 100.
  Nothing is stored in the browser: a refresh loses an unsaved edit.
- On Save the store sends the `version` of the request it holds. While saving, the form is disabled.
- **200:** the store replaces `request` with the response (new `version`, `status`, `updatedAt`), the panel closes, and
  the list reloads (`RequestsStore.retry()`, which reruns the same query; the dialog injects it from the list's
  element injector, see Task 4). The pill and "Last updated" update.
- **409:** the panel closes and the dialog shows "Someone else changed this request. Showing the latest version."
  while the store reloads it (`GET`); the message stays until the user opens the panel again or closes the dialog. The
  list reloads too, so the row matches.
- **400 or 422:** the panel stays open and shows `problemMessage(error)` under the form (the server's message; for 400
  the field messages). The user can change the status or name and save again; nothing is reloaded.
- **404 on save:** the dialog switches to the not-found state.
- **Network error (status 0):** the panel stays open with the "Can't reach the server" message.

### Acting as (developer's decision)

- `ActingAsService` (`core/acting-as.service.ts`, `providedIn: 'root'`): a signal `name` (starts empty, per the
  developer: nothing is persisted) and `setName(text)`.
- The app toolbar gets an "Acting as" text input (right side, avatar with initials when non-empty, placeholder
  "Acting as…"). `maxlength` 100. The name isn't validated until a change is saved.
- An empty toolbar name just gives an empty "Changed by" box, which blocks Save.

### Details layout

- Header: "REQUEST #id" (muted), the title, the status pill (`app-status-pill`), the pencil button (`aria-label`
  "Change status"), and a close button.
- Body: Organization, Assigned to (initials circle and name), Priority (pill), Created, Last updated. Timestamps in
  UTC as in the list (`yyyy-MM-dd HH:mm`, labeled UTC). `version` is never shown.
- The dialog is a fixed width on desktop and full width with a 16 px gutter on narrow screens.

### Files (in `frontend/src/app/`)

| File | Responsibility |
|---|---|
| `core/models/request.model.ts` | add `UpdateStatusRequest { status; version; changedBy }` |
| `core/api/requests-api.service.ts` | add `getById(id)` and `updateStatus(id, body)`; no state |
| `core/acting-as.service.ts` | toolbar name signal |
| `app.component.ts` | toolbar "Acting as" input |
| `features/requests/request-details/request-details.store.ts` | load, save and their states |
| `features/requests/request-details/request-details.component.{ts,html,scss}` | dialog content: fields, states, status panel |
| `features/requests/request-details/request-details-route.component.ts` | route host: opens and closes the dialog |
| `features/requests/requests-table/requests-table.component.*` | title link and row click (emits/links to `requests/:id`) |
| `features/requests/requests-list/requests-list.component.*` | `<router-outlet />` |
| `app.routes.ts` | child route `:id` |

Shared files touched, to list in the PR: `app.component.ts`, `app.routes.ts`, `request.model.ts`,
`requests-api.service.ts` (all shared with tasks 15 and 16), `requests-table` and `requests-list` (the list slice).

### How it is checked

- **Vitest unit tests** (names in the tasks below).
- **Manual check with two browser tabs** on the seeded database, recorded in the PR: open the same request in both;
  change it to In progress in tab A; in tab B change it to Waiting → the conflict message, the reloaded status and
  `version`, and then a second attempt succeeds. Also: a disallowed transition shows the 422 text in the panel; a
  blank name blocks Save; a refresh on `requests/<id>` reopens the dialog over the same list; an unknown id shows
  not-found; the list row shows the new status after a save.
- `ng build`, `ng lint`, `ng test` and `prettier --check` pass.

### Left to the builder

Exact copy of messages, spacing and widths, the panel mechanism (menu or CDK overlay), the test file split.

## Global Constraints

- Standalone components, `ChangeDetectionStrategy.OnPush`, `@if`/`@for`, `inject()`, `input()`/`output()`/`computed()`.
  No `any`. Strict TypeScript. No NgRx. Components never inject `HttpClient`.
- Inline template and styles while short; move to `.html`/`.scss` past about 60 lines.
- No client-side transition rules. The server's messages explain rejections.
- Subscriptions use `takeUntilDestroyed()` or `toSignal`. `catchError` inside the `switchMap` inner observable.
- No sensitive data in the console (no `changedBy`, no bodies).
- Tests: Vitest (globals), names `methodName_Scenario_ExpectedResult`, Arrange / Act / Assert separated by a blank
  line, hand-written fakes (`vi.fn` at most).
- Work inside `frontend/` on `feature/14-details-status-ui`, created from `origin/main` after `git submodule update
  --init`. No submodule pointer change in the main repository.
- Run `npm ci` once inside `frontend/` before the first test run.

## Review Focus

1. **A 409 must reload and say so**, and the next save uses the new `version`. → Task 3
   `updateStatus_Conflict_ReloadsAndNextSaveUsesNewVersion`.
2. **A 422 or 400 keeps the panel open with the server's text**, and nothing is reloaded. → Task 3
   `updateStatus_Rejected_ShowsServerMessageAndKeepsRequest`.
3. **`changedBy` is per change.** Edit it, save, reopen: it starts from the toolbar name again; the toolbar name never
   changes. → Task 4 `statusPanel_Reopened_StartsFromToolbarName`.
4. **No transition rules in the client.** → review the diff for any status comparison; Task 4
   `statusPanel_Open_OffersAllStatuses`.
5. **A refresh on `requests/:id`** reopens the dialog and the list keeps its filters. → Task 5 test and manual check.

---

### Task 1: Models and API calls

**Files** (relative to `frontend/src/app/`): modify `core/models/request.model.ts`,
`core/api/requests-api.service.ts`; test `core/api/requests-api.service.spec.ts`.

**Interfaces — Produces:**
- `interface UpdateStatusRequest { status: RequestStatus; version: string; changedBy: string }`.
- `getById(id: number): Observable<RequestDto>` → `GET /api/requests/{id}`.
- `updateStatus(id: number, body: UpdateStatusRequest): Observable<RequestDto>` → `PATCH /api/requests/{id}/status`.

- [ ] **Step 1: Write the failing tests** (`HttpTestingController`):
  - `getById_Id_RequestsThatUrl`; `getById_Response_ReturnsBody`.
  - `updateStatus_Body_SendsPatchWithStatusVersionAndChangedBy` (method, URL and exact body).
  - `updateStatus_Response_ReturnsUpdatedRequest`.
- [ ] **Step 2: Run** `npx ng test --watch=false` → the new specs fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx ng test --watch=false` → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `14: Add the request details and status update API calls`

### Task 2: Acting-as name in the toolbar

**Files:** create `core/acting-as.service.ts`; modify `app.component.ts`; test `core/acting-as.service.spec.ts`,
`app.component.spec.ts`.

**Interfaces — Produces:** `ActingAsService` with `readonly name: Signal<string>` (starts `''`) and
`setName(text: string): void`.

- [ ] **Step 1: Write the failing tests:**
  - `name_Initially_IsEmpty`; `setName_Text_UpdatesName`.
  - `toolbar_Typing_UpdatesActingAsName`; `toolbar_EmptyName_ShowsPlaceholderAndNoAvatar`;
    `toolbar_NameSet_ShowsInitials` (reuse `shared/initials.ts`).
- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement.** The input is limited to 100 characters.
- [ ] **Step 4: Run** → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `14: Add the acting-as name to the toolbar`

### Task 3: Details store

**Files:** create `features/requests/request-details/request-details.store.ts`; test `request-details.store.spec.ts`.

**Interfaces:**
- Consumes: `RequestsApiService` (Task 1), `problemMessage`.
- Produces: `RequestDetailsStore` with the signals in "State and states" and actions `load(id)`, `retry()`,
  `updateStatus(status: RequestStatus, changedBy: string): void`, `dismissConflict(): void`, and an `updated`
  output-like `Subject<void>` (`updated$`) that emits after every successful save and after a 409's reload, so the
  component can reload the list.

- [ ] **Step 1: Write the failing tests** (hand-written fake API returning `Subject`s):
  - `load_Success_ShowsRequest`; `load_NotFound_ShowsNotFound`; `load_Error_ShowsMessageAndRetryReloads`.
  - `load_NewIdWhilePending_CancelsPreviousRequest`.
  - `updateStatus_Success_ReplacesRequestWithResponseAndEmitsUpdated`: new `version` and `updatedAt` kept.
  - `updateStatus_Always_SendsHeldVersionStatusAndChangedBy`.
  - `updateStatus_Conflict_ReloadsAndNextSaveUsesNewVersion`: `conflict()` true, a `GET` follows, the next `PATCH`
    carries the reloaded `version`.
  - `updateStatus_Rejected_ShowsServerMessageAndKeepsRequest`: 422 and 400 each set `saveError` to
    `problemMessage(...)`, no `GET`, `saveState` back to `idle`.
  - `updateStatus_NotFound_SwitchesToNotFound`; `updateStatus_NetworkError_ShowsCannotReachServer`.
  - `updateStatus_WhileSaving_IgnoresSecondCall` (no double submit).
- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement.** `saveError` clears when a new save starts; `conflict` clears on `dismissConflict()`
  (called when the panel opens) and when the dialog closes.
- [ ] **Step 4: Run** → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `14: Add the request details store with the status update`

### Task 4: Details dialog and status panel

**Files:** create `features/requests/request-details/request-details.component.{ts,html,scss}`; test
`request-details.component.spec.ts`.

**Interfaces:**
- Consumes: `RequestDetailsStore` (Task 3), `ActingAsService` (Task 2), `StatusPillComponent`, `RequestsStore` (injected
  with `{ optional: true }` so the component renders without a list), `MAT_DIALOG_DATA` (`{ id: number }`).
- Produces: `RequestDetailsComponent` (`providers: [RequestDetailsStore]`).

- [ ] **Step 1: Write the failing tests** (fake store via `overrideComponent`):
  - `render_Loading_ShowsProgress`; `render_Error_ShowsMessageAndRetry`; `render_NotFound_ShowsNotFoundAndClose`.
  - `render_Success_ShowsEveryFieldAndNoVersion` (organization, assignee, priority, created, last updated in UTC).
  - `statusPanel_Open_OffersAllStatuses`: four options, the current one included.
  - `statusPanel_Reopened_StartsFromToolbarName`: edit the name, save, reopen → the toolbar name again.
  - `statusPanel_NoStatusChosen_DisablesSave`; `statusPanel_BlankChangedBy_DisablesSave`.
  - `statusPanel_Save_CallsStoreWithStatusAndTrimmedName`.
  - `statusPanel_SaveError_ShowsServerMessageAndStaysOpen`.
  - `render_Conflict_ShowsSomeoneElseChangedMessage`.
  - `updated_Emitted_ReloadsList`: the store's `updated$` calls `RequestsStore.retry()`.
- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement** per Design: the dialog content, the panel, the pill and the pencil.
- [ ] **Step 4: Run** → all pass.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `14: Add the request details dialog with the status panel`

### Task 5: Route, list wiring and links

**Files:** create `features/requests/request-details/request-details-route.component.ts`; modify `app.routes.ts`,
`requests-list.component.{ts,html}`, `requests-table.component.{ts,html}`; tests in the existing specs plus
`request-details-route.component.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `route_IdParam_OpensDialogWithThatId`; `route_DialogClosed_NavigatesToListPreservingQuery`.
  - `route_NonNumericId_RedirectsToList`.
  - `render_Items_TitleLinksToDetailsPreservingQuery`; `rowClick_Row_NavigatesToDetails`.
  - `render_ChildRoute_ListStaysRendered` (the list's table is still there with the dialog open).
  - An integration-style test with the real router: `requests/5?status=New` → the list's store loads with
    `status=New` and the dialog loads request 5; closing returns to `requests?status=New`.
  - That the dialog can inject the list's `RequestsStore` through the router outlet is checked here
    (`updated_Emitted_ReloadsList` in Task 4 only proves the call).
- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement.** If the outlet doesn't expose the list's store to the dialog (its injector is the
  dialog's), pass a close/updated callback in the dialog data instead; keep the behavior and tests the same.
- [ ] **Step 4: Run** `npx ng test --watch=false`, `npx ng lint`, `npx ng build`, `npx prettier --check .` → all
  pass, 0 warnings.
- [ ] **Step 5: Commit**: stop, show, ask. Proposed: `14: Open request details from the list`

### Task 6: Manual check and PR

- [ ] **Step 1: Sync** inside `frontend/`: `git fetch origin`, `git merge origin/main`.
- [ ] **Step 2: Run the stack.** In `backend/`: `docker compose up -d`,
  `dotnet run --project src/RequestTracker.Api -- seed`, `dotnet run --project src/RequestTracker.Api`. In
  `frontend/`: `npx ng serve`.
- [ ] **Step 3: Two-tab check** from "How it is checked", with a note and a screenshot of the conflict message for the
  PR.
- [ ] **Step 4: Verify** the four commands above, then run `/code-review`.
- [ ] **Step 5: Push and open the PR** in `request-tracker-client` after the developer approves the commits. Title
  `14: Request details and status update UI`. Description: what was done; the manual-check results; deviations (details
  as a dialog on a child route; no preselected status; the list reloads via `retry()` and the statistics refresh is
  added by task 16); shared files touched.
