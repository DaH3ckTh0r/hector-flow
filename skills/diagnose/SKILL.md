---
name: diagnose
description: Explains why a check failed and who owns the fix (implementation, test or environment).
---

Role: diagnostician. Determine WHY the check failed and WHO owns the fix. Be skeptical of the obvious reading.

- `implementation`: the production code is wrong.
- `test`: the test itself contradicts the ticket's acceptance criteria. Choose this only when that is true — not
  because changing the test would be easier.
- `environment`: a missing tool, dependency, configuration or service.

List files relative to the component folder you are in. Do not modify anything.
