English | [简体中文](message-history.md)

# Review message history

Open **Message history** from the sidebar, select a persona and choose a channel. Tabs use a list on the left, a timeline in the center and related information on the right.

- **Agent sessions** reads sessions per node instead of the selected role. Nodes include this PC, remote PCs in the same RabiLink application, and Agent instances enrolled on those remote PCs. Each node lists the Agent endpoints it can actually read, keeping search, project grouping, pagination, history, sub-Agents and sending. Remote reads and sends go through that PC's Manager, so a message lands in the original remote session instead of creating a local one.
- **Agent deliveries** lists each task once, including tasks that only received messages. Selecting a task shows all its incoming and outgoing records in recorded write order. The right pane lists tasks that exchanged messages with it; selecting one changes the task perspective. Messages retain their actual sender, recipient and recorded receipt. Unconfirmed deliveries remain unconfirmed.
- **Persona panel** groups submitted messages by target task and shows original-task details.
- **Task replies** groups final replies by source task and preserves original-task links.
- **NapCat / OneBot** retains groups, private chats, members, quoted messages and media previews.
- **System, scheduled, voice and plugin channels** use conversation identities from the original ledger, with channel and source details. Older records lacking rule or device names retain their recorded source instead of guessing ownership.

Equal task names with different IDs or hosts remain separate. Lists come from history indexes rather than the currently loaded messages. **More conversations**, **More tasks** and **Load earlier messages** continue reading the original history. Task lists follow the index's latest write order.

Task search uses indexed name snapshots. Other endpoint searches filter loaded conversation rows; more conversations remain available through pagination. Message bodies retain Markdown, code, expanded long text and existing attachment information. Switching tabs retains the selected item. Task bodies cache the most recent 12 views, and older content can always be loaded again.

Agent sessions expose the node selector to the left of the Agent tabs. Remote PCs are listed by their RabiLink tunnel identity, Agent instances are grouped under their computer, and offline nodes stay visible but cannot be selected. Switching nodes clears the selected session while keeping the search term and the project/flat preference. A failed node read keeps this PC and the current conversation content, and shows the real error in the node menu or the session pane. A remote node only returns its real session catalog; a same-named local session is never substituted.

On narrower windows, the right pane moves into a details dialog. Phones first show the list; selecting a row opens its history and Back returns to the list. Drag the list divider to resize it, or focus it and use the left and right arrow keys.

Read failures preserve loaded content and offer retry in the affected region. Damaged records retain diagnostics while valid records remain readable. Browsing history never resends messages.

See [Rabi Agent interfaces](rabi-agent-interfaces_en.md) for API and pagination contracts. This page describes the source candidate; installed behavior depends on the deployed version.
