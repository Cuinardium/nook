import { telegramChannel } from "eve/channels/telegram";
import { getUserByTelegramId } from "../lib/users";

// Telegram's `typing` chat action expires after ~5s, so while a tool runs we
// refresh it on an interval. Keyed by chat id because one process can serve
// several chats. The indicator stays live through the approval-card wait and
// the commit push, acting as the in-progress spinner.
const TYPING_REFRESH_MS = 4000;
const typingTimers = new Map<string, ReturnType<typeof setInterval>>();

type ChannelHandle = {
  telegram: { chatId: string; startTyping(): Promise<void> };
};

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

    // Only allowlisted users get through
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

    async "action.result"(_data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
    },

    async "message.completed"(data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
      if (data.finishReason === "tool-calls" || !data.message) {
        return;
      }
      await channel.telegram.post(data.message);
    },

    async "turn.failed"(data, channel) {
      stopTypingKeepAlive(channel as unknown as ChannelHandle);
      // Terminal failures also emit session.failed; let that handler own the
      // single user-facing notice.
      if (data.terminal) {
        return;
      }
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
