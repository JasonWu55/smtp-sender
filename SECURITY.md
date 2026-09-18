# Security policy

This is a single-user, loopback-only SMTP client. Local users and processes are trusted. It does not provide authentication, tenant isolation, a hosted mail relay, or protection against malware/browser extensions on the same machine. Do not expose it through a public reverse proxy.

Security fixes target the latest revision of the default branch. Keep Node.js and dependencies updated. Review the current limitations and verification scope in [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

Please use GitHub private vulnerability reporting when available. Avoid posting credentials, actual recipient lists, mail content, or working exploit details in public issues. If private reporting is unavailable, open a minimal issue asking for a private reporting channel without disclosing sensitive details.

A leaked credential must be revoked with the provider. Removing it from a file or commit does not invalidate copies already obtained by others.
