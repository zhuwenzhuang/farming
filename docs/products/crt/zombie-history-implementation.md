# Agent Cleanup And History Archive

> Chinese version: [zombie-history-implementation.zh_cn.md](./zombie-history-implementation.zh_cn.md)

This document defines the durable cleanup and archive model for inactive or exited non-Main Agents. History is a record of completed Agent lifecycles, not a second live-session owner.

## User Story

Farming should prevent abandoned Agents from consuming resources indefinitely while preserving enough context for the user to understand what ended and why. Cleanup should remain low-noise: archived runs appear in History rather than as a permanent Zombies section.

## State Ownership And Transitions

The Agent lifecycle owner decides whether an Agent is live and performs termination. The persisted history store owns archived summaries. The browser only presents those authoritative results.

An eligible non-Main Agent transitions from live to terminating when either the user requests termination or the inactivity policy selects it. A natural process exit enters the same archive path without a termination request. After the runtime reaches a terminal outcome, Farming removes the Agent from live supervision and attempts to record one archive summary.

The inactivity policy is intentionally conservative. It uses persisted activity evidence and excludes Main Agent. Policy thresholds and scan cadence are operational tuning, not part of the archive data contract.

## Correctness And Recovery

Safety requires that Main Agent is never selected by automatic cleanup, an archived summary is never treated as a live process handle, and repeated observation of the same terminal lifecycle does not create conflicting archive outcomes.

Liveness requires every admitted cleanup to reach a visible terminal result: stopped, already exited, or failed with the live Agent still represented for retry. A restart may reconcile persisted lifecycle evidence, but must not infer successful termination from age alone.

History preserves user-relevant context such as the Agent identity, task/workspace context, timing, and terminal reason. Exact persistence fields are an internal schema and may evolve independently of this product contract.

## Failure Semantics

Failure to prove runtime termination must not be reported as cleanup success. If runtime termination succeeds but history persistence fails, Farming may complete the live lifecycle, but it must surface that archive failure separately rather than claim that history was recorded. History filtering, detail views, and restart-from-history are presentation or future workflow concerns; they do not change lifecycle ownership.

## Verification Strategy

Deterministic tests should cover manual termination, inactivity selection, natural exit, Main Agent exclusion, duplicate terminal observations, persistence failure, and restart reconciliation. Browser tests should verify that live Agents disappear only after a terminal result and that the corresponding archive summary is presented once.
