# Security policy

Kettle is pre-release software. Security updates are currently provided for
the latest commit on `main`.

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository. If that is unavailable,
contact the maintainer through the link on the
[Kettle product home](https://github.com/charlesberret/kettle).

Include the affected version or commit, reproduction steps, impact, and any
suggested mitigation. Please avoid including private project data in reports.

The extension starts and communicates with a loopback-only Kettle core. Reports
about core authorization, project-root boundaries, provider execution, or the
HTTP API may belong in
[`kettle-core`](https://github.com/charlesberret/kettle-core/security/advisories/new).
