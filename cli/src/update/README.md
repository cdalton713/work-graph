# Managed updates

Run `wg update status` to see the active version, the last check result, the rollback hold, and any plugin review notice. A normal command starts at most one release check per day. A failed check also starts the daily interval. Status reads work offline. A read-only installation can run the current version.

Set `WG_UPDATE=off` to disable checks. Set `WG_UPDATE_PIN=MAJOR.MINOR.PATCH` to accept only that newer stable version. Clear the variable to resume discovery. When the latest release has a different signing key, discovery checks up to eight newer stable candidates from the first 100 listed releases for a signed key transition. If the bridge is outside that window, pin its stable version for one check, then clear the pin. All transitions require a manifest signed by the installed key.

An update preserves edits in old versions. Changes to files in the active version or an existing candidate prevent activation. Save the edits and restore the signed files before retrying. To request an earlier retry, remove `update-check` from the managed root under `~/.local/share/work-graph`.

Run `wg update rollback` to verify and select the previous version. This writes `update-hold` in the managed root. Remove that file when ready to resume updates. A plugin change sets a reminder in `update status`. Run `wg agents --install` to compare the registered plugin with the installed bytes. Review any new access request in Orca. After review, remove `update-plugin-review` to clear the reminder. The updater leaves registrations, consents and disabled-plugin settings with their owner.
