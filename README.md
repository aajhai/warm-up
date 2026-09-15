# Local LinkedIn warm-up service

Internal tool for team-owned LinkedIn accounts in existing, logged-in GoLogin profiles. Runs from this Mac and connects to one GoLogin Cloud Browser profile at a time. It browses the feed, expands posts, occasionally likes content, then runs a small connection batch from LinkedIn's My Network suggestions.

Variable timing and pacing are behavior settings, **not a guarantee against detection or account restrictions**. A challenge, restriction, invitation limit, or uncertain connection result pauses the profile for manual review. The service does not complete logins, challenges, or email-verification dialogs.

## Setup

Node.js 22.12+ and an active GoLogin plan with Cloud Browser access are required. The service connects Puppeteer directly to GoLogin's cloud endpoint and stops the remote session through GoLogin's authenticated API. Copy `.env.example` to `.env` and provide your GoLogin API token, exact profile ID/name, and Slack incoming webhook. Credentials stay in `.env`; never commit them. Set `CONNECTIONS_ENABLED=true` to enable production connection batches. Set `GOLOGIN_BROWSER_MODE=local` only when intentionally falling back to the desktop app's loopback API.

Copy `profiles.example.json` to `data/profiles.json` and enter the profiles to enroll. Each entry requires a unique GoLogin ID, exact name, and `enabled` boolean. All profiles currently use the same activity defaults. Kunal is the initial locally enrolled profile. The service reloads this registry between runs.

```bash
npm install
npm test
npm run status
npm run notify:test
```

## Activity defaults

- Feed browsing: 10–15 minutes, three variable windows within 09:00–17:00 IST. Approximately 20% of windows are skipped. Weekends have lighter feed engagement.
- Likes: at most 2–5% of distinct visible posts, three attempts per session, six attempts per IST day. Skip ads, existing reactions, the first posts, and the beginning/end of the session.
- Connections: a separate batch after successful feed browsing, 2–4 attempts, with pauses and a maximum four-minute batch duration. Requests have no note and come only from recognizable My Network person cards.
- Weekly connection caps: randomly selected within **30–50**, **50–70**, **70–80**, then **80–100**, with an absolute ceiling of 100.
- Connection budgets reset **Monday 00:00 UTC**. This is our internal budget policy, not a claim about LinkedIn's actual limits. A lower platform limit always stops activity.
- A selected cap is saved for the week and never resampled by a restart. Stages advance using completed seven-day periods since the first production run, evaluated at the start of each UTC budget week. An initial partial week therefore does not trigger an immediate stage increase. Tests do not start warm-up age.
- A daily connection ceiling of `ceil(weekly cap / 7)` spreads activity across IST days. Budgets are ceilings, not targets. Missed activity is not made up later.
- No comments, follows, messages, reposts, contact uploads, invitations with notes, or automated verification responses.

## Commands

```bash
# One production session during normal work hours
npm run once -- --profile "Kunal Mittal"

# Short browse-only test at any time: ZERO likes and connection requests
npm run once:force -- --profile "Kunal Mittal"

# Full production session outside normal hours, with all budgets and stops intact
npm run once -- --profile "Kunal Mittal" --outside-hours

# Production trial: four minutes browsing, zero likes, at most ONE real invitation
# Counts toward normal daily/weekly budgets and warm-up age
npm run once -- --profile "Kunal Mittal" --connection-trial

# Inspect My Network controls without clicking Connect
npm run audit:network -- --profile "Kunal Mittal"

# Run the local scheduler until Ctrl-C
npm run schedule

npm run status
npm run review -- --profile "Kunal Mittal"
npm run resolve -- --profile "Kunal Mittal"
npm run notify:flush
```

Keep `npm run schedule` running in a terminal. It does not install a login item or wake this Mac. While the Mac sleeps, execution stops. Windows missed by more than two minutes are skipped when execution resumes; an active session detects a long heartbeat gap and ends. There are no catch-up bursts. With multiple profiles, conflicting windows may be missed because browsers run sequentially.

The normal feed duration excludes browser startup, notifications, and the additional connection batch. At most three production sessions are attempted per IST day. Two failed production sessions stop further production attempts that day. Browse-only diagnostic failures are tracked separately; profile pauses always block diagnostic runs too.

## Pause and recovery

```bash
npm run pause -- --profile "Kunal Mittal" --reason "Manual maintenance"

# Open the account yourself, resolve the issue, and inspect uncertain invitations first.
npm run resume -- --profile "Kunal Mittal" --reviewed
```

Security challenges and restrictions also require a 48-hour cooldown. Resume cannot bypass that cooldown. A login screen requires manual login and resume. Pausing again does not erase an existing challenge cooldown. Neither test mode nor `--outside-hours` bypasses profile pauses or activity budgets.

Do not run the same profile manually in GoLogin while this service owns it. The service refuses profiles reported as already running. Locks prevent concurrent local workers. After a forcibly killed process, verify the browser has stopped, then release the stale lock:

```bash
npm run unlock -- --lock browser
npm run unlock -- --lock service
```

Unlock refuses if the recorded process is still alive. An uncertain local API launch or failed shutdown also retains the browser lock for inspection. There is deliberately no automatic stale-lock deletion. A malformed lock requires manual inspection.

## State and reporting

`data/state-<profile-id>.json` contains daily/weekly budgets, scheduled-window status, current run, recent run history, pauses, and hashed action identities. Writes use a temporary file, flush, and atomic rename. Unreadable state blocks that profile instead of resetting limits; the scheduler continues planning healthy profiles and reports a changed profile error once. Files are local, so preserve `data/` when upgrading or moving the project.

Every like and connection attempt reserves budget **before clicking**. Unknown outcomes retain that reservation. Connection recipients are deduplicated per profile across sessions. A connection is considered confirmed only when the same person's card shows Pending. Unexpected dialogs, missing confirmation, or changed controls stop the batch for review. This is conservative: uncertain requests can consume allowance without having been sent.

Slack receives service start/stop, session start/completion/failure, paused profiles, and errors. Repeated recoverable warnings are summarized per session. Notification events are saved in `data/notifications/` before delivery; network failures and rate limits retain them for later retry. Delivery is at least once: a timeout after Slack accepts a message can produce a duplicate with the same event ID. The scheduler retries each minute; one-shot commands flush at the end, and `notify:flush` retries due events manually. Outbox files contain no webhook or GoLogin token.

Diagnostic JSON and screenshots remain in `logs/`. They can contain feed content; they are not uploaded to Slack. Logs/state currently have no automatic retention policy beyond a 200-run summary history, so disk usage should be monitored during longer trials.

## Verification and current limits

`npm test` covers UTC reset boundaries, stable weekly caps, conservative stage progression, crash reservations, duplicate prevention, daily/session limits, profile isolation, corrupt state, locks, missed schedules, Slack retry timing/redaction, account-state classification, and fixture-based My Network controls/dialogs.

The live read-only audit has recognized four suggestions on Kunal's My Network page. Actual invitation submission and its confirmation UI still require a live end-to-end trial; fixture tests and recognizing controls do not prove those steps work on every LinkedIn layout. Selectors currently assume English UI.

A browse-only trial on September 14 completed with six distinct posts, zero likes, zero invitations, and delivered Slack reporting. Earlier trials exposed recommendation panels above the first post and an incorrect document-scroll fallback; these have been corrected. Orbita also returned slow native-input responses and reported a hidden tab. Tab selection now foregrounds the selected page, and protocol operations have a 15-second timeout, but the final timeout/foregrounding changes still need another live trial before unattended operation is considered verified.

On September 15, the Node GoLogin SDK was removed and Puppeteer Core was upgraded to 25.11.0. The service now defaults to the [official GoLogin Cloud Browser connection flow](https://gologin.com/docs/api-reference/cloud-browser/getting-started); the local desktop API remains an explicit fallback. A live cloud browse-only trial completed with six distinct posts, two expansions, zero likes, zero invitations, and confirmed remote cleanup. `npm audit` reports **zero known npm vulnerabilities** for the installed tree. This audit covers this project’s npm dependencies, not GoLogin or Orbita themselves.
