# Account session module excludes Oneplay

Prima, Voyo, JOJ Play, SledovaniTV and TV Barrandov share one account session module (single-flight login, expiry renewal, invalidate-and-retry-once on rejection). Oneplay stays outside it: its session state is pushed into every pooled WebSocket connection, validated by a probe request, and involves account, profile and PIN steps, so forcing it behind the shared interface would make that interface as complex as the connection pool.

Barrandov was outside at first, because it logged in on every playback resolution. Searches resolve every result to inspect it, so that meant several logins per search; it now keeps its login cookie in the shared module and logs in again only when the premium archive stops accepting it.
