# Hack Club's Hall of Fame

A Slack bot that watches for messages with 5+ :star: reactions and posts them to
[#hall-of-fame](https://hackclub.slack.com/archives/C028VGT0JMQ).

## The rules

All of them live in [`src/config.ts`](src/config.ts) — that is the only place to
change any of this.

- **5 stars** to qualify.
- **The author's own star never counts.** Enforced in `starCount()`
  ([`src/slack.ts`](src/slack.ts)), which every path reads counts through, so a
  message needs five stars from other people.
- **At most 3 announcements per channel per 5 minutes**, so one busy channel
  can't take over the feed.
- **A reconcile only auto-posts messages younger than 24 hours, at most 10 per
  run.** This is what stops a restart replaying a backlog into the channel — see
  below.
- **Messages older than a year aren't tracked at all.**

Slack's reaction state is the only source of truth. The `stars` column is a
cached copy, reconciled against Slack, never incremented.

## How it doesn't spam the channel after downtime

The live handler posts any qualifying message it sees, however old — a star
landing on an old message today is a real, organic entry.

The reconciler is different: it looks at what the bot *missed*, so it only posts
origins younger than `RULES.catchUpWindowHours` (24h), capped at
`RULES.maxCatchUpPostsPerRun` (10) per run and 3 per channel. Anything older that
qualifies is recorded with its correct star count and simply not posted; the run
summary says how many. A week of downtime therefore costs at most 10 posts, not a
week's worth.

That decision is re-derived from each message's timestamp on every run, so it is
never written to the database and can never be written wrongly. The previous
version stored it as `announce = false`, which meant *noticing* a message had
been missed was what disqualified it from ever being announced — every outage
permanently retired the backlog it created. `skip` (the replacement) is only ever
set by a deliberate act: `hof skip`, or somebody deleting an announcement by hand.

A reconcile runs every 6 hours, and on boot **only if one is actually due** — the
interval is stored in the database, so restarts don't reset it.

### The one thing it can't catch

A reconcile works from two sources: the messages already in the database, and the
contents of #hall-of-fame. So it will find a message whose stars drifted, whose
announcement was deleted, or that crossed the threshold while nobody was looking —
but only if **at least one** star reaction on it was recorded at some point.

If a message got all five of its stars during downtime and none afterwards, no row
was ever created and nothing knows it exists. Any later star fixes that
automatically (the live handler has no age limit, so it will post it then).
Otherwise, `hof check '#channel'` scans a channel live and will find it.

Scanning every channel automatically was considered and rejected: the bot is in
~3,800 of them, `conversations.history` doesn't return thread replies (where real
entries do land), and Slack's newer rate limits make a full sweep take hours. The
cost of that complexity isn't worth the handful of messages it would recover.

## Running it

```sh
cp .env.example .env    # then fill it in
yarn install
yarn build
yarn start
```

The schema is created and migrated automatically at boot by `initSchema()` in
[`src/db.ts`](src/db.ts). There is no Prisma and no migration step.

For development, `yarn watch` in one terminal and `yarn dev` in another.

## The `hof` command

One CLI for every operational task, replacing the eight ad-hoc scripts this
project used to carry. Build first (`yarn build`), then:

```sh
yarn hof status                       # counts, when the last reconcile ran, the rules in force
yarn hof check '#some-channel'        # what's starred there right now, and why each is/isn't announced
yarn hof pending                      # messages that qualify on the live count but aren't announced
yarn hof reconcile                    # dry run: what a reconcile would change
yarn hof reconcile --apply            # actually do it
yarn hof post <permalink> --apply     # announce a specific message, overriding the age rule
yarn hof skip <permalink>             # never announce this
yarn hof unskip <permalink>           # allow it again
```

Reads are read-only. Writes need `--apply`. The only way to post something the
rules wouldn't post on their own is `hof post`, which takes permalinks one at a
time (max 25) and still verifies the live star count first — there is deliberately
no bulk mode.

## In Slack

`/hof status`, `/hof check <#channel>`, `/hof reconcile`. Restricted to the log
channel, since they surface internal state and can trigger real posts.
`/ninja-check` and `/ninja-sync` still work as aliases for `check` and
`reconcile`.

## Logging

Everything logs through [`src/log.ts`](src/log.ts): `log.info`, `log.warn`,
`log.error`, plus `log.progress` for per-item chatter that goes to the console
only. Slack posts are queued and paced, identical messages inside 15 minutes are
counted rather than reposted, and **only errors ping** — and only the first one in
the window, so a repeating failure costs one @-mention per 15 minutes rather than
one per event.

## Layout

| File | What's in it |
| --- | --- |
| `config.ts` | every constant and env var |
| `log.ts` | the logger |
| `db.ts` | schema + every SQL query (two tables) |
| `slack.ts` | Slack calls and how to read a star count off a message |
| `policy.ts` | the rules, and the only three functions that write to #hall-of-fame |
| `reconcile.ts` | the accuracy job |
| `scan.ts` | "what's starred in this channel right now" |
| `status.ts` | the status view |
| `events/` | reactions, deletions, channel joins, slash commands |
| `cli.ts` | the `hof` command |
