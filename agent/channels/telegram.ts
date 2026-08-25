import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  telegramChannel,
} from "eve/channels/telegram";
import {
  commitApprovalCard,
  commitMessageOf,
  commitRejectedCard,
  commitResultCard,
  isCommitApproval,
} from "../lib/cards";
import { getUserByTelegramId } from "../lib/users";

export default telegramChannel({
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
  async onMessage(_ctx, message) {
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
    async "input.requested"(data, channel) {
      for (const request of data.requests) {
        const rendered = renderTelegramInputRequest(request, channel.state);

        const text = isCommitApproval(request)
          ? commitApprovalCard(commitMessageOf(request))
          : rendered.text;

        const posted = await channel.telegram.post({
          reply_markup: rendered.replyMarkup,
          text,
        });

        if (rendered.freeformRequestId !== undefined && posted.id) {
          registerTelegramFreeformPrompt(channel.state, {
            messageId: posted.id,
            requestId: rendered.freeformRequestId,
          });
        }
      }
    },

    // Result card after the gated commit runs (or is rejected at the keyboard).
    async "action.result"(data, channel) {
      const action = data.result;
      if (action.kind !== "tool-result" || action.toolName !== "commit_entry") {
        return;
      }

      if (data.status === "rejected") {
        await channel.telegram.post(commitRejectedCard());
        return;
      }
      if (data.status === "failed" || data.error) {
        await channel.telegram.post(
          `⚠️ commit_entry falló: ${data.error?.message ?? "error desconocido"}`,
        );
        return;
      }
      await channel.telegram.post(
        commitResultCard(
          typeof action.output === "object" && action.output !== null
            ? (action.output as Record<string, unknown>)
            : {},
        ),
      );
    },
  },
});
