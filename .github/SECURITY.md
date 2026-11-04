# Security and data handling

The service is designed for a single user on the local machine. It binds to loopback and checks the request origin and session capability. It is not a hardened public hosting or multi-user authentication service.

Each project context has its own file root and capability token. Project tools reject paths outside that root and check changes before writing. Import and archive operations do not delete manuscript files.

The optional AI agent sends messages, selected context, attachments, and tool results to the configured API. Typed API keys are held in process memory; non-secret catalog settings are stored locally. The public application does not import credentials from another program's configuration.

Do not include keys, private documents, local project indexes, resume-session files, runtime caches, logs, or generated build data in an issue or patch. Back up .local/projects and imported project folders as ordinary user data.

For a suspected vulnerability, use the repository's private vulnerability reporting feature if available, or contact the maintainer through the hosting platform before posting sensitive exploit details. A useful report identifies the affected version, a minimal synthetic reproduction, expected behavior, and the boundary that was crossed.
