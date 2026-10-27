# 17 Performance Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Never run `git commit` without the developer's explicit permission in the session.** Each "Commit" step means:
> stop, show what would be committed, and ask.

**Goal:** Show with measurements on 100,000 seeded rows that the main operations run efficiently, that every index has
a reason, and that the likely bottlenecks are identified with a proposed improvement.

**Architecture:** No product code by default. Measure with SQL Server's actual execution plans and
`SET STATISTICS IO, TIME ON`, run against the seeded Docker database, then write the results to
`docs/PERFORMANCE.md`. A migration in the server repository is added only if a measurement shows an index must change.

**Tech Stack:** SQL Server 2022 (Docker), `dotnet run … -- seed`, SSMS or Azure Data Studio (or `sqlcmd`) for plans,
EF Core query logging for the generated SQL. No new packages.

**Spec:** `docs/PLAN.md` → task 17 and US-7.1; exam §1, §6, §11; `CLAUDE.md` → Indexes;
`docs/code-patterns.md` → Repository; known inputs from `docs/plan/08-list-api.md` (deep-page `OFFSET`, count and page
as separate statements).

## Design

**Dependencies:** task 13 (stats) merged, which brings in 08 and 10 and (through 11) the bulk path. Check on `main`
before starting. In phase 3 only this task may change the schema.

**Scope.** The core is the list endpoint (A) and the statistics query (B), as `docs/PLAN.md` requires. The bulk update
(C) is also measured. `docs/PLAN.md` does not require it, so the PR description notes it as an addition to the task
text. Do A and B first, then C.

**Plans are hypotheses.** Each scenario states the expected plan first, as a hypothesis to test. A Scan or a Sort
step alone does not justify an index change. An index changes only when a before-and-after measurement shows a real
improvement (logical reads, CPU, elapsed median) and the write cost of the new index has been considered.

**Rules for a fair measurement:**

- The seed is deterministic (fixed random seed), so two runs give the same data. Record the seed command and the row
  count in `PERFORMANCE.md`.
- **Replay the EF-generated SQL, parameters intact.** Capture the SQL EF Core actually generates (do not hand-write
  it), and run it through `sp_executesql` with the same parameter declarations and values as EF sent. Do not replace
  parameters with literals: literals change plan choice and plan reuse, so the measured plan would not be the one the
  API gets. This also shows that filtering, sorting and paging run in the database.
- **One warm-up, then five measured runs; report the median** of logical reads, CPU and elapsed time. Logical reads
  are the primary metric (stable); elapsed time is supporting. Cold-cache numbers are not reported.
- **Common and rare filter values.** For every filter scenario, measure a value that matches many rows and one that
  matches few (found from the seeded distribution, e.g. `GROUP BY` counts), since the plan and cost can differ.
  Record the match counts next to the results.
- Update statistics after seeding (`UPDATE STATISTICS Requests WITH FULLSCAN`) so plans reflect the data.

## Scenarios

### A. List endpoint (`GET api/requests`)

| # | Scenario | Hypothesis | What to check |
|---|---|---|---|
| A1 | Default (`createdAt:desc`, page 1) | Backward scan of `IX_Requests_CreatedAt`, no Sort, top N | Reads stay near the page size, not 100k |
| A2 | `status=X` + default sort, common and rare value | Seek on `IX_Requests_Status_CreatedAt` | Whether the rare and the common value get the same plan; no Sort step |
| A3 | `status=X&status=Y` (OR) + default sort | Seek on the same index, possibly Merge/Sort | Whether a Sort step appears, and its cost |
| A4 | `assignedTo=…` and `priority=…` + default sort, common and rare | Seek on the matching `(Field, CreatedAt)` index | Index chosen, and which filter is not covered when two are combined |
| A5 | `organizationName=prefix`, common and rare prefix | Seek on `IX_Requests_OrganizationName` (`LIKE 'x%'`) | Sargable; compare with a contains match to show the contrast |
| A6 | `search=text` (`LIKE '%x%'`), common and rare text | Scan | Candidate bottleneck 1 |
| A7 | `sort=title` and `sort=updatedAt` | Sort step on the filtered set (no index) | Candidate bottleneck 2; see Decisions for what an index change needs |
| A8 | Deep page (e.g. page 5000, size 20) vs page 1 | `OFFSET` reads and discards skipped rows | Candidate bottleneck 3; how reads grow with the page number |
| A9 | The `COUNT(*)` of A1, A2 and A6 | Index scan/seek count | Candidate bottleneck 4: count over a large filtered set |

For A1–A8 record the page query and its count query separately, since they are separate statements. A hypothesis
that the measurement contradicts is a result, and goes in the document as such.

### B. Statistics (`GET api/requests/stats`), cache miss

- Measure each statement the stats query issues (count by status, open-request age buckets, top assignees), not just the
  endpoint total, replayed with `sp_executesql` as described above.
- Hypothesis: count by status uses `IX_Requests_Status_CreatedAt`; the age buckets and top assignees may scan. Record
  which does, and whether a scan is a problem at 100k rows given the 5-minute cache.
- Show the cache effect: first call versus a call within the 5 minutes (the DB is not hit), and a call after a status
  update (the tag is invalidated, the DB is hit again).

### C. Bulk status update (`PATCH api/requests/bulk-status`)

- **Reproducible test data:** a script or seed step that creates the items deterministically (fixed ids and
  `version` values read just before the run, a fixed share of stale versions for the mixed case) and restores the
  database to the same state before each run. Without a reset, runs after the first measure different rows.
- **Several batch sizes** (e.g. 1, 10, 50, 100), each with the warm-up plus five runs and the median. Describe the
  growth as it is measured; claim linear scaling only if the sizes show it.
- Measure per statement (conditional update, audit insert, read-back, commit) as well as the total. Total duration
  includes round trips, commits and log writes, so it is not a measurement of index maintenance cost. To estimate the
  write cost of an index, compare the same update with and without that index (or the logical reads and log written
  of the update statement), not the bulk total.

## Decisions to make from the measurements

- **Index changes (`UpdatedAt`, `Title`, or any other):** a Scan or a Sort in a plan is not enough. Add an index only
  when the before-and-after median shows a measurable improvement for a scenario that matters at this data volume
  and page size, and the write cost has been considered (every extra index is maintained on writes; `UpdatedAt` changes
  on every status update). The default is to leave them unindexed and document the cost.
- **`search`:** keep as a documented bottleneck with Full-Text Search as the proposed improvement (not in the default
  Docker image). Do not add an index that cannot help `LIKE '%x%'`.
- **Deep offsets and `COUNT`:** keep the page-number contract. Propose keyset paging and an approximate or capped count
  as improvements, and say which contract change they would need.
- **Count and page inconsistency:** documented as a known limitation, as decided in `docs/plan/08-list-api.md`. This
  task does not change it. `READ_COMMITTED_SNAPSHOT` is not proposed as a fix: it gives statement-level consistency,
  so the count and the page would still see different versions. A consistent view needs both queries in one `SNAPSHOT`
  isolation transaction; that is a possible future change with its own cost and is not implemented here.

## Files

| File | Change |
|---|---|
| `docs/PERFORMANCE.md` (main repo) | New. The deliverable |
| `docs/plan/17-performance.md` | This file |
| Server repo: entity configurations and a new migration | Only if a measurement requires an index change |

Do not touch other files. Plan state changes go through the task board.

## Steps

- [ ] **Step 1: Prepare.** `git submodule update --init`; confirm tasks 08, 10, 11, 13 are on `main`. Start SQL Server in
  Docker, run `dotnet run --project backend/src/RequestTracker.Api -- seed`, then `UPDATE STATISTICS … WITH FULLSCAN`.
  Verify the row count is 100,000.
- [ ] **Step 2: Capture the SQL.** Enable EF Core command logging in Development only, with parameter values shown
  only on the local seeded database (no real data), call each endpoint scenario, and save the generated SQL with its
  parameter declarations and values for A, B and C. Revert any logging change; do not commit it.
- [ ] **Step 3: Pick filter values.** From the seeded distribution, choose a common and a rare value for each filter
  and record their match counts.
- [ ] **Step 4: Measure A (list).** For each scenario replay the page and count statements through `sp_executesql`
  with `SET STATISTICS IO, TIME ON` and the actual plan: one warm-up, five measured runs. Record the index used, the
  median logical reads, CPU and elapsed time, and the plan shape. Save plan XML or a screenshot under `docs/` only if
  small.
- [ ] **Step 5: Measure B (stats).** Same method for each stats statement, then the cache behaviour through the API.
- [ ] **Step 6: Decide.** Compare results with the hypotheses. Apply the decisions above. If an index change meets the
  bar (measured improvement, write cost considered): add the configuration and a migration in the server repository on
  `feature/17-performance`, re-measure the affected scenario with the same method, and record before and after.
- [ ] **Step 7: Measure C (bulk).** Build the reproducible data, measure the batch sizes, and follow the rules in
  section C.
- [ ] **Step 8: Write `docs/PERFORMANCE.md`.** Sections: environment and method (including the `sp_executesql` replay
  and the warm-up plus median rule); index table with the reason for each index (from `CLAUDE.md` → Indexes, updated by
  the results); how the API avoids loading data into memory (filter → count → sort → page → project in SQL, page size
  capped at 100, with the generated SQL as proof); a table per operation with plan summary and median metrics for the
  common and rare values; bottlenecks, each with a proposed improvement and its cost; limitations.
- [ ] **Step 9: Check.** Every scenario has a plan and a median metric; every index has a reason; at least one
  bottleneck has an improvement; the numbers can be reproduced from the stated commands. If a migration was added:
  build, run all tests, run `/code-review`.
- [ ] **Step 10: Commit.** Stop, show what would be committed in each repository, and ask for permission. PR title
  starts with `17:`; the description notes the added bulk measurement (C), any index change with its
  before-and-after evidence, and the known count/page limitation.

## Risks

- Timings on a laptop container are noisy: lead with median logical reads and plan shape, and treat elapsed time as
  supporting data.
- Literals instead of parameters, or a rare value only, can give a plan the API never gets: replay with parameters and
  test both value kinds.
- A plan can differ on 100k rows from what a small database suggests; always measure on the seeded data with fresh
  statistics.
- Do not tune for the benchmark: an index not justified by a measured improvement costs every write.

## Known limitations to carry to the README (task 19)

- `search` scans; Full-Text Search is the proposed fix.
- `OFFSET` cost grows with the page number, because skipped rows are still read. `COUNT` cost depends on the data and
  the filters (the size of the filtered set), not on the page number.
- The count and the page are separate statements, so `totalCount` can differ from the rows when a write commits
  between them. A consistent view would need both queries in one `SNAPSHOT` transaction; not done.
