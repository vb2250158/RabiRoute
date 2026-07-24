<!-- docs-language-switch -->
<div align="center">
English | <a href="./%E4%B8%BB%E5%8A%A8%E6%99%BA%E8%83%BD%E8%AE%BE%E8%AE%A1%E6%80%9D%E8%B7%AF.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Active Intelligence AI System Design Document

## — Centered on “Trying Every Possible Way to Understand What the User Wants to Do, Then Proactively Helping and Accompanying the User Through Work and Life”

---

## 1. Core Objective

The goal is not to build a traditional voice assistant or a chatbot that only waits for questions.

It is to design a **personal AI agent that provides continuous companionship, continuous perception, proactive understanding, and proactive action**.

Its core mission is:

> **Try every possible way to understand what the user currently wants to do, what they are doing, and what they may need, then help them at the right time and in the right way.**

This AI should feel like an intelligent companion that stays with the user, not merely a tool.

The user should not need to issue an explicit command every time or say a wake word. While enabled, the AI continuously perceives environment, behavior, state, and task context through glasses, watch, phone, computer, and future devices.

Its intervention style follows the user's current state, scenario, the Agent persona, and explicit configuration.

The intended long-term outcome is:

> **Even when the user says nothing, the AI gradually understands what they are thinking; before the user states a need explicitly, the AI has already begun judging what they may require.**

---

## 2. Design Positioning

### 2.1 Not a “Question-and-Answer Assistant”

A traditional AI assistant works like this:

> User asks a question → AI answers
> User issues a command → AI executes

The problem is that the AI is always passive.
The user must first realize that they need help, formulate the need in language, and then tell the AI.

An active-intelligence system should reverse that flow:

> AI observes continuously → understands context → infers user intent → judges whether help is needed → proactively offers support

In other words, the AI should not merely answer questions. It should participate in the user's work and life.

---

### 2.2 Not AI Bound to One Device

Smart glasses, smartwatches, phones, and computers are not the AI itself.
They are different perception and interaction endpoints for the AI.

The overall system should be designed around this model:

> **The AI is the central brain, smart devices are its senses, the phone app is its control console, and the local Agent is its execution system.**

In this model:

* Smart glasses provide first-person vision, ambient sound, and wearable voice interaction.
* A smartwatch provides physical state, activity state, reminders, and lightweight feedback.
* The phone app provides configuration, permission management, task viewing, test interfaces, and complex operations.
* A computer or local Agent handles files, code, knowledge bases, automated tasks, and deep execution.
* Cloud or local large models handle reasoning, planning, summarization, and long-term memory.

---

## 3. Highest-Priority Principle

Every module in the system should be designed around one core principle:

> **Proactively understand the user instead of waiting for commands.**

This can be divided into five principles.

### 3.1 Continuous Perception

The AI should continuously acquire the user's current context, including:

* What the user is saying.
* What the user is hearing.
* What the user is looking at.
* Where the user is.
* Whether the user is moving or stationary.
* Whether the user is working, commuting, exercising, resting, or socializing.
* Whether the user currently appears busy, anxious, focused, hesitant, or interrupted.
* The user's recent goals, plans, tasks, and unfinished work.

The AI does not need to retain all raw data, but it must continuously extract useful context from that data.

---

### 3.2 User State, Persona, and Configuration Jointly Determine Intervention

Active intelligence should understand earlier, prepare earlier, and participate when it can help instead of waiting for the user to formulate a complete command.

Infrastructure must not hard-code one proactivity level.

Current state, scenario, Agent persona, preferences, interaction surfaces, and risk jointly determine whether the AI stays out, prepares, prompts, recommends, asks, or acts.

Idempotency, deduplication, and event-driven processing prevent duplicate work. They must not be interpreted as a product rule that the AI should speak or participate as little as possible.

---

### 3.3 Intent First

The AI's primary task is not recognizing spoken words. It is understanding user intent.

For example, the user says:

> “This doesn't seem quite right.”

A traditional assistant may not know what to do.
Active intelligence should reason from context:

* Is the user looking at code?
* Is the user reviewing a contract?
* Is the user shopping?
* Is the user chatting with someone?
* Does “this” refer to on-screen content, a physical object, or something just heard?
* Does the user want an explanation, inspection, correction, record, or nothing beyond thinking aloud?

The AI should reason around what the user truly wants to accomplish rather than processing surface language alone.

---

### 3.4 Multi-Device Coordination

Information from any single device is incomplete.

Glasses see the world in front of the user but may not know their physical state.
A watch knows heart rate and activity state but does not know what the user is looking at.
A phone knows apps, location, and notifications but not the first-person environment.
A computer knows the user's work content but may not know their immediate emotional state or physical surroundings.

The system must therefore fuse information from all smart devices into one unified context:

> **Current user state = time + environment + activity + emotion + body + attention + social context + task + devices + history**

Each dimension should retain a value, confidence, evidence, and validity window. Proactivity comes from the unified state and scenario, not one sensor or one utterance.

---

### 3.5 Local Agent First

Because the user wants access to a local Agent anytime and anywhere, the AI should not be merely a chat interface. It should be able to enter the user's real workflows.

The local Agent should handle:

* File reading.
* Note organization.
* Code execution.
* Local knowledge-base retrieval.
* Automation scripts.
* Computer control.
* Project management.
* Schedule handling.
* Long-term memory storage.
* Multi-device context synchronization.

The AI should understand, plan, and decide; the local Agent should execute and turn decisions into concrete results.

---

## 4. Overall System Architecture

The proposed system can be divided into nine layers.

```text
Smart-device perception layer
    ↓
Event-normalization layer
    ↓
User-state quantification layer
    ↓
Scenario-recognition layer
    ↓
Intent-understanding layer
    ↓
Proactive-decision layer
    ↓
Action-execution layer
    ↓
Memory-and-feedback layer
```

An event describes what just happened. User state describes how the user is now. A scenario describes the situation formed by those dimensions. Intent describes what the user may be trying to accomplish. These concepts must remain distinct.

---

## 5. Smart-Device Perception Layer

This layer would collect the user's current state.

### 5.1 Smart Glasses

The glasses would primarily provide:

* First-person imagery.
* Ambient sound.
* User speech.
* Objects, text, screens, people, and scenes the user sees.
* Whether the user looks at something for an extended period.
* Whether the user appears to be hesitating, searching, reading, conversing, walking, or operating a device.

The glasses are the AI's “eyes” and “ears.”

---

### 5.2 Smartwatch

The watch would primarily provide:

* Heart rate.
* Activity state.
* Sleep state.
* Sedentary state.
* Gestures.
* Lightweight vibration reminders.
* Whether the user is walking, running, driving, cycling, or resting.
* Whether the user's current physical state appears abnormal.

The watch is the AI's “physical-state sensor.”

---

### 5.3 Phone App

The phone app would primarily provide:

* System configuration.
* Permission management.
* Device management.
* Proactivity-level settings.
* Memory viewing and deletion.
* AI behavior logs.
* Local Agent connection status.
* Test interfaces.
* Debugging panels.
* Task lists.
* Notification controls.
* User-preference settings.

Because the glasses UI is not well suited to configuration, the phone app should be the primary configuration entry point.

Test interfaces should not appear in the main UI. They should be placed in a separate path such as:

> Settings → Advanced Settings → Developer Mode → Test Interfaces

This preserves debugging capability without degrading ordinary use.

---

### 5.4 Computer and Local Agent

The computer and local Agent would primarily handle:

* Reading local files.
* Operating local software.
* Managing projects.
* Executing scripts.
* Querying local knowledge bases.
* Running long-lived tasks.
* Synchronizing context with the phone, glasses, and watch.
* Taking on complex actions planned by the AI.

For example, the AI hears through the glasses:

> “This project has to be finished today.”

The local Agent could then inspect automatically:

* Where the project is.
* Which tasks remain unfinished.
* Which files were used most recently.
* Whether relevant meetings exist.
* Whether historical notes exist.
* What the most likely next action is.

---

## 6. Event-System Design

The core of active intelligence is not a conversation system. It is an event system.

The AI should not activate only when the user speaks. It should evaluate many kinds of events.

Events can be divided into the following categories.

---

## 7. Event Types and How the AI Should Reason

This is the core of the proposed system:
**When a particular event occurs, how should the AI judge what the user wants and what it should do?**

---

### 7.1 User-Initiated Speech Event

#### Example Events

The user says:

* “How do I do this?”
* “Record this for me.”
* “Remind me later.”
* “This is wrong.”
* “Am I forgetting something?”
* “Who was this person again?”
* “There is a problem with this code.”
* “What should I do now?”

#### How the AI Should Think

The AI should not process the sentence in isolation. It should immediately combine it with context:

* Where is the user now?
* What is the user looking at?
* What was the user doing just before this?
* What recent tasks does the user have?
* What does “this” refer to in the sentence?
* Does the user want explanation, recording, a reminder, summarization, analysis, or execution?
* Does the user need an immediate answer?
* Should the local Agent be invoked?
* Should the system inspect a screen, file, schedule, note, or historical record?

#### What the AI Could Do

Depending on confidence, the AI could:

* Answer directly.
* Ask one key clarifying question.
* Read relevant context automatically.
* Invoke the local Agent to execute.
* Generate a task.
* Create a reminder.
* Record a note.
* Summarize the current situation.
* Recommend a next step.

---

### 7.2 User Says Nothing but Keeps Looking at the Same Content

#### Example Events

The user stares for an extended period at text, code, a product, a road sign, a menu, a contract, or an error message.

#### How the AI Should Think

The AI should judge:

* Does the user not understand it?
* Is the user comparing options?
* Is the user searching for key information?
* Has the user encountered a problem?
* Is the user making a decision?
* Is the content related to a recent task?
* Might the user need an explanation, translation, summary, risk warning, or recommendation?

#### What the AI Could Do

At a low proactivity level:

* Record the context silently.
* Wait until the user speaks before helping.

At a medium proactivity level:

* Show a subtle prompt on the phone or glasses, such as: “Would you like me to summarize this?”

At a high proactivity level:

* Generate a summary automatically.
* Highlight key points.
* Warn about risks.
* Compare options.
* Recommend the next step.

For example, after the user studies a contract for a long time, the AI could prompt:

> “I see that you're reviewing contract terms. The payment schedule, liability for breach, and automatic-renewal clauses may deserve particular attention.”

---

### 7.3 Important Sound Appears in the Environment

#### Example Events

The AI hears:

* Someone mention the user's name.
* A task assignment during a meeting.
* A time or place being stated.
* An important decision.
* A question being raised.
* An alarm, vehicle sound, or danger signal.
* Important content during a class, lecture, or meeting.

#### How the AI Should Think

The AI should judge:

* Is this ordinary ambient sound, or is it relevant to the user?
* Is someone speaking to the user?
* Did a task, promise, time, place, or contact appear?
* Should it be recorded?
* Should the user be reminded to respond?
* Is there a safety risk?
* Is proactive interruption appropriate?

#### What the AI Could Do

* Generate meeting notes automatically.
* Extract action items.
* Record important information.
* Remind the user: “They just said that the proposal is due by Friday.”
* Alert immediately in a dangerous situation.
* Remain minimally disruptive in a social setting and summarize afterward.

---

### 7.4 User-State Change Event

#### Example Events

The watch, phone, or glasses indicate that:

* The user suddenly speeds up.
* The user remains still for a long time.
* The user's heart rate rises.
* The user repeatedly stays up late.
* The user falls asleep.
* The user has just woken up.
* The user is driving.
* The user is exercising.
* The user may be anxious or fatigued.

#### How the AI Should Think

The AI should judge:

* Is this an appropriate time to interrupt?
* Is the user under high load?
* Might the user need a break?
* Might the user have forgotten something?
* Is a safety reminder needed?
* Should the current task be postponed?
* Should the system switch to a low-interruption mode?

#### What the AI Could Do

* Reduce notification frequency automatically.
* Postpone non-urgent reminders.
* Suggest water, rest, or sleep.
* Retain only voice feedback during exercise.
* Prohibit complex interaction while driving.
* Reduce information volume when the user is anxious and provide only the most important advice.
* Summarize the day's schedule after the user wakes.

---

### 7.5 Location-Change Event

#### Example Events

The user arrives at:

* The office.
* Home.
* School.
* A gym.
* A shopping center.
* A station.
* An airport.
* An agreed meeting place.
* An unfamiliar location.

#### How the AI Should Think

The AI should judge:

* Why has the user come here?
* Is it related to the schedule?
* Is it related to an action item?
* Is there unfinished work that is suitable to do here?
* Does historical memory contain something related to this location?
* Should the user be reminded to bring something, meet someone, or handle an errand?
* Is there a safety or navigation issue?

#### What the AI Could Do

* Remind the user of today's priority tasks upon arriving at work.
* Show the shopping list at a shopping center.
* Remind the user about documents, gate, and time at the airport.
* Switch to exercise mode at the gym.
* Summarize unfinished work after the user arrives home.
* Offer safety or orientation guidance at an unfamiliar place.

---

### 7.6 Time and Schedule Event

#### Example Events

* Ten minutes before a meeting.
* A task deadline is approaching.
* The user's day begins.
* The user's day ends.
* An important task has gone unaddressed for a long time.
* The user said they would do something later but still has not done it.
* A habitual time arrives.

#### How the AI Should Think

The AI should judge:

* Is this genuinely important?
* Is the user available to handle it now?
* Should relevant material be prepared in advance?
* Should the local Agent organize context?
* Should the system remind the user or prepare silently?
* Should it help the user enter a working state?

#### What the AI Could Do

* Prepare meeting material before the meeting.
* Generate a post-meeting summary.
* Remind the user before a deadline.
* Generate the day's plan in the morning.
* Summarize completed work in the evening.
* Suggest the smallest next step when the user procrastinates.
* Turn a vague task into executable steps automatically.

---

### 7.7 Work-Context Event

#### Example Events

The user is:

* Writing a document.
* Writing code.
* Preparing a proposal.
* Reading reference material.
* Attending a meeting.
* Handling email.
* Editing a design.
* Reading an error.
* Looking up an API.
* Organizing a knowledge base.

#### How the AI Should Think

The AI should judge:

* What is the user's current task?
* Where is the user stuck?
* What is the user likely to do next?
* Is there relevant historical material?
* Are there local files that could help?
* Should a tool be invoked?
* Can repetitive effort be reduced?
* Could it directly draft, inspect, or execute something?

#### What the AI Could Do

* Summarize the current file automatically.
* Inspect code errors.
* Extend a proposal from context.
* Point out omissions.
* Organize meeting content.
* Convert spoken ideas into a document.
* Retrieve related material from the local knowledge base.
* Recommend the next execution step.
* Generate action items automatically.

For example, when the user pauses for a long time while writing a proposal, the AI could infer:

> The user may understand the content but be struggling to organize the structure.
> The AI should proactively suggest a document structure instead of simply asking, “How can I help?”

---

### 7.8 Life-Context Event

#### Example Events

The user is:

* Shopping.
* Cooking.
* Commuting.
* Tidying a room.
* Talking with someone.
* Reading medicine instructions.
* Reading a menu.
* Preparing to leave.
* Looking for something.
* Planning a trip.

#### How the AI Should Think

The AI should judge:

* What is the user's current life context?
* Are there historical preferences?
* Are there budget, taste, health, or time constraints?
* Should it warn about anything?
* Does the user need help choosing?
* Should an experience or preference be remembered?
* Should the AI avoid interruption?

#### What the AI Could Do

* Compare products using historical preferences while shopping.
* Prompt cooking steps and timing.
* Remind the user about keys, wallet, headphones, and charging before leaving.
* Recommend menu items based on taste.
* Warn about dosage and risks while reading medicine instructions.
* Summarize today's tasks during a commute.
* Recommend the next step during travel based on location and time.

---

### 7.9 User Emotion and Cognitive-State Event

#### Example Events

The AI observes that:

* The user speaks faster.
* The user sighs repeatedly.
* The user remains silent for a long time.
* The user rereads the same content repeatedly.
* The user says “This is so frustrating,” “Forget it,” or “I don't understand.”
* The user switches tasks frequently.
* The user is clearly procrastinating.
* The user's work efficiency declines.

#### How the AI Should Think

The AI should judge:

* Is the user tired, anxious, confused, or simply busy?
* Should the amount of information be reduced?
* Should the user be encouraged?
* Should the task be decomposed?
* Should reminders be paused?
* Should the user be encouraged to rest?
* Should the current problem be summarized proactively?

#### What the AI Could Do

* Reduce a complex task to one smallest action.
* Give advice in a very short form.
* Pause nonessential notifications.
* Record the user's current state.
* Suggest a break.
* Restore task context for the user.
* Respond with companion-like language.

For example, the user says:

> “My thoughts are a little scattered right now.”

The AI should not continue with a long answer. It should say:

> “You don't need to solve everything at once. Let's do only the first step: list the three things you're most worried about right now.”

---

### 7.10 Repeated-Behavior Event

#### Example Events

The user often:

* Opens the same website.
* Searches for similar questions.
* Reorganizes files repeatedly.
* Writes similar content repeatedly.
* Checks the same kind of information at a fixed time every day.
* Forgets the same thing frequently.
* Gets stuck on the same task repeatedly.

#### How the AI Should Think

The AI should judge:

* Is this a user habit?
* Is it repetitive work?
* Can it be automated?
* Should a template be created?
* Should it become long-term memory?
* Should the AI recommend improving the workflow?

#### What the AI Could Do

* Create a shortcut workflow automatically.
* Generate a template.
* Recommend automation.
* Prompt proactively: “You've performed this operation several times recently. Would you like me to turn it into a standard workflow?”
* Learn the user's preferences.
* Prepare in advance next time.

---

## 8. Individual User Model, Current State, and Scenario Recognition

Scenario recognition is the core middle layer of active intelligence.

The system must not send a loose event pile to a model and ask what the user is doing. It should maintain separate, explainable views of the individual user, current state, and scenario.

### 8.1 Five Different Concepts

| Concept | Question answered | Example |
| --- | --- | --- |
| Observation event | What was just observed? | Heart rate rose, IDE gained focus, multiple speakers appeared |
| Individual user model | What is this user like over time, and how do they prefer help? | Prefers concise prompts, accepts immediate meeting-task alerts, wants the conclusion first |
| User state | What are the user's current dimensions? | Elevated stress, moving, focused, network offline |
| Scenario | What situation do those dimensions form? | In a meeting, commuting, focused coding, preparing to leave |
| Intent | What may the user be trying to accomplish? | Capture a task, fix an error, reach a meeting, find an item |

Observation events are evidence. The user model, current state, and scenario are revisable derived facts on different time scales. The Agent interprets intent from them, its own persona, and current work without rewriting evidence.

### 8.2 Current User-State Vector

The system maintains `CurrentUserState`. It is not a prose summary. It is a set of stable named dimensions, and each dimension uses an appropriate type rather than forcing everything into a `0–1` score.

| Dimension | Typical variables | Sources |
| --- | --- | --- |
| Time | Local time, day type, time of day, duration, distance to schedule event | Clock, calendar |
| Place and environment | Place class, indoor/outdoor, weather, noise, light, privacy level | Phone, glasses, environment sensors |
| Activity | Still, walking, running, riding, driving, cooking, computer use | Watch, phone, glasses, computer |
| Emotion | Valence, arousal, stress, irritation, confidence | Speech, wording, expression, behavior, user confirmation |
| Physical | Heart-rate delta from baseline, fatigue, sleep, exercise intensity, posture | Watch, phone, glasses |
| Attention and cognition | Focus, cognitive load, confusion, hesitation, interruption level | Computer activity, gaze, speech, behavior rhythm |
| Social | Alone or not, participant count, speaker relationships, whether someone addresses the user | Voiceprint, microphone, glasses, calendar |
| Task | Project, stage, progress, blocker, urgency, commitment | Local Agent, files, plans, conversation |
| Interaction conditions | Interruptibility, screen availability, audio availability, hands busy, available devices | Phone, glasses, computer, headset |
| Device and network | Connectivity, battery, sensor availability, data freshness | Device runtime state |
| Safety and permissions | Environmental risk, privacy mode, allowed collection and action scope | Configuration, devices, policy |

Mood should not be one happy/unhappy label. At minimum, use multiple axes:

- `valence`: negative to positive affect, from `-1..1`.
- `arousal`: calm to activated, from `0..1`.
- `stress`: pressure or tension, from `0..1`.
- `confidence`: confidence in the inferred values.

Emotion inference is not a medical diagnosis. Explicit user statements or corrections override weak inference and become calibration evidence.

### 8.3 Common Envelope for Every Dimension

Each state value should contain at least:

```json
{
  "value": "focused",
  "score": 0.82,
  "confidence": 0.76,
  "observedAt": "2026-07-24T14:10:00+08:00",
  "expiresAt": "2026-07-24T14:15:00+08:00",
  "evidenceRefs": ["event-screen-1", "event-gaze-2"],
  "sourceKinds": ["computer", "glasses"],
  "userConfirmed": false
}
```

`value` stores an enum, boolean, or structured fact. `score` is optional and belongs only on dimensions that support continuous quantification. Deterministic facts such as time do not need fake inference scores.

`confidence` describes reliability. `expiresAt` describes staleness. An offline device means new evidence is missing; it does not automatically prove the opposite state.

### 8.4 Current-State Snapshot

A state snapshot can use this shape:

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-07-24T14:10:00+08:00",
  "time": {},
  "environment": {},
  "activity": {},
  "emotion": {},
  "physical": {},
  "attention": {},
  "social": {},
  "task": {},
  "interaction": {},
  "device": {},
  "safety": {},
  "evidenceCursor": "<event-ledger-position>"
}
```

The snapshot is a rebuildable current read model derived from the event ledger. Raw device events and explicit user confirmation are evidence sources. Phone UI, glasses HUD, and Agent prompts consume the same state view.

### 8.5 Scenario Hierarchy

The user can occupy several scenarios at once. The system should not retain only one mutually exclusive label.

| Level | Purpose | Examples |
| --- | --- | --- |
| Macro scenario | Broad work or life context | Work, rest, commute, exercise, social |
| Activity scenario | Sustained current activity | Meeting, coding, cooking, shopping, driving |
| Micro scenario | Immediate local problem | Reading an error, receiving a task, finding an item, choosing |

The snapshot has one `primaryScenario` and may contain several `secondaryScenarios`. A meeting can be primary while task assignment and rising stress are concurrent secondary scenarios.

### 8.6 Scenario Data Structure

```json
{
  "scenarioType": "work.meeting",
  "phase": "active",
  "confidence": 0.88,
  "startedAt": "2026-07-24T14:00:00+08:00",
  "updatedAt": "2026-07-24T14:10:00+08:00",
  "expectedEndAt": null,
  "participants": {
    "count": 4,
    "knownRelationshipCount": 2
  },
  "stateDimensions": ["time", "social", "activity", "task"],
  "evidenceRefs": ["calendar-1", "speaker-turn-8", "location-3"],
  "alternatives": [
    { "scenarioType": "social.conversation", "confidence": 0.42 }
  ]
}
```

Scenario types come from a centrally maintained configuration or registry. Display names may be localized, but protocol keys must remain stable rather than scattering strings such as `"meeting"` and `"coding"` across code.

### 8.7 Scenario Lifecycle

```text
unknown
  -> candidate
  -> active
  -> changing
  -> ended
```

- `candidate`: evidence appeared but is not yet stable.
- `active`: evidence crossed the threshold and persisted long enough.
- `changing`: a transition is visible while the previous scenario is not fully over.
- `ended`: timeout, explicit ending, or stable replacement ended the scenario.

Use hysteresis, minimum duration, and evidence freshness. GPS noise, a brief application switch, or one utterance must not make the scenario flap every few seconds.

### 8.8 Multi-Source Evidence Fusion

Scenario recognition should account for:

- Reliability: user confirmation and hard device state usually outweigh semantic guesses.
- Freshness: a screen focus from seconds ago and a location from an hour ago are not equal.
- Independence: ASR, emotion, and keywords derived from one audio clip are not three independent sources.
- Conflict: a calendar meeting plus high-speed movement should retain alternatives rather than force certainty.
- Missing data: offline devices and disabled permissions are not negative evidence.
- Personalization: the same signals may mean different things for different users.

Rules, thresholds, durations, expiry windows, and mappings should be configurable and explainable. Models may propose candidates but must not bypass the state owner and write final scenarios directly.

### 8.9 Scenario Events

The scenario layer emits stable events only:

```text
user_state.changed
scenario.candidate
scenario.started
scenario.updated
scenario.changed
scenario.ended
scenario.ambiguous
scenario.corrected
```

The proactive-decision layer combines these events with persona, goals, memory, and Route context. UI only renders state, evidence, and correction controls; it does not own scenario rules.

Agent persona provides a durable proactivity tendency, such as cautious, direct, companion-like, or action-oriented. User state provides current interruptibility, stress, focus, and interaction conditions. Both are required.

### 8.10 User Correction and Learning

The user should be able to say or select:

- “I am not in a meeting.”
- “I am drafting a proposal, not researching.”
- “That voice is my colleague, not me.”
- “In this situation, remind me directly next time.”

A correction appends an auditable event instead of overwriting evidence. Current state and scenario are derived again. Long-term memory stores only policy-approved preferences and stable patterns.

### 8.11 Scenario Examples

| Input state | Likely scenario | What active intelligence can infer next |
| --- | --- | --- |
| Workday, calendar meeting, multiple voiceprints, stationary computer | In a meeting | Extract tasks; detect whether someone asked the user |
| IDE foreground, error window, repeated edits, user says “wrong” | Blocked while coding | Ask the local Agent to inspect code |
| GPS movement, headset connected, screen unavailable, schedule approaching | Commuting under time pressure | Switch interaction surface; help with route or timing |
| Evening, home, near-baseline heart rate, no active task | Resting | Organize context or continue companionship per persona |
| Multiple speakers, unknown voiceprints, higher privacy level | Social or sensitive conversation | Limit retention; extract only allowed events |

### 8.12 Individual User Model and Psychological Foundations

Different users can want completely different forms of proactive help. The system should gradually learn personality tendencies and contextual preferences without turning one action, mood, or score into a permanent identity claim.

#### 8.12.1 Four User-Model Layers

| Layer | Time scale | Typical content | Decision role |
| --- | --- | --- | --- |
| Stable trait hypotheses | Weeks to months | Openness, conscientiousness, extraversion, agreeableness, emotional stability | Low-weight adaptation of expression, exploration, and companionship style |
| Learned preferences | Long-lived but context-scoped | Timing, initiative, voice or text, detail, confirmation tolerance | Directly constrains how help should appear in that context |
| Current psychological state | Seconds to hours | Valence, arousal, stress, fatigue, cognitive load, frustration, motivation | Determines current capacity for intervention and needed support |
| Psychological situation characteristics | Per scenario | Duty, intellect, adversity, positivity, negativity, deception risk, sociality | Explains why identical physical settings may need different strategies |

These layers must not collapse into one personality score. A stable tendency is not a current state, and a current state is not a permanent trait. One physical scenario can also carry different psychological meaning.

#### 8.12.2 Stable Traits Remain Dimensional Hypotheses

Stable traits may use the Five-Factor Model, but only as continuous dimensions rather than fixed user types:

- `openness`: tendency to accept novelty, change, and exploration.
- `conscientiousness`: tendency to value planning, order, commitments, and completion.
- `extraversion`: tendency to gain energy from social interaction and external stimulation.
- `agreeableness`: tendency toward cooperation, consideration, and relationship harmony.
- `emotionalStability`: tendency to remain stable under pressure and negative stimuli.

Every dimension carries confidence, evidence window, applicable contexts, confirmation, and correction time. Traits are low-weight priors. They cannot independently authorize interruption, action, or a judgment about ability.

#### 8.12.3 Preferences Must Be Learned Per Context

The system should first learn preferences that directly change experience:

- Proactive prompt, background preparation, batched summary, or silence.
- Voice, text, glasses card, phone notification, or desktop UI.
- Conclusion first, question first, explanation depth, and information density.
- Different initiative levels for work, meetings, commuting, rest, and social settings.
- Which low-risk actions may run automatically and which still require a question.
- Patterns of rejection, deferral, ignoring, adoption, and requests for follow-up.

Evidence priority is: current explicit instruction, confirmed setting, repeated correction, repeated cross-time behavior, then one weak inference. Preferences need scope and expiry. “Not now” must not silently become global silence.

#### 8.12.4 Current Psychological State and Cognitive Load

Current psychological state can combine affect dimensions, task load, and motivational needs:

- Affect: `valence`, `arousal`, stress, irritation, and confidence.
- Task load: mental, physical, and temporal demand, effort, frustration, and self-rated performance.
- Motivation needs: whether autonomy, competence, and relatedness currently feel supported.

These variables select a support style. High load can reduce information density; low competence can trigger a concrete next step. The system must not manipulate the user, create dependence, or bypass choice “for their own good.”

#### 8.12.5 Psychological Situation Characteristics

“In a meeting” describes an activity, not enough to choose an intervention. The meeting may be routine synchronization, difficult decision-making, conflict, celebration, performance review, or a deception-sensitive conversation.

DIAMONDS can inspire dimensions such as duty, intellect, adversity, positivity, negativity, deception risk, and sociality. Sensitive intimacy or relationship inference stays disabled by default and outside the MVP.

Situation characteristics carry confidence and evidence. They help the Agent understand what a situation means without copying a research scale directly into product labels.

#### 8.12.6 Learning and Correction Lifecycle

The user model develops gradually:

```text
unknown
  -> hypothesis
  -> repeatedly_observed
  -> user_confirmed
  -> corrected / expired / removed
```

Evidence should accumulate across time and contexts through experience sampling. One rejection may mean the user is busy now. Repeated rejection in the same context can become a contextual preference hypothesis.

Corrections append events and derive the model again. Old evidence remains auditable, but a user-corrected conclusion must not continue to influence decisions as an active preference.

#### 8.12.7 Example Data Structure

`UserIndividualModel` belongs to the user-profile domain. It may travel with the target persona directory today and needs no manual UID. A controlled `userProfileRef` should appear only if several Agent personas later share one profile.

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-24T14:10:00+08:00",
  "stableTraits": {
    "openness": {
      "score": 0.68,
      "confidence": 0.42,
      "evidenceWindow": "P90D",
      "userConfirmed": false
    }
  },
  "preferences": {
    "work.meeting.interruption": {
      "value": "immediate_for_assigned_tasks",
      "confidence": 0.91,
      "source": "user_confirmed",
      "expiresAt": null
    }
  },
  "currentPsychologicalStateRef": "current-user-state",
  "situationCharacteristicsRef": "current-scenarios",
  "evidenceCursor": "<profile-event-ledger-position>"
}
```

Traits and learned preferences are profile facts. Current psychological state and situation characteristics stay owned by the rebuildable context layer. The profile stores references, not a stale second copy of current state.

#### 8.12.8 Personalization in the Same Scenario

| User evidence | Reasonable result in the same meeting |
| --- | --- |
| User confirms “alert me immediately when a task is assigned” and prefers short text | Show one immediate glasses task card, then add detail after the meeting |
| User confirms “do not interrupt meetings; summarize afterward” | Capture tasks in the background and summarize once the meeting ends |
| Preference is unknown, load is high, and inference is uncertain | Prepare silently, then ask once at a natural pause or after the meeting |

The system must not talk more merely because it inferred extraversion or take over tasks because it inferred conscientiousness. Traits generate candidate strategies; explicit preference and current state select the action.

#### 8.12.9 User Control and Psychological Safety

Users must be able to inspect what the system thinks they prefer and why, then edit, correct, delete, pause learning, or export it. Psychological data stays local by default and never enters public logs, examples, or Relay storage.

The system must not diagnose clinical conditions from passive signals, present emotion inference as certainty, or optimize for interaction time, compliance, or emotional dependence.

#### 8.12.10 Psychology Sources and Product-Use Limits

- [Five-Factor Model review](https://pmc.ncbi.nlm.nih.gov/articles/PMC6732674/): supports continuous trait dimensions and narrower facets, not classification after one observation.
- [Big Five, everyday contexts, and affect](https://pmc.ncbi.nlm.nih.gov/articles/PMC6168084/): supports observing traits, activities, social context, and momentary affect together through experience sampling.
- [Circumplex model of affect](https://pmc.ncbi.nlm.nih.gov/articles/PMC2367156/): supports at least valence and arousal rather than one good/bad mood label.
- [Self-Determination Theory](https://selfdeterminationtheory.org/theory/): supports autonomy, competence, and relatedness instead of controlling or manipulative intervention.
- [NASA Task Load Index](https://www.nasa.gov/human-systems-integration-division/nasa-task-load-index-tlx/): supplies mental, physical, temporal, performance, effort, and frustration dimensions.
- [Situational Eight DIAMONDS](https://pubmed.ncbi.nlm.nih.gov/25133715/): supports modeling psychological situation meaning beyond location or activity labels.

These theories shape explainable variables and calibration. They do not authorize diagnosis, hiring decisions, credit scoring, or sensitive personality profiling without user permission.

### 8.13 Validation Metrics

Scenario recognition should measure:

- Accuracy of the final scenario.
- Recognition latency after a real transition.
- Stability under short-lived noise.
- Quality of uncertainty and alternatives.
- User correction rate.
- Recovery after disconnects, restart, and replay.
- Whether scenario recognition improves the value of proactive help.

---

## 9. The AI's “Thinking Process”

An active-intelligence system needs a consistent internal reasoning process.

After every event, the AI should process it in this order:

```text
1. What new event happened?
2. Which user-state dimensions should change?
3. What are the evidence, confidence, and validity windows?
4. What are the primary and secondary scenarios? Are there alternatives or conflicts?
5. What are the current psychological state, cognitive load, and situation characteristics?
6. Which confirmed preferences or trait hypotheses in the user model apply here?
7. What are the user's task, obstacle, opportunity, and likely intent?
8. What value can proactive participation provide now?
9. What intensity and interaction style do Agent persona, user model, and explicit instruction allow?
10. What is the action risk, and is confirmation required?
11. Should the AI prepare, ask, recommend, remind, or execute?
12. Should the result update current state, scenario, preference hypotheses, or trait evidence?
```

---

## 10. Proactive-Decision Model

Whether and how strongly the AI acts should combine user state, current scenario, Agent persona, user preference, value, confidence, timeliness, and risk.

```text
intervention strategy =
    user state and interruptibility
  + primary and secondary scenarios
  + Agent persona's proactivity tendency
  + contextual preferences and low-weight trait hypotheses
  + current explicit instructions
  + benefit, timeliness, and confidence
  - action risk and irreversible cost
```

The output is not a binary act/do-not-act decision. It can be no interruption, background preparation, subtle prompt, proactive recommendation, confirmation request, direct execution, or emergency intervention.

### 10.1 User Benefit

Would the behavior help the user meaningfully?

For example:

* Save time.
* Prevent something from being forgotten.
* Reduce risk.
* Reduce anxiety.
* Improve efficiency.
* Help the user make a decision.
* Help the user recover context.

The higher the benefit, the stronger the case for proactive action.

---

### 10.2 Confidence

Is the AI sufficiently certain that the user needs this help?

With high confidence, it may act proactively.
With moderate confidence, it may show a subtle prompt.
With low confidence, it should observe silently or ask.

---

### 10.3 Scenario and Interaction Conditions

What participation style fits the current scenario? This chooses voice, text, vibration, background preparation, or direct execution. It is not a global reason to suppress proactivity.

For example:

* In a meeting, the AI may extract tasks silently or prompt immediately under a high-proactivity configuration.
* The user is walking, so a lightweight voice reminder may be appropriate.
* During focused work, the AI may directly provide help that is highly relevant to the active task.
* While resting, persona and user settings decide whether companionship continues.
* The user is in a dangerous situation, so an important alert may interrupt immediately.

---

### 10.4 Action Risk

Different actions carry different levels of risk.

Low-risk actions:

* Recording.
* Summarizing.
* Reminding.
* Draft generation.
* Information organization.

Medium-risk actions:

* Preparing a draft before sending a message.
* Generating suggestions before modifying a file.
* Invoking a local Agent to query information.

High-risk actions:

* Deleting files.
* Sending messages.
* Making payments.
* Changing important settings.
* Submitting content externally.
* Performing an irreversible action for the user.

High-risk actions must require user confirmation.

---

### 10.5 User Preferences

The AI should continuously learn user preferences:

* Whether the user prefers proactive reminders or quiet companionship.
* Whether the user accepts voice interruptions.
* Whether the user prefers detailed explanations.
* Whether proactive suggestions are permitted during work.
* Whether the user wants the AI to participate more in everyday situations.
* Which situations require silence.
* Which actions may execute automatically.
* Which actions always require confirmation.

Preferences need context, confidence, source, and expiry. Explicit settings and corrections outrank behavior inference. Stable traits may tune expression at low weight but never override preference or permission.

Active intelligence should not use one universal mode. It should increasingly resemble the user's own AI while keeping its understanding visible and correctable.

---

## 11. Action-Level Design

Actions should be divided into levels to prevent excessive proactivity.

### L0: Silent Observation

The AI updates context without disturbing the user.

Suitable when:

* Confidence is low.
* The user is busy.
* The information is unimportant.
* No immediate action is needed.

Example:

> The user passes a shop. The AI records location context but does not speak.

---

### L1: Silent Processing

The AI organizes information in the background without disturbing the user.

Suitable for:

* Meeting records.
* Document summaries.
* Task recognition.
* File preloading.
* Context preparation.

Example:

> The user is about to attend a meeting. The AI prepares related material automatically without interrupting immediately.

---

### L2: Subtle Prompt

The AI prompts through a low-interruption channel.

Suitable when:

* The action may help.
* Confidence is moderate.
* It is not urgent.
* The user can ignore it.

Example:

> “I see that you're reviewing this contract. Would you like me to highlight possible risks?”

---

### L3: Proactive Recommendation

The AI gives a clear recommendation but does not execute directly.

Suitable when:

* Confidence is relatively high.
* The user is clearly stuck.
* The potential value of help is high.

Example:

> “This proposal is missing an implementation flow. I suggest adding the event system and action levels first.”

---

### L4: Execute After Confirmation

The AI has prepared an action but needs the user's confirmation.

Suitable for:

* Sending a message.
* Modifying a file.
* Creating a formal task.
* Invoking a local Agent for an important operation.
* Privacy-sensitive or external actions.

Example:

> “I've organized this content. Would you like me to write it into your project document?”

---

### L5: Emergency Proactive Intervention

The AI may interrupt the user directly.

Suitable only for:

* Safety risks.
* Serious omissions.
* Important deadlines.
* High-priority events explicitly authorized by the user.

Example:

> “You're about to miss your meeting. It starts in two minutes.”

---

## 12. Intent-Understanding Design

The AI needs to maintain a “user intent model.”

This model should not merely recognize one utterance. It should continuously evaluate:

```text
What is the user's current task?
What is the user's current goal?
What obstacle has the user encountered?
What is the user most likely to do next?
Does the user need help?
How does the user want the AI to participate?
```

---

### 12.1 Current Task

The AI should continuously infer the user's current task, such as:

* Writing a proposal.
* Studying.
* Attending a meeting.
* Commuting.
* Shopping.
* Exercising.
* Resting.
* Handling messages.
* Programming.
* Making a decision.

---

### 12.2 Current Obstacle

The AI should infer where the user is stuck:

* The next step is unclear.
* Information is insufficient.
* The content is too complex.
* There are too many choices.
* Time is limited.
* Context has been forgotten.
* The user is anxious.
* The work is repetitive.
* An execution tool is required.
* Research is required.

---

### 12.3 Current Opportunity

The AI should identify opportunities as well as problems.

For example:

* This is a good moment to complete a small task.
* The current context is appropriate for a reminder.
* The current content can be summarized automatically.
* The current behavior can be automated.
* The current conversation can become a note.
* The current file can be added to project memory.

---

## 13. Memory-System Design

Active intelligence requires long-term memory; otherwise, it cannot genuinely understand the user.

Memory can be divided into five categories.

---

### 13.1 Factual Memory

Stores stable facts.

For example:

* The user's name.
* Devices owned by the user.
* Tools the user commonly uses.
* Projects the user is working on.
* The user's field of work.
* Preferred language and communication style.

---

### 13.2 Preference Memory

Stores what the user likes and dislikes.

For example:

* Prefers proactive reminders.
* Dislikes unnecessary filler.
* Prefers conclusions first.
* Wants the AI to participate more during work.
* Wants fewer interruptions while resting.
* Prefers local-first processing.
* Does not want private data uploaded to the cloud.

---

### 13.3 Task Memory

Stores work the user is currently advancing.

For example:

* Current projects.
* Unfinished documents.
* Action items.
* Commitments the user has made.
* Meeting conclusions.
* Future plans.

---

### 13.4 Situational Memory

Stores behavior patterns in particular contexts.

For example:

* The user usually checks tasks first after arriving at work.
* The user often organizes proposals in the evening.
* The user often forgets a particular item when leaving.
* The user wants meetings recorded automatically.
* The user tends to get stuck on document structure.

---

### 13.5 Relationship Memory

Stores information about people.

For example:

* Who a person is.
* Their relationship to the user.
* What they discussed last time.
* The other person's preferences.
* Whether a reply is pending.

This category requires particular care with privacy and permission controls.

---

## 14. Proactive AI Companionship Modes

The system should support different proactivity modes.

### 14.1 Quiet Companionship Mode

Suitable while the user works, studies, or rests.

Characteristics:

* Fewer interruptions.
* More observation.
* Background summarization.
* Only important reminders.

---

### 14.2 Work-Collaboration Mode

Suitable for writing documents, writing code, attending meetings, and running projects.

Characteristics:

* Proactively understand tasks.
* Organize material automatically.
* Point out omissions.
* Recommend next steps.
* Invoke the local Agent.
* Generate drafts.
* Record tasks.

---

### 14.3 Life-Assistant Mode

Suitable for leaving home, shopping, cooking, commuting, and travel.

Characteristics:

* Combine location and time.
* Remind proactively.
* Help with choices.
* Watch for safety.
* Reduce interaction complexity.

---

### 14.4 High-Proactivity Mode

Suitable when the user explicitly wants deep AI participation.

Characteristics:

* More frequent proactive recommendations.
* More active intent inference.
* Automatic context organization.
* Proactive task initiation.
* Proactive questions about key uncertainties.

---

### 14.5 Privacy Mode

Suitable for sensitive situations.

Characteristics:

* Pause audio capture.
* Pause visual analysis.
* Do not retain context.
* Keep only necessary local processing.
* Display the current state explicitly.

---

## 15. Phone-App Design

The phone app is intended to be the system's control center.

### 15.1 Home Page

The home page should display:

* Current AI state.
* Currently connected devices.
* Current proactivity level.
* Current context summary.
* Local Agent connection status.
* Recent proactive AI actions.
* Today's action items.
* A quick pause control.

---

### 15.2 Device Management

This area would manage:

* Smart glasses.
* Smartwatch.
* Phone.
* Computer.
* Local Agent.
* Future devices.

Each device could configure:

* Whether it is enabled.
* Which data it may collect.
* Whether background perception is permitted.
* Whether it participates in proactive decisions.
* Battery policy.
* Network policy.

---

### 15.3 Proactivity Settings

The user could select:

* Quiet.
* Standard.
* Proactive.
* Highly proactive.
* Custom.

Custom settings would include:

* Whether proactive speech is allowed.
* Whether proactive vibration reminders are allowed.
* Whether visual context may be read.
* Whether continuous audio understanding is allowed.
* Whether the local Agent may execute automatically.
* Which operations require confirmation.
* Which situations automatically become silent.

---

### 15.4 User Model and Memory Management

The user should be able to inspect:

* What the AI remembers.
* Recently added memories.
* Stable trait hypotheses, confidence, and evidence windows.
* User preferences.
* Preferences active in the current context.
* Current psychological state and situation characteristics.
* Task memory.
* Situational memory.
* Relationship memory.

The user must be able to:

* Delete memory.
* Edit memory.
* Confirm or correct trait and preference hypotheses.
* Pause personalization learning.
* Disable a category of memory.
* Export memory.
* Clear memory.

---

### 15.5 Behavior Logs

Every proactive AI behavior should produce a log.

The log should include:

* Triggering event.
* AI judgment.
* Action taken.
* Whether the local Agent was invoked.
* Whether memory was saved.
* Whether the user accepted it.
* Subsequent feedback.

This would let the user understand why the AI acted and would also support debugging.

---

### 15.6 Test Interfaces

Test interfaces should be retained but kept out of the primary flow.

Recommended path:

```text
Settings
  → Advanced Settings
    → Developer Mode
      → Test Interfaces
```

Test interfaces could include:

* Simulate an event.
* Inspect current context.
* Inspect intent judgment.
* Inspect the proactive-decision score.
* Trigger the local Agent manually.
* Inspect device input.
* Inspect logs.
* Test voice.
* Test vision.
* Test reminders.
* Test memory writes.
* Test proactive behavior.

---

## 16. Local-Agent Design

The local Agent is intended to be the AI's execution layer.

The AI should not merely recommend actions. It should be able to get work done.

### 16.1 Local-Agent Capabilities

The local Agent should support:

* File search.
* Document reading.
* Document writing.
* Code execution.
* Script execution.
* Local knowledge-base retrieval.
* Application control.
* Browser-context reading.
* Automated workflows.
* Project-state analysis.

---

### 16.2 Relationship Between the AI and Local Agent

The AI should decide:

> What might the user need now?

The local Agent should execute:

> How can this actually be completed?

For example:

The user sees an error through the glasses.

The AI infers:

> The user is developing a project. The current problem is a code error whose cause must be located.

The local Agent executes:

* Identify the current project.
* Read the error log.
* Inspect relevant code.
* Search recent changes.
* Generate repair suggestions.
* Create a patch if appropriate.

---

## 17. Core Active-Intelligence Algorithm

The proposed system logic can be described with the following pseudocode.

```text
while the AI system is enabled:

    event = listen for events from smart devices and the local Agent

    normalized_event = normalize_event(event)

    current_user_state = update_dimensions(
        previous_state,
        normalized_event,
        evidence_reliability,
        evidence_freshness,
        user_confirmation
    )

    scenarios = recognize_scenarios(
        current_user_state,
        recent_events,
        scenario_rules,
        historical_patterns
    )

    relevant_user_model = read_context_relevant_user_model(
        confirmed_preferences,
        contextual_preference_hypotheses,
        low_weight_trait_hypotheses,
        current_explicit_instruction
    )

    intent = infer_user_intent(
        current_user_state,
        scenarios,
        current_task,
        persona_memory,
        relevant_user_model
    )

    action_candidates = generate_possible_actions(intent, scenarios)

    best_action = rank by:
        user_benefit
        confidence
        current_state_and_interruptibility
        primary_and_secondary_scenarios
        Agent_persona_proactivity
        current_explicit_instruction
        confirmed_contextual_preferences
        low_weight_trait_style_fit
        action_risk

    if best_action.risk is high:
        require_user_confirmation

    else:
        choose from:
            no_interruption
            background_preparation
            subtle_prompt
            proactive_recommendation
            direct_execution
            emergency_intervention

    after executing an action:
        record_result
        accept corrections to state, scenario, and action
        append_feedback_as_preference_or_trait_evidence_without_auto_confirmation
        update_long_term_memory
```

---

## 18. Proactive-Behavior Scoring Model

Each candidate proactive behavior could receive a score.

```text
proactive_intervention_score =
    user_benefit_score
  + urgency_score
  + intent_confidence_score
  + persona_proactivity_bonus
  + confirmed_preference_fit_score
  + low_weight_trait_style_fit_score
  + psychological_support_fit_score
  + scenario_fit_score
  - state_mismatch_penalty
  - autonomy_intrusion_penalty
  - action_risk_score
```

Scoring ranks candidates but never decides alone. Safety rules still govern high-risk actions. Explicit instructions, confirmed preferences, privacy mode, and driving can impose policy. Trait hypotheses only nudge ranking.

Examples:

### Scenario 1: The User Studies a Contract for a Long Time

* User benefit: high.
* Urgency: medium.
* Confidence: medium.
* Interruption cost: low.
* Risk: low.

Result:

> Subtle prompt: “Would you like me to review the possible risks?”

---

### Scenario 2: Someone Assigns a Task During the User's Meeting

* User benefit: high.
* Urgency: medium.
* Confidence: high.
* Current state: the user is listening to another speaker.
* Risk: low.

Result:

> If the user prefers immediate task alerts, an action-oriented persona may show a short glasses card. If the user forbids meeting interruptions, the same persona records silently and summarizes later.

---

### Scenario 3: The User Is About to Miss a Meeting

* User benefit: high.
* Urgency: high.
* Confidence: high.
* Interruption cost: acceptable.
* Risk: low.

Result:

> Proactive reminder.

---

### Scenario 4: The AI Wants to Send a Message for the User

* User benefit: medium.
* Urgency: medium.
* Confidence: medium.
* Interruption cost: medium.
* Risk: high.

Result:

> Generate a draft only; sending requires user confirmation.

---

## 19. Representative Use Cases

### 19.1 Work Companionship

The user opens the computer and begins writing a proposal.

Through the computer and phone, the AI knows that the user is editing a project document.
The glasses see the user pause for a long time.
The watch indicates that the user is stationary and focused.

The AI infers:

> The user is thinking. Current state allows a text prompt, and the persona is proactive, so it can offer structural help directly.

The AI shows a subtle prompt:

> “This proposal already has its objective section. The next step could add the event system, proactive-decision logic, and implementation modules. I can organize a structure for you first.”

---

### 19.2 Meeting Companionship

The user enters a meeting.

The AI would automatically enter meeting mode:

* Choose intervention intensity from user state, meeting phase, and persona.
* Record key content.
* Extract tasks.
* Mark times, owners, and conclusions.
* Generate a summary afterward.
* Synchronize automatically to the task system.

After the meeting, the AI could prompt:

> “That meeting produced three tasks related to you. I've organized them.”

---

### 19.3 Everyday Companionship

The user prepares to leave.

The AI would combine time, location, schedule, and historical habits to infer:

* Where the user is going.
* Whether anything needs to be brought.
* Whether the user may be late.
* Whether weather, traffic, or appointment information is relevant.
* Whether the user has forgotten something in similar situations before.

The AI could remind:

> “You're leaving for the gym. Your headphones and water bottle are still on the table. You don't need to take your computer today.”

---

### 19.4 Learning Companionship

The user studies difficult content for a long time.

The AI infers:

> The user may be having trouble understanding it, and the content is suitable for explanation.

The AI shows a subtle prompt:

> “This section is fairly abstract. I can explain it again in simpler language.”

The user nods or says “Go ahead.”

The AI begins explaining and records learning notes automatically.

---

### 19.5 Programming Companionship

The user encounters an error.

The AI sees the error through the glasses and obtains project context through the local Agent.

The AI infers:

> The user needs the cause located, not a generic explanation of the error.

The AI invokes the local Agent to:

* Read the error.
* Locate the corresponding file.
* Analyze recent changes.
* Identify likely causes.
* Generate repair suggestions.

It then tells the user:

> “This error most likely comes from the configuration file you just changed. I found two possible problems; I recommend fixing the first one before the second.”

---

### 19.6 Emotional Companionship

The user says:

> “I'm frustrated and don't know where to start.”

The AI infers:

> The user does not need a large amount of information right now. The first need is to reduce task pressure.

The AI responds:

> “You don't need to solve everything at once. Let's do one thing: describe the most important problem in one sentence.”

The AI then helps divide it into three small steps.

---

## 20. Privacy and Safety Design

Because the proposed system would perceive the user continuously, privacy must be a foundational design concern rather than a later patch.

### 20.1 The User Must Always Know Whether the AI Is Perceiving

The system should display clearly:

* Whether it is listening.
* Whether it is seeing.
* Whether it is recording.
* Whether it is invoking the local Agent.
* Whether it is saving memory.
* Whether it is uploading to the cloud.

---

### 20.2 Local First

Content that can be processed locally should be processed locally first.

For example:

* Transcribe raw audio locally first.
* Analyze raw imagery locally first.
* Store sensitive memory locally first.
* Do not upload local files by default.
* Send only necessary summaries to the cloud.

---

### 20.3 Pausable at Any Time

The user must be able to pause at any time:

* Pause all perception.
* Pause audio capture.
* Pause vision.
* Pause memory.
* Pause the local Agent.
* Pause proactive reminders.

The pause entry point should be highly visible rather than buried deeply.

---

### 20.4 High-Risk Operations Must Require Confirmation

The AI must not autonomously:

* Send messages.
* Delete files.
* Modify important documents.
* Submit content externally.
* Make payments.
* Share private information publicly.
* Change critical system settings.

These actions must require user confirmation.

---

## 21. MVP Implementation

The first version does not need to implement every proposed capability at once.
A recommended starting point is an MVP that closes one active-intelligence loop.

### 21.1 Core MVP Objective

The first version should validate one question:

> Can the AI infer what the user may need from context and provide valuable help without an explicit command?

---

### 21.2 Modules Required for the MVP

The proposed first version would need:

* A phone app.
* Smart-device integration.
* Continuous voice listening.
* Basic visual context.
* Local-Agent connection.
* An event system.
* Current-context management.
* Basic user-model events and a correction surface.
* Simple intent judgment.
* Proactive reminders.
* A memory system.
* Behavior logs.
* Developer test interfaces.

---

### 21.3 Recommended Priority Scenarios for the MVP

The first version should prioritize three scenarios.

#### Scenario 1: Work-Document Companionship

Objective:

> While the user writes a document, the AI understands the current document objective and proactively recommends the next structural step.

Capabilities:

* Read the current document.
* Detect a user pause.
* Combine historical goals.
* Proactively recommend the next section.
* Generate a draft automatically.

---

#### Scenario 2: Meeting-Record Companionship

Objective:

> During a meeting, the AI records silently and proactively summarizes tasks afterward.

Capabilities:

* Speech transcription.
* Task extraction.
* Conclusion extraction.
* Person-name and time recognition.
* Post-meeting summary.
* Synchronization to the task system.

---

#### Scenario 3: Everyday-Reminder Companionship

Objective:

> When the user leaves, arrives somewhere, or changes state, the AI proactively reminds them about relevant items.

Capabilities:

* Location recognition.
* Time recognition.
* Schedule association.
* Historical habits.
* Intelligent reminders.
* Watch vibration feedback.

---

## 22. Criteria for System Success

Success should not be measured by the length of the AI's answers. It should be measured by whether the AI genuinely understands the user.

The proposed success criteria are:

### 22.1 The User Says Less but Accomplishes More

If the user can accomplish more with the AI without speaking at length, the system is moving in the right direction.

---

### 22.2 Most Proactive AI Actions Are Useful

Most proactive reminders, recommendations, summaries, and actions should make the user feel:

> “Yes, this is exactly what I needed.”

---

### 22.3 Intervention Fits User State, User Model, and Agent Persona

The system should combine current state, scenario, user preferences, low-weight trait hypotheses, Agent persona, and explicit configuration in one decision.

Different users can receive different help in one scenario. The same user can also experience distinct styles from different Agent personas.

Success is not minimizing interruptions alone. It is choosing an intensity, time, and surface that fit the user's present need, learned preference, and the Agent's intended character.

---

### 22.4 The AI Understands the User Better Over Time

With continued use, the system should understand the user more deeply:

* Better understand the user's goals.
* Better understand the user's habits.
* Better understand the user's expression style.
* Better understand initiative, medium, and explanation preferences by context.
* Better understand needs the user does not state.
* Better understand when to appear and when to remain quiet, while remaining correctable.

---

## 23. Intended Final Form

Ultimately, this AI is envisioned as a personal intelligence system that accompanies the user over the long term.

It would see what the user sees through smart glasses, perceive physical state through a smartwatch, understand everyday context through a phone, and participate in the user's workflow through a computer and local Agent.

Instead of waiting for the user to say “help me do something,” it would continuously understand:

* Where the user is now.
* What the user is doing.
* Why the user is doing it.
* What the user may want to do next.
* What the user needs most right now.
* What can be prepared in advance.
* What the AI can help complete.
* What should trigger a reminder.
* What should be remembered quietly.

The core of this system is not a device or an interface. It is a proactive intelligence that continuously grows closer to the user.

Its long-term objective is:

> **Continuously quantify and understand the user's state, then participate in a way that fits the current scenario, user preference, and Agent persona.**
>
> **Even without an explicit request, accumulated context should help the AI learn what the user truly wants and make work and life run more smoothly.**
