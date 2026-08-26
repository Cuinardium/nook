import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  telegramChannel,
  type TelegramMessageBody,
} from "eve/channels/telegram";
import {
  commitApprovalCard,
  commitMessageOf,
  commitRejectedCard,
  commitResultCard,
  isCommitApproval,
} from "../lib/cards";
import { getUserByTelegramId } from "../lib/users";
import { outputSchema } from "../tools/commit_entry";

// Telegram's `typing` chat action expires after ~5s, so while a tool runs we
// refresh it on an interval. Keyed by chat id because one process can serve
// several chats. The indicator stays live through the approval-card wait and
// the commit push, acting as the in-progress spinner.
const TYPING_REFRESH_MS = 4000;
const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
// Message id of the active commit approval card, so we can strip its keyboard
// once the user confirms (prevents a double-tap).
const approvalCardId = new Map<string, string>();

type ChannelHandle = { telegram: { chatId: string; startTyping(): Promise<void> } };

function chatIdOf(channel: ChannelHandle): string {
  return channel.telegram.chatId || "";
}

function stopTypingKeepAlive(channel: ChannelHandle): void {
  const chatId = chatIdOf(channel);
  if (!chatId) {
    return;
  }
  const timer = typingTimers.get(chatId);
  if (timer) {
    clearInterval(timer);
    typingTimers.delete(chatId);
  }
}

function startTypingKeepAlive(channel: ChannelHandle): void {
  const chatId = chatIdOf(channel);
  if (!chatId) {
    return;
  }
  stopTypingKeepAlive(channel);
  void channel.telegram.startTyping().catch(() => undefined);
  const timer = setInterval(() => {
    void channel.telegram.startTyping().catch(() => undefined);
  }, TYPING_REFRESH_MS);
  typingTimers.set(chatId, timer);
}

// `post` only types the common fields; parse_mode is forwarded straight to
// sendMessage by the channel, so we extend the body for rich HTML cards.
type HtmlBody = TelegramMessageBody & { parse_mode: "HTML" };

function htmlPost(
  channel: { telegram: { post(body: TelegramMessageBody | string): Promise<{ id: string }> } },
  body: HtmlBody,
): Promise<{ id: string }> {
  return channel.telegram.post(body as TelegramMessageBody);
}

export default telegramChannel({
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
  async onMessage(handle, message) {
    // Clear any stale typing timer for this chat before a new turn.
    stopTypingKeepAlive(handle as unknown as ChannelHandle);

    // Only private-chat senders get through
    if (message.chat.type !== "private") {
      return null;
    }

    // Only white listed user
    const userId = message.from?.id;
    if (!userId) {
      return null;
    }

    const user = getUserByTelegramId(userId);
    if (!user) {
      return null;
    }

    return {
      auth: {
        authenticator: "telegram",
        principalType: "user",
        principalId: user.principalId,
        attributes: {
          telegramUserId: user.telegramUserId,
        },
      },
      title: `nook: ${user.principalId}`,
    };
  },
  events: {
    // Persistent "typing" while any tool runs (the in-progress spinner).
    async "actions.requested"(_data, channel) {
      startTypingKeepAlive(channel as unknown as ChannelHandle);
    },

    async "input.requested"(data, channel) {
      for (const request of data.requests) {
        const rendered = renderTelegramInputRequest(request, channel.state);

        if (isCommitApproval(request)) {
          const posted = await htmlPost(channel as never, {
            text: commitApprovalCard(commitMessageOf(request)),
            reply_markup: rendered.replyMarkup,
            parse_mode: "HTML",
          });
          if (posted.id) {
            approvalCardId.set(channel.telegram.chatId, posted.id);
          }
          continue;
        }

        const posted = await channel.telegram.post({
          reply_markup: rendered.replyMarkup,
          text: rendered.text,
        });

        if (rendered.freeformRequestId !== undefined && posted.id) {
          registerTelegramFreeformPrompt(channel.state, {
            messageId: posted.id,
            requestId: rendered.freeformRequestId,
          });
        }
      }
    },

    async "action.result"(data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
      const action = data.result;
      if (action.kind !== "tool-result" || action.toolName !== "commit_entry") {
        return;
      }

      // Strip the approval card's keyboard so it can't be tapped twice.
      const cardId = approvalCardId.get(channel.telegram.chatId);
      if (cardId) {
        await channel.telegram
          .editMessageReplyMarkup({ messageId: cardId, replyMarkup: {} })
          .catch(() => undefined);
        approvalCardId.delete(channel.telegram.chatId);
      }

      if (data.status === "rejected") {
        await htmlPost(channel as never, {
          text: commitRejectedCard(),
          parse_mode: "HTML",
        });
        return;
      }
      if (data.status === "failed" || data.error) {
        await channel.telegram.post(
          `⚠️ commit_entry falló: ${data.error?.message ?? "error desconocido"}`,
        );
        return;
      }
      const parsed = outputSchema.safeParse(action.output);
      if (!parsed.success) {
        await channel.telegram.post(
          "⚠️ commit_entry devolvió una salida inesperada.",
        );
        return;
      }
      await htmlPost(channel as never, {
        text: commitResultCard(parsed.data),
        parse_mode: "HTML",
      });
    },

    async "message.completed"(data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
      if (data.finishReason === "tool-calls" || !data.message) {
        return;
      }
      await channel.telegram.post(data.message);
    },

    async "turn.failed"(_data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
      await channel.telegram.post(
        "I hit an error while handling your request. Please try again, rephrase, or reach out if it keeps failing.",
      );
    },

    async "session.failed"(_data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
      await channel.telegram.post(
        "This session could not recover from an error. Start a new message to continue.",
      );
    },
  },
});
