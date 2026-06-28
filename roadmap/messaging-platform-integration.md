# Messaging Platform Integration

Invoke Mastra workflows from Slack (and other messaging platforms) so users can feed tasks and requirements directly from chat.

## Goal

A user types a requirement in Slack (e.g. "build a login page with email + password") and the autonomous developer workflow runs — planner breaks it down, developer writes the code, result is posted back to the thread.

---

## Approach: REST API + Slack Slash Command (Phase 1)

Simpler path to ship first. No conversational memory, but handles one-shot task triggers well.

### Steps

1. **Create a Slack App**
   - Go to https://api.slack.com/apps → Create New App
   - Enable Socket Mode or HTTP mode
   - Under "Slash Commands" → create `/run-workflow`
   - Set Request URL to `https://your-domain/slack/commands`
   - Copy `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` to `.env`

2. **Add environment variables**
   ```
   SLACK_SIGNING_SECRET=...
   SLACK_BOT_TOKEN=...
   ```

3. **Create `src/mastra/routes/slack-webhook.ts`**
   - Verify Slack's request signature (HMAC-SHA256)
   - Extract `text` from the slash command payload
   - Immediately respond to Slack (3-second limit)
   - Async: call `workflow.execute({ inputData: { requirement: text } })`
   - Post result back via `response_url`

4. **Register the custom route in `src/mastra/index.ts`**
   - Add to `server.apiRoutes`

5. **Deploy and test**
   - Run `npm run build` → deploy `.mastra/output`
   - Or use `ngrok` locally to expose `localhost:4111` for testing
   - Type `/run-workflow build a todo list API` in Slack

---

## Approach: Native Channels / Agent Bot (Phase 2)

Richer experience — streaming responses, conversation memory, tool approval cards in Slack.

### Steps

1. **Install the Slack adapter**
   ```bash
   npm install @chat-sdk/slack
   ```

2. **Configure `channels` on `developerAgent`**
   - Attach `SlackAdapter` with signing secret + bot token + app token
   - Set `toolDisplay: 'timeline'` for live tool-progress in the thread
   - Override `onDirectMessage` handler to route messages into the workflow instead of plain agent chat

3. **Mastra auto-registers webhook routes**
   - `POST /channels/slack/webhook` — Slack event subscriptions
   - `POST /channels/slack/actions` — button/approval clicks (used for `requireApproval` tools)

4. **Point Slack App's Event Subscriptions URL** to `/channels/slack/webhook`

5. **Enable events**
   - `message.im` (direct messages)
   - `app_mention` (@ mentions in channels)

---

## Other Platforms (Future)

Same pattern applies:

| Platform  | Adapter package         | Notes                            |
|-----------|-------------------------|----------------------------------|
| Discord   | `@chat-sdk/discord`     | Gateway WebSocket, no 3s limit   |
| Telegram  | `@chat-sdk/telegram`    | Long polling or webhook          |
| WhatsApp  | Twilio / Meta Cloud API | No first-party adapter yet       |
| MS Teams  | Bot Framework adapter   | No first-party adapter yet       |

---

## Message Flow (both approaches)

```
User types in Slack
       │
       ▼
Slack sends POST to Mastra webhook
       │
       ▼
Handler extracts requirement text
       │
       ▼
workflow.execute({ inputData: { requirement: text } })
       │
       ├── plannerStep   → breaks requirement into steps
       ├── developerStep → writes TypeScript code
       └── verifyStep    → runs npm build / tests
       │
       ▼
Post result back to Slack thread
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/mastra/routes/slack-webhook.ts` | Slash command handler + signature verification |
| `src/mastra/workflows/autonomous-dev-workflow.ts` | Planner → Developer → Verify workflow |
| `.env` additions | `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` |
