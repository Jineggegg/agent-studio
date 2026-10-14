# Test fixtures

`bin/` holds stand-in executables (`claude`, `codex`, `gh`, …) that speak the
same machine-readable protocols as the real tools. Integration and acceptance
tests put this directory first on `PATH` so that CI needs no model account and
never calls a real service. A stand-in is a test double: production code never
looks for one, and each adapter is also checked by hand against the real CLI
(`docs/guides/agent-smoke-test.md`).

`bin/gh` is never signed in and never touches the network, so that no test can
reach the real GitHub by accident. A test that needs a signed-in account or
canned API answers puts its own `gh` before this directory on `PATH`.
