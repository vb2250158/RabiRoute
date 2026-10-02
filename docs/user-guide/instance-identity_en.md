# Distinguish PCs and reset an instance ID

English | [简体中文](instance-identity.md)

Status: introduced in 0.3.21. The installed Windows Host owns the reset; a source-only Manager cannot execute it.

Each PC needs its own instance ID and connection key. The display name, local connection ID and instance ID are separate fields. Renaming does not repair an identity copied from another PC. A remote PC sharing the local identity may be filtered out of persona sources as though it were local.

## Use the local page

1. Save configuration changes you want to keep. Reset uses saved data and does not save page drafts for you.
2. Open **RabiLink → Configuration** and click **Reset instance ID** beside the instance ID.
3. Read the confirmation and confirm. The application backs up the old identity, stops the current runtime, creates a new instance ID and connection key, and restarts.
4. Wait for completion and a newly read instance ID. If the address changes, reopen RabiRoute from the tray. Do not repeat the reset because the page briefly disconnects.
5. Check both PCs on the RabiLink home page and refresh persona sources. The source PC must still be online and support remote personas.

Reset preserves the saved name, server URL, application token, connection ID, Routes, personas and message history. It does not erase data, reset remote Agent node identity or rewrite historical message sources. Backups are in the runtime data directory at `data/rabilink/identity-resets/<operation ID>/`. They contain private configuration and keys and must never be uploaded or committed.

Pinned trust for the old public key is not automatically replaced. If another device reports an identity change, verify and re-establish that connection; reset never expands existing service grants. If both PCs still share the same local connection ID, set and save distinct values. Instance ID reset preserves this field.

## Prevent another copied identity

After upgrade, the application records local ownership of the identity. Startup rejects an identity when configuration carrying this marker, or its entire data directory, is copied to another PC. Do not delete the marker to bypass the check. When moving personas and history, preserve the new PC's own configuration and connection key.

Legacy configurations have no ownership marker. Their first upgrade preserves and binds the existing identity, so it cannot detect a previous copy. Already duplicated PCs need an explicit reset on one PC. The check uses operating-system machine identity; a complete OS clone retaining that identity still needs a manual reset. This is not hardware attestation.

## If reset does not complete

The page treats “queued” as acceptance only. During this operation it queries status for at most 45 seconds and reads the identity again after confirmed completion. Disconnection or timeout does not prove reset failure and never triggers automatic resubmission.

Host records operation state, subprocess purpose, PID, launch source and logs. An interrupted reset leaves its transaction record; on the next start, Host recovers it before launching Manager. If current files cannot be verified or recovery fails, startup stops. See [Windows startup and packaging](../windows-launcher-and-packaging_en.md#instance-identity-reset) for the formal Host recovery entry in a faulted state.
