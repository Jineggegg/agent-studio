# ADR 0009 — Unattended work is denied what it would have to ask for

**Status:** accepted

## Decision
A run that nobody is watching — a scheduled automation — is marked
unattended. Where an attended run would ask a person, an unattended run is
**denied**, and the denial is recorded in the transcript, the automation's
history and a notification. It never waits and never proceeds.

A *deferred message* is different: it is a message a person wrote for a
conversation they are working in, sent at a time they chose. It behaves like a
typed message — a request that needs approval waits for that person, who is
told by a push notification — because denying would silently throw away work
they asked for.

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
