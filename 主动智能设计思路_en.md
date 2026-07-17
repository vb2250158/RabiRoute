<!-- docs-language-switch -->
<div align="center">
English | <a href="./%E4%B8%BB%E5%8A%A8%E6%99%BA%E8%83%BD%E8%AE%BE%E8%AE%A1%E6%80%9D%E8%B7%AF.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Active Intelligence AI System Design Document

## — Centered on “Trying Every Possible Way to Understand What the User Wants to Do, Then Proactively Helping and Accompanying the User Through Work and Life”

---

## 1. Core Objective

The goal of this system is not to build a traditional voice assistant or a chatbot that can only wait for questions. It is to design a **personal AI agent that provides continuous companionship, continuous perception, proactive understanding, and proactive action**.

Its core mission is:

> **Try every possible way to understand what the user currently wants to do, what they are doing, and what they may need, then help them at the right time and in the right way.**

This AI should feel like an intelligent companion that stays with the user, not merely a tool.
The user should not need to issue an explicit command every time or say a wake word. While the system is enabled, the AI should remain in a low-interruption companionship state. Through smart glasses, a smartwatch, a phone, a computer, and additional future devices, it should continuously perceive the user's environment, behavior, state, and task context.

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

### 3.2 Low-Interruption Companionship

Active intelligence does not mean speaking constantly or interrupting the user frequently.

A good proactive AI should have the judgment of a considerate person:

* Remain quiet when it should not speak.
* Remind promptly when a reminder is warranted.
* Observe first when uncertain.
* Reduce proactivity when it may disturb the user.
* Intervene proactively when something is important.
* Ask for confirmation before higher-risk actions.

The key to active intelligence is not saying more. It is doing the right thing at the right time.

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

> **Current user state = vision + hearing + speech + location + time + physiological state + task context + historical memory**

The AI's proactivity should come from this unified context, not from one isolated sensor.

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

The proposed system can be divided into seven layers.

```text
Smart-device perception layer
    ↓
Event-recognition layer
    ↓
Context-fusion layer
    ↓
Intent-understanding layer
    ↓
Proactive-decision layer
    ↓
Action-execution layer
    ↓
Memory-and-feedback layer
```

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

## 8. The AI's “Thinking Process”

An active-intelligence system needs a consistent internal reasoning process.

After every event, the AI should process it in this order:

```text
1. What happened?
2. Is it relevant to the user?
3. What state is the user currently in?
4. What might the user be trying to accomplish?
5. Does the user need help?
6. What help can I provide?
7. Is this an appropriate time to interrupt?
8. How risky would the action be?
9. Should I handle it silently, show a subtle prompt, ask proactively, or execute directly?
10. Should I record and learn from the outcome afterward?
```

---

## 9. Proactive-Decision Model

Five factors should jointly determine whether the AI acts proactively.

### 9.1 User Benefit

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

### 9.2 Confidence

Is the AI sufficiently certain that the user needs this help?

With high confidence, it may act proactively.
With moderate confidence, it may show a subtle prompt.
With low confidence, it should observe silently or ask.

---

### 9.3 Interruption Cost

Is this an appropriate time to interrupt the user?

For example:

* The user is in a meeting, so voice interruption is inappropriate.
* The user is walking, so a lightweight voice reminder may be appropriate.
* The user is focused on work, so only a low-interruption prompt is suitable.
* The user is resting, so non-urgent items should be postponed.
* The user is in a dangerous situation, so an important alert may interrupt immediately.

---

### 9.4 Action Risk

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

### 9.5 User Preferences

The AI should continuously learn user preferences:

* Whether the user prefers proactive reminders or quiet companionship.
* Whether the user accepts voice interruptions.
* Whether the user prefers detailed explanations.
* Whether proactive suggestions are permitted during work.
* Whether the user wants the AI to participate more in everyday situations.
* Which situations require silence.
* Which actions may execute automatically.
* Which actions always require confirmation.

Active intelligence should not use one universal mode. It should increasingly resemble the user's own personal AI.

---

## 10. Action-Level Design

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

## 11. Intent-Understanding Design

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

### 11.1 Current Task

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

### 11.2 Current Obstacle

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

### 11.3 Current Opportunity

The AI should identify opportunities as well as problems.

For example:

* This is a good moment to complete a small task.
* The current context is appropriate for a reminder.
* The current content can be summarized automatically.
* The current behavior can be automated.
* The current conversation can become a note.
* The current file can be added to project memory.

---

## 12. Memory-System Design

Active intelligence requires long-term memory; otherwise, it cannot genuinely understand the user.

Memory can be divided into five categories.

---

### 12.1 Factual Memory

Stores stable facts.

For example:

* The user's name.
* Devices owned by the user.
* Tools the user commonly uses.
* Projects the user is working on.
* The user's field of work.
* Preferred language and communication style.

---

### 12.2 Preference Memory

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

### 12.3 Task Memory

Stores work the user is currently advancing.

For example:

* Current projects.
* Unfinished documents.
* Action items.
* Commitments the user has made.
* Meeting conclusions.
* Future plans.

---

### 12.4 Situational Memory

Stores behavior patterns in particular contexts.

For example:

* The user usually checks tasks first after arriving at work.
* The user often organizes proposals in the evening.
* The user often forgets a particular item when leaving.
* The user wants meetings recorded automatically.
* The user tends to get stuck on document structure.

---

### 12.5 Relationship Memory

Stores information about people.

For example:

* Who a person is.
* Their relationship to the user.
* What they discussed last time.
* The other person's preferences.
* Whether a reply is pending.

This category requires particular care with privacy and permission controls.

---

## 13. Proactive AI Companionship Modes

The system should support different proactivity modes.

### 13.1 Quiet Companionship Mode

Suitable while the user works, studies, or rests.

Characteristics:

* Fewer interruptions.
* More observation.
* Background summarization.
* Only important reminders.

---

### 13.2 Work-Collaboration Mode

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

### 13.3 Life-Assistant Mode

Suitable for leaving home, shopping, cooking, commuting, and travel.

Characteristics:

* Combine location and time.
* Remind proactively.
* Help with choices.
* Watch for safety.
* Reduce interaction complexity.

---

### 13.4 High-Proactivity Mode

Suitable when the user explicitly wants deep AI participation.

Characteristics:

* More frequent proactive recommendations.
* More active intent inference.
* Automatic context organization.
* Proactive task initiation.
* Proactive questions about key uncertainties.

---

### 13.5 Privacy Mode

Suitable for sensitive situations.

Characteristics:

* Pause audio capture.
* Pause visual analysis.
* Do not retain context.
* Keep only necessary local processing.
* Display the current state explicitly.

---

## 14. Phone-App Design

The phone app is intended to be the system's control center.

### 14.1 Home Page

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

### 14.2 Device Management

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

### 14.3 Proactivity Settings

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

### 14.4 Memory Management

The user should be able to inspect:

* What the AI remembers.
* Recently added memories.
* User preferences.
* Task memory.
* Situational memory.
* Relationship memory.

The user must be able to:

* Delete memory.
* Edit memory.
* Disable a category of memory.
* Export memory.
* Clear memory.

---

### 14.5 Behavior Logs

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

### 14.6 Test Interfaces

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

## 15. Local-Agent Design

The local Agent is intended to be the AI's execution layer.

The AI should not merely recommend actions. It should be able to get work done.

### 15.1 Local-Agent Capabilities

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

### 15.2 Relationship Between the AI and Local Agent

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

## 16. Core Active-Intelligence Algorithm

The proposed system logic can be described with the following pseudocode.

```text
while the AI system is enabled:

    event = listen for events from smart devices and the local Agent

    context = fuse_current_context(
        user_speech,
        ambient_sound,
        visual_information,
        location,
        time,
        physiological_state,
        current_task,
        historical_memory,
        local_Agent_state
    )

    intent = infer_user_intent(context, event)

    need = judge_whether_user_needs_help(intent, context)

    action_candidates = generate_possible_actions(intent, need, context)

    best_action = rank by:
        user_benefit
        confidence
        interruption_cost
        action_risk
        user_preferences
        current_situation

    if best_action.benefit is low:
        observe_silently

    elif best_action.risk is low and confidence is high and interruption_cost is low:
        execute_proactively or recommend_proactively

    elif best_action.risk is medium:
        show_subtle_prompt or request_confirmation

    elif best_action.risk is high:
        require_user_confirmation

    after executing an action:
        record_result
        learn_from_user_feedback
        update_long_term_memory
```

---

## 17. Proactive-Behavior Scoring Model

Each candidate proactive behavior could receive a score.

```text
proactive_behavior_score =
    user_benefit_score
  + urgency_score
  + intent_confidence_score
  - interruption_cost_score
  - action_risk_score
  + user_preference_bonus
```

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
* Interruption cost: high.
* Risk: low.

Result:

> Record silently and summarize the task after the meeting.

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

## 18. Representative Use Cases

### 18.1 Work Companionship

The user opens the computer and begins writing a proposal.

Through the computer and phone, the AI knows that the user is editing a project document.
The glasses see the user pause for a long time.
The watch indicates that the user is stationary and focused.

The AI infers:

> The user is thinking and should not be interrupted too much, but structural help may be valuable.

The AI shows a subtle prompt:

> “This proposal already has its objective section. The next step could add the event system, proactive-decision logic, and implementation modules. I can organize a structure for you first.”

---

### 18.2 Meeting Companionship

The user enters a meeting.

The AI would automatically enter meeting mode:

* Reduce proactive interruption.
* Record key content.
* Extract tasks.
* Mark times, owners, and conclusions.
* Generate a summary afterward.
* Synchronize automatically to the task system.

After the meeting, the AI could prompt:

> “That meeting produced three tasks related to you. I've organized them.”

---

### 18.3 Everyday Companionship

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

### 18.4 Learning Companionship

The user studies difficult content for a long time.

The AI infers:

> The user may be having trouble understanding it, and the content is suitable for explanation.

The AI shows a subtle prompt:

> “This section is fairly abstract. I can explain it again in simpler language.”

The user nods or says “Go ahead.”

The AI begins explaining and records learning notes automatically.

---

### 18.5 Programming Companionship

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

### 18.6 Emotional Companionship

The user says:

> “I'm frustrated and don't know where to start.”

The AI infers:

> The user does not need a large amount of information right now. The first need is to reduce task pressure.

The AI responds:

> “You don't need to solve everything at once. Let's do one thing: describe the most important problem in one sentence.”

The AI then helps divide it into three small steps.

---

## 19. Privacy and Safety Design

Because the proposed system would perceive the user continuously, privacy must be a foundational design concern rather than a later patch.

### 19.1 The User Must Always Know Whether the AI Is Perceiving

The system should display clearly:

* Whether it is listening.
* Whether it is seeing.
* Whether it is recording.
* Whether it is invoking the local Agent.
* Whether it is saving memory.
* Whether it is uploading to the cloud.

---

### 19.2 Local First

Content that can be processed locally should be processed locally first.

For example:

* Transcribe raw audio locally first.
* Analyze raw imagery locally first.
* Store sensitive memory locally first.
* Do not upload local files by default.
* Send only necessary summaries to the cloud.

---

### 19.3 Pausable at Any Time

The user must be able to pause at any time:

* Pause all perception.
* Pause audio capture.
* Pause vision.
* Pause memory.
* Pause the local Agent.
* Pause proactive reminders.

The pause entry point should be highly visible rather than buried deeply.

---

### 19.4 High-Risk Operations Must Require Confirmation

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

## 20. MVP Implementation

The first version does not need to implement every proposed capability at once.
A recommended starting point is an MVP that closes one active-intelligence loop.

### 20.1 Core MVP Objective

The first version should validate one question:

> Can the AI infer what the user may need from context and provide valuable help without an explicit command?

---

### 20.2 Modules Required for the MVP

The proposed first version would need:

* A phone app.
* Smart-device integration.
* Continuous voice listening.
* Basic visual context.
* Local-Agent connection.
* An event system.
* Current-context management.
* Simple intent judgment.
* Proactive reminders.
* A memory system.
* Behavior logs.
* Developer test interfaces.

---

### 20.3 Recommended Priority Scenarios for the MVP

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

## 21. Criteria for System Success

Success should not be measured by the length of the AI's answers. It should be measured by whether the AI genuinely understands the user.

The proposed success criteria are:

### 21.1 The User Says Less but Accomplishes More

If the user can accomplish more with the AI without speaking at length, the system is moving in the right direction.

---

### 21.2 Most Proactive AI Actions Are Useful

Most proactive reminders, recommendations, summaries, and actions should make the user feel:

> “Yes, this is exactly what I needed.”

---

### 21.3 The User Is Rarely Interrupted

Active intelligence must not become interruption intelligence.

If the user frequently finds the AI annoying, proactive decision-making has failed.

---

### 21.4 The AI Understands the User Better Over Time

With continued use, the system should understand the user more deeply:

* Better understand the user's goals.
* Better understand the user's habits.
* Better understand the user's expression style.
* Better understand needs the user does not state.
* Better understand when to appear and when to remain quiet.

---

## 22. Intended Final Form

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

> **Understand the user as much as possible without disturbing them; appear proactively when they need help; and, even before they state a need explicitly, gradually learn through continuous companionship and accumulated context what they truly want, helping make both work and life run more smoothly.**
