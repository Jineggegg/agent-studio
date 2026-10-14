# ADR 0009 — Unattended work is denied what it would have to ask for

**Status:** accepted

## Decision
A run that nobody is watching — a scheduled automation, a deferred message —
is marked unattended. Where an attended run would ask a person, an unattended
run is **denied**, and the denial is recorded in the transcript, the
automation's history and a notification. It never waits and never proceeds.

An automation may run in `plan` or `ask` (which therefore means "read, and
report what it would have changed"), and in `accept-edits` or `auto` only in a
project whose owner has switched auto mode on. It acts as the person who
created it and is refused if that person has since lost access. Automation is
off for a project until its owner turns it on.

Scheduling is exactly-once: a due run is claimed in a transaction before it
executes, an automation never overlaps itself, a run missed during downtime is
made up only within a grace window, and nothing is retried automatically.

## Why
A schedule is a standing permission to act while no one is looking. The safe
default is that such a permission covers reading and reporting, and that
anything more is a deliberate, per-project choice by the owner.
