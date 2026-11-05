# Message-processing automation 1.0.1

English | [简体中文](README.md)

Follow knowledge callbacks and plan changes. Activating the instance does not scan old requests, schedule recurring reply reminders or start historical delivery recovery.

Original requests and receipts remain in the message history. Use explicit original-ID receipt checks to determine an outcome; unconfirmed results retain their state.

The plugin keeps the `manager.message-processing-automation@1` host service contract, existing knowledge callback reminders, plan subscriptions and stable instance identity.

Unanswered requests are shown once by the current session’s Stop hook; this does not send a message or start a new turn.
