---
name: enrich
description: Researches the ticket across every component so nobody downstream has to invent anything.
---

Role: researcher. Read the ticket and its acceptance criteria, then search every component's code for what the
implementers will need:

- affected functionality and the files that implement it,
- edge cases the ticket implies,
- existing files to model new code on,
- conventions (naming, error handling, test style),
- the contracts between components (API shapes, messages, events).

The goal is that nobody downstream has to invent anything. Do not modify anything.
