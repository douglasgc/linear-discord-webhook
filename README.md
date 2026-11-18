![linear-discord-webhook](.github/banner.png)

# Linear Discord Webhook

Receive Linear updates directly in your Discord channels.

This application is powered by [Vercel][vercel] serverless functions utilizing Linear's webhooks to get notified when somebody creates a new issue, comment on the issue, or change the status of the issue.

It's inspired by the official [Slack integration][slack] for Linear.

## Installation

Visit [ldw.screfy.com][ui] and follow the instructions.

## How does it work?

It's really simple. We form a URL that contains the Discord webhook ID, Discord webhook token, Linear API token, and use that as our Linear webhook URL, e.g.:

```
https://ldw.screfy.com/api/webhook?webhookId=123&webhookToken=abc&linearToken=lin_api_abcdefgh
```

[vercel]: https://vercel.com
[slack]: https://linear.app/docs/slack
[ui]: https://ldw.screfy.com

## Linear backup (free plan limit)

`scripts/linear-backup.mjs` backs up every completed/canceled issue from cycles that
already ended (the current cycle and issues without a cycle are never touched), uploads
it to S3 and archives the issues so they stop counting toward the free plan limit.

```bash
cp .env.backup.example .env.backup          # once: set bucket / AWS profile
pnpm backup:linear                          # backup + upload only
pnpm backup:linear --archive                # backup + upload, then archive in Linear
```

It reuses the local `linear` CLI and AWS CLI credentials (run `aws sso login` if the
session expired). Output, one folder per cycle, locally in `backups/linear/` and in
`s3://$LINEAR_BACKUP_BUCKET/$LINEAR_BACKUP_PREFIX/`:

```
ciclo-02_2026-10-28_a_2026-11-10/
  README.md          index grouped by team
  issues.json        full data
  ENG/ENG-42_issue-title.md
```

Archiving only runs after the S3 upload is verified. Archived issues can be restored
from Linear at any time.
