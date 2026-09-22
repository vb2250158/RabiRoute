English | [简体中文](embedded-plan-view.md)

# Embedded plan view

The single-plan page `/routes/:id/plan/:planId` displays plan content directly when opened in an iframe. It omits global navigation, language and connection controls, the global save button, and the focus and refresh toolbar. DSH bound-plan panels use this view automatically, without extra parameters; the DSH directory still selects among multiple bound plans.

Plan details, attachments, steps, feedback, and event updates continue to use the same page. Load failures retain their error messages and retry actions. Opening the address outside an iframe retains the full Rabi Web navigation and toolbars.

All plan pages share a compact linked-Agent section with one outer border. Each Agent uses two lines for the session title, Agent role, and workspace, with one status badge on the right. Long titles and paths are truncated with their full values available on hover. Status retry and available session-opening actions remain accessible.

DSH panels include `embedAgent=dsh` and `embedSession=<current session ID>` in the route query. The embedded page hides plan guidance and excludes bindings matching both the host adapter and session ID. Other bindings remain visible; an empty list hides the entire linked-Agent section and skips its status query. Standalone pages ignore these presentation parameters and retain guidance and all actual bindings. The parameters grant no business permissions.
