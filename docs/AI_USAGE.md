# AI Usage

The project was built with Claude Code (Anthropic) as a coding assistant. The developer set the requirements,
made the architecture decisions, reviewed every change before it was merged, and owns the result. This page lists
where AI was used and what was checked or changed by hand (exam §11).

Commits that AI helped write carry a `Co-Authored-By: Claude` line, so the history shows the extent per change.

## Where AI was used

| Area | What AI did | What the developer did |
|---|---|---|
| Requirements and conventions (tasks 01–03) | Drafted the requirement analysis, `CLAUDE.md`, the status transition matrix and `docs/PLAN.md` | Decided the architecture, the database, Partial Success, the transition matrix, what is out of scope; rewrote and tightened the drafts over several rounds |
| Implementation plans | Drafted `docs/plan/` files for the tasks of 5 hours or more | Reviewed each plan against the task's acceptance criteria before implementation |
| Backend and frontend code | Wrote most code and tests, one task per branch and session, following `CLAUDE.md` | Reviewed every PR, compared it with the reference implementations, requested changes |
| Code review | Ran `/code-review` on every PR, with numbered findings and severities | Decided per finding to fix, skip or record it; the fixes are the "review findings" commits in each repository |
| Performance analysis (task 17) | Captured the SQL that EF generated, replayed it with `STATISTICS IO/TIME` and execution plans, drafted `docs/PERFORMANCE.md` | Checked that the numbers came from real runs, decided not to add the measured `Title`/`UpdatedAt` indexes |
| Documentation (task 19) | Drafted this README and this page | Checked every statement against the code and the measurements |

## What was checked or changed by hand

- **Concurrency.** The conditional update, the read-back before commit and the 404/409 decision were checked against
  SQL Server behavior, and the two integration tests (stale version, overlapping updates) were required to run against
  the real database, not a fake, because a fake can't prove the database enforces it.
- **Server-side data operations.** The generated SQL was inspected (task 17) to confirm that filtering, counting,
  sorting and paging run in the database and that only one page is loaded.
- **Rules AI tends to break.** The conventions forbid AutoMapper, MediatR, FluentAssertions, NgRx and generic
  repository base classes, and penalize abstractions without a use; reviews checked for these. Review also checked
  `CancellationToken` propagation, ProblemDetails on every error path and that no request bodies or `changedBy`
  values are logged.
- **Contract gaps found in review.** For example, `allowedStatuses` was added to `RequestDto` after review showed that
  the UI would otherwise copy the transition matrix (the `fix/allowed-statuses` PRs).
- **Claims in documents.** Statements in the README and `docs/PERFORMANCE.md` were checked against the code and the
  measurements; claims that could not be backed (for example about library behavior) were removed or reworded.
- **Commits.** AI never committed without the developer's explicit permission.

## Limits of this account

AI output was accepted only after review, but a review can miss things. The tests, the performance measurements and
the clean-clone run (task 20) are the checks that do not depend on reading the code.
