# View persona skills

English | [简体中文](persona-skills.md)

Open the Knowledge page for a route with a bound persona and select **Persona Skills**. The catalog shows saved Skill titles and summaries. Select an item to read its body as plain text; HTML is never executed.

This is a read-only resource catalog, **not proof that the current Agent has loaded these skills**. It does not install, enable, disable or edit skills. `active`, `draft` and `archived` describe resource metadata, not execution-host loading status.

On a phone, sign in to Relay management, select a computer owned by that account, and open its WebGUI to use the same entry. Requests retain the existing Manager remote prefix and authorization. This feature does not expand mobile-token proxy permissions or create a second skill authority on the phone.

The catalog loads on opening, persona changes and explicit refresh only. Persona changes clear previous details and discard late responses. An empty catalog means no readable skills were returned; failures are shown separately. Refresh the catalog or select a skill again to retry.

This is a source implementation with isolated client tests. Full builds, installed-page checks, light/dark themes and mobile-device acceptance must be verified separately during release.
