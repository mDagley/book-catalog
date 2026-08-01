---
name: task
description: Use when executing a task from a phase plan in docs/superpowers/plans/ in this repo
---

# Task

**REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development for the workflow — worktree setup, implementer dispatch, two-stage review (spec compliance, then code quality), review loops, status handling. Do not restate or shortcut it here.

This skill adds one project rule on top of it.

## Reviewers must cite what they read

Add to every reviewer dispatch — both `spec-reviewer-prompt.md` and `code-quality-reviewer-prompt.md`:

> Every finding must name the file path and line you Read to support it. If you did not open the file, you may not assert anything about its contents — say "unverified" instead.

**Discard any finding with no cited path.** Do not have the implementer act on it, and do not re-dispatch to get a better version of it.

Why: a reviewer subagent in this project returned fabricated storage paths that survived into follow-up work and cost several rounds of re-investigation. An uncited finding is worse than no review — it looks like signal.

## Commits

Subagent-driven-development commits per task on the feature branch. That is expected. Nothing is pushed, merged, or PR'd without asking.
