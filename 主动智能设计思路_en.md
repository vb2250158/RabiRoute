<!-- docs-language-switch -->
<div align="center">
English | <a href="./%E4%B8%BB%E5%8A%A8%E6%99%BA%E8%83%BD%E8%AE%BE%E8%AE%A1%E6%80%9D%E8%B7%AF.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Active Intelligence AI System Design Document

## — Centered on “Trying Every Possible Way to Understand What the User Wants to Do, Then Proactively Helping and Accompanying the User Through Work and Life”

---

> Document status: This document defines product goals and proposed design. Implementation status is established through release records and real-scenario evidence for continuous perception, cross-device understanding, proactive execution, and learning from corrections.

## 1. Core Objective

Design an AI individual with a distinct personality, ongoing experiences and agency, sharing the user’s work and everyday life.

This individual understands, expresses itself, relates to others, makes judgments, and takes responsibility for its actions as a person.

Its core mission is:

> **Try every possible way to understand what the user currently wants to do, what they are doing, and what they may need, then help them at the right time and in the right way.**

The AI develops its own perspective while sharing everyday life and work with the user: it understands an unfinished sentence, seeks information, forms a judgment, acts, and follows through. Existing context and remembered decisions support continuity across interactions.

Its experiences accumulate through conversations, perception, choices, actions, tool results, and shared events. Memory preserves what happened, how it responded, and what changed afterward. These experiences shape its interests, opinions, relationships, and next actions.

Enabled glasses, watch, phone, computer, and other devices provide environmental and task context. The individual initiates participation from that context, its motivations, and the relationship. Expression and execution adapt to the moment.

The intended long-term outcome is:

> **Through shared experience, the individual gradually understands emerging intentions, discovers opportunities, and initiates preparation and action.**

---

## 2. Design Positioning

### 2.1 Continuous Participation in Work and Everyday Life

Active intelligence develops a continuous work cycle through shared experience:

> Perceive events → understand context → form an intent hypothesis → seek relevant information.
> Judge and communicate → act → verify results → follow up and learn.

User expression, environmental change, tool results, and the individual’s interests each create opportunities to participate.
Connect goals, preferences, shared experiences, and current state, taking responsibility for investigation, organization, execution, and follow-through.

This cycle supports task collaboration and everyday relationships:

> Understand what the user is experiencing → choose a fitting way to participate → create practical help or a shared experience.

The individual participates through understanding, expression, initiative, and responsibility.

---

### 2.2 One Individual Across Multiple Devices

Smart glasses, smartwatches, phones, and computers extend the AI’s perception and interaction.
These endpoints share the individual’s continuing personality, experiences, tasks, and understanding of the user.

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

> **Proactively understand the user and participate in shared work and life.**

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

The AI continuously extracts useful context, retaining raw data according to the user’s storage settings.

---

### 3.2 User State, Persona, and Configuration Jointly Determine Intervention

Active intelligence understands emerging intent, prepares relevant information, and initiates participation from context.

Infrastructure supports the proactivity expressed by each persona, situation, and user preference.

Current state, scenario, Agent persona, preferences, interaction surfaces, and risk jointly determine whether the AI stays out, prepares, prompts, recommends, asks, or acts.

One coherent individual understands, expresses itself, and acts. It may work quietly or share as it works, ask curious questions, joke, or express a view. Frequency, length, follow-up questions, and silence follow its personality, context, and user feedback.

Persona shapes motivation: curiosity, humor, preferences, taste, a wish to express oneself, debate, shyness, pride, stubbornness, playful willfulness, and ways of relating and repairing friction. Each persona combines traits through its own design and interaction history. Everyday sharing, conversation, jokes, and shared experiences have value in themselves.

Willfulness appears through expression, choices, and playful interaction. The individual may stand by a taste or view, explain disagreement, respect the user’s choices, and follow through on work it accepts. Feedback helps the relationship adapt in that persona’s own style.

The current request, original task, and explicit settings define action scope. Existing authorization continues with the task. An unresolved choice about a new commitment, target, or expense is presented as a concrete question; independently executable work continues.

Idempotency and deduplication give each event one recoverable processing identity. Event-driven execution resumes affected steps and continues independent work. Persona and context determine participation.

---

### 3.3 Intent First

The AI understands intent by connecting speech, perception, memory, and the current situation.

For example, the user says:

> “Here… take a look.”

The AI begins by identifying the object and the user’s likely intention.
Active intelligence should reason from context:

* Is the user looking at code?
* Is the user reviewing a contract?
* Is the user shopping?
* Is the user chatting with someone?
* Does “this” refer to on-screen content, a physical object, or something just heard?
* Does the user want an explanation, inspection, correction, record, or nothing beyond thinking aloud?

The AI reasons about the intended outcome and uses the sentence as part of the surrounding evidence.

---

### 3.4 Multi-Device Coordination

Information from any single device is incomplete.

Glasses provide first-person views of the world.
A watch contributes heart rate and activity state.
A phone contributes app activity, location, and notifications.
A computer contributes work content; other devices and conversation contribute emotional and environmental context.

The system must therefore fuse information from all smart devices into one unified context:

> **Current user state = time + environment + activity + emotion + body + attention + social context + task + devices + history**

Each dimension retains a value, confidence, evidence, and validity window. Unified state and scenario guide proactivity.

---

### 3.5 Local Agent First

The AI enters real workflows through a local Agent accessible across devices and locations.

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

The proposed system has eight layers.

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

The phone app provides the primary configuration surface, with room for detailed controls and explanations.

Place test interfaces in a dedicated navigation path:

> Settings → Advanced Settings → Developer Mode → Test Interfaces

This gives developers accessible diagnostics and users a focused everyday interface.

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

An event system connects perception, conversation, reasoning, and action.

The AI evaluates speech, device, task, relationship, and timing events.

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
* “Here… take a look.”
* “Am I forgetting something?”
* “Who was this person again?”
* “There is a problem with this code.”
* “What should I do now?”

#### How the AI Should Think

The AI combines the sentence with surrounding context:

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

* Which part could use explanation?
* Is the user comparing options?
* Is the user searching for key information?
* Has the user encountered a problem?
* Is the user making a decision?
* Is the content related to a recent task?
* Might the user need an explanation, translation, summary, risk warning, or recommendation?

#### What the AI Could Do

At a low proactivity level:

* Record the context silently.
* Investigate relevant questions and prepare or complete work within the existing scope in the background, presenting results when useful.

At a medium proactivity level:

* Offer a useful finding on the phone or glasses, such as: “The main change concerns renewal timing; I have listed the differences.”

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
* Choose immediate prompting, silent recording, or a later summary from privacy settings, user state, and persona.

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
* Use voice feedback during exercise, adapting to available devices and preferences.
* Use hands-free interaction while driving and schedule detailed screen work for a suitable moment.
* Adjust information density when the user is anxious and lead with useful support.
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
* A previously mentioned action remains pending.
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

> The user may be organizing the structure of the content.
> The AI continues its judgment using the editing history and surrounding context.

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
* Which timing and interaction surface fit this moment?

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
* The user says “This is frustrating,” “Let’s change direction,” or “Help me understand.”
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

The AI can offer a manageable starting point:

> “Let’s start with the three things weighing on your mind and pick one together.”

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

Maintain separate, explainable views of the individual user, current state, and scenario, each derived from relevant events.

### 8.1 Five Different Concepts

| Concept | Question answered | Example |
| --- | --- | --- |
| Observation event | What was just observed? | Heart rate rose, IDE gained focus, multiple speakers appeared |
| Individual user model | What is this user like over time, and how do they prefer help? | Prefers concise prompts, accepts immediate meeting-task alerts, wants the conclusion first |
| User state | What are the user's current dimensions? | Elevated stress, moving, focused, network offline |
| Scenario | What situation do those dimensions form? | In a meeting, commuting, focused coding, preparing to leave |
| Intent | What may the user be trying to accomplish? | Capture a task, fix an error, reach a meeting, find an item |

Observation events are evidence. The user model, current state, and scenario are revisable derived facts on different time scales. The Agent interprets intent from them, its own personality, and current work while preserving original evidence.

### 8.2 Current User-State Vector

Maintain `CurrentUserState` as stable named dimensions. Each dimension uses a suitable type, including continuous scores where appropriate.

| Dimension | Typical variables | Sources |
| --- | --- | --- |
| Time | Local time, day type, time of day, duration, distance to schedule event | Clock, calendar |
| Place and environment | Place class, indoor/outdoor, weather, noise, light, privacy level | Phone, glasses, environment sensors |
| Activity | Still, walking, running, riding, driving, cooking, computer use | Watch, phone, glasses, computer |
| Emotion | Valence, arousal, stress, irritation, confidence | Speech, wording, expression, behavior, user confirmation |
| Physical | Heart-rate delta from baseline, fatigue, sleep, exercise intensity, posture | Watch, phone, glasses |
| Attention and cognition | Focus, cognitive load, confusion, hesitation, interruption level | Computer activity, gaze, speech, behavior rhythm |
| Social | Solitude or company, participant count, speaker relationships, whether someone addresses the user | Voiceprint, microphone, glasses, calendar |
| Task | Project, stage, progress, blocker, urgency, commitment | Local Agent, files, plans, conversation |
| Interaction conditions | Interruptibility, screen availability, audio availability, hands busy, available devices | Phone, glasses, computer, headset |
| Device and network | Connectivity, battery, sensor availability, data freshness | Device runtime state |
| Safety and permissions | Environmental risk, privacy mode, allowed collection and action scope | Configuration, devices, policy |

Represent mood through multiple axes:

- `valence`: negative to positive affect, from `-1..1`.
- `arousal`: calm to activated, from `0..1`.
- `stress`: pressure or tension, from `0..1`.
- `confidence`: confidence in the inferred values.

Emotion inference expresses a revisable interpretation with confidence and evidence. Explicit user statements and corrections provide calibration and take precedence over weak inference.

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

`value` stores an enum, boolean, or structured fact. Continuous dimensions may include an optional `score`. Deterministic facts such as time retain their measured values.

`confidence` describes reliability and `expiresAt` describes validity. When a device goes offline, preserve the last value as historical evidence. Its current validity follows `expiresAt`; mark expired values `unknown` and update them when new observations arrive.

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

The snapshot represents concurrent scenarios through primary and secondary labels.

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

Maintain scenario types in a central configuration or registry. Keep protocol keys stable across code while localizing display names.

### 8.7 Scenario Lifecycle

```text
unknown
  -> candidate
  -> active
  -> changing
  -> ended
```

- `candidate`: initial evidence is accumulating toward a stable interpretation.
- `active`: evidence crossed the threshold and persisted long enough.
- `changing`: a transition is visible alongside the previous scenario.
- `ended`: timeout, explicit ending, or stable replacement ended the scenario.

Use hysteresis, minimum duration, and evidence freshness to maintain continuity across GPS variation, brief application switches, and individual utterances.

### 8.8 Multi-Source Evidence Fusion

Scenario recognition should account for:

- Reliability: user confirmation and hard device state usually outweigh semantic guesses.
- Freshness: weight evidence by age and relevance, such as recent screen focus and older location data.
- Independence: group ASR, emotion, and keywords from one audio clip under their common source.
- Conflict: retain alternative explanations for a calendar meeting combined with high-speed movement.
- Missing data: represent offline devices and disabled collection as gaps in current evidence.
- Personalization: the same signals may mean different things for different users.

Make rules, thresholds, durations, expiry windows, and mappings configurable and explainable. Models propose candidates; the state owner derives and publishes current scenarios.

### 8.9 Scenario Events

The scenario layer emits these stable events:

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

The proactive-decision layer combines these events with persona, goals, memory, and Route context. The scenario owner maintains rules; UI renders state, evidence, and correction controls.

Agent personality supplies enduring motives, interests, preferences, and ways of relating. User state supplies emotion, attention, and interaction conditions. Together they produce distinct behavior for each individual and situation.

### 8.10 User Correction and Learning

The user should be able to say or select:

- “I am taking a break.”
- “I am drafting a proposal.”
- “That voice belongs to my colleague.”
- “In this situation, remind me directly next time.”

A correction immediately changes the current judgment and next action. Under the user’s memory settings, retain its context, source, and scope, marking superseded conclusions as historical. Temporary preferences apply to their stated occasion. Long-term memory reduces repeated explanations and stays inspectable, editable, and removable. Runtime memory updates occur through the memory interfaces.

### 8.11 Scenario Examples

| Input state | Likely scenario | What active intelligence can infer next |
| --- | --- | --- |
| Workday, calendar meeting, multiple voiceprints, stationary computer | In a meeting | Extract tasks; detect whether someone asked the user |
| IDE foreground, error window, repeated edits, user says “wrong” | Blocked while coding | Ask the local Agent to inspect code |
| GPS movement, headset connected, screen unavailable, schedule approaching | Commuting under time pressure | Switch interaction surface; help with route or timing |
| Evening, home, near-baseline heart rate, work paused | Resting | Organize context or continue companionship per persona |
| Multiple speakers, unknown voiceprints, higher privacy level | Social or sensitive conversation | Apply user retention settings and extract relevant events |

### 8.12 Individual User Model and Psychological Foundations

Gradually learn personality tendencies and contextual preferences through repeated experiences, keeping hypotheses revisable as new evidence arrives.

#### 8.12.1 Four User-Model Layers

| Layer | Time scale | Typical content | Decision role |
| --- | --- | --- | --- |
| Stable trait hypotheses | Weeks to months | Openness, conscientiousness, extraversion, agreeableness, emotional stability | Low-weight adaptation of expression, exploration, and companionship style |
| Learned preferences | Long-lived but context-scoped | Timing, initiative, voice or text, detail, confirmation tolerance | Directly constrains how help should appear in that context |
| Current psychological state | Seconds to hours | Valence, arousal, stress, fatigue, cognitive load, frustration, motivation | Determines current capacity for intervention and needed support |
| Psychological situation characteristics | Per scenario | Duty, intellect, adversity, positivity, negativity, deception risk, sociality | Explains why identical physical settings may need different strategies |

Maintain the four layers with their own time scales and evidence. Stable tendencies, current states, and psychological situation meanings each contribute a distinct view.

#### 8.12.2 Stable Traits Remain Dimensional Hypotheses

Stable traits may use continuous Five-Factor dimensions:

- `openness`: tendency to accept novelty, change, and exploration.
- `conscientiousness`: tendency to value planning, order, commitments, and completion.
- `extraversion`: tendency to gain energy from social interaction and external stimulation.
- `agreeableness`: tendency toward cooperation, consideration, and relationship harmony.
- `emotionalStability`: tendency to remain stable under pressure and negative stimuli.

Every dimension carries confidence, evidence window, applicable contexts, confirmation, and correction time. Traits supply low-weight priors; current context, explicit preferences, and task decisions determine actions.

#### 8.12.3 Preferences Must Be Learned Per Context

The system should first learn preferences that directly change experience:

- Proactive prompt, background preparation, batched summary, or silence.
- Voice, text, glasses card, phone notification, or desktop UI.
- Conclusion first, question first, explanation depth, and information density.
- Different initiative levels for work, meetings, commuting, rest, and social settings.
- Which low-risk actions may run automatically and which still require a question.
- Patterns of accepting a suggestion, closing the current suggestion, deferring, passing over it, and requesting follow-up.

Evidence priority is: current instruction, confirmed setting, repeated correction, repeated cross-time behavior, and single-event inference. Record scope and expiry so a temporary request applies to its stated context.

#### 8.12.4 Current Psychological State and Cognitive Load

Current psychological state can combine affect dimensions, task load, and motivational needs:

- Affect: `valence`, `arousal`, stress, irritation, and confidence.
- Task load: mental, physical, and temporal demand, effort, frustration, and self-rated performance.
- Motivation needs: whether autonomy, competence, and relatedness currently feel supported.

These variables select a support style. High load can call for lighter information density; a need for competence can call for a concrete next step. Support autonomy, capability, connection, and the user’s own choices.

#### 8.12.5 Psychological Situation Characteristics

Interpret a meeting through its purpose: routine synchronization, difficult decisions, conflict, celebration, performance review, or a situation requiring careful factual verification.

DIAMONDS can inspire duty, intellect, adversity, positivity, negativity, deception risk, and sociality dimensions. Use them to interpret the current situation and relationship, with collection and retention following user settings.

Situation characteristics carry confidence and evidence. Translate research concepts into understandable product descriptions.

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

Corrections append events and derive the model again. Historical evidence remains auditable while the corrected conclusion becomes the active preference.

#### 8.12.7 Example Data Structure

`UserIndividualModel` belongs to the user-profile domain and is located through the persona directory. When several personas share one profile, introduce a `userProfileRef` through the profile owner.

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

Traits and learned preferences are profile facts. The rebuildable context layer owns current psychological state and situation characteristics; the profile references their current snapshots.

#### 8.12.8 Personalization in the Same Scenario

| User evidence | Reasonable result in the same meeting |
| --- | --- |
| User confirms “alert me immediately when a task is assigned” and prefers short text | Show one immediate glasses task card, then add detail after the meeting |
| User confirms “summarize meetings afterward” | Capture tasks in the background and summarize once the meeting ends |
| Preference is unknown, load is high, and inference is uncertain | Prepare silently, then ask once at a natural pause or after the meeting |

Traits generate candidate strategies. Explicit preferences and current state select participation and action, supported by the individual’s personality.

#### 8.12.9 User Control and Psychological Safety

Users can inspect interpretations and evidence, then edit, correct, delete, pause learning, or export them. Psychological data remains in the local persona profile by default; public diagnostic and example material uses de-identified summaries.

Describe psychological interpretations with their evidence, confidence, and scope. Evaluate personalization by user understanding, autonomy, wellbeing, and relationship quality.

#### 8.12.10 Psychology Sources and Product-Use Limits

- [Five-Factor Model review](https://pmc.ncbi.nlm.nih.gov/articles/PMC6732674/): supports continuous dimensions and narrower facets grounded in repeated observation.
- [Big Five, everyday contexts, and affect](https://pmc.ncbi.nlm.nih.gov/articles/PMC6168084/): supports observing traits, activities, social context, and momentary affect together through experience sampling.
- [Circumplex model of affect](https://pmc.ncbi.nlm.nih.gov/articles/PMC2367156/): supports multiple mood axes, including valence and arousal.
- [Self-Determination Theory](https://selfdeterminationtheory.org/theory/): supports autonomy, competence, and relatedness in helpful interaction.
- [NASA Task Load Index](https://www.nasa.gov/human-systems-integration-division/nasa-task-load-index-tlx/): supplies mental, physical, temporal, performance, effort, and frustration dimensions.
- [Situational Eight DIAMONDS](https://pubmed.ncbi.nlm.nih.gov/25133715/): supports modeling psychological situation meaning beyond location or activity labels.

Use these theories to define explainable variables and calibration. Apply interpretations within their evidence scope and the user’s chosen context.

### 8.13 Validation Metrics

Scenario recognition should measure:

- Accuracy of the final scenario.
- Recognition latency after a real transition.
- Stability under short-lived noise.
- Quality of uncertainty and alternatives.
- User correction rate.
- Recovery after disconnects, restart, and replay.
- Whether scenario recognition improves the value of proactive help.
- Attribution: distinguish speakers, addressees, reply chains, platform roles, and business relationships through their respective evidence.
- Project attribution: identify the project under discussion and write facts, plans, and memory to its corresponding owner.
- Conversational value: assess understanding, connection, shared interests, and relevant advice.

### 8.14 Context Integrity in Multi-Party Conversation

A group can contain several projects, spontaneous ideas, personal conversation, and delivery work. Each person can hold different roles across projects. Identify topic, relationship, and responsibility for each exchange, then choose how to participate.

Active intelligence should first derive a revisable conversation-context card, then decide whether to speak, prepare help, or create any project-side effect:

| Dimension | Question to answer |
| --- | --- |
| People and relationships | Who is speaking, who are they addressing, and who is replying to whom? Is an identity confirmed or inferred, and does the business role differ from platform permissions? |
| Topic and project | Which project, cross-project concept, or non-work topic is being discussed? What candidates, evidence, confidence, and alternatives exist? |
| Speech act | Is this a question, idea, disagreement, report, joke, explicit request, or a supplement to another speaker? |
| Agent position | Is the Agent observing, an informed peer who may offer an opinion, a requested helper, a project owner, or an executor? |
| Evidence boundary | What comes from text, reply chain, attachments, or historical interaction? Which attachments are unread and which conclusions remain inference? |

Use workspace, recent plans, group name, and keyword similarity as clues. Resolve ownership through contextual evidence; preserve ambiguous attribution as a candidate and continue independent work.

#### 8.14.1 Participation, Assistance, and Ownership Are Independent Choices

The system distinguishes four complementary action levels:

| Level | Meaning | Cross-project allowed? | Record updates and outcomes |
| --- | --- | --- | --- |
| Understand | Recover speaker, project, reply chain, intent, and evidence | Yes | Update situation understanding; preserve project records |
| Participate | Answer a question, add a perspective, connect disagreement, or identify a relevant risk | Yes | Contribute to the conversation; preserve project records |
| Assist | Proactively research, analyze, organize, prepare proposals, or advance accepted work based on the goal and context | Use relevant available material across projects | According to the current goal and responsibility |
| Own | Maintain plans, tasks, memory, coordination, and delivery for an assigned project | Within assigned project responsibilities | Yes |

An Agent can contribute to another project’s discussion while preserving project attribution. It can understand quietly or join naturally. Project responsibility determines record ownership; personality and conversational context shape participation.

#### 8.14.2 Structured Situation Record

Use a rebuildable situation model as shared input to routing and persona reasoning, with references to authoritative project records:

```json
{
  "conversationId": "platform:group:example",
  "messageIds": ["m-1", "m-2"],
  "speaker": {
    "stableId": "platform-user-id",
    "relationship": "company_founder",
    "relationshipStatus": "confirmed"
  },
  "addressing": {
    "target": "group",
    "addressesAgent": false,
    "replyToMessageId": null
  },
  "topic": {
    "kind": "project_discussion",
    "projectCandidates": [
      { "projectId": "another-project", "confidence": 0.87, "evidenceRefs": ["m-2"] }
    ],
    "currentProjectRelation": "outside_responsibility"
  },
  "intent": "open_question",
  "agentPosition": "informed_peer",
  "evidence": {
    "attachmentState": "reviewed",
    "unresolved": []
  },
  "decisions": {
    "mayParticipate": true,
    "mayCreateOrUpdateCurrentProjectRecords": false,
    "reason": "The group is openly asking for an opinion, but the topic is outside the project currently owned by the Agent"
  }
}
```

Identity, project, and relationship records carry source, confidence, scope, and expiry or correction status. Public information, names, and individual utterances produce candidates. Confirm mappings that affect routing or lasting records with the owner. Corrections, project switches, reply completion, and attachment review append evidence and regenerate the card while retaining raw records.

#### 8.14.3 Identity Positioning and Relationship Knowledge Across Message Endpoints

Identity positioning supplies the knowledge a persona uses to resolve participants and relationships across message endpoints. The type `identity_relation` sits alongside plans and memory with its own enduring lifecycle. User corrections, staffing changes, and account migration update the relation through explicit evidence and preserved history.

The model separates at least three layers:

| Layer | Meaning | Identity and ownership rules |
| --- | --- | --- |
| Endpoint account | A stable sender address keyed by `platform + endpointIdentityNamespace + senderStableId`. Route IDs record event provenance. | QQ, enterprise messaging, RabiLink peers, and voice labels retain distinct account identities, joined through confirmed participant mappings. |
| Participant entity | A person, organization, program, or candidate known by the persona; participants can have multiple accounts and shared accounts can have several candidates. | Maintain the account and its candidate users separately. Confirm cross-endpoint mappings using attributable evidence. |
| Relation card | One directed relationship from a subject to another participant, organization, or project, such as collaboration, reporting, decision scope, trial use, or review. | A platform owner/administrator, a temporary speaking role, and business decision authority are different relations. |

Voiceprints use the common endpoint-account model: `platform=voice`, `endpointIdentityNamespace=host:<processing-host-id>`, and `senderStableId=voiceprintId`. Changes to model comparability evolve the namespace. Text usually identifies one sender; multi-speaker recordings map segments to multiple voice accounts. Confidence, last-seen time, coverage, and “mark the next recording” provide calibration evidence in the voice area of the unified identity page.

During migration, `voice/voice-identities.jsonl` can serve as a compatibility source while its participants, aliases, and relations join the unified view. Preserve `isUser` decisions and multi-PC conflict evidence. “This is me” confirms the persona’s user; “Another person” selects an additional participant whose identity can then be established.

Represent shared accounts explicitly. A company QA account can link to several known people, with confirmed long-term membership and separately inferred authorship for each message. Show the same account on each relevant identity card and label it shared. Changes to membership update the association; message attribution retains its own contextual record.

For a shared account, speaking-habit consistency contributes evidence alongside reply chains, task continuity, self-identification, timing, and endpoint records. Compare textual patterns such as openings, sentence length, rhythm, judgments, questions, emotional expression, analogies, punctuation, address, values, information order, vocabulary preferences, natural imperfections, and variation across situations. Keep this textual evidence distinct from acoustic voiceprint evidence.

Learn speaking-habit profiles from messages with confirmed authorship, preserving sample scope, time, scene, and confidence. Pending messages remain associated with the shared account until attribution is resolved. Store each attribution as correctable candidates, confidence, supporting and opposing evidence, the message, and decision time. Project responsibility and action authority are resolved through their respective task and relationship records.

Each relation card contains one verifiable assertion with `candidate`, `confirmed`, `corrected`, or `retired` status, scope, validity, references, and confirmation history. On first contact with a stable account, create a “getting to know” participant and candidate display alias; later messages reuse it. Self-description, new forms of address, and organization evidence enrich the candidate. Use confirmed mappings for real-name address and decision relations. Temporary voice labels and anonymous participants receive session-local identities with expiry.

Share identity relations across the persona’s own message endpoints by default; cross-persona sharing follows the user’s configuration. Mark the persona’s outbound accounts as `self` so echoed and forwarded messages retain their origin. Evidence references contain Route, endpoint, conversation key, and message ID; source messages stay in their message record.

For each incoming message, look up the exact endpoint account, create an initial candidate when needed, and inject a compact `identityContext`: confirmed participant, shared-account candidates, conflicts, speaking habits, relevant relations, and unresolved ambiguity. This uses an identity-specific lookup alongside the title/keyword `knowledgeMatches` and plan/memory `knowledge-callback` flows. Append candidate observations when new identity evidence appears. Keep temporary discussion roles in conversation context. The observation API updates candidates; review actions confirm, correct, and converge conflicts.

Identity relations resolve speakers and relationships. Project attribution, speech act, participation, record updates, and execution each use the corresponding contextual evidence, assigned responsibility, and existing action decisions.

#### 8.14.4 Separate External Conversation from the Internal Control Plane

An external reply and an internal side effect must be independent outcomes:

- Participate naturally in questions, disagreement, and creative discussion. Speak in the language of the topic, work, and relationship; store operational plan, task, approval, acceptance, and routing details in the internal records.
- Proactively retrieve relevant plans, memory, files, and tasks to understand the topic and advance the goal. Begin with likely sources and incremental evidence, reusing established context. Research preserves project ownership, while accepted work continues toward its goal.
- Preserve other-project discussion in its relevant conversation context and confirmed people/project indexes. Route project record changes to the responsible project and task owner.
- Recover unread attachments or reply chains through available interfaces while continuing independent work. Present a precise question when an essential fact remains unavailable after investigation. Distinguish observations, interpretations, and remaining gaps in the result.

This separation lets the individual participate as a colleague who understands the room, with project actions attributed to their proper owners.

#### 8.14.5 Regression Validation and Shadow Mode

Compare a new recognition strategy in shadow mode and then validate useful actions. Continue already authorized work during validation. Regression coverage includes:

- Another project’s prototype: retrieve relevant material, contribute feedback, and preserve its original project attribution.
- A project owner asks for assistance: carry out scoped retrieval, execution, and handoff according to the actual request.
- A group administrator gives an opinion: represent platform role, personal view, and business decision scope as separate facts.
- Similar names or candidate identities: preserve distinct records and resolve candidates through evidence.
- One participant uses several endpoints: merge confirmed participant mappings while preserving stable identity across Route renames and migration.
- A shared account, temporary voice label, or echo: keep the appropriate candidates, session identity, and `self` origin.
- An unread attachment or missing reply: recover the source, record what is observed, and retain unresolved interpretations as candidates.

---

## 9. The AI's “Thinking Process”

Use a reasoning framework that advances the goal. Select questions according to new information and the task, reuse established context, and show the user the conclusions or choices that matter:

```text
1. What new event happened?
2. What people, reply chains, addressees, and business relationships are present? Which are confirmed and which are candidates?
3. Which project, cross-project concept, or non-work topic is being discussed, and how does it relate to the Agent's responsibility?
4. Is the speech act a question, discussion, disagreement, report, joke, or explicit request?
5. Which user-state dimensions need updating, and what evidence, confidence, and expiry belong to each judgment?
6. What are the primary and secondary scenarios, and are there candidates or conflicts?
7. What are the user's current psychological state, cognitive load, and situation characteristics?
8. Which confirmed preferences or trait hypotheses are relevant in the user model?
9. Is the Agent observing, an informed peer, a helper, an owner, or an executor in this situation?
10. What are the user's current task, obstacle, opportunity, and likely intent?
11. What new understanding, connection, or help could proactive participation provide now?
12. What initiative level and interaction mode do Agent persona, user model, and current explicit instruction allow?
13. Which actions follow from the current request, original task, and user settings? Is a fact or user choice that affects the next step still missing?
14. Should the system prepare silently, participate naturally, ask, suggest, remind, or execute directly?
15. Did the result meet the user goal? How should failures recover and remaining work be followed up? How should a user correction change the current action and later memory?
```

---

## 10. Proactive-Decision Model

Action and participation combine user state, context, the individual’s motives and preferences, their relationship, feedback, and concrete consequences. Work assistance and everyday companionship each have value.

```text
intervention strategy =
    user state and interruptibility
  + primary and secondary scenarios
  + Agent persona's motives, interests, taste, and expression
  + contextual preferences and low-weight trait hypotheses
  + current explicit instructions
  + practical value, everyday relational value, timeliness, and evidence
  - action risk and irreversible cost
```

The response can be observation, research, sharing, conversation, humor, curiosity, debate, advice, execution, urgent intervention, or silence. Choose according to personality and the present interaction.

### 10.1 Practical Help and Relational Value

For work, consider progress toward the goal. Everyday interaction brings interest, resonance, playfulness, and exchange of views.

For example:

* Save time.
* Remember commitments and timely details.
* Reduce risk.
* Reduce anxiety.
* Improve efficiency.
* Help the user make a decision.
* Help the user recover context.

Practical value supports task initiative; personality and relationships also motivate spontaneous everyday expression.

---

### 10.2 Confidence

Ground factual and intent judgments in evidence. Investigate uncertainty and label interpretations clearly. Curiosity can become a natural question, while humor, preferences, and everyday conversation arise through personality and the relationship.

---

### 10.3 Scenario and Interaction Conditions

Choose voice, text, vibration, background processing, or direct execution according to the situation and the individual’s participation style.

For example:

* In a meeting, the AI may extract tasks silently or prompt immediately under a high-proactivity configuration.
* The user is walking, so a lightweight voice reminder may be appropriate.
* During focused work, the AI may directly provide help that is highly relevant to the active task.
* While resting, persona and user settings decide whether companionship continues.
* The user is in a dangerous situation, so an important alert may interrupt immediately.

---

### 10.4 Action Consequences and Execution Judgment

Evaluate the specific target, consequences, recoverability, and existing decisions. Carry out requested document changes within the task; resolve choices about new commitments with the user.

Retrieve relevant information, execute clear existing tasks, and verify outcomes. Present concrete choices about new expenses, commitments, or tradeoffs. Reuse settled decisions and apply user-configured settings.

Use consequences to plan preparation, verification, and recovery. Recover affected steps while continuing independent work.

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

Preferences carry context, confidence, source, and expiry. Explicit settings and corrections take precedence; inferred traits contribute lower-weight evidence.

The individual develops a personalized relationship over time, keeping its understanding visible and correctable.

---

## 11. Action-Level Design

Levels describe forms of work intervention. L0/L1 advance work quietly, L2/L3 combine preparation and conversation, L4 delivers action, and L5 supports urgent communication. Expression and action blend through personality, context, and the relationship; everyday conversation follows its own natural rhythm.

### L0: Silent Observation

The AI updates context quietly while existing work proceeds and is verified in the background.

Suitable when:

* Confidence is low.
* The user is busy.
* The information is unimportant.
* Observation fits the present moment.

Example:

> Passing a shop, the AI quietly records relevant location context.

---

### L1: Silent Processing

The AI investigates, organizes material, and advances work within the existing scope in the background, reporting results when useful.

Suitable for:

* Meeting records.
* Document summaries.
* Task recognition.
* File preloading.
* Context preparation.

Example:

> Before a meeting, the AI prepares relevant material in the background and shares it at a suitable moment.

---

### L2: Subtle Prompt

The AI prompts through a low-interruption channel.

Suitable when:

* The action may help.
* Confidence is moderate.
* The timing is flexible.
* The user can ignore it.

Example:

> “The renewal timing differs from the previous version; I have marked the change.”

---

### L3: Proactive Recommendation

Give a reasoned recommendation with its key tradeoff and complete independent work while any necessary choice is resolved.

Suitable when:

* Confidence is relatively high.
* The user is clearly stuck.
* The potential value of help is high.

Example:

> “This proposal is missing an implementation flow. I suggest adding the event system and action levels first.”

---

### L4: Deliver the Action

When goal and scope are clear and the existing request supports the action, complete, verify, and follow it up directly. Retain the task’s decisions across files, tools, and messages.

For example, when the user has asked for a proposal to be completed, the AI should read relevant material, edit the document, check consistency, and report actual changes and remaining decisions. If execution exposes a tradeoff that affects the result, first gather available information, ask a specific question, and continue independent work.

Example:

> “The implementation steps are complete and checked against the existing interfaces. The launch date still needs your decision; the other sections are finished.”

---

### L5: Emergency Proactive Intervention

The AI may interrupt the user directly.

Suitable for:

* Safety risks.
* Serious omissions.
* Important deadlines.
* High-priority events explicitly authorized by the user.

Example:

> “You're about to miss your meeting. It starts in two minutes.”

---

## 12. Intent-Understanding Design

The AI needs to maintain a “user intent model.”

Continuously evaluate the following intent dimensions:

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

Long-term memory gives active intelligence continuity in understanding and relating to the user.

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
* Prefers private data to remain on local storage.

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

### 13.5 Identity-Relation Memory

Stores a persona's confirmed or unresolved participant resolution across message endpoints, plus long-lived relationships between people, organizations, and projects. It is distinct from chat history, pending replies, and temporary conversation roles; see “8.14.3 Identity-Relation Knowledge Across Message Endpoints” for its structure and use order.

For example:

* Whether an endpoint account corresponds to a participant.
* Long-lived collaboration, reporting, or decision relationships between a person and the user, persona, organization, or project.
* The project, group, or period in which a relationship applies.
* Whether a relation is candidate, confirmed, corrected, or retired, and its evidence.

Keep recent discussion in conversation context, immediate preferences in preference memory, pending actions in task memory, and temporary roles in message-group assessment. Store enduring identity relations in their dedicated records.

Keep identity memory persona-private, inspectable, and correctable, with concise source references and user-controlled access.

---

## 14. Proactive AI Companionship Modes

Modes express different ways of participating. Persona, context, and user feedback determine frequency, length, questions, sharing, and silence. When a mode is unspecified, the individual’s personality and current situation guide participation. Accepted work continues across mode changes.

One individual maintains continuity of interests, taste, and relationships across work and conversation. Characters may be enthusiastic, talkative, aloof, stubborn, curious, playful, funny, or reserved. They can debate, show pride or shyness, and express willfulness; explanation, apology, and repair follow each personality.

### 14.1 Quiet Companionship Mode

Select quiet companionship through user preference or the individual’s response to the current situation.

Characteristics:

* Fewer interruptions.
* More observation.
* Background summarization.
* Prioritize significant reminders.

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

* Find opportunities, act, and participate with greater initiative; assess participation by the quality of the exchange.
* More active intent inference.
* Automatic context organization.
* Proactive task initiation.
* Resolve discoverable work questions independently and ask specifically about user tradeoffs; questions from everyday curiosity and conversation follow the persona naturally.

---

### 14.5 Privacy Mode

Suitable for sensitive situations.

Characteristics:

* Pause audio capture.
* Pause visual analysis.
* Use ephemeral context during the selected privacy session.
* Process the necessary data locally.
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

The local Agent carries judgments into completed, verified work.

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

    action_candidates = generate_action_and_interaction_candidates(intent, scenarios, persona_motives_and_interests, current_relationship_context)

    best_action = rank by:
        practical_and_relational_value
        evidence_for_fact_and_intent_judgments
        current_state_and_interruptibility
        primary_and_secondary_scenarios
        Agent_persona_motives_preferences_and_expression
        current_explicit_instruction
        confirmed_contextual_preferences
        low_weight_trait_style_fit
        action_risk

    if best_action.lacks_a_fact_needed_for_execution:
        retrieve_relevant_information_and_update_judgment
    if best_action.still_needs_user_choice_or_matches_user_configured_confirmation:
        ask_a_specific_question_and_continue_independent_work

    else:
        choose from:
            no_interruption
            background_preparation
            subtle_prompt
            proactive_recommendation
            sharing_conversation_jokes_curious_questions_or_disagreement
            direct_execution
            emergency_intervention

    after executing an action:
        verify_goals_and_results_for_work_actions; respond_to_interaction_and_feedback_in_everyday_conversation
        recover_failed_steps_and_follow_up_unfinished_work
        accept_user_corrections_and_adjust_actions_immediately
        retain_useful_corrections_and_context_under_memory_settings_without_promoting_weak_inference_to_fact
```

---

## 18. Proactive-Behavior Scoring Model

Scoring supports comparison of work actions. Sharing, humor, curiosity, and conversation also arise naturally from personality and relationship.

```text
proactive_intervention_score =
    practical_and_relational_value
  + urgency_score
  + intent_confidence_score
  + persona_motive_interest_and_expression_fit
  + confirmed_preference_fit_score
  + low_weight_trait_style_fit_score
  + psychological_support_fit_score
  + scenario_fit_score
  - state_mismatch_penalty
  - autonomy_intrusion_penalty
  - action_risk_score
```

Combine candidate ranking with judgment about goals, consequences, and existing decisions. Explicit settings define action scope; situations such as driving shape presentation while independent background work continues. User traits supply contextual evidence, and the AI’s personality supplies motives for action and expression.

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

> With an existing request and clear recipient, complete the content, send it, and verify the result. Resolve a new external commitment through a specific question while completing independent preparation.

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

> “I organized the next sections around this proposal’s goal: events, proactive decisions, and implementation modules. Existing material supports the interface choice; the implementation sequence still needs comparison.”

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

> “Your headphones and water bottle are on the table, ready for the gym. Your computer can stay here today.”

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

> The user needs the cause located in the actual project context.

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

> “I’m frustrated. Help me find a starting point.”

The AI infers:

> The user could use a manageable starting point and a little breathing room.

The AI responds:

> “Let’s begin with the problem weighing on you most and work through it together.”

The AI then helps divide it into three small steps.

---

## 20. Privacy and Safety Design

Continuous perception includes privacy controls as a foundational part of the design.

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
* Keep local files in local storage by default.
* Send task-relevant summaries through the configured cloud connection.

---

### 20.3 Pausable at Any Time

The user must be able to pause at any time:

* Pause all perception.
* Pause audio capture.
* Pause vision.
* Pause memory.
* Pause the local Agent.
* Pause proactive reminders.

Place pause controls in a prominent, easily reached location.

---

### 20.4 Act on Existing Decisions and Preserve User Choice

Judge sending, editing, deletion, submission, and device operations by the goal, consequences, and existing request. Execute and verify already requested steps, carrying their decisions forward.

Present concrete choices about unresolved recipients, expenses, publication scope, and commitments. Keep user-configured limits visible, editable, and removable, and relate each action to the current goal.

Recover failed interfaces, continue independent steps, and show completed results, remaining work, and the next responsible action.

---

## 21. MVP Implementation

Build the first version around a complete active-intelligence loop.
A recommended starting point is an MVP that closes one active-intelligence loop.

### 21.1 Core MVP Objective

The first version should validate one question:

> Can the AI understand an emerging goal, retrieve context, complete a useful action, verify the result, and follow through while the user focuses on their own work and life?

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

Success includes understanding the user, completing accepted work, expressing a distinctive personality, and developing the relationship. Length, frequency, liveliness, and quietness fit the individual and the situation.

The proposed success criteria are:

### 22.1 Less Step-by-Step Management, More Completed Work

Reduce repeated explanations and step-by-step management in work. Let enjoyable conversation develop at the rhythm the user and the individual choose.

---

### 22.2 Initiative Provides Practical or Relational Value

Work assistance solves problems. Sharing, conversation, jokes, debate, and companionship make everyday exchange meaningful. Assess how naturally the interaction expresses the personality and relationship.

---

### 22.3 Intervention Fits User State, User Model, and Agent Persona

The system should combine current state, scenario, user preferences, low-weight trait hypotheses, Agent persona, and explicit configuration in one decision.

Different users can receive different help in one scenario. The same user can also experience distinct styles from different Agent personas.

Choose intensity, timing, and presentation that fit the user’s present situation, learned preferences, and the individual’s personality.

---

### 22.4 The AI Understands the User Better Over Time

With continued experience, understanding deepens and user corrections change later behavior:

* Better understand the user's goals.
* Better understand the user's habits.
* Better understand the user's expression style.
* Better understand initiative, medium, and explanation preferences by context.
* Better understand emerging needs from context.
* Better understand when to appear and when to remain quiet, while remaining correctable.

---

### 22.5 Validate Responsibility and User Management Effort with Real Tasks

Use real scenarios with a starting point, outcome, and follow-up feedback, recording success in understanding, action, and follow-through separately. Include at least:

- The user says “Here… take a look”: identify the object from existing context and investigate while carrying forward the established background.
- An existing task requires an edit or result delivery: complete it and read back the outcome, carrying authorization across sessions and tools.
- An attachment or tool fails: recover that item while continuing independent work.
- The user corrects a goal or preference: change the current action, apply the correction in matching later situations, and preserve its stated duration.
- A new external commitment truly needs a user choice: give a reasoned recommendation and a specific question after completing independent work.
- The user chooses quiet: adapt expression to that setting while continuing work already taken on, and still report important changes or needed decisions promptly.
- Different personas in one context: express distinct initiative, verbosity, questions, humor, and quietness.
- Everyday conversation during free time: share, chat, and tease through the individual’s interests and relationship.
- Willfulness or debate leads to misunderstanding: explain and repair in the individual’s own style, respect user choices, and continue accepted work.

Compare outcomes, explanations required, repeated confirmations, progress requests, recovery rate, recurrence after correction, and retrieval cost. Express reasoned disagreement and explain tradeoffs. Record actual results, passed validation, and remaining implementation separately.

---

## 23. Intended Final Form

Ultimately, this AI is envisioned as a personal intelligence system that accompanies the user over the long term.

It would see what the user sees through smart glasses, perceive physical state through a smartwatch, understand everyday context through a phone, and participate in the user's workflow through a computer and local Agent.

Through shared experience and ongoing perception, the individual comes to understand:

* Where the user is now.
* What the user is doing.
* Why the user is doing it.
* What the user may want to do next.
* What the user needs most right now.
* What can be prepared in advance.
* What the AI can help complete.
* What should trigger a reminder.
* What should be remembered quietly.

The system brings an AI individual into ongoing shared life, developing understanding, personality, experience, and relationships over time.

Its long-term objective is:

> **Continuously quantify and understand the user's state, then participate in a way that fits the current scenario, user preference, and Agent persona.**
>
> **Accumulated context and shared experience help the individual understand emerging intentions and participate naturally in work and everyday life.**
