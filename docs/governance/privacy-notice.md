# How CS Virtual Lab uses your data

Version 1, 19 October 2026. This is the notice shown in the app. Every past version is kept in
this folder's history so we can always show what a learner agreed to.

## In one paragraph

Labs and topic checks run in your browser. Your progress is saved on your device first. If
you create an account, your email, a display name and your learning progress are stored on
the project's own server so you can carry on from another device. While you are signed in,
the app also keeps a record of your learning activity under a research code, so that you can
see your own history and so that, **only if you choose it**, researchers can study how
students learn computing. We never sell data and we never share it with advertisers. Research
use is a separate choice, off unless you turn it on, and you can turn it off at any time.

## What we store when you have an account

- Your **email address** and a **password hash** (never the password itself).
- A **display name**, a **username**, an optional picture link, and an age band if you choose
  to give one.
- Your **learning progress**: which labs you attempted or passed, your topic-check scores and
  your mastery per topic.
- Your **learning events**: opening a course, unit or lab; running the checker and the
  outcome; revealing a hint; resetting the bench; answering topic-check questions (right or
  wrong, never the text you typed); and the circuit, program or query you had built at each
  check. Each event carries the time, how long you took, the kind of device (phone, tablet
  or computer) and the kind of connection (2G, 3G, 4G or Wi-Fi). Events are stored under a
  **research code** derived from your account with a secret key that is kept outside the
  database, so the database alone cannot link them to you.

Not recorded, ever: anything you type in messages or forum posts (when those exist), your
location, your device's identifiers, your keystrokes, or anything from pages outside the app.

## Research use is your separate choice

On your profile page you can allow, purpose by purpose:

1. **Your learning events** to be included in research datasets.
2. **Snapshots of your lab work** (your circuits, programs, queries) to be included, after a
   scan that replaces anything that looks like a name, email, phone number or ID with a token.
3. **Counts of your forum and group activity** (how often, never what you wrote), once those
   features exist.
4. **Being contacted** about follow-up interviews or surveys.

Each choice is off by default and has no effect on what you can do in the app. Withdrawing is
one click and stops future collection into the research stream immediately. Records already
marked for research are kept only if you had agreed at the time; delete them from the
"Your data" page whenever you wish.

If you are **under 18**, research use needs the agreement of a parent, guardian or your
institution. The app asks you to confirm that agreement before any research choice is saved;
without it your records stay out of the research stream and you are off public boards.

## Why

The research purpose is to understand how students learn practical computing on low-end
devices and intermittent connections, so that courses, labs and the app itself can be
improved, and so that approved researchers in computer science and IT education can study it.
Aggregate findings (never individual records) may be published.

## Who can see what

- **You**: everything, on the "Your data" page, including downloads as JSON and CSV.
- **The project team**: account and progress data, to run the service. Every time the team
  looks up the person behind a research code it is written to an audit log.
- **Your lecturer**, once class features exist: patterns for the class and where students are
  stuck, used to help, never to make an automatic decision about you. This notice will be
  updated before that starts.
- **Approved researchers**: only de-identified records of learners who opted in, after a
  written request, ethics approval and a signed data use agreement. Each released dataset
  re-keys the research codes, so two releases cannot be joined. See
  [docs/05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md](../05-LEARNING-ANALYTICS-AND-RESEARCH-DATA.md).

## How long

- Account and progress data: while your account exists.
- Learning events and snapshots: while your account exists, plus up to 12 months, unless you
  delete them earlier from the "Your data" page. Records you agreed to share for research are
  kept in the pseudonymous research copy for up to 10 years; the rest are deleted with your
  account. Copies already released to researchers under agreement cannot be recalled; they do
  not identify you.
- Server request logs (address, path, status and timing; no content): about a month, for
  security and troubleshooting.

## Your rights

Download your data, correct your profile, change or withdraw your research choices, delete
your recorded events, or delete your account at any time from your profile page. You can
complain to the Data Protection Commission of Ghana. The project is designed to meet the Data
Protection Act, 2012 (Act 843) and the GDPR.

## Contact

The operator of this deployment names its data protection contact here before going live.
