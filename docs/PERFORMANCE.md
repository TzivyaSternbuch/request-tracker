# Performance

Measurements of the list endpoint, the statistics query and the bulk status update on 100,000 seeded requests, the
reason for every index, and the bottlenecks with a proposed improvement for each. Task 17; exam §1, §6, §11.

**Result in one paragraph.** All filtering, counting, sorting and paging run in SQL Server, and only the requested
page (at most 100 rows) is returned to the application. That does not mean every query is cheap: the common cases
(default list, status, assignee and priority filters) read about 64 pages for the page statement, but text search,
deep pages and a selective filter answered by scanning the default sort index read tens of thousands of pages to return
20 rows (see the bottlenecks). No index was added or changed: the sorts on `title` and `updatedAt` cost about 25 ms
at 100,000 rows, which the measurements show to be acceptable, while an `UpdatedAt` index would add about 42 % log
bytes to every status update. Five bottlenecks are documented with a proposed improvement each; none is implemented.

## Environment and method

| Item | Value |
|---|---|
| Database | SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) in Docker on a development laptop |
| Server code | `request-tracker-server` `main` at `96e24aa` (tasks 08, 10, 11, 12, 13 merged) |
| Data | `dotnet run --project backend/src/RequestTracker.Api -- seed` → 100,000 `Requests`, 0 `RequestStatusHistory` rows (see the note on data drift below) |
| Statistics | `UPDATE STATISTICS Requests WITH FULLSCAN` after seeding |
| Metrics | `SET STATISTICS IO, TIME ON` and the actual execution plan (`SET STATISTICS XML ON`) |

**Replaying the real SQL.** The statements were not written by hand. Command logging was switched on temporarily in
the Development API (`EnableSensitiveDataLogging()` plus the log level of
`Microsoft.EntityFrameworkCore.Database.Command` set to `Information`, both reverted, nothing committed), each URL
below was called once, and the logged statements were replayed through `sp_executesql` with the parameter types and
values EF sent, for example:

```sql
EXEC sp_executesql
  N'SELECT [r].[Id], [r].[Title], [r].[OrganizationName], [r].[Status], [r].[Priority], [r].[AssignedTo],
           [r].[CreatedAt], [r].[UpdatedAt], [r].[Version]
    FROM [Requests] AS [r]
    WHERE [r].[Status] = @parameters_Status1
    ORDER BY [r].[CreatedAt] DESC, [r].[Id] DESC
    OFFSET @p ROWS FETCH NEXT @p2 ROWS ONLY',
  N'@parameters_Status1 int, @p int, @p2 int',
  @parameters_Status1 = 2, @p = 0, @p2 = 20;
```

Parameters stay parameters (literals would change plan choice), so the measured plan is the one the API gets. The
page query and the count query are separate statements, so each is reported on its own.

**Statistics.** One warm-up run, then five measured runs on a warm cache; the table reports the **median logical
reads** (stable, the primary metric) and the median CPU and elapsed time in ms (supporting only: a laptop container is
noisy, and times under 1 ms are shown as `<1`). Cold-cache numbers are not reported. Reads are summed over all tables
and indexes of the statement.

**Data drift.** The Docker database is shared with another running API instance that was used for manual testing
during these measurements. A few status changes were written by it while the measurements ran (the history table
held 7 rows afterwards, written by users other than this analysis). That is why a row count such as the open
requests is 30,086 in some plans and 30,083 in a later re-measurement, while the seed gives 30,085 (100,000 − 69,915
`Completed`). A difference of a few rows does not change plan shapes or logical reads; the row counts in this
document are the seed's, and the `actual rows` quoted for the stats plans are within three rows of them. The bulk
benchmark (C) restores its own 100 rows before every run, and the write-cost test is rolled back.

**Filter values.** Common and rare values were taken from the seeded distribution:

| Filter | Common value (rows) | Rare value (rows) |
|---|---|---|
| `status` | `Completed` (69,915) | `Waiting` (8,056) |
| `priority` | `Medium` (49,923) | `High` (19,905) |
| `assignedTo` | `Henry Young` (2,641) | `Nathan Clark` (2,409) — the seed spreads requests evenly over 40 assignees, so there is no truly rare assignee |
| `organizationName` prefix | `Red` (9,463) | `Silverline Software` (146) |
| `search` | `reset` (5,045) | `projector in training` (68) |

The seeded status mix is skewed on purpose (most requests `Completed`), which is why the stats and status filters
differ by value.

## Indexes

| Index | Reason | Measured use |
|---|---|---|
| PK clustered `Requests(Id)` | get by id, `Id` tiebreaker, row lookup for the page's columns | Key lookup of every page row (A1–A8) |
| `IX_Requests_CreatedAt` | default sort `createdAt desc` and paging without a sort step | A1, A8; also chosen for the page of rare filters (A3, A5, A6) |
| `IX_Requests_Status_CreatedAt` | `status` filter with the default sort; stats count by status | A2, A3 (count), B1–B3 |
| `IX_Requests_Priority_CreatedAt` | `priority` filter with the default sort | A4 |
| `IX_Requests_AssignedTo_CreatedAt` | `assignedTo` filter with the default sort; stats top assignees | A4, B3 |
| `IX_Requests_OrganizationName` | `organizationName` prefix (`LIKE 'x%'` is sargable) | A5 count: 7 reads against 597 for a full count; the page query did not choose it (see A5) |
| `IX_RequestStatusHistory_RequestId_ChangedAt (RequestId, ChangedAt DESC)` | history endpoint, newest first | Not measured here: the history table is empty after seeding and the endpoint is not one of the required scenarios |

Deliberately not indexed: `search` (a `LIKE '%x%'` cannot seek), `Title` and `UpdatedAt` (see A7 for the
before-and-after numbers and the write cost). Index sizes on the seeded data: PK 20.5 MB, `OrganizationName` 9.1 MB,
`AssignedTo_CreatedAt` 8.6 MB, `Status_CreatedAt` 5.2 MB, `Priority_CreatedAt` 5.1 MB, `CreatedAt` 4.7 MB.

## How the API avoids loading data into memory

The repository builds one `IQueryable` and EF Core translates all of it: filter → count → sort → page → project.
Nothing is materialized before the final `ToListAsync`, which returns at most `pageSize` rows (maximum 100,
enforced by the query validator). The default list page (`GET api/requests`) produces these two statements:

```sql
SELECT COUNT(*) FROM [Requests] AS [r]

SELECT [r].[Id], [r].[Title], [r].[OrganizationName], [r].[Status], [r].[Priority], [r].[AssignedTo],
       [r].[CreatedAt], [r].[UpdatedAt], [r].[Version]
FROM [Requests] AS [r]
ORDER BY [r].[CreatedAt] DESC, [r].[Id] DESC
OFFSET @p ROWS FETCH NEXT @p1 ROWS ONLY     -- @p = 0, @p1 = 20
```

With a filter (`status=Waiting`) the predicate is part of both statements
(`WHERE [r].[Status] = @parameters_Status1`), and with `search=reset` it is
`WHERE [r].[Title] LIKE @search_contains OR [r].[OrganizationName] LIKE @search_contains`. The `Top` operator in every
page plan shows the page is cut in the database: the actual plan reads 20 rows from the index and does 20 key lookups
(A1, A2, A4). The statistics query is three aggregate statements (B below) that return 4, 1 and 5 rows.

## A. List endpoint (`GET api/requests`, page size 20)

Each row has the count statement and the page statement. `Reads` is logical reads. `Index` is the index the actual plan
used for the page statement. Every page plan is `Top → Nested Loops → index scan or seek + Clustered Index Seek
(PK)` unless the Plan column says otherwise.

| # | Scenario (URL query) | Count: reads / CPU·elapsed ms | Page: reads / CPU·elapsed ms | Plan of the page statement |
|---|---|---|---|---|
| A1 | default (none) | 597 / 6·8 | 64 / <1 | Scan `IX_Requests_CreatedAt` backwards, stops after 20 rows, no Sort |
| A2 | `status=Completed` (common) | 468 / 4·6 | 64 / <1 | Seek `IX_Requests_Status_CreatedAt`, no Sort |
| A2 | `status=Waiting` (rare) | 60 / <1 | 64 / <1 | Same plan as the common value |
| A3 | `status=New&status=Waiting` (OR, 18,133 rows) | 129 / <1·1 | 454 / <1 | Scan `IX_Requests_CreatedAt`, status as a residual filter (147 rows read for 20); no Sort |
| A4 | `assignedTo=Henry Young` | 28 / <1 | 64 / <1 | Seek `IX_Requests_AssignedTo_CreatedAt` |
| A4 | `assignedTo=Nathan Clark` | 29 / <1 | 64 / <1 | Same |
| A4 | `priority=Medium` | 329 / 3·4 | 64 / <1 | Seek `IX_Requests_Priority_CreatedAt` |
| A4 | `priority=High` | 134 / 1·1 | 64 / <1 | Same |
| A4 | `assignedTo=Henry Young&priority=High` | 162 / 2·3 (two seeks + Hash Match) | 269 / <1 | Seek on the assignee index, 87 rows read for 20; `priority` is checked after the key lookup |
| A5 | `organizationName=Red` (common) | 96 / <1·2 | 699 / <1 | Scan `IX_Requests_CreatedAt`, 227 rows read for 20 |
| A5 | `organizationName=Silverline Software` (rare) | 7 / <1 | **55,971 / 21·22** | Scan `IX_Requests_CreatedAt`, **18,238 rows read** for 20 |
| A5 | contrast, hand-written `LIKE '%Silverline Software%'` (not an API call) | 1,171 / 108·107 | 1,618 / 113·114 | Seek on the org index with a Sort |
| A6 | `search=reset` (common) | **2,627 / 284·287** | 926 / <1·1 | Count: Clustered Index Scan. Page: Scan `IX_Requests_CreatedAt`, 300 rows read for 20 |
| A6 | `search=projector in training` (rare) | **2,627 / 286·287** | **89,408 / 119·120** | Page: Scan `IX_Requests_CreatedAt`, 29,135 rows read for 20 |
| A7 | `sort=title` | 597 / 8·8 | **2,760 / 222·25** | Clustered Index Scan of all 100,000 rows, parallel Sort, Top |
| A7 | `sort=updatedAt:desc` | 597 / 6·8 | **2,760 / 174·23** | Same |
| A8 | `page=1` (= A1) | 597 / 6·8 | 64 / <1 | |
| A8 | `page=100` | 597 / 8·9 | 6,143 / 1·3 | Scan `IX_Requests_CreatedAt`, 2,000 rows read and looked up |
| A8 | `page=1000` | 597 / 9·10 | 61,377 / 28·30 | 20,000 rows |
| A8 | `page=2500` | 597 / 7·9 | 153,433 / 74·75 | 50,000 rows |
| A8 | `page=5000` | 597 / 7·8 | 306,847 / 120·121 | 100,000 rows (the whole table is read to return the last page) |

### What the measurements say about the hypotheses

- **A1, A2, A4 confirmed:** seek or backward scan on the intended index, no Sort step, 64 reads for the page
  statement, equal for common and rare values. The page statement stops after 20 rows, so it is not expected to grow
  with the table, but only one table size (100,000) was measured. The time of a list call is page plus count: for the
  default list that is under 1 ms plus a count of about 8 ms, so roughly 9 ms in the database. The count is the larger
  part of the cost here.
- **A3 (OR of statuses) partly contradicted:** there is no Sort and no Merge, but the optimizer scans
  `IX_Requests_CreatedAt` and filters, instead of seeking the status index. 454 reads for a page is still small.
- **A4 with two filters:** only one filter is served by an index; the other is evaluated per row after the key lookup.
  269 reads for a page is acceptable here; a composite index for every filter pair is not justified.
- **A5 contradicted at page level:** for both prefixes the optimizer reads `IX_Requests_CreatedAt` in order and
  filters, instead of seeking `IX_Requests_OrganizationName`. For the common prefix that is right (699 reads). For the
  rare prefix it reads 18,238 rows to find 20 matches (55,971 reads, 21 ms): the plan estimated about 9,700 matching
  rows for the parameterized `LIKE` (actual 146), so it expected to find 20 within the first ~200 rows. The index is
  still used by the **count**, where it cuts the reads from 597 to 7. This is a limitation of estimates for
  parameterized prefix filters (bottleneck 4 below), not a missing index.
- **A5 contrast:** a contains match (`'%x%'`) on the same column reads 1,171 pages and costs 108 ms CPU for the count,
  against 7 reads for the prefix match. This is why `organizationName` is specified as a prefix filter.
- **A6, A7, A8 as expected:** search scans, the two sorts sort the whole table, and deep pages grow with the page
  number. Details in the bottlenecks.

### A7 index experiment (not applied)

To decide on `Title` and `UpdatedAt`, both indexes were created temporarily, the A7 statements were replayed, the
write cost was measured, and the indexes were dropped again (no migration was added).

| | No index (now) | With the index |
|---|---|---|
| `sort=title` page | 2,760 reads, 222 ms CPU, 25 ms elapsed | 64 reads, <1 ms |
| `sort=updatedAt:desc` page | 2,760 reads, 174 ms CPU, 23 ms elapsed | 63 reads, <1 ms |
| Count of the unfiltered list | 597 reads | 254 reads (the narrower index is scanned) |
| Conditional status UPDATE (statement reads, log bytes) | 9 reads, 592 bytes | `UpdatedAt` index: 13 reads, 840 bytes (+4 reads = +44 %, +248 bytes = +41.9 %, rounded to 42 % elsewhere). `Title` index: no change, `Title` is not updated |
| Size | | `UpdatedAt` 2.1 MB, `Title` 9.1 MB |

**Decision: no index change.** The gain is real in reads, but the measured performance without the indexes (about
25 ms for a sorted page at 100,000 rows) is sufficient at this volume and page size, so it does not justify the
storage and maintenance cost. An `UpdatedAt` index is paid for on every status update, the write path the system is
built around (single and bulk), because `UpdatedAt` changes on each one. A `Title` index adds no cost to status updates
but adds 9.1 MB and is maintained on every insert. Only the unfiltered sorts were measured with the temporary indexes;
how they behave together with filters was not measured. The decision should be revisited if the table grows by an
order of magnitude (the sort cost grows with the table, the update write cost does not) or if a latency target is set.

To reproduce the experiment (on the seeded database, indexes dropped at the end):

```sql
CREATE INDEX IX_tmp_UpdatedAt ON Requests (UpdatedAt);
CREATE INDEX IX_tmp_Title ON Requests (Title);
-- replay the A7 page statements, then the write-cost script below
DROP INDEX IX_tmp_UpdatedAt ON Requests;
DROP INDEX IX_tmp_Title ON Requests;
```

Write cost: the same conditional UPDATE the repository sends, run three times in a transaction that is rolled back,
reading the log written by this session's own transaction from `sys.dm_tran_database_transactions`, joined to
`sys.dm_tran_current_transaction` on the transaction id (filtering by database id alone would also pick up other
sessions' open transactions, and the database is shared with another API instance). The script was run twice without
the index, twice with `IX_tmp_UpdatedAt` and once with both temporary indexes; all 3 repetitions of every run gave
identical numbers, and they equal the numbers from the earlier unfiltered version of the script.

```sql
SET NOCOUNT ON;
SET STATISTICS IO ON;
DECLARE @i int = 0, @logBytes bigint, @v varbinary(8);
WHILE @i < 3
BEGIN
  BEGIN TRAN;
  SELECT @v = Version FROM Requests WHERE Id = 5 + @i;
  UPDATE Requests SET Status = 1, UpdatedAt = SYSDATETIMEOFFSET()
  WHERE Id = 5 + @i AND Version = @v;          -- the statement whose reads are read from the IO output
  SELECT @logBytes = dt.database_transaction_log_bytes_used
  FROM sys.dm_tran_database_transactions AS dt
  JOIN sys.dm_tran_current_transaction AS ct ON ct.transaction_id = dt.transaction_id
  WHERE dt.database_id = DB_ID();
  PRINT CONCAT('log bytes: ', @logBytes);
  ROLLBACK;
  SET @i += 1;
END
```

Each iteration prints two `Requests` lines: the first is the version read (3 logical reads), the second is the UPDATE
(9 logical reads without the `UpdatedAt` index, 13 with it). The log figure is everything the open transaction has
written, which here is only the UPDATE (592 bytes without, 840 with the `UpdatedAt` index). The transaction is rolled
back, so no data changes.

## B. Statistics (`GET api/requests/stats`, cache miss)

The endpoint issues three statements, one after another. Measured the same way:

| Statement | Reads | CPU·elapsed ms | Plan |
|---|---|---|---|
| B1 count by status | 664 | 10·11 | Scan of all of `IX_Requests_Status_CreatedAt`, Stream Aggregate, 4 rows |
| B2 open-request age buckets | 208 | 5·6 | Seek on `IX_Requests_Status_CreatedAt` for `Status <> 3` (about 30,085 rows; 30,086 and 30,083 were seen, see data drift), Stream Aggregate |
| B3 top five assignees by open count | 1,317 | 26·29 | Seek of the status index joined to `IX_Requests_AssignedTo_CreatedAt` by Hash Match, Sort of the 40 groups, Top 5 |
| Total | 2,189 | about 41·46 | |

Hypothesis check: B1 uses the status index, as expected, but as a scan (it has to count every row). B2 and B3 do not
scan the table: both use indexes, and B3 combines two of them with a hash join, the most expensive of the three. No
statement is a table scan, and about 46 ms for a miss is not a problem for an endpoint that is cached for five minutes.

**Cache behaviour**, checked from the EF command log through the API:

| Call | Statements sent to the database |
|---|---|
| first call (cache empty) | 3 (B1–B3) |
| second call within 5 minutes | 0 |
| call after `PATCH api/requests/{id}/status` | 3 again: the update invalidated the `stats` tag |

## C. Bulk status update (`PATCH api/requests/bulk-status`)

This scenario is an addition to the task text (`docs/PLAN.md` asks for A and B).

**Reproducible data.** The first 100 requests with status `New` (by id) are used. Before every run the database is
restored: their status and `UpdatedAt` are set back to the original values and their history rows are deleted. The
`version` values are read just before the call. In the mixed case every fifth item has a stale version (20 %): its row
is touched after the version was read. Each batch size has one warm-up and five measured runs; the table shows the
median (and the range of the totals). The runs went through the real API on localhost with EF command logging at
`Information`, which adds some overhead to every number below. Per-statement times are the durations EF logged.

| Batch | Result | Total ms (range) | Update ms | Audit insert ms | Read-back ms | DB statements |
|---|---|---|---|---|---|---|
| 1 | 1 ok | 17 (13–29) | 2 | 1 | 4 | 4 |
| 10 | 10 ok | 145 (94–223) | 19 | 18 | 21 | 31 |
| 50 | 50 ok | 479 (375–850) | 63 | 61 | 66 | 151 |
| 100 | 100 ok | 1,768 (821–3,141) | 229 | 228 | 239 | 301 |
| 10 | 8 ok, 2 conflict | 73 (60–131) | 12 | 11 | 12 | 25 |
| 50 | 40 ok, 10 conflict | 414 (350–666) | 54 | 51 | 54 | 121 |
| 100 | 80 ok, 20 conflict | 973 (767–1,858) | 131 | 121 | 127 | 241 |

What follows from the numbers:

- Statements per call are 1 + 3 × (succeeded items): one up-front read, then update, audit insert and read-back for
  each success. A stale-version item costs no statement here, because the service compares the version against the
  up-front read and reports `Conflict` without a write. The conditional update in the database is still the guard for a
  change that lands after that read; this benchmark does not exercise that race (the integration tests do).
- Cost per succeeded item was about 10–15 ms for batches of 10 and 50. The sum of the logged durations of the three
  statement types is about 40 % of the total at every size. **Measured:** that sum. **Not measured:** how the other
  ~60 % splits. It includes transaction management (begin and commit, one transaction per item), network round trips
  and processing in the application (validation, mapping, serialization, logging), and this analysis does not
  separate them, so it cannot say which part dominates. The batch of 100 shows a median of 17.7 ms per item with a very
  wide range (821–3,141 ms), so the data supports "roughly linear up to 50" and not more than that.
- Total duration is not a measure of index maintenance cost, because it contains all of the above. The index write
  cost is the per-statement comparison in A7: the conditional UPDATE reads 9 pages and writes 592 log bytes now, and
  13 and 840 with an `UpdatedAt` index.

## Bottlenecks and proposed improvements

None of these is implemented; each names the contract change it would need.

1. **Text search scans (A6).** `LIKE '%x%'` cannot seek. Every search pays a full clustered-index scan for the count
   (2,627 reads, about 285 ms CPU, whatever the text) and, for a rare text, the page scan walks the default sort order
   until it has 20 matches (89,408 reads, 120 ms for a text matching 68 rows). *Improvement:* SQL Server Full-Text
   Search with `CONTAINS`, which uses an inverted index. *Cost:* the full-text component is not in the default Docker
   image, the index is populated asynchronously (search can lag behind writes), and matching changes from substring to
   word or prefix, which changes what `search` returns.
2. **Counting a large filtered set (A9).** `totalCount` is a separate `COUNT(*)` on every list call: 597 reads for the
   unfiltered list, 468 for `status=Completed`, 2,627 for a search. The cost follows the size of the filtered set, not
   the page. At 100,000 rows only the search count is slow. *Improvement:* return the total only for page 1 (or cap
   it, "more than 10,000"), or cache the count of the unfiltered and status-filtered lists with the same invalidation
   as the stats. *Cost:* the UI loses an exact page count beyond the cap, or shows a count up to five minutes old.
3. **Deep pages (A8).** `OFFSET` reads and discards the skipped rows, and each skipped row also costs a key lookup,
   because the page query selects columns that the index does not hold: about 3.1 logical reads per skipped row
   (6,143 / 1,980; 61,377 / 19,980; 153,433 / 49,980; 306,847 / 99,980). Page 5000 reads the whole table, 120 ms.
   *Improvement:* keyset paging, which seeks to `(CreatedAt, Id)` of the last row seen and costs the same on every
   page. *Cost:* the API contract (`page`) changes to a cursor and the UI can no longer jump to an arbitrary page. A
   smaller change that keeps `page` is to select only the 20 keys with the offset and then join to the table for the
   columns, so the skipped rows pay no key lookup; this was not measured.
4. **Selective filter answered by scanning the default sort index (A3, A5 rare, A6 rare).** When the optimizer
   expects many matches it reads `IX_Requests_CreatedAt` in order and filters. When the estimate is wrong, as for the
   rare organization prefix (estimated ~9,700, actual 146), the page reads 18,238 rows (55,971 reads, 21 ms). The cost
   grows with the table and with how rare the value is. *Improvement:* none that is an index (the right index exists
   and the count uses it). Candidates are `OPTION (RECOMPILE)` on the page query, so the plan uses the value's
   statistics, or an index hint; both need a before-and-after measurement and a per-query exception in the repository.
5. **Sort by `title` or `updatedAt` (A7).** Sorts the whole filtered set: 2,760 reads and about 25 ms at 100,000
   rows. *Improvement:* a single-column index per sort field, measured above (64 reads). *Cost:* about 42 % more log
   per status update for `UpdatedAt`, nine MB for `Title`; left out until the table size or a latency target justifies
   it.

## Limitations

- The count and the page are separate statements, so `totalCount` can differ from the rows when a write commits
  between them. `READ_COMMITTED_SNAPSHOT` would not remove this (each statement still sees its own snapshot). A
  consistent view needs both queries in one `SNAPSHOT` isolation transaction, which has its own cost and is not done.
- Timings come from one laptop container with one client; there was no concurrent load. Logical reads and plan shape
  are the reliable numbers, times are indicative.
- Measurements A and B ran from a SQL client, not through the API: they leave out serialization and the HTTP stack.
  C ran through the API with command logging on.
- Only the required list scenarios were varied by value. Sorts on other fields, date ranges and combinations beyond
  A4 were not measured.
- The history endpoint's index (`RequestId, ChangedAt DESC`) was not measured.
