import {
  telegramChannel,
  type TelegramHandle,
  type TelegramInboundResult,
  type TelegramMessage,
} from "eve/channels/telegram";
import { getUserByTelegramId } from "../lib/users";
import { log } from "../lib/log";

// Telegram's `typing` chat action expires after ~5s, so while tool calls run we
// refresh it on an interval. Keyed by chat id because one process can serve
// several chats, and counted because a step can run several calls at once.
// The indicator stays live through the approval-card wait and the commit push
// (a call only settles after it executes), acting as the in-progress spinner.
const TYPING_REFRESH_MS = 4000;

type TypingState = {
  active: number;
  timer: ReturnType<typeof setInterval>;
};

const typing = new Map<string, TypingState>();

function chatIdOf(handle: TelegramHandle): string {
  return handle.chatId || "";
}

function stopTyping(handle: TelegramHandle): void {
  const chatId = chatIdOf(handle);
  if (!chatId) {
    return;
  }
  const state = typing.get(chatId);
  if (state) {
    clearInterval(state.timer);
    typing.delete(chatId);
  }
}

function startTyping(handle: TelegramHandle): void {
  const chatId = chatIdOf(handle);
  if (!chatId) {
    return;
  }
  stopTyping(handle);
  void handle.startTyping().catch(() => undefined);
  const timer = setInterval(() => {
    void handle.startTyping().catch(() => undefined);
  }, TYPING_REFRESH_MS);
  typing.set(chatId, { active: 0, timer });
}

function startCall(handle: TelegramHandle): void {
  const chatId = chatIdOf(handle);
  if (!chatId) {
    return;
  }
  const state = typing.get(chatId);
  if (!state) {
    startTyping(handle);
    const started = typing.get(chatId);
    if (started) {
      started.active = 1;
    }
    return;
  }
  state.active += 1;
}

function endCall(handle: TelegramHandle): void {
  const chatId = chatIdOf(handle);
  if (!chatId) {
    return;
  }
  const state = typing.get(chatId);
  if (!state) {
    return;
  }
  state.active = Math.max(0, state.active - 1);
  if (state.active === 0) {
    stopTyping(handle);
  }
}

/** The answer text of a reply part, when the channel got the whole value. */
function replyText(
  kind: string,
  phase: string,
  value: unknown,
  fallbackText: string | undefined,
): string | undefined {
  if (kind !== "text" || phase !== "reply") {
    return undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallbackText && fallbackText.length > 0 ? fallbackText : undefined;
}

export default telegramChannel({
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
  onMessage(
    ctx,
    message: TelegramMessage,
  ): TelegramInboundResult | null {
    // Clear any stale typing timer for this chat before a new turn.
    stopTyping(ctx.telegram);

    // Only private-chat senders get through
    if (message.chat.type !== "private") {
      log.warn({
        event: "message.rejected",
        reason: "not-private-chat",
        chatType: message.chat.type,
        chatId: message.chat.id,
        telegramUserId: message.from?.id ?? null,
      });
      return null;
    }

    // Only allowlisted users get through
    const userId = message.from?.id;
    if (!userId) {
      return null;
    }

    const user = getUserByTelegramId(userId);
    if (!user) {
      // Dropped by design, but never silently: the operator needs the sender id
      // to grant access, and the sender has no way to learn it on their own.
      log.warn({
        event: "message.rejected",
        reason: "not-allowlisted",
        telegramUserId: userId,
        telegramUsername: message.from?.username ?? null,
        telegramName:
          [message.from?.firstName, message.from?.lastName]
            .filter(Boolean)
            .join(" ") || null,
      });
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
    // Persistent "typing" while any tool call runs (the in-progress spinner).
    async "call.requested"(_event, ctx) {
      startCall(ctx.channel.telegram);
    },

    async "call.settled"(_event, ctx) {
      endCall(ctx.channel.telegram);
    },

    // The turn's answer. Narration parts are not posted: the agent speaks once.
    async "content.completed"(event, ctx) {
      const text = replyText(
        event.data.kind,
        event.data.phase,
        event.data.value,
        event.data.fallbackText,
      );
      if (text === undefined) {
        return;
      }
      stopTyping(ctx.channel.telegram);
      await ctx.channel.telegram.post(text);
    },

    // A failed turn (a failed session settles its turn as cancelled, so this is
    // never the terminal case).
    async "turn.settled"(event, ctx) {
      stopTyping(ctx.channel.telegram);
      if (event.data.outcome !== "failed") {
        return;
      }
      await ctx.channel.telegram.post(
        "I hit an error while handling your request. Please try again, rephrase, or reach out if it keeps failing.",
      );
    },

    async "session.ended"(event, ctx) {
      stopTyping(ctx.channel.telegram);
      if (event.data.outcome !== "failed") {
        return;
      }
      await ctx.channel.telegram.post(
        "This session could not recover from an error. Start a new message to continue.",
      );
    },
  },
});
